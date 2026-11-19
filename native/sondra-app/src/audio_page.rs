//! The Ton page: one take on a waveform. Drag over it to choose a stretch, press play to hear the stretch
//! (or all of it), and let the tools work on the choice — cut, level, tone, noise, room — each one a step
//! in a history that can be walked back. Nothing is written until „Speichern“, and the file the sound came
//! from stays as it was. The edits are `sondra-media::editor` (and `edit`, `effects` underneath), the
//! same arithmetic as the web app's editor.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{canvas, div, prelude::*, px, AnyElement, Bounds, Context, MouseButton, PathPromptOptions, Pixels};
use sondra_media::audio::{decode_file, write_wav_f32};
use sondra_media::convert::Settings as ConvertSettings;
use sondra_media::editor::{Editor, Op};
use sondra_media::declick::ClickStrength;
use sondra_media::{Cancel, Ffmpeg};
use sondra_a11y::{accessible, Role};
use sondra_ui::{radius, NoticeKind, Ui};

use crate::clip_player::ClipPlayer;
use crate::shell::Shell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Cut,
    Level,
    Tone,
    Clean,
    Room,
    Pitch,
    Output,
    History,
}

const TOOLS: [(Tool, &str); 8] = [(Tool::Cut, "Schnitt"), (Tool::Level, "Pegel"), (Tool::Tone, "Klang"), (Tool::Clean, "Säubern"), (Tool::Room, "Raum"), (Tool::Pitch, "Tonhöhe und Tempo"), (Tool::Output, "Ausgabe"), (Tool::History, "Verlauf")];

pub struct AudioState {
    pub path: Option<PathBuf>,
    pub editor: Option<Editor>,
    /// The chosen stretch, in seconds, `from < to`.
    pub selection: Option<(f64, f64)>,
    pub tool: Tool,
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    pub said: Option<String>,
    pub player: Option<ClipPlayer>,
    pub made: Vec<PathBuf>,
    /// Where the waveform was drawn last, to turn a press into a place on it.
    pub bounds: Rc<Cell<Bounds<Pixels>>>,
    /// Where a drag began, in seconds.
    anchor: Option<f64>,
    ticking: bool,
}

impl AudioState {
    pub fn new() -> AudioState {
        AudioState { path: None, editor: None, selection: None, tool: Tool::Cut, busy: None, error: None, said: None, player: None, made: Vec::new(), bounds: Rc::new(Cell::new(Bounds::default())), anchor: None, ticking: false }
    }
}

impl Default for AudioState {
    fn default() -> Self {
        Self::new()
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0);
    format!("{}:{:04.1}", (s / 60.0).floor() as u64, s % 60.0).replace('.', ",")
}

fn db(v: f64) -> String {
    format!("{v:.1}").replace('.', ",").replacen('-', "−", 1)
}

impl Shell {
    pub(crate) fn choose_audio_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.audio_open(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Reads a sound file whole and puts it on the waveform.
    pub fn audio_open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        a.player = None;
        a.busy = Some("Liest den Ton …");
        a.error = None;
        let read = path.clone();
        Self::in_background(
            cx,
            move || -> Result<sondra_media::audio::AudioData, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                decode_file(&ff, &read, None).map_err(|e| e.to_string())
            },
            move |shell, answer, cx| {
                let a = &mut shell.audio;
                a.busy = None;
                match answer {
                    Ok(audio) => {
                        a.editor = Some(Editor::new(audio));
                        a.path = Some(path);
                        a.selection = None;
                        a.said = None;
                        a.made.clear();
                    }
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests and for the drop of a file: the sound itself.
    pub fn audio_load(&mut self, audio: sondra_media::audio::AudioData, name: PathBuf, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        a.editor = Some(Editor::new(audio));
        a.path = Some(name);
        a.selection = None;
        a.said = None;
        a.error = None;
        cx.notify();
    }

    fn audio_seconds(&self) -> f64 {
        self.audio.editor.as_ref().map_or(0.0, |e| e.audio().seconds())
    }

    /// Chooses a stretch (or, with `None`, nothing: then everything is meant).
    pub fn audio_select(&mut self, range: Option<(f64, f64)>, cx: &mut Context<Self>) {
        let total = self.audio_seconds();
        self.audio.selection = range.map(|(a, b)| (a.min(b).clamp(0.0, total), a.max(b).clamp(0.0, total))).filter(|(a, b)| b - a >= 0.001);
        cx.notify();
    }

    fn audio_at(&self, x: Pixels) -> f64 {
        let bounds = self.audio.bounds.get();
        let width: f32 = bounds.size.width.into();
        if width <= 0.0 {
            return 0.0;
        }
        let (left, x): (f32, f32) = (bounds.origin.x.into(), x.into());
        ((x - left) / width).clamp(0.0, 1.0) as f64 * self.audio_seconds()
    }

    /// Does one edit away from the window, then puts the take back.
    pub fn audio_do(&mut self, op: Op, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        if a.busy.is_some() {
            return;
        }
        let Some(mut editor) = a.editor.take() else { return };
        a.player = None;
        a.busy = Some("Rechnet …");
        a.error = None;
        let range = a.selection;
        Self::in_background(
            cx,
            move || {
                let said = editor.apply(op, range);
                (editor, said)
            },
            move |shell, (editor, said), cx| {
                let a = &mut shell.audio;
                a.busy = None;
                let total = editor.audio().seconds();
                a.editor = Some(editor);
                match said {
                    Ok(label) => {
                        a.said = Some(label);
                        // What was cut away is no longer there to be chosen; a choice past the end goes too.
                        if matches!(op, Op::Cut | Op::RemoveSilence { .. } | Op::Resample(_)) || a.selection.is_some_and(|(_, to)| to > total + 1e-9) {
                            a.selection = None;
                        }
                    }
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn audio_copy(&mut self, cx: &mut Context<Self>) {
        let range = self.audio.selection;
        if let Some(editor) = &mut self.audio.editor {
            match editor.copy(range) {
                Ok(said) => self.audio.said = Some(said),
                Err(e) => self.audio.error = Some(e),
            }
        }
        cx.notify();
    }

    pub fn audio_learn_noise(&mut self, cx: &mut Context<Self>) {
        let range = self.audio.selection;
        if let Some(editor) = &mut self.audio.editor {
            match editor.learn_noise(range) {
                Ok(said) => {
                    self.audio.said = Some(said);
                    self.audio.error = None;
                }
                Err(e) => self.audio.error = Some(e),
            }
        }
        cx.notify();
    }

    pub fn audio_undo(&mut self, cx: &mut Context<Self>) {
        self.audio.player = None;
        if let Some(editor) = &mut self.audio.editor {
            if let Some(label) = editor.undo() {
                self.audio.said = Some(format!("Rückgängig: {label}"));
            }
        }
        cx.notify();
    }

    pub fn audio_redo(&mut self, cx: &mut Context<Self>) {
        self.audio.player = None;
        if let Some(editor) = &mut self.audio.editor {
            if let Some(label) = editor.redo() {
                self.audio.said = Some(format!("Wiederholt: {label}"));
            }
        }
        cx.notify();
    }

    /// Plays the chosen stretch, or all of it; the same button stops it.
    pub fn audio_play(&mut self, cx: &mut Context<Self>) {
        if self.audio.player.take().is_some() {
            cx.notify();
            return;
        }
        let Some(editor) = &self.audio.editor else { return };
        let (from, to) = self.audio.selection.unwrap_or((0.0, editor.audio().seconds()));
        self.audio.player = Some(ClipPlayer::start(editor.audio(), from, to));
        self.audio_start_ticker(cx);
        cx.notify();
    }

    fn audio_start_ticker(&mut self, cx: &mut Context<Self>) {
        if self.audio.ticking {
            return;
        }
        self.audio.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(80)).await;
            let alive = this.update(cx, |shell, cx| {
                if shell.audio.player.as_ref().is_some_and(ClipPlayer::finished) {
                    shell.audio.player = None;
                }
                let alive = shell.audio.player.is_some();
                if !alive {
                    shell.audio.ticking = false;
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

    /// Writes the take beside the file it came from, as `format_id` says (wav, flac, mp3).
    pub fn audio_save(&mut self, format_id: &'static str, cx: &mut Context<Self>) {
        let (Some(editor), Some(path)) = (&self.audio.editor, self.audio.path.clone()) else { return };
        if self.audio.busy.is_some() {
            return;
        }
        let audio = editor.audio().clone();
        self.audio.busy = Some("Schreibt …");
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let dir = path.parent().map(PathBuf::from).unwrap_or_default();
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Ton".into());
                let temp = dir.join(format!(".sondra-ton-{}.wav", std::process::id()));
                write_wav_f32(&temp, &audio).map_err(|e| e.to_string())?;
                let out = sondra_media::run::convert_file(&ff, &temp, &dir, &format!("{stem} (bearbeitet)"), &ConvertSettings { format_id: format_id.into(), ..ConvertSettings::default() }, &Cancel::new(), &mut |_| {});
                let _ = std::fs::remove_file(&temp);
                out.map(|o| o.path).map_err(|e| e.message)
            },
            |shell, answer, cx| {
                let a = &mut shell.audio;
                a.busy = None;
                match answer {
                    Ok(path) => a.made.push(path),
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests: where the waveform was drawn.
    pub fn audio_bounds(&self) -> Bounds<Pixels> {
        self.audio.bounds.get()
    }

    /// For tests.
    pub fn audio_take(&self) -> Option<&sondra_media::audio::AudioData> {
        self.audio.editor.as_ref().map(Editor::audio)
    }
    pub fn audio_selection(&self) -> Option<(f64, f64)> {
        self.audio.selection
    }
    pub fn audio_made(&self) -> &[PathBuf] {
        &self.audio.made
    }
    pub fn audio_is_playing(&self) -> bool {
        self.audio.player.is_some()
    }

    pub(crate) fn audio_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let a = &self.audio;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Ton bearbeiten"));
        page = page.child(ui.prose("Ziehen Sie über die Welle, um eine Stelle zu wählen; die Werkzeuge gelten für sie, ohne Auswahl für die ganze Datei. Jeder Schritt steht im Verlauf und lässt sich zurücknehmen. Geschrieben wird erst mit „Speichern“, die Ausgangsdatei bleibt, wie sie war."));
        if let Some(error) = &a.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        if let Some(what) = a.busy {
            page = page.child(ui.prose(what));
        }
        let Some(editor) = &a.editor else {
            let pick = {
                let me = me.clone();
                ui.button("ton-waehlen", "Datei wählen").primary().disabled(a.busy.is_some()).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_audio_file(cx)))
            };
            return page.child(div().flex().child(pick)).into_any_element();
        };
        let audio = editor.audio();
        let total = audio.seconds();
        let name = a.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let busy = a.busy.is_some();

        // The file, the transport, the history's two steps.
        let mut bar = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.title(name)).child(ui.value(format!("{} · {} Hz · {}", clock(total), audio.sample_rate, if audio.channels.len() == 1 { "Mono" } else { "Stereo" })));
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-abspielen", if a.player.is_some() { "Anhalten" } else if a.selection.is_some() { "Auswahl anhören" } else { "Anhören" }).primary().on_click(move |_, app| me.update(app, |shell, cx| shell.audio_play(cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-zurueck", "Rückgängig").small().disabled(busy || !editor.can_undo()).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_undo(cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-wieder", "Wiederholen").small().disabled(busy || !editor.can_redo()).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_redo(cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-andere", "Andere Datei").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_audio_file(cx))));
        }
        page = page.child(bar);

        // The waveform.
        let peaks = editor.peaks(480);
        let mut columns = div().relative().flex().items_center().h(px(140.)).w_full().bg(c.stage);
        for (lo, hi) in &peaks {
            let up = (hi * 62.0).max(1.0);
            let down = (-lo * 62.0).max(1.0);
            columns = columns.child(div().flex_1().flex().flex_col().items_center().justify_center().child(div().w_full().h(px(up)).bg(c.stage_ink).mb(px(0.))).child(div().w_full().h(px(down)).bg(c.stage_ink)));
        }
        let measure = a.bounds.clone();
        columns = columns.child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full());
        if let Some((from, to)) = a.selection {
            columns = columns.child(div().absolute().top_0().bottom_0().left(gpui::relative((from / total) as f32)).w(gpui::relative(((to - from) / total) as f32)).bg(c.stage_accent).opacity(0.35));
        }
        if let Some(player) = &a.player {
            columns = columns.child(div().absolute().top_0().bottom_0().left(gpui::relative((player.position() / total).clamp(0.0, 1.0) as f32)).w(px(2.)).bg(c.stage_accent));
        }
        let (down, drag, up) = (me.clone(), me.clone(), me.clone());
        let stage = div()
            .id("welle")
            .cursor_crosshair()
            .on_mouse_down(MouseButton::Left, move |event, _, app| {
                let x = event.position.x;
                down.update(app, |shell, cx| {
                    let at = shell.audio_at(x);
                    shell.audio.anchor = Some(at);
                    shell.audio_select(None, cx);
                })
            })
            .on_mouse_move(move |event, _, app| {
                if event.pressed_button == Some(MouseButton::Left) {
                    let x = event.position.x;
                    drag.update(app, |shell, cx| {
                        if let Some(anchor) = shell.audio.anchor {
                            let at = shell.audio_at(x);
                            shell.audio_select(Some((anchor, at)), cx);
                        }
                    })
                }
            })
            .on_mouse_up(MouseButton::Left, move |_, _, app| up.update(app, |shell, _| shell.audio.anchor = None))
            .child(columns);
        let says = match a.selection {
            Some((from, to)) => format!("Auswahl {} bis {} ({} s)", clock(from), clock(to), db(to - from).replace(" ", "")),
            None => "Keine Auswahl: gilt für die ganze Datei".into(),
        };
        page = page.child(accessible("welle", Role::Group, stage).label("Wellenform").value(says.clone()));
        let mut selection_row = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.hint(says));
        {
            let me = me.clone();
            selection_row = selection_row.child(ui.button("alles-waehlen", "Alles auswählen").small().on_click(move |_, app| me.update(app, |shell, cx| {
                let total = shell.audio_seconds();
                shell.audio_select(Some((0.0, total)), cx)
            })));
        }
        if a.selection.is_some() {
            let me = me.clone();
            selection_row = selection_row.child(ui.button("auswahl-aufheben", "Auswahl aufheben").small().on_click(move |_, app| me.update(app, |shell, cx| shell.audio_select(None, cx))));
        }
        page = page.child(selection_row);
        if let Some(said) = &a.said {
            page = page.child(ui.hint(format!("● {said}")));
        }

        // The tools.
        let mut tabs = div().flex().flex_wrap().gap(px(6.));
        for (tool, label) in TOOLS {
            let me = me.clone();
            tabs = tabs.child(ui.chip(format!("werkzeug-{label}"), label, a.tool == tool).accessible_name(format!("Werkzeug {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.audio.tool = tool;
                cx.notify();
            })));
        }
        page = page.child(tabs);
        let op = |id: String, label: String, op: Op| {
            let me = me.clone();
            ui.button(id, label.clone()).small().accessible_name(label).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_do(op, cx)))
        };
        let group = |title: &str, items: Vec<gpui::AnyElement>| div().flex().flex_col().gap(px(8.)).child(ui.title(title.to_string())).child(div().flex().flex_wrap().gap(px(8.)).children(items));
        let mut panel = div().flex().flex_col().gap(px(16.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        match a.tool {
            Tool::Cut => {
                let me2 = me.clone();
                let copy = ui.button("kopieren", "Kopieren").small().disabled(busy || a.selection.is_none()).on_click(move |_, app| me2.update(app, |shell, cx| shell.audio_copy(cx)));
                panel = panel
                    .child(group("Auswahl", vec![
                        op("ausschneiden".into(), "Ausschneiden".into(), Op::Cut).into_any_element(),
                        copy.into_any_element(),
                        op("einfuegen".into(), "Einfügen".into(), Op::Paste).disabled(busy || !editor.has_clipboard()).into_any_element(),
                        op("verdoppeln".into(), "Verdoppeln".into(), Op::Duplicate).into_any_element(),
                        op("stumm".into(), "Stumm schalten".into(), Op::Mute).into_any_element(),
                    ]))
                    .child(group("Ganze Datei", vec![
                        op("stille-einfuegen-halb".into(), "0,5 s Stille einfügen".into(), Op::InsertSilence(0.5)).into_any_element(),
                        op("stille-einfuegen".into(), "1 s Stille einfügen".into(), Op::InsertSilence(1.0)).into_any_element(),
                        op("stille-entfernen".into(), "Stille entfernen".into(), Op::RemoveSilence { threshold_db: -50.0 }).into_any_element(),
                    ]));
            }
            Tool::Level => {
                panel = panel
                    .child(group("Pegel ändern", [-6.0, -3.0, 3.0, 6.0].iter().map(|g| op(format!("pegel-{g}"), format!("{} dB", db(*g)), Op::Gain(*g)).into_any_element()).collect()))
                    .child(group("Normalisieren auf die lauteste Stelle", [-1.0, -0.3].iter().map(|g| op(format!("normalisieren-{g}"), format!("{} dBFS", db(*g)), Op::NormalizePeak(*g)).into_any_element()).collect()))
                    .child(group("Blenden", vec![op("einblenden".into(), "Einblenden".into(), Op::FadeIn).into_any_element(), op("ausblenden".into(), "Ausblenden".into(), Op::FadeOut).into_any_element()]));
            }
            Tool::Tone => {
                panel = panel
                    .child(group("Tiefen entfernen (Hochpass)", [80.0, 120.0, 200.0].iter().map(|hz| op(format!("hochpass-{hz}"), format!("unter {hz:.0} Hz"), Op::Highpass(*hz)).into_any_element()).collect()))
                    .child(group("Höhen entfernen (Tiefpass)", [4000.0, 8000.0, 12000.0].iter().map(|hz| op(format!("tiefpass-{hz}"), format!("über {:.0} kHz", hz / 1000.0), Op::Lowpass(*hz)).into_any_element()).collect()))
                    .child(group("Bässe und Höhen", vec![
                        op("waermer".into(), "Wärmer (Bässe +3, Höhen −2)".into(), Op::Tone { bass_db: 3.0, treble_db: -2.0 }).into_any_element(),
                        op("heller".into(), "Heller (Bässe −2, Höhen +3)".into(), Op::Tone { bass_db: -2.0, treble_db: 3.0 }).into_any_element(),
                        op("praesenz".into(), "Dünner (Bässe −6)".into(), Op::Tone { bass_db: -6.0, treble_db: 0.0 }).into_any_element(),
                    ]))
                    .child(group("Dynamik", vec![
                        op("kompressor-sanft".into(), "Kompressor sanft (3:1 ab −24 dB)".into(), Op::Compress { threshold_db: -24.0, ratio: 3.0 }).into_any_element(),
                        op("kompressor-stark".into(), "Kompressor stark (6:1 ab −30 dB)".into(), Op::Compress { threshold_db: -30.0, ratio: 6.0 }).into_any_element(),
                    ]));
            }
            Tool::Clean => {
                let me2 = me.clone();
                let learn = ui.button("rauschen-lernen", if editor.has_noise_profile() { "Rauschen neu lernen" } else { "Rauschen lernen" }).small().disabled(busy || a.selection.is_none()).on_click(move |_, app| me2.update(app, |shell, cx| shell.audio_learn_noise(cx)));
                panel = panel
                    .child(ui.prose("Wählen Sie eine Stelle, an der nur das Rauschen zu hören ist (mindestens eine Fünftelsekunde), und lassen Sie es lernen. Danach lässt es sich abziehen — in der Auswahl oder überall."))
                    .child(group("Rauschen", vec![learn.into_any_element()]))
                    .child(group("Rauschen entfernen, bis zu", [6.0, 12.0, 18.0].iter().map(|d| op(format!("rauschen-{d}"), format!("{} dB", db(*d).replace('−', "")), Op::RemoveNoise { max_cut_db: *d }).disabled(busy || !editor.has_noise_profile()).into_any_element()).collect()))
                    .child(ui.prose("Klicks und Knackser: alte Platten, Kabelknacken, Schmatzen am Mikrofon. Schläge und Konsonanten bleiben. Gesucht wird in der ganzen Datei."))
                    .child(group("Klicks entfernen", [("sanft", "Sanft", ClickStrength::Soft), ("mittel", "Mittel", ClickStrength::Medium), ("stark", "Stark", ClickStrength::Strong)].iter().map(|(id, label, strength)| op(format!("klicks-{id}"), label.to_string(), Op::RemoveClicks(*strength)).into_any_element()).collect()))
                    .child(group("Sonst", vec![op("gleichspannung".into(), "Gleichspannung entfernen".into(), Op::RemoveDc).into_any_element()]));
            }
            Tool::Room => {
                panel = panel
                    .child(ui.prose("Echo und Hall klingen über das Ende der Stelle hinaus nach."))
                    .child(group("Echo", vec![
                        op("echo-kurz".into(), "Kurz (150 ms)".into(), Op::Echo { delay_ms: 150.0, feedback: 0.4, mix: 0.4 }).into_any_element(),
                        op("echo-lang".into(), "Lang (350 ms)".into(), Op::Echo { delay_ms: 350.0, feedback: 0.5, mix: 0.5 }).into_any_element(),
                    ]))
                    .child(group("Hall", [0.8, 1.5, 3.0].iter().map(|s| op(format!("hall-{s}"), format!("{} s", format!("{s}").replace('.', ",")), Op::Reverb { seconds: *s, mix: 0.5 }).into_any_element()).collect()));
            }
            Tool::Pitch => {
                panel = panel
                    .child(ui.prose("Gilt für die Auswahl, ohne Auswahl für die ganze Datei. Die Länge bleibt bei der Tonhöhe, die Tonhöhe beim Tempo — gerechnet wird mit dem Phasenvocoder, wie auf der Website."))
                    .child(group("Tonhöhe", [-12.0, -7.0, -5.0, -2.0, -1.0, 1.0, 2.0, 5.0, 7.0, 12.0].iter().map(|n: &f64| {
                        let label = format!("{}{} Halbtöne", if *n > 0.0 { "+" } else { "−" }, n.abs());
                        op(format!("tonhoehe-{n}"), label, Op::Pitch(*n)).into_any_element()
                    }).collect()))
                    .child(group("Tempo", [0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2.0].iter().map(|t: &f64| op(format!("tempo-{t}"), format!("{}×", format!("{t}").replace('.', ",")), Op::Tempo(*t)).into_any_element()).collect()));
            }
            Tool::Output => {
                let save = |format_id: &'static str, label: &str| {
                    let me = me.clone();
                    ui.button(format!("speichern-{format_id}"), label.to_string()).small().primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_save(format_id, cx)))
                };
                panel = panel
                    .child(group("Kanäle", vec![
                        op("mono".into(), "Zu Mono mischen".into(), Op::ToMono).into_any_element(),
                        op("stereo".into(), "Zu Stereo verdoppeln".into(), Op::ToStereo).into_any_element(),
                        op("tauschen".into(), "Links und rechts tauschen".into(), Op::Swap).into_any_element(),
                    ]))
                    .child(group("Abtastrate", [22050u32, 44100, 48000].iter().map(|r| op(format!("rate-{r}"), format!("{r} Hz"), Op::Resample(*r)).into_any_element()).collect()))
                    .child(group("Speichern", vec![save("wav", "Als WAV speichern").into_any_element(), save("flac", "Als FLAC speichern").into_any_element(), save("mp3", "Als MP3 speichern").into_any_element()]));
                for path in &a.made {
                    panel = panel.child(ui.value(path.display().to_string()));
                }
            }
            Tool::History => {
                let history = editor.history();
                if history.is_empty() {
                    panel = panel.child(ui.prose("Noch nichts geändert."));
                }
                for (i, entry) in history.iter().enumerate() {
                    panel = panel.child(ui.prose(format!("{}. {}", i + 1, entry.label)));
                }
            }
        }
        page.child(panel).into_any_element()
    }
}
