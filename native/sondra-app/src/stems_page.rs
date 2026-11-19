//! The Spuren-trennen page: a song split into voice, drums, bass and the rest, by the model-free method of
//! `sondra-media::separation` (the web app's, number for number). Each stem can be heard alone, the karaoke
//! version (the song without the voice) comes with them, and all of it is written as WAV files in a folder
//! beside the song. Three settings stand for what the work is for.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gpui::{div, prelude::*, px, AnyElement, Context, PathPromptOptions};
use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::separation::{separate, stem_label, to_instrumental, SeparationOptions, DEFAULT_SEPARATION, STEM_IDS};
use sondra_media::Ffmpeg;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::clip_player::ClipPlayer;
use crate::shell::Shell;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub desc: &'static str,
    pub options: SeparationOptions,
}

pub const PRESETS: [Preset; 3] = [
    Preset { id: "balanced", label: "Ausgewogen", desc: "Gesang, Beat und Begleitung gleich gewichtet — der Ausgangspunkt.", options: DEFAULT_SEPARATION },
    Preset { id: "vocals", label: "Gesang", desc: "Schärfere Mitte, härtere Masken: weniger Begleitung im Gesang — und ein saubereres Instrumental für Karaoke.", options: SeparationOptions { vocal_focus: 0.85, mask_exponent: 3.5, ..DEFAULT_SEPARATION } },
    Preset { id: "rhythm", label: "Rhythmus", desc: "Kürzere Fenster, die Anschläge von Schlagzeug und Perkussion sauber halten.", options: SeparationOptions { vocal_focus: 0.5, mask_exponent: 3.0, fft_size: 2048, hop_size: 512, time_kernel: 9, freq_kernel: 9, ..DEFAULT_SEPARATION } },
];

#[derive(Default)]
struct Work {
    share: f64,
    note: String,
    done: Option<Result<Vec<AudioData>, String>>,
}

pub struct StemsState {
    pub path: Option<PathBuf>,
    pub preset: usize,
    pub original: Option<Arc<AudioData>>,
    work: Option<Arc<Mutex<Work>>>,
    /// Voice, drums, bass, the rest, and the song without the voice.
    pub stems: Vec<Arc<AudioData>>,
    pub playing: Option<(usize, ClipPlayer)>,
    pub reading: bool,
    pub error: Option<String>,
    pub made: Vec<PathBuf>,
    pub writing: bool,
    ticking: bool,
}

impl StemsState {
    pub fn new() -> StemsState {
        StemsState { path: None, preset: 0, original: None, work: None, stems: Vec::new(), playing: None, reading: false, error: None, made: Vec::new(), writing: false, ticking: false }
    }
}

impl Default for StemsState {
    fn default() -> Self {
        Self::new()
    }
}

const NAMES: [&str; 5] = ["Gesang", "Schlagzeug", "Bass", "Übriges", "Instrumental"];

impl Shell {
    pub(crate) fn choose_stems_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.stems_open(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    pub fn stems_open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let s = &mut self.stems;
        s.playing = None;
        s.reading = true;
        s.error = None;
        s.stems.clear();
        s.made.clear();
        let read = path.clone();
        Self::in_background(
            cx,
            move || -> Result<AudioData, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                decode_file(&ff, &read, None).map_err(|e| e.to_string())
            },
            move |shell, answer, cx| {
                shell.stems.reading = false;
                match answer {
                    Ok(audio) => {
                        shell.stems.path = Some(path);
                        shell.stems.original = Some(Arc::new(audio));
                    }
                    Err(e) => shell.stems.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests and for a drop: the song itself.
    pub fn stems_load(&mut self, audio: AudioData, name: PathBuf, cx: &mut Context<Self>) {
        self.stems.path = Some(name);
        self.stems.original = Some(Arc::new(audio));
        self.stems.stems.clear();
        cx.notify();
    }

    pub fn stems_preset(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.stems.work.is_none() && index < PRESETS.len() {
            self.stems.preset = index;
            cx.notify();
        }
    }

    pub fn stems_start(&mut self, cx: &mut Context<Self>) {
        let s = &mut self.stems;
        let Some(audio) = s.original.clone() else { return };
        if s.work.is_some() {
            return;
        }
        s.playing = None;
        s.stems.clear();
        s.made.clear();
        s.error = None;
        let options = PRESETS[s.preset].options;
        let work = Arc::new(Mutex::new(Work { note: "Analyse".into(), ..Default::default() }));
        s.work = Some(work.clone());
        std::thread::spawn(move || {
            let mut out = separate(&audio, &options, &mut |share, note| {
                let mut w = work.lock().unwrap();
                w.share = share;
                w.note = note.to_owned();
            })
            .to_vec();
            let instrumental = to_instrumental(&audio, &out[0]);
            out.push(instrumental);
            work.lock().unwrap().done = Some(Ok(out));
        });
        self.stems_ticker(cx);
        cx.notify();
    }

    fn stems_ticker(&mut self, cx: &mut Context<Self>) {
        if self.stems.ticking {
            return;
        }
        self.stems.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(150)).await;
            let alive = this.update(cx, |shell, cx| {
                let s = &mut shell.stems;
                if let Some(work) = s.work.clone() {
                    let finished = work.lock().unwrap().done.take();
                    match finished {
                        Some(Ok(stems)) => {
                            s.stems = stems.into_iter().map(Arc::new).collect();
                            s.work = None;
                        }
                        Some(Err(e)) => {
                            s.error = Some(e);
                            s.work = None;
                        }
                        None => {}
                    }
                }
                if s.playing.as_ref().is_some_and(|(_, p)| p.finished()) {
                    s.playing = None;
                }
                let alive = s.work.is_some() || s.playing.is_some();
                if !alive {
                    s.ticking = false;
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

    /// Plays one stem; the same button stops it, another one switches to that stem.
    pub fn stems_hear(&mut self, index: usize, cx: &mut Context<Self>) {
        let s = &mut self.stems;
        if let Some((current, _)) = s.playing.take() {
            if current == index {
                cx.notify();
                return;
            }
        }
        let Some(audio) = s.stems.get(index).cloned() else { return };
        s.playing = Some((index, ClipPlayer::start(&audio, 0.0, audio.seconds())));
        self.stems_ticker(cx);
        cx.notify();
    }

    /// All of them, as WAV files in a folder beside the song.
    pub fn stems_save(&mut self, cx: &mut Context<Self>) {
        let (Some(path), false) = (self.stems.path.clone(), self.stems.stems.is_empty()) else { return };
        let stems = self.stems.stems.clone();
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Lied".into());
        let dir = path.parent().map(PathBuf::from).unwrap_or_default().join(format!("{stem} (Spuren)"));
        self.stems.writing = true;
        Self::in_background(
            cx,
            move || -> Result<Vec<PathBuf>, String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let mut made = Vec::new();
                for (audio, name) in stems.iter().zip(NAMES) {
                    let target = dir.join(format!("{stem} – {name}.wav"));
                    write_wav_f32(&target, audio).map_err(|e| e.to_string())?;
                    made.push(target);
                }
                Ok(made)
            },
            |shell, answer, cx| {
                shell.stems.writing = false;
                match answer {
                    Ok(p) => shell.stems.made = p,
                    Err(e) => shell.stems.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests.
    pub fn stems_count(&self) -> usize {
        self.stems.stems.len()
    }
    pub fn stems_made(&self) -> &[PathBuf] {
        &self.stems.made
    }
    pub fn stems_playing(&self) -> Option<usize> {
        self.stems.playing.as_ref().map(|(i, _)| *i)
    }
    pub fn stems_running(&self) -> bool {
        self.stems.work.is_some()
    }
    pub fn stems_audio(&self, index: usize) -> Option<Arc<AudioData>> {
        self.stems.stems.get(index).cloned()
    }

    pub(crate) fn stems_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.stems;
        let mut page = div().flex().flex_col().gap(px(20.)).max_w(px(860.)).child(ui.heading("Gesang, Schlagzeug, Bass und Rest"));
        page = page.child(ui.prose("Ein Lied wird in seine Spuren zerlegt, ohne Netz und ohne Modell: Rechnen am Spektrum trennt, was gleichmässig klingt, von dem, was anschlägt, und die Mitte des Bildes vom Rand. Ergebnis sind vier Spuren und das Lied ohne Gesang."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let running = s.work.is_some();
        let pick = {
            let me = me.clone();
            ui.button("spuren-waehlen", if s.path.is_some() { "Anderes Lied" } else { "Lied wählen" }).primary().disabled(running || s.reading).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_stems_file(cx)))
        };
        let mut file = div().flex().flex_wrap().items_center().gap(px(12.)).child(pick);
        if s.reading {
            file = file.child(ui.prose("Liest den Ton …"));
        }
        if let Some(path) = &s.path {
            file = file.child(ui.value(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        page = page.child(file);
        let Some(original) = &s.original else { return page.into_any_element() };
        if original.channels.len() == 1 {
            page = page.child(ui.notice(NoticeKind::Info, "Mono-Material: Ohne Stereobild lässt sich die Stimme nur an Frequenz und Rhythmus erkennen, die Trennung wird gröber."));
        }
        let mut presets = div().flex().flex_wrap().gap(px(6.));
        for (i, p) in PRESETS.iter().enumerate() {
            let me = me.clone();
            presets = presets.child(ui.chip(format!("spuren-{}", p.label), p.label, s.preset == i).accessible_name(format!("Worauf es ankommt: {}", p.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.stems_preset(i, cx))));
        }
        page = page.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Worauf es ankommt")).child(presets).child(ui.hint(PRESETS[s.preset].desc)));

        if let Some(work) = &s.work {
            let w = work.lock().unwrap();
            page = page.child(div().flex().flex_col().gap(px(8.)).child(ui.prose("Wird getrennt …")).child(ui.bar("spuren-fortschritt", Some(w.share as f32), w.note.clone())));
        } else {
            let me2 = me.clone();
            page = page.child(div().flex().child(ui.button("spuren-trennen", if s.stems.is_empty() { "Spuren trennen" } else { "Neu trennen" }).primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.stems_start(cx)))));
        }

        if !s.stems.is_empty() {
            let mut list = div().flex().flex_col();
            for (i, name) in NAMES.iter().enumerate() {
                let playing = s.playing.as_ref().is_some_and(|(p, _)| *p == i);
                let me = me.clone();
                list = list.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .py(px(10.))
                        .border_t_1()
                        .border_color(c.line)
                        .child(div().flex().flex_col().child(ui.title(*name)).child(ui.hint(if i == 4 { "Das Lied ohne den Gesang — für Karaoke" } else { stem_label(STEM_IDS[i]) })))
                        .child(ui.button(format!("spur-hoeren-{i}"), if playing { "Anhalten" } else { "Anhören" }).small().accessible_name(format!("{name} {}", if playing { "anhalten" } else { "anhören" })).on_click(move |_, app| me.update(app, |shell, cx| shell.stems_hear(i, cx)))),
                );
            }
            let mut out = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.subheading("Die Spuren")).child(list);
            let me3 = me.clone();
            out = out.child(div().flex().child(ui.button("spuren-speichern", "Alle als WAV speichern").disabled(s.writing).on_click(move |_, app| me3.update(app, |shell, cx| shell.stems_save(cx)))));
            for path in &s.made {
                out = out.child(ui.value(path.display().to_string()));
            }
            page = page.child(out);
        }
        page.into_any_element()
    }
}
