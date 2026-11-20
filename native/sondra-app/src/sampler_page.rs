//! The Zerschneiden page: a loop or a break cut into pads — by hits, by a grid, by equal parts, by length or
//! by the pauses — and the pads laid on a step grid to be heard, bounced to a WAV or written as MIDI. The
//! plan is `sondra-media::chop` (the same as the web app's, number for number), the pads and the beat are
//! `sondra-media::pattern`. Every pad can be heard alone; every setting of a pad is a step on a row of
//! chips, or — opened up — as a piano roll (`roll_ui.rs`).

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{canvas, div, prelude::*, px, AnyElement, Bounds, Context, MouseButton, PathPromptOptions, Pixels};
use sondra_a11y::{accessible, Role};
use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::chop::{plan_chop, ChopMethod, ChopSettings, Flux, PlanContext};
use sondra_media::cue::{create_audacity_labels, create_cue_sheet, ExportSlice};
use sondra_media::pattern::{bounce_pattern, pattern_to_midi, render_voice, starter_pattern, Bed, Material, Pattern, PlayMode, Slice, SoundKind};
use sondra_media::tempo::estimate_tempo;
use sondra_media::Ffmpeg;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::clip_player::ClipPlayer;
use crate::shell::Shell;

pub struct SamplerState {
    pub path: Option<PathBuf>,
    pub audio: Option<Arc<AudioData>>,
    flux: Option<Arc<Flux>>,
    pub peaks: Vec<(f32, f32)>,
    /// What the tempo detection thought of the file: tempo, how sure, where the first beat is.
    pub tempo: Option<(f64, f64, f64)>,
    pub settings: ChopSettings,
    pub pads: Vec<Slice>,
    pub capped: bool,
    pub pattern: Pattern,
    pub selected: usize,
    pub choke: bool,
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    pub said: Option<String>,
    pub player: Option<ClipPlayer>,
    /// The pads that sound under the fingers, one over the other: which pad, and its voice.
    pub voices: Vec<(usize, ClipPlayer)>,
    pub made: Vec<PathBuf>,
    pub bounds: Rc<Cell<Bounds<Pixels>>>,
    /// The cut the pointer holds while it is down on the waveform.
    cut: Option<crate::cut_drag::Grab>,
    ticking: bool,
    /// The piano roll of a pad, when one is open.
    pub roll: Option<crate::roll_ui::RollView>,
}

impl SamplerState {
    pub fn new() -> SamplerState {
        SamplerState {
            path: None,
            audio: None,
            flux: None,
            peaks: Vec::new(),
            tempo: None,
            settings: ChopSettings::default(),
            pads: Vec::new(),
            capped: false,
            pattern: Pattern::new(16, 120.0),
            selected: 0,
            choke: true,
            busy: None,
            error: None,
            said: None,
            player: None,
            voices: Vec::new(),
            made: Vec::new(),
            bounds: Rc::new(Cell::new(Bounds::default())),
            cut: None,
            ticking: false,
            roll: None,
        }
    }
}

impl Default for SamplerState {
    fn default() -> Self {
        Self::new()
    }
}

fn seconds(s: f64) -> String {
    format!("{s:.2}").replace('.', ",")
}

fn db(v: f64) -> String {
    format!("{v:.1}").replace('.', ",").replacen('-', "−", 1)
}

const METHODS: [(ChopMethod, &str); 6] = [(ChopMethod::Auto, "Automatisch"), (ChopMethod::Hits, "Schläge"), (ChopMethod::Grid, "Raster"), (ChopMethod::Even, "Gleiche Teile"), (ChopMethod::Length, "Feste Länge"), (ChopMethod::Silence, "Pausen")];

impl Shell {
    pub(crate) fn choose_sampler_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.sampler_open(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    pub fn sampler_open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        self.sampler.player = None;
        self.sampler.voices.clear();
        self.sampler.busy = Some("Liest und hört den Ton ab …");
        self.sampler.error = None;
        let read = path.clone();
        Self::in_background(
            cx,
            move || -> Result<AudioData, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                decode_file(&ff, &read, None).map_err(|e| e.to_string())
            },
            move |shell, answer, cx| {
                shell.sampler.busy = None;
                match answer {
                    Ok(audio) => {
                        shell.sampler.path = Some(path);
                        shell.sampler_take(audio, cx);
                    }
                    Err(e) => shell.sampler.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// A sound already in hand (a test, a drop), with the name it carries.
    pub fn sampler_load(&mut self, audio: AudioData, name: PathBuf, cx: &mut Context<Self>) {
        self.sampler.path = Some(name);
        self.sampler_take(audio, cx);
    }

    /// Takes the sound: its picture, its tempo, its hits — then the first plan.
    pub fn sampler_take(&mut self, audio: AudioData, cx: &mut Context<Self>) {
        let s = &mut self.sampler;
        let audio = Arc::new(audio);
        s.peaks = peaks_of(&audio, 480);
        s.flux = Flux::of(&audio).map(Arc::new);
        let tempo = estimate_tempo(&audio);
        s.tempo = Some((tempo.bpm, tempo.confidence, tempo.offset_seconds));
        s.settings.bpm = tempo.bpm.round().max(40.0);
        s.pattern = Pattern::new(16, s.settings.bpm);
        s.roll = None;
        s.audio = Some(audio);
        s.made.clear();
        s.said = None;
        self.sampler_replan(cx);
    }

    /// Cuts again with the settings as they are; the pads that are still there keep their settings and steps.
    pub fn sampler_replan(&mut self, cx: &mut Context<Self>) {
        let s = &mut self.sampler;
        let Some(audio) = s.audio.clone() else { return };
        let context = PlanContext { range: None, tempo_offset_seconds: s.tempo.map_or(0.0, |t| t.2) };
        let plan = plan_chop(&audio, s.flux.as_deref(), &s.settings, &context);
        s.capped = plan.capped;
        let old = std::mem::take(&mut s.pads);
        s.pads = plan
            .slices
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let id = format!("p{}", i + 1);
                match old.get(i) {
                    Some(previous) => Slice { start: p.start, end: p.end, ..previous.clone() },
                    None => Slice::new(&id, p.start, p.end),
                }
            })
            .collect();
        let ids: Vec<String> = s.pads.iter().map(|p| p.id.clone()).collect();
        s.pattern.cells.retain(|id, _| ids.contains(id));
        s.pattern.notes.retain(|id, _| ids.contains(id));
        s.pattern.muted.retain(|id, _| ids.contains(id));
        if s.roll.as_ref().is_some_and(|r| !s.pattern.notes.contains_key(&r.id)) {
            s.roll = None;
        }
        s.selected = s.selected.min(s.pads.len().saturating_sub(1));
        cx.notify();
    }

    pub fn sampler_set(&mut self, change: impl FnOnce(&mut ChopSettings), cx: &mut Context<Self>) {
        change(&mut self.sampler.settings);
        self.sampler_replan(cx);
    }

    pub fn sampler_pad(&mut self, change: impl FnOnce(&mut Slice), cx: &mut Context<Self>) {
        let i = self.sampler.selected;
        if let Some(pad) = self.sampler.pads.get_mut(i) {
            change(pad);
        }
        cx.notify();
    }

    pub fn sampler_select(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.sampler.pads.len() {
            self.sampler.selected = index;
            cx.notify();
        }
    }

    pub fn sampler_toggle_step(&mut self, pad: usize, step: usize, cx: &mut Context<Self>) {
        let s = &mut self.sampler;
        let Some(slice) = s.pads.get(pad) else { return };
        let steps = s.pattern.steps;
        let cells = s.pattern.cells.entry(slice.id.clone()).or_insert_with(|| vec![false; steps]);
        cells.resize(steps, false);
        cells[step] = !cells[step];
        cx.notify();
    }

    pub fn sampler_pattern(&mut self, change: impl FnOnce(&mut Pattern), cx: &mut Context<Self>) {
        let before = self.sampler.pattern.steps;
        change(&mut self.sampler.pattern);
        let steps = self.sampler.pattern.steps;
        if steps != before {
            for cells in self.sampler.pattern.cells.values_mut() {
                let old = cells.clone();
                *cells = (0..steps).map(|i| if i < before { old[i] } else { old.get(i % before.max(1)).copied().unwrap_or(false) }).collect();
            }
            for notes in self.sampler.pattern.notes.values_mut() {
                *notes = sondra_media::pattern::resize_notes(notes, before, steps);
            }
        }
        cx.notify();
    }

    pub fn sampler_starter(&mut self, cx: &mut Context<Self>) {
        let steps = self.sampler.pattern.steps;
        let cells = starter_pattern(&self.sampler.pads, steps);
        self.sampler.pattern.cells = cells;
        self.sampler.pattern.notes.clear();
        self.sampler.roll = None;
        cx.notify();
    }

    fn sampler_stop(&mut self) -> bool {
        let voices = !self.sampler.voices.is_empty();
        self.sampler.voices.clear();
        self.sampler.player.take().is_some() || voices
    }

    /// One pad, played once by itself; the same button stops it.
    pub fn sampler_hear_pad(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.sampler_stop() {
            cx.notify();
            if self.sampler.selected == index {
                return;
            }
        }
        self.sampler_play_pad(index, cx);
    }

    /// One pad, played now, whatever was sounding.
    fn sampler_play_pad(&mut self, index: usize, cx: &mut Context<Self>) {
        self.sampler_audition(index, 0.0, cx);
    }

    /// One pad, played now a number of semitones above its own pitch (the keys of the piano roll).
    pub(crate) fn sampler_audition(&mut self, index: usize, extra: f64, cx: &mut Context<Self>) {
        let (Some(audio), Some(mut pad)) = (self.sampler.audio.clone(), self.sampler.pads.get(index).cloned()) else { return };
        pad.semitones += extra;
        self.sampler.selected = index;
        // Pads sound over one another, as on the website; with „Choke“ a pad struck again cuts its own earlier voice.
        if self.sampler.choke {
            self.sampler.voices.retain(|(i, _)| *i != index);
        }
        let rate = audio.sample_rate;
        let length = ((pad.end - pad.start) / 2f64.powf(pad.semitones / 12.0)).max(0.05) + 0.2;
        let mut bed = Bed::new(rate, (length * f64::from(rate)).ceil() as usize);
        render_voice(&mut bed, &Material { audio: &audio }, &Slice { mode: PlayMode::OneShot, ..pad }, 0.0, None, 1.0, None);
        let heard = AudioData { channels: vec![bed.left, bed.right], sample_rate: rate };
        self.sampler.voices.push((index, ClipPlayer::start(&heard, 0.0, heard.seconds())));
        self.sampler_ticker(cx);
        cx.notify();
    }

    /// A key of the keyboard: the pad that sits on it plays (and is chosen). Returns whether the key was one of them.
    pub fn sampler_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        const PAD_KEYS: [&str; 16] = ["1", "2", "3", "4", "q", "w", "e", "r", "a", "s", "d", "f", "y", "x", "c", "v"];
        let Some(index) = PAD_KEYS.iter().position(|k| *k == key.to_lowercase()) else { return false };
        if self.sampler.audio.is_none() || index >= self.sampler.pads.len() {
            return false;
        }
        self.sampler_play_pad(index, cx);
        true
    }

    /// The beat, played from the start; the same button stops it.
    pub fn sampler_hear_pattern(&mut self, cx: &mut Context<Self>) {
        if self.sampler_stop() {
            cx.notify();
            return;
        }
        let Some(audio) = self.sampler.audio.clone() else { return };
        let (pads, pattern, choke) = (self.sampler.pads.clone(), self.sampler.pattern.clone(), self.sampler.choke);
        self.sampler.busy = Some("Rechnet den Beat …");
        Self::in_background(
            cx,
            move || bounce_pattern(&pads, &pattern, &Material { audio: &audio }, 2, choke),
            |shell, heard, cx| {
                shell.sampler.busy = None;
                shell.sampler.player = Some(ClipPlayer::start(&heard, 0.0, heard.seconds()));
                shell.sampler_ticker(cx);
                cx.notify();
            },
        );
        cx.notify();
    }

    fn sampler_ticker(&mut self, cx: &mut Context<Self>) {
        if self.sampler.ticking {
            return;
        }
        self.sampler.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let alive = this.update(cx, |shell, cx| {
                if shell.sampler.player.as_ref().is_some_and(ClipPlayer::finished) {
                    shell.sampler.player = None;
                }
                shell.sampler.voices.retain(|(_, v)| !v.finished());
                let alive = shell.sampler.player.is_some() || !shell.sampler.voices.is_empty();
                if !alive {
                    shell.sampler.ticking = false;
                }
                cx.notify();
                alive
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    fn sampler_stem(&self) -> String {
        self.sampler.path.as_ref().and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Zerschnitten".into())
    }

    fn sampler_folder(&self) -> PathBuf {
        self.sampler.path.as_ref().and_then(|p| p.parent()).map(PathBuf::from).unwrap_or_else(crate::store::downloads_dir)
    }

    /// Writes something away from the window and says where it went.
    fn sampler_write(&mut self, cx: &mut Context<Self>, work: impl FnOnce() -> Result<Vec<PathBuf>, String> + Send + 'static) {
        self.sampler.busy = Some("Schreibt …");
        self.sampler.error = None;
        Self::in_background(cx, work, |shell, answer, cx| {
            shell.sampler.busy = None;
            match answer {
                Ok(paths) => shell.sampler.made = paths,
                Err(e) => shell.sampler.error = Some(e),
            }
            cx.notify();
        });
        cx.notify();
    }

    /// Every pad as its own WAV, with its pitch, level, pan and fades, in a folder beside the file.
    pub fn sampler_export_pads(&mut self, cx: &mut Context<Self>) {
        let Some(audio) = self.sampler.audio.clone() else { return };
        let (pads, dir) = (self.sampler.pads.clone(), self.sampler_folder().join(format!("{} (Pads)", self.sampler_stem())));
        self.sampler_write(cx, move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut made = Vec::new();
            for (i, pad) in pads.iter().enumerate() {
                let rate = audio.sample_rate;
                let length = ((pad.end - pad.start) / 2f64.powf(pad.semitones / 12.0)).max(0.05) + 0.05;
                let mut bed = Bed::new(rate, (length * f64::from(rate)).ceil() as usize);
                render_voice(&mut bed, &Material { audio: &audio }, &Slice { mode: PlayMode::OneShot, ..pad.clone() }, 0.0, None, 1.0, None);
                let out = AudioData { channels: vec![bed.left, bed.right], sample_rate: rate };
                let path = dir.join(format!("Pad {:02}.wav", i + 1));
                write_wav_f32(&path, &out).map_err(|e| e.to_string())?;
                made.push(path);
            }
            Ok(made)
        });
    }

    pub fn sampler_export_beat(&mut self, midi: bool, cx: &mut Context<Self>) {
        let Some(audio) = self.sampler.audio.clone() else { return };
        let (pads, pattern, choke) = (self.sampler.pads.clone(), self.sampler.pattern.clone(), self.sampler.choke);
        let (dir, stem) = (self.sampler_folder(), self.sampler_stem());
        self.sampler_write(cx, move || {
            if midi {
                let path = sondra_media::run::unique_path(&dir, &format!("{stem} (Beat)"), "mid");
                std::fs::write(&path, pattern_to_midi(&pads, &pattern, 1)).map_err(|e| e.to_string())?;
                Ok(vec![path])
            } else {
                let bounced = bounce_pattern(&pads, &pattern, &Material { audio: &audio }, 1, choke);
                let path = sondra_media::run::unique_path(&dir, &format!("{stem} (Beat)"), "wav");
                write_wav_f32(&path, &bounced).map_err(|e| e.to_string())?;
                Ok(vec![path])
            }
        });
    }

    /// The cut points as text for other programs: `cue` or `audacity`.
    pub fn sampler_export_marks(&mut self, kind: &'static str, cx: &mut Context<Self>) {
        let marks: Vec<ExportSlice> = self.sampler.pads.iter().map(|p| ExportSlice { start: p.start, end: p.end, name: None }).collect();
        if marks.is_empty() {
            return;
        }
        let (dir, stem) = (self.sampler_folder(), self.sampler_stem());
        let file = self.sampler.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.sampler_write(cx, move || {
            let (path, text) = if kind == "cue" {
                (sondra_media::run::unique_path(&dir, &stem, "cue"), create_cue_sheet(&file, &marks, &stem))
            } else {
                (sondra_media::run::unique_path(&dir, &format!("{stem}-labels"), "txt"), create_audacity_labels(&marks))
            };
            std::fs::write(&path, text).map_err(|e| e.to_string())?;
            Ok(vec![path])
        });
    }

    /// Where on the sound a pointer at `x` is, in seconds, and how many seconds six pixels are.
    fn sampler_time_at(&self, x: Pixels) -> Option<(f64, f64)> {
        let audio = self.sampler.audio.as_ref()?;
        let b = self.sampler.bounds.get();
        let width: f32 = b.size.width.into();
        if width <= 0.0 {
            return None;
        }
        let (left, x): (f32, f32) = (b.origin.x.into(), x.into());
        let total = audio.seconds();
        Some((((x - left) / width).clamp(0.0, 1.0) as f64 * total, 6.0 / f64::from(width) * total))
    }

    /// A press on the waveform: near a cut it takes hold of it, elsewhere it chooses the pad under it.
    fn sampler_down(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let Some((at, tolerance)) = self.sampler_time_at(x) else { return };
        let edges: Vec<(f64, f64)> = self.sampler.pads.iter().map(|p| (p.start, p.end)).collect();
        if let Some(grab) = crate::cut_drag::grab_at(&edges, at, tolerance) {
            self.sampler.cut = Some(grab);
            return;
        }
        if let Some(i) = self.sampler.pads.iter().position(|p| at >= p.start && at < p.end) {
            self.sampler_select(i, cx);
        }
    }

    /// The pointer moves with a cut held: the pads on both sides follow.
    fn sampler_drag(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let (Some(grab), Some((at, _))) = (self.sampler.cut, self.sampler_time_at(x)) else { return };
        let Some(total) = self.sampler.audio.as_ref().map(|a| a.seconds()) else { return };
        let edges: Vec<(f64, f64)> = self.sampler.pads.iter().map(|p| (p.start, p.end)).collect();
        for (pad, (start, end)) in self.sampler.pads.iter_mut().zip(crate::cut_drag::drag(&edges, grab, at, total)) {
            pad.start = start;
            pad.end = end;
        }
        self.sampler.player = None;
        self.sampler.voices.clear();
        cx.notify();
    }

    fn sampler_release(&mut self, cx: &mut Context<Self>) {
        if self.sampler.cut.take().is_some() {
            cx.notify();
        }
    }

    /// For tests.
    pub fn sampler_pads(&self) -> &[Slice] {
        &self.sampler.pads
    }
    pub fn sampler_pattern_ref(&self) -> &Pattern {
        &self.sampler.pattern
    }
    pub fn sampler_made(&self) -> &[PathBuf] {
        &self.sampler.made
    }
    pub fn sampler_is_playing(&self) -> bool {
        self.sampler.player.is_some() || !self.sampler.voices.is_empty()
    }
    /// For tests: how many pads sound now.
    pub fn sampler_voice_count(&self) -> usize {
        self.sampler.voices.len()
    }
    pub fn sampler_bounds(&self) -> Bounds<Pixels> {
        self.sampler.bounds.get()
    }
    pub fn sampler_selected(&self) -> usize {
        self.sampler.selected
    }

    pub(crate) fn sampler_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.sampler;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Zerlegen und auf Tasten legen"));
        page = page.child(ui.prose("Loops und Breaks an Schlägen, Pausen oder Takten zerschneiden, jedes Stück als Pad hören und im Schritt-Raster zu einem Beat legen. Jedes Pad lässt sich einzeln in Tonhöhe, Pegel und Lage ändern; geschrieben wird, was Sie hören."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        if let Some(what) = s.busy {
            page = page.child(ui.prose(what));
        }
        let Some(audio) = s.audio.clone() else {
            let pick = {
                let me = me.clone();
                ui.button("zerschneiden-waehlen", "Datei wählen").primary().disabled(s.busy.is_some()).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_sampler_file(cx)))
            };
            return page.child(div().flex().child(pick)).into_any_element();
        };
        let busy = s.busy.is_some();
        let name = s.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tempo = s.tempo.map(|(bpm, sure, _)| if sure >= 0.5 { format!("Tempo etwa {} BPM", bpm.round()) } else { format!("Tempo unsicher (etwa {} BPM)", bpm.round()) }).unwrap_or_default();
        let mut bar = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.title(name)).child(ui.value(format!("{} s · {}", seconds(audio.seconds()), tempo)));
        {
            let me = me.clone();
            bar = bar.child(ui.button("zerschneiden-andere", "Andere Datei").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_sampler_file(cx))));
        }
        page = page.child(bar);

        // The waveform with its cuts; a press chooses the pad under it.
        let total = audio.seconds();
        let mut columns = div().relative().flex().items_center().h(px(120.)).w_full().bg(c.stage);
        for (lo, hi) in &s.peaks {
            let up = (hi * 52.0).max(1.0);
            let down = (-lo * 52.0).max(1.0);
            columns = columns.child(div().flex_1().flex().flex_col().items_center().justify_center().child(div().w_full().h(px(up)).bg(c.stage_ink)).child(div().w_full().h(px(down)).bg(c.stage_ink)));
        }
        let measure = s.bounds.clone();
        columns = columns.child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full());
        for (i, pad) in s.pads.iter().enumerate() {
            let mut cell = div().absolute().top_0().bottom_0().left(gpui::relative((pad.start / total) as f32)).w(gpui::relative(((pad.end - pad.start) / total) as f32)).border_l_1().border_color(c.stage_accent);
            if i == s.selected {
                cell = cell.bg(c.stage_accent).opacity(0.35);
            }
            columns = columns.child(cell);
        }
        let (press, drag, release) = (me.clone(), me.clone(), me.clone());
        let stage = div()
            .id("zerschneiden-welle")
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, move |event, _, app| {
                let x = event.position.x;
                press.update(app, |shell, cx| shell.sampler_down(x, cx))
            })
            .on_mouse_move(move |event, _, app| {
                if event.pressed_button == Some(MouseButton::Left) {
                    let x = event.position.x;
                    drag.update(app, |shell, cx| shell.sampler_drag(x, cx))
                }
            })
            .on_mouse_up(MouseButton::Left, {
                let release = release.clone();
                move |_, _, app| release.update(app, |shell, cx| shell.sampler_release(cx))
            })
            .on_mouse_up_out(MouseButton::Left, move |_, _, app| release.update(app, |shell, cx| shell.sampler_release(cx)))
            .child(columns);
        page = page.child(accessible("zerschneiden-welle", Role::Group, stage).label("Wellenform mit Schnitten").value(format!("{} Pads", s.pads.len())));

        // How to cut.
        let mut methods = div().flex().flex_wrap().gap(px(6.));
        for (method, label) in METHODS {
            let me = me.clone();
            methods = methods.child(ui.chip(format!("verfahren-{label}"), label, s.settings.method == method).accessible_name(format!("Verfahren {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set(move |c| c.method = method, cx))));
        }
        let chips = |title: &str, key: &'static str, values: Vec<(f64, String)>, now: f64, set: fn(&mut ChopSettings, f64)| {
            let mut row = div().flex().flex_wrap().gap(px(6.));
            for (v, label) in values {
                let me = me.clone();
                row = row.child(ui.chip(format!("{key}-{label}"), label.clone(), (now - v).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_set(move |c| set(c, v), cx))));
            }
            div().flex().flex_col().gap(px(6.)).child(ui.hint(title.to_string())).child(row)
        };
        let ms = |values: &[f64]| -> Vec<(f64, String)> { values.iter().map(|v| (*v, format!("{v} ms"))).collect() };
        let st = &s.settings;
        let mut plan = div().flex().flex_col().gap(px(12.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.subheading("Wie geschnitten wird")).child(methods);
        match st.method {
            ChopMethod::Auto => {
                plan = plan.child(chips("Anzahl", "anzahl", [4.0, 8.0, 16.0, 32.0].iter().map(|v| (*v, format!("{v}"))).collect(), st.count, |c, v| c.count = v)).child(chips("Empfindlichkeit", "empf", [0.8, 1.4, 2.0].iter().map(|v| (*v, format!("{v}").replace('.', ","))).collect(), st.sensitivity, |c, v| c.sensitivity = v));
            }
            ChopMethod::Hits => {
                plan = plan.child(chips("Empfindlichkeit", "empf", [0.8, 1.4, 2.0].iter().map(|v| (*v, format!("{v}").replace('.', ","))).collect(), st.sensitivity, |c, v| c.sensitivity = v)).child(chips("Mindestabstand", "abstand", ms(&[40.0, 80.0, 160.0, 320.0]), st.min_gap_ms, |c, v| c.min_gap_ms = v));
            }
            ChopMethod::Grid => {
                let detected = s.tempo.map(|t| t.0.round()).unwrap_or(120.0);
                let mut tempos: Vec<f64> = vec![detected / 2.0, detected, detected * 2.0];
                tempos.dedup();
                plan = plan
                    .child(chips("Tempo", "tempo", tempos.iter().map(|v| (v.round(), format!("{} BPM", v.round()))).collect(), st.bpm.round(), |c, v| c.bpm = v))
                    .child(chips("Länge eines Stücks in Schlägen", "schlaege", [(0.25, "¼"), (0.5, "½"), (1.0, "1"), (2.0, "2"), (4.0, "4")].iter().map(|(v, l)| (*v, l.to_string())).collect(), st.beats_per_slice, |c, v| c.beats_per_slice = v));
            }
            ChopMethod::Even => {
                plan = plan.child(chips("Teile", "teile", [4.0, 8.0, 16.0, 32.0].iter().map(|v| (*v, format!("{v}"))).collect(), st.count, |c, v| c.count = v));
            }
            ChopMethod::Length => {
                plan = plan.child(chips("Länge je Teil", "laenge", ms(&[125.0, 250.0, 500.0, 1000.0]), st.length_ms, |c, v| c.length_ms = v));
            }
            ChopMethod::Silence => {
                plan = plan
                    .child(chips("Pause ab", "pause-db", [-60.0, -45.0, -35.0].iter().map(|v| (*v, format!("{} dB", db(*v)))).collect(), st.silence_db, |c, v| c.silence_db = v))
                    .child(chips("Mindestdauer", "pause-ms", ms(&[60.0, 120.0, 250.0, 500.0]), st.silence_ms, |c, v| c.silence_ms = v));
                let me2 = me.clone();
                let on = st.drop_silence;
                plan = plan.child(div().flex().child(ui.chip("pausen-weglassen", "Pausen weglassen", on).on_click(move |_, app| me2.update(app, |shell, cx| shell.sampler_set(move |c| c.drop_silence = !on, cx)))));
            }
        }
        plan = plan.child(chips("Vorlauf", "vorlauf", ms(&[0.0, 10.0, 20.0, 40.0]), st.pre_roll_ms, |c, v| c.pre_roll_ms = v));
        {
            let me2 = me.clone();
            let on = st.snap;
            plan = plan.child(div().flex().child(ui.chip("nulldurchgang", "Schnitte am Nulldurchgang", on).on_click(move |_, app| me2.update(app, |shell, cx| shell.sampler_set(move |c| c.snap = !on, cx)))));
        }
        let count = s.pads.len();
        plan = plan.child(ui.hint(if count == 0 { "Mit diesen Einstellungen ergibt sich kein Schnitt.".to_string() } else if s.capped { format!("{count} Pads (mehr sind nicht sinnvoll; der Rest wurde weggelassen)") } else { format!("{count} Pads") }));
        page = page.child(plan);
        if s.pads.is_empty() {
            return page.into_any_element();
        }

        // The pads: each can be heard; the chosen one has its settings.
        let mut pads = div().flex().flex_wrap().gap(px(8.));
        for (i, pad) in s.pads.iter().enumerate() {
            let (hear, pick) = (me.clone(), me.clone());
            let label = format!("Pad {} anhören", i + 1);
            pads = pads.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(ui.chip(format!("pad-{i}"), format!("{}", i + 1), i == s.selected).accessible_name(format!("Pad {} wählen", i + 1)).on_click(move |_, app| pick.update(app, |shell, cx| shell.sampler_select(i, cx))))
                    .child(ui.button(format!("pad-hoeren-{i}"), "▶").small().accessible_name(label).on_click(move |_, app| hear.update(app, |shell, cx| shell.sampler_hear_pad(i, cx))))
                    .child(ui.hint(format!("{} s", seconds(pad.end - pad.start)))),
            );
        }
        page = page.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Pads")).child(pads));

        if let Some(pad) = s.pads.get(s.selected) {
            let pad_chips = |title: &str, key: &'static str, values: Vec<(f64, String)>, now: f64, set: fn(&mut Slice, f64)| {
                let mut row = div().flex().flex_wrap().gap(px(6.));
                for (v, label) in values {
                    let me = me.clone();
                    row = row.child(ui.chip(format!("{key}-{label}"), label.clone(), (now - v).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pad(move |p| set(p, v), cx))));
                }
                div().flex().flex_col().gap(px(6.)).child(ui.hint(title.to_string())).child(row)
            };
            let mut modes = div().flex().flex_wrap().gap(px(6.));
            for (mode, label) in [(PlayMode::OneShot, "Einmal"), (PlayMode::Gate, "Gehalten"), (PlayMode::Loop, "Wiederholt")] {
                let me = me.clone();
                modes = modes.child(ui.chip(format!("modus-{label}"), label, pad.mode == mode).accessible_name(format!("Spielart {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pad(move |p| p.mode = mode, cx))));
            }
            let mut sounds = div().flex().flex_wrap().gap(px(6.));
            for kind in [SoundKind::Sample, SoundKind::Warm, SoundKind::Sub808, SoundKind::EPiano, SoundKind::Pluck, SoundKind::Lead] {
                let me = me.clone();
                sounds = sounds.child(ui.chip(format!("klang-{}", kind.label()), kind.label(), pad.sound == kind).accessible_name(format!("Klang {}", kind.label())).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pad(move |p| p.sound = kind, cx))));
            }
            let rev = {
                let (me, on) = (me.clone(), pad.reverse);
                ui.chip("rueckwaerts", "Rückwärts", on).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pad(move |p| p.reverse = !on, cx)))
            };
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .p(px(16.))
                    .rounded(px(radius::CARD))
                    .bg(c.panel_soft)
                    .child(ui.subheading(format!("Pad {}", s.selected + 1)))
                    .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Spielart")).child(modes))
                    .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Klang")).child(sounds))
                    .child(pad_chips("Tonhöhe", "ton", [-12.0, -7.0, -5.0, -2.0, 0.0, 2.0, 5.0, 7.0, 12.0].iter().map(|v| (*v, format!("{}", if *v > 0.0 { format!("+{v}") } else { format!("{v}") }).replace('-', "−"))).collect(), pad.semitones, |p, v| p.semitones = v))
                    .child(pad_chips("Pegel", "pegel", [-12.0, -6.0, -3.0, 0.0, 3.0, 6.0].iter().map(|v| (*v, format!("{} dB", db(*v)))).collect(), pad.gain_db, |p, v| p.gain_db = v))
                    .child(pad_chips("Lage", "lage", [(-1.0, "Links"), (-0.5, "Halb links"), (0.0, "Mitte"), (0.5, "Halb rechts"), (1.0, "Rechts")].iter().map(|(v, l)| (*v, l.to_string())).collect(), pad.pan, |p, v| p.pan = v))
                    .child(pad_chips("Anschwellen", "an", [0.0, 5.0, 20.0, 60.0].iter().map(|v| (*v, format!("{v} ms"))).collect(), pad.attack_ms, |p, v| p.attack_ms = v))
                    .child(pad_chips("Ausklingen", "aus", [0.0, 20.0, 80.0, 250.0].iter().map(|v| (*v, format!("{v} ms"))).collect(), pad.release_ms, |p, v| p.release_ms = v))
                    .child(div().flex().flex_wrap().gap(px(8.)).child(rev).child({
                        let (me, rolled) = (me.clone(), s.roll.as_ref().is_some_and(|r| r.id == pad.id));
                        let index = s.selected;
                        ui.button("klavierrolle", if rolled { "Klavierrolle ist offen" } else { "Klavierrolle" }).small().accessible_name(format!("Klavierrolle für Pad {}", index + 1)).disabled(rolled).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_roll_open(index, cx)))
                    })),
            );
        }

        // The step grid.
        let pattern = &s.pattern;
        let mut grid = div().flex().flex_col().gap(px(6.));
        for (row, pad) in s.pads.iter().enumerate() {
            let mut line = div().flex().items_center().gap(px(4.)).child(div().w(px(48.)).child(ui.hint(format!("Pad {}", row + 1))));
            let cells = pattern.cells.get(&pad.id);
            let rolled = pattern.notes.get(&pad.id);
            for step in 0..pattern.steps {
                // A pad with a roll plays its notes: the steps show where they begin or last, and a press goes to the roll.
                let on = match rolled {
                    Some(notes) => notes.iter().any(|n| step >= n.step && step < n.step + n.length),
                    None => cells.and_then(|c| c.get(step)).copied().unwrap_or(false),
                };
                let me = me.clone();
                let is_rolled = rolled.is_some();
                line = line.child(
                    ui.chip(format!("schritt-{row}-{step}"), if on { "●" } else { "·" }, on).accessible_name(format!("Pad {} Schritt {}", row + 1, step + 1)).on_click(move |_, app| {
                        me.update(app, |shell, cx| if is_rolled { shell.sampler_roll_open(row, cx) } else { shell.sampler_toggle_step(row, step, cx) })
                    }),
                );
            }
            grid = grid.child(line);
        }
        let bpm_chips = {
            let mut row = div().flex().flex_wrap().gap(px(6.));
            let detected = s.tempo.map(|t| t.0.round());
            let mut values: Vec<f64> = vec![80.0, 90.0, 100.0, 120.0, 140.0, 160.0];
            if let Some(d) = detected {
                if !values.contains(&d) {
                    values.push(d);
                    values.sort_by(|a, b| a.total_cmp(b));
                }
            }
            for v in values {
                let me = me.clone();
                row = row.child(ui.chip(format!("bpm-{v}"), format!("{v} BPM"), (pattern.bpm - v).abs() < 1e-9).accessible_name(format!("Tempo {v} BPM")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pattern(move |p| p.bpm = v, cx))));
            }
            row
        };
        let mut options = div().flex().flex_wrap().gap(px(6.));
        for steps in [16usize, 32] {
            let me = me.clone();
            options = options.child(ui.chip(format!("schritte-{steps}"), format!("{steps} Schritte"), pattern.steps == steps).accessible_name(format!("{steps} Schritte")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pattern(move |p| p.steps = steps, cx))));
        }
        for (swing, label) in [(0.0, "Gerade"), (0.2, "Etwas Swing"), (0.4, "Viel Swing")] {
            let me = me.clone();
            options = options.child(ui.chip(format!("swing-{label}"), label, (pattern.swing - swing).abs() < 1e-9).accessible_name(format!("Swing {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pattern(move |p| p.swing = swing, cx))));
        }
        {
            let (me, on) = (me.clone(), s.choke);
            options = options.child(ui.chip("choke", "Neuer Anschlag stoppt den alten", on).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.sampler.choke = !on;
                cx.notify();
            })));
        }
        let mut play_row = div().flex().flex_wrap().gap(px(8.));
        {
            let me = me.clone();
            play_row = play_row.child(ui.button("beat-hoeren", if s.player.is_some() { "Anhalten" } else { "Beat anhören" }).primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_hear_pattern(cx))));
        }
        {
            let me = me.clone();
            play_row = play_row.child(ui.button("start-beat", "Start-Beat legen").disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_starter(cx))));
        }
        {
            let me = me.clone();
            play_row = play_row.child(ui.button("beat-leeren", "Raster leeren").disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.sampler_pattern(|p| p.cells.clear(), cx))));
        }
        page = page.child(div().flex().flex_col().gap(px(12.)).child(ui.subheading("Beat")).child(bpm_chips).child(options).child(grid).child(play_row));
        if let Some(roll) = self.roll_editor(ui, cx) {
            page = page.child(roll);
        }

        // What can be written.
        let mut out = div().flex().flex_wrap().gap(px(8.));
        let write = |id: &'static str, label: &str, f: fn(&mut Shell, &mut Context<Shell>)| {
            let me = me.clone();
            ui.button(id, label.to_string()).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| f(shell, cx)))
        };
        out = out
            .child(write("pads-speichern", "Pads als WAV-Dateien", |s, cx| s.sampler_export_pads(cx)))
            .child(write("beat-wav", "Beat als WAV", |s, cx| s.sampler_export_beat(false, cx)))
            .child(write("beat-midi", "Beat als MIDI", |s, cx| s.sampler_export_beat(true, cx)))
            .child(write("marken-cue", "Schnittmarken als CUE", |s, cx| s.sampler_export_marks("cue", cx)))
            .child(write("marken-audacity", "Schnittmarken für Audacity", |s, cx| s.sampler_export_marks("audacity", cx)));
        let mut written = div().flex().flex_col().gap(px(10.)).child(ui.subheading("Speichern")).child(out);
        for path in &s.made {
            written = written.child(self.written_row(&ui, path, cx));
        }
        page.child(written).into_any_element()
    }
}

fn peaks_of(audio: &AudioData, columns: usize) -> Vec<(f32, f32)> {
    let n = audio.frames();
    (0..columns)
        .map(|c| {
            let a = c * n / columns;
            let b = (((c + 1) * n / columns).max(a + 1)).min(n);
            let (mut lo, mut hi) = (0f32, 0f32);
            for channel in &audio.channels {
                for v in &channel[a.min(n)..b] {
                    lo = lo.min(*v);
                    hi = hi.max(*v);
                }
            }
            (lo, hi)
        })
        .collect()
}
