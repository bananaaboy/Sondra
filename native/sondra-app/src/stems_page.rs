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
    /// „Feinjustierung“: the options changed by hand (then no template is chosen), and whether it is open.
    pub custom: Option<SeparationOptions>,
    pub fine: bool,
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
    /// The ZIP of the written tracks: where it lies and how big, or why not.
    pub zip: Option<Result<(PathBuf, u64), String>>,
    pub packing: bool,
    ticking: bool,
    /// A model the person brought (`.onnx`): used instead of the spectral masks, and what the page knows of it.
    pub model: Option<PathBuf>,
    pub model_info: Option<String>,
    pub model_checking: bool,
    pub model_error: Option<String>,
    /// The last separation was done by the model.
    pub by_model: bool,
}

impl StemsState {
    pub fn new() -> StemsState {
        StemsState { path: None, custom: None, fine: false, preset: 0, original: None, work: None, stems: Vec::new(), playing: None, reading: false, error: None, made: Vec::new(), writing: false, zip: None, packing: false, ticking: false, model: None, model_info: None, model_checking: false, model_error: None, by_model: false }
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
            self.stems.custom = None;
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
        let options = s.custom.unwrap_or(PRESETS[s.preset].options);
        let model = s.model.clone();
        s.by_model = model.is_some();
        let work = Arc::new(Mutex::new(Work { note: if model.is_some() { "Modell wird geöffnet" } else { "Analyse" }.into(), ..Default::default() }));
        s.work = Some(work.clone());
        std::thread::spawn(move || {
            let progress = |work: &Arc<Mutex<Work>>, share: f64, note: &str| {
                let mut w = work.lock().unwrap();
                w.share = share;
                if !note.is_empty() {
                    w.note = note.to_owned();
                }
            };
            let separated = match &model {
                // The person's model, run on this computer.
                Some(path) => sondra_onnx::Model::open(path).and_then(|mut m| m.separate(&audio, &mut |share, note| progress(&work, share, note))).map(|stems| stems.to_vec()),
                None => Ok(separate(&audio, &options, &mut |share, note| progress(&work, share, note)).to_vec()),
            };
            work.lock().unwrap().done = Some(separated.map(|mut out| {
                let instrumental = to_instrumental(&audio, &out[0]);
                out.push(instrumental);
                out
            }));
        });
        self.stems_ticker(cx);
        cx.notify();
    }

    /// The file dialog for a model.
    pub fn stems_choose_model(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = answer.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |shell, cx| shell.stems_set_model(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Takes a model: it is opened once, away from the window, to see what it is (and that it is one); it is kept in
    /// mind, not in memory — it is opened again when the separation begins.
    pub fn stems_set_model(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let s = &mut self.stems;
        s.model_checking = true;
        s.model_error = None;
        let shown = path.clone();
        Self::in_background(
            cx,
            move || sondra_onnx::Model::open(&shown).map(|m| m.info.describe()),
            move |shell, result, cx| {
                shell.stems.model_checking = false;
                match result {
                    Ok(info) => {
                        shell.stems.model = Some(path.clone());
                        shell.stems.model_info = Some(info);
                        shell.stems_keep_model();
                    }
                    Err(e) => shell.stems.model_error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Back to the spectral masks Sondra brings.
    pub fn stems_drop_model(&mut self, cx: &mut Context<Self>) {
        self.stems.model = None;
        self.stems.model_info = None;
        self.stems.model_error = None;
        self.stems_keep_model();
        cx.notify();
    }

    /// The model the person chose stays chosen at the next start (the path only; the file stays where it is).
    fn stems_keep_model(&self) {
        if let Some(mut store) = crate::store::FileStore::at_default("Spuren.json") {
            use sondra_merk::folder_memory::Store;
            store.set_item("modell", self.stems.model.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
        }
    }

    /// Takes up the model of the last time, if the file is still there.
    pub fn open_stems_memory(&mut self, store: crate::store::FileStore) {
        use sondra_merk::folder_memory::Store;
        if let Some(path) = store.get_item("modell").filter(|p| !p.is_empty()).map(PathBuf::from).filter(|p| p.is_file()) {
            self.stems.model = Some(path);
        }
    }

    /// For tests: the model that is chosen and what is known of it.
    pub fn stems_model(&self) -> (Option<PathBuf>, Option<String>, Option<String>) {
        (self.stems.model.clone(), self.stems.model_info.clone(), self.stems.model_error.clone())
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
                    Ok(p) => {
                        shell.stems.made = p;
                        shell.stems.zip = None;
                    }
                    Err(e) => shell.stems.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The written tracks in one ZIP beside them.
    pub fn stems_pack(&mut self, cx: &mut Context<Self>) {
        let files: Vec<(String, PathBuf)> = self.stems.made.iter().map(|p| (p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), p.clone())).collect();
        let Some(dir) = self.stems.made.first().and_then(|p| p.parent().map(PathBuf::from)) else { return };
        let suggestion = self.stems.path.as_ref().and_then(|p| p.file_stem()).map(|s| format!("{} (Spuren)", s.to_string_lossy())).unwrap_or_else(|| "Spuren".into());
        self.stems.packing = true;
        self.stems.zip = None;
        cx.notify();
        Self::pack_in_background(cx, files, dir, suggestion, |shell, result, cx| {
            shell.stems.packing = false;
            shell.stems.zip = Some(result);
            cx.notify();
        });
    }

    /// For tests: where the ZIP lies, once it is written.
    pub fn stems_zip(&self) -> Option<Result<(PathBuf, u64), String>> {
        self.stems.zip.clone()
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
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Spuren trennen", "Gesang, Schlagzeug, Bass und der Rest: ein Lied wird in seine Spuren zerlegt, ohne Netz und ohne Modell: Rechnen am Spektrum trennt, was gleichmässig klingt, von dem, was anschlägt, und die Mitte des Bildes vom Rand. Ergebnis sind vier Spuren und das Lied ohne Gesang."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let running = s.work.is_some();
        let pick = {
            let me = me.clone();
            ui.button("spuren-waehlen", if s.path.is_some() { "Anderes Lied" } else { "Lied wählen" }).primary_when(s.path.is_none()).disabled(running || s.reading).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_stems_file(cx)))
        };
        let mut file = div().flex().flex_wrap().items_center().gap(px(12.)).child(pick);
        if s.reading {
            file = file.child(ui.prose("Liest den Ton …"));
        }
        if let Some(path) = &s.path {
            file = file.child(ui.value(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        let mut work = div().flex().flex_col().gap(px(20.)).child(file);
        let mut presets = div().flex().flex_wrap().gap(px(6.));
        for (i, p) in PRESETS.iter().enumerate() {
            let me = me.clone();
            presets = presets.child(ui.chip(format!("spuren-{}", p.label), p.label, s.preset == i && s.custom.is_none()).accessible_name(format!("Worauf es ankommt: {}", p.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.stems_preset(i, cx))));
        }
        let mut settings = vec![ui.setting("Worauf es ankommt", presets, Some(if s.custom.is_some() { "Eigene Einstellung — siehe Feinjustierung." } else { PRESETS[s.preset].desc }))];
        // „Feinjustierung“: the four values the website lets one set by hand.
        {
            let now = s.custom.unwrap_or(PRESETS[s.preset].options);
            let me2 = me.clone();
            let fine = s.fine;
            let mut box_ = div().flex().flex_col().gap(px(10.)).child(div().flex().child(ui.button("feinjustierung", if fine { "Feinjustierung schliessen" } else { "Feinjustierung" }).small().ghost().on_click(move |_, app| me2.update(app, |shell, cx| {
                shell.stems.fine = !fine;
                cx.notify();
            }))));
            if fine {
                let set = |id: String, label: String, on: bool, change: Box<dyn Fn(&mut SeparationOptions)>| {
                    let me = me.clone();
                    ui.chip(id, label, on).on_click(move |_, app| me.update(app, |shell, cx| {
                        if shell.stems.work.is_none() {
                            let mut o = shell.stems.custom.unwrap_or(PRESETS[shell.stems.preset].options);
                            change(&mut o);
                            shell.stems.custom = Some(o);
                        }
                        cx.notify();
                    }))
                };
                let row = |title: &str, chips: Vec<gpui::AnyElement>| div().flex().flex_col().gap(px(6.)).child(ui.hint(title.to_string())).child(div().flex().flex_wrap().gap(px(6.)).children(chips));
                box_ = box_
                    .child(row("Mittenschärfe", [0.5f64, 0.65, 0.75, 0.85, 0.95].iter().map(|v| { let v = *v; set(format!("mitte-{v}"), format!("{v:.2}").replace('.', ","), (now.vocal_focus - v).abs() < 1e-9, Box::new(move |o| o.vocal_focus = v)).into_any_element() }).collect()))
                    .child(row("Maskenhärte", [1.5f64, 2.0, 2.8, 3.5, 4.5].iter().map(|v| { let v = *v; set(format!("maske-{v}"), format!("{v:.1}").replace('.', ","), (now.mask_exponent - v).abs() < 1e-9, Box::new(move |o| o.mask_exponent = v)).into_any_element() }).collect()))
                    .child(row("Auflösung (FFT)", [(2048usize, "2048 — Beat / Drums"), (4096, "4096 — Musik"), (8192, "8192 — Orchester / Solo")].iter().map(|(n, l)| { let n = *n; set(format!("fft-{n}"), l.to_string(), now.fft_size == n, Box::new(move |o| { o.fft_size = n; o.hop_size = n / 4; })).into_any_element() }).collect()))
                    .child(row("Filterfenster", [(9usize, "9 — schnell & knackig"), (17, "17 — Standard"), (31, "31 — gründlich")].iter().map(|(n, l)| { let n = *n; set(format!("filter-{n}"), l.to_string(), now.time_kernel == n, Box::new(move |o| { o.time_kernel = n; o.freq_kernel = n; })).into_any_element() }).collect()));
            }
            settings.push(ui.setting("Feinjustierung", box_, Some("Grösser trennt Töne feiner, kleiner schont Anschläge.")));
        }

        // A model of the person's own.
        {
            let (choose, drop) = (me.clone(), me.clone());
            let mut block = div().flex().flex_col().gap(px(8.)).child(ui.title("Eigenes Modell (.onnx)")).child(ui.setting_note("Ein Demucs- oder Spleeter-Export, den Sie selbst mitbringen: Sondra liefert keine Modelle mit. Es läuft auf diesem Gerät und ersetzt die Trennung mit Masken."));
            let mut row = div().flex().flex_wrap().items_center().gap(px(10.));
            if let Some(path) = &s.model {
                row = row.child(ui.value(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
                if let Some(info) = &s.model_info {
                    row = row.child(ui.hint(info.clone()));
                }
                row = row.child(ui.button("modell-anderes", "Anderes Modell wählen").small().disabled(s.model_checking || s.work.is_some()).on_click(move |_, app| choose.update(app, |shell, cx| shell.stems_choose_model(cx))));
                row = row.child(ui.button("modell-weg", "Ohne Modell trennen").small().ghost().disabled(s.work.is_some()).on_click(move |_, app| drop.update(app, |shell, cx| shell.stems_drop_model(cx))));
            } else {
                row = row.child(ui.button("modell-waehlen", if s.model_checking { "Prüft das Modell …" } else { "Modell wählen …" }).small().disabled(s.model_checking).on_click(move |_, app| choose.update(app, |shell, cx| shell.stems_choose_model(cx))));
            }
            block = block.child(row);
            if let Some(error) = &s.model_error {
                block = block.child(ui.notice(NoticeKind::Warning, error.clone()));
            }
            settings.push(block.into_any_element());
        }
        let Some(original) = &s.original else {
            if s.path.is_none() && !s.reading {
                work = work.child(ui.empty("spuren-leer", "Noch kein Lied gewählt", "Gesang, Schlagzeug, Bass und der Rest kommen als eigene Spuren heraus. Was links eingestellt ist, gilt für das nächste Lied.", vec![]));
            }
            return page.child(ui.tool_body(settings, work)).into_any_element();
        };
        if original.channels.len() == 1 {
            work = work.child(ui.notice(NoticeKind::Info, "Mono-Material: Ohne Stereobild lässt sich die Stimme nur an Frequenz und Rhythmus erkennen, die Trennung wird gröber."));
        }

        if let Some(job) = &s.work {
            let w = job.lock().unwrap();
            work = work.child(div().flex().flex_col().gap(px(8.)).child(ui.prose(if s.by_model { "Wird mit Ihrem Modell getrennt …" } else { "Wird getrennt …" })).child(ui.bar("spuren-fortschritt", Some(w.share as f32), w.note.clone())));
        } else {
            let me2 = me.clone();
            work = work.child(div().flex().child(ui.button("spuren-trennen", if s.stems.is_empty() { "Spuren trennen" } else { "Neu trennen" }).primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.stems_start(cx)))));
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
                out = out.child(self.written_row(&ui, path, cx));
            }
            if !s.made.is_empty() {
                let me4 = me.clone();
                out = out.child(div().flex().child(ui.button("spuren-zip", "Als ZIP speichern").small().disabled(s.packing).on_click(move |_, app| me4.update(app, |shell, cx| shell.stems_pack(cx)))));
                match &s.zip {
                    Some(Ok((path, bytes))) => out = out.child(ui.prose(format!("ZIP gespeichert: {} · {}", path.display(), sondra_merk::format::format_bytes(*bytes as f64, 1)))),
                    Some(Err(e)) => out = out.child(ui.notice(NoticeKind::Warning, e.clone())),
                    None if s.packing => out = out.child(ui.prose("Das ZIP wird geschrieben …")),
                    None => {}
                }
            }
            work = work.child(out);
        }
        page.child(ui.tool_body(settings, work)).into_any_element()
    }
}
