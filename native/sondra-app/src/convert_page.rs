//! The Umwandeln page: files in, a format (or a template) chosen, one click. What is run is
//! `sondra-media`'s `convert_file` — the argument lists are the website's, held to its answers — with the
//! real FFmpeg, one file after the other, each with its bar and a way to stop. A failure is said in a
//! sentence, FFmpeg's own words one step behind it; an existing file is never replaced.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_media::convert::{find_format, Kind, Settings, FORMATS};
use sondra_media::presets::{built_in, preset_for};
use sondra_media::{Cancel, Ffmpeg, Progress};
use sondra_ui::{family, size, NoticeKind, Ui};

use crate::lines::Line;
use crate::nav::Panel;
use crate::shell::Shell;

pub struct Made {
    pub from: String,
    pub result: Result<(PathBuf, u64), String>,
}

pub struct Run {
    pub index: usize,
    pub of: usize,
    pub name: String,
    pub progress: Arc<Mutex<Progress>>,
    pub cancel: Cancel,
}

pub struct ConvertState {
    pub files: Vec<PathBuf>,
    pub settings: Settings,
    /// A template chosen (its id), over the settings.
    pub preset: Option<&'static str>,
    pub folder: Option<PathBuf>,
    pub run: Option<Run>,
    pub made: Vec<Made>,
    pub error: Option<String>,
}

impl ConvertState {
    pub fn new() -> ConvertState {
        ConvertState { files: Vec::new(), settings: Settings::default(), preset: None, folder: None, run: None, made: Vec::new(), error: None }
    }

    /// What kind of file the first of them is, for what a template sets.
    fn source_kind(&self) -> Kind {
        let first = self.files.first().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match sondra_player::player_kind(&first, "") {
            Some(sondra_player::Kind::Audio) => Kind::Audio,
            Some(sondra_player::Kind::Video) => Kind::Video,
            None => Kind::Image,
        }
    }

    fn choose_format(&mut self, id: &str) {
        self.settings.format_id = id.to_string();
        self.preset = None;
    }

    fn choose_preset(&mut self, id: &'static str) {
        let source = self.source_kind();
        self.preset = Some(id);
        if let Some(preset) = built_in().into_iter().find(|p| p.id == id) {
            if let Some(partial) = preset_for(&preset, source) {
                self.settings = Settings::default();
                partial.apply(&mut self.settings);
            }
        }
    }
}

impl Default for ConvertState {
    fn default() -> Self {
        Self::new()
    }
}

fn size_text(n: u64) -> String {
    sondra_merk::format::format_bytes(n as f64, 1)
}

impl Shell {
    fn convert_do(me: &Entity<Shell>, app: &mut gpui::App, change: impl FnOnce(&mut ConvertState)) {
        me.update(app, |shell, cx| {
            change(&mut shell.convert);
            cx.notify();
        });
    }

    pub(crate) fn choose_convert_files(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.convert_take(paths, cx)).ok();
            }
        })
        .detach();
    }

    /// Takes files to convert (what was chosen, dropped or handed to the program).
    pub fn convert_take(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        self.convert.files = paths.into_iter().filter(|p| p.is_file()).collect();
        self.convert.error = None;
        cx.notify();
    }

    /// For tests: where the results go.
    pub fn convert_into(&mut self, folder: PathBuf) {
        self.convert.folder = Some(folder);
    }

    pub fn convert_choose_format(&mut self, id: &str, cx: &mut Context<Self>) {
        self.convert.choose_format(id);
        cx.notify();
    }

    /// Converts the files one after the other, each away from the window.
    pub(crate) fn start_convert(&mut self, cx: &mut Context<Self>) {
        let c = &mut self.convert;
        if c.run.is_some() || c.files.is_empty() {
            return;
        }
        let Some(ffmpeg) = Ffmpeg::locate() else {
            c.error = Some("FFmpeg ist nicht da. Ohne FFmpeg kann Sondra nichts umwandeln.".into());
            cx.notify();
            return;
        };
        c.made.clear();
        c.error = None;
        let (files, settings, folder) = (c.files.clone(), c.settings.clone(), c.folder.clone());
        let progress = Arc::new(Mutex::new(Progress::default()));
        let cancel = Cancel::new();
        c.run = Some(Run { index: 0, of: files.len(), name: String::new(), progress: progress.clone(), cancel: cancel.clone() });
        let current = Arc::new(Mutex::new((0usize, String::new())));
        let watch = current.clone();
        let task = cx.background_spawn(async move {
            let mut made = Vec::new();
            for (n, file) in files.iter().enumerate() {
                let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                *watch.lock().expect("lock") = (n, name.clone());
                *progress.lock().expect("lock") = Progress::default();
                let dir = folder.clone().or_else(|| file.parent().map(PathBuf::from)).unwrap_or_default();
                let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Datei".into());
                let result = sondra_media::run::convert_file(&ffmpeg, file, &dir, &stem, &settings, &cancel, &mut |p| *progress.lock().expect("lock") = p)
                    .map(|o| (o.path, o.size))
                    .map_err(|e| if e.cancelled { "Abgebrochen.".to_string() } else { e.message });
                let stop = cancel.is_cancelled();
                made.push(Made { from: name, result });
                if stop {
                    break;
                }
            }
            made
        });
        // Which file is being done, as the window draws.
        self.convert_watch = Some(current);
        cx.spawn(async move |this, cx| {
            let made = task.await;
            this.update(cx, |shell, cx| {
                shell.convert.run = None;
                shell.convert_watch = None;
                shell.convert.made = made;
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// The page.
    pub(crate) fn convert_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.convert;
        let busy = s.run.is_some();
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Umwandeln"));
        page = page.child(ui.prose("Dateien in ein anderes Format bringen — Ton, Video, Bild. Gerechnet wird auf Ihrem Gerät; keine Datei wird hochgeladen."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        // The files.
        let choose = {
            let me = me.clone();
            ui.button("umwandeln-dateien", if s.files.is_empty() { "Dateien wählen" } else { "Andere Dateien wählen" }).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_convert_files(cx)))
        };
        let mut head = div().flex().flex_wrap().items_center().gap(px(12.)).child(choose);
        if !s.files.is_empty() {
            let names: Vec<String> = s.files.iter().map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
            let shown = names.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            head = head.child(ui.value(if names.len() > 3 { format!("{shown} und {} weitere", names.len() - 3) } else { shown }));
        }
        page = page.child(head);
        if s.files.is_empty() {
            return page.into_any_element();
        }

        // Templates, then formats.
        let mut presets = div().flex().flex_wrap().gap(px(6.));
        for preset in built_in() {
            let me = me.clone();
            let id = preset.id;
            presets = presets.child(ui.chip(format!("vorlage-{id}"), preset.label, s.preset == Some(id)).accessible_name(format!("Vorlage {}: {}", preset.label, preset.hint)).on_click(move |_, app| Self::convert_do(&me, app, move |s| s.choose_preset(id))));
        }
        let mut formats = div().flex().flex_wrap().gap(px(6.));
        for format in FORMATS.iter() {
            let me = me.clone();
            let id = format.id;
            formats = formats.child(ui.chip(format!("format-{id}"), format.label, s.settings.format_id == id).accessible_name(format!("Format {}: {}", format.label, format.hint)).on_click(move |_, app| Self::convert_do(&me, app, move |s| s.choose_format(id))));
        }
        page = page.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Vorlage")).child(presets)).child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Format")).child(formats));
        if let Some(format) = find_format(&s.settings.format_id) {
            page = page.child(ui.hint(format!("{}: {}", format.label, format.hint)));
        }

        // Audio bitrate for the lossy sound formats.
        if let Some(format) = find_format(&s.settings.format_id) {
            if format.kind == Kind::Audio && !format.lossless {
                let mut rates = div().flex().flex_wrap().items_center().gap(px(6.));
                rates = rates.child(ui.hint("Qualität:"));
                for kbps in [128u32, 192, 256, 320] {
                    let me = me.clone();
                    rates = rates.child(ui.chip(format!("rate-{kbps}"), format!("{kbps} kbit/s"), s.settings.audio_bitrate_kbps == kbps).on_click(move |_, app| Self::convert_do(&me, app, move |s| {
                        s.settings.audio_bitrate_kbps = kbps;
                        s.settings.use_variable_bitrate = false;
                        s.preset = None;
                    })));
                }
                page = page.child(rates);
            }
        }

        let go = {
            let me = me.clone();
            ui.button("umwandeln-los", if busy { "Wandelt um …" } else { "Umwandeln" }).primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.start_convert(cx)))
        };
        page = page.child(div().flex().child(go));

        // The way there.
        if let (Some(run), Some(watch)) = (&s.run, &self.convert_watch) {
            let (n, name) = watch.lock().expect("lock").clone();
            let progress = *run.progress.lock().expect("lock");
            let cancel = run.cancel.clone();
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title(format!("Datei {} von {}: {}", n + 1, run.of, name)))
                    .child(ui.bar("umwandeln", progress.fraction.map(|f| f as f32), format!("{name}: umgewandelt")))
                    .child(div().flex().flex_wrap().items_center().gap(px(12.)).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.prose).child(progress.speed.map_or(String::new(), |x| format!("{x:.1}× so schnell wie abgespielt")))).child(ui.button("umwandeln-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.cancel()))),
            );
        }

        // What came out.
        if !s.made.is_empty() {
            let mut rows = div().flex().flex_col();
            for (n, made) in s.made.iter().enumerate() {
                let (name, says, path) = match &made.result {
                    Ok((path, bytes)) => (path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), format!("{} · {}", path.display(), size_text(*bytes)), Some(path.clone())),
                    Err(message) => (made.from.clone(), format!("Nicht umgewandelt: {message}"), None),
                };
                let mut actions = div().flex().gap(px(8.));
                if let Some(path) = path {
                    let (play, show) = (me.clone(), me.clone());
                    let (p1, folder) = (path.clone(), path.parent().map(PathBuf::from));
                    let playable = path.file_name().is_some_and(|f| sondra_player::player_kind(&f.to_string_lossy(), "").is_some());
                    if playable {
                        actions = actions.child(ui.button(format!("fertig-abspielen-{n}"), "Abspielen").small().accessible_name(format!("{name} abspielen")).on_click(move |_, app| {
                            let p = p1.clone();
                            play.update(app, |shell, cx| {
                                shell.go(Panel::Player, cx);
                                shell.play_files(vec![p], cx);
                            })
                        }));
                    }
                    actions = actions.child(ui.button(format!("fertig-zeigen-{n}"), "Im Ordner zeigen").small().accessible_name(format!("{name} im Ordner zeigen")).on_click(move |_, app| {
                        if let Some(folder) = folder.clone() {
                            show.update(app, |shell, cx| {
                                shell.go(Panel::Folder, cx);
                                shell.open_folder(folder, cx);
                            })
                        }
                    }));
                }
                rows = rows.child(Line {
                    colors: c,
                    id: format!("umgewandelt-{n}").into(),
                    name: name.clone().into(),
                    says: says.clone().into(),
                    first: n == 0,
                    tile: None,
                    selected: false,
                    body: vec![div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(2.)).child(ui.value(name)).child(div().text_size(px(size::SMALL)).text_color(c.prose).child(says)).into_any_element(), actions.into_any_element()],
                    on_open: std::rc::Rc::new(|_, _| {}),
                });
            }
            page = page.child(div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Fertig"))).child(rows));
        }
        page.into_any_element()
    }
}
