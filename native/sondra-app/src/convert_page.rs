//! The Umwandeln page: files in, a format (or a template) chosen, one click. What is run is
//! `sondra-media`'s `convert_file` — the argument lists are the website's, held to its answers — with the
//! real FFmpeg, one file after the other, each with its bar and a way to stop. A failure is said in a
//! sentence, FFmpeg's own words one step behind it; an existing file is never replaced.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_media::convert::{find_format, Kind, Settings, FORMATS};
use sondra_media::presets::{built_in, new_own, own_json, parse_own, preset_for, Own};
use sondra_media::{Cancel, Ffmpeg, Progress};
use sondra_merk::folder_memory::Store;
use sondra_ui::{family, size, NoticeKind, TextField, Ui};

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
    pub preset: Option<String>,
    /// The settings kept under a name (`Umwandeln.json`, the website's list in the website's shape).
    pub own: Vec<Own>,
    /// The name a template is to get.
    pub name: Entity<TextField>,
    store: Option<crate::store::FileStore>,
    pub folder: Option<PathBuf>,
    pub run: Option<Run>,
    pub made: Vec<Made>,
    /// The ZIP of the results, when one was asked for: where it lies and how big, or why not.
    pub zip: Option<Result<(PathBuf, u64), String>>,
    pub packing: bool,
    pub error: Option<String>,
}

impl ConvertState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> ConvertState {
        let store = crate::store::FileStore::at_default("Umwandeln.json");
        let own = store.as_ref().and_then(|s| s.get_item("vorlagen")).map(|j| parse_own(&j)).unwrap_or_default();
        let name = cx.new(|cx| TextField::new(cx, colors, "Name der Vorlage").placeholder("Name für diese Einstellungen").max_chars(40));
        ConvertState { files: Vec::new(), settings: Settings::default(), preset: None, own, name, store, folder: None, run: None, made: Vec::new(), zip: None, packing: false, error: None }
    }

    /// Reads the own templates again (after a take-over wrote some).
    pub fn reload_own(&mut self) {
        self.store = crate::store::FileStore::at_default("Umwandeln.json");
        self.own = self.store.as_ref().and_then(|s| s.get_item("vorlagen")).map(|j| parse_own(&j)).unwrap_or_default();
    }

    fn keep_own(&mut self) {
        let json = own_json(&self.own);
        if let Some(store) = self.store.as_mut() {
            store.set_item("vorlagen", json);
        }
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

    fn choose_preset(&mut self, id: &str) {
        let source = self.source_kind();
        self.preset = Some(id.to_string());
        let partial = match built_in().into_iter().find(|p| p.id == id) {
            Some(preset) => preset_for(&preset, source).cloned(),
            None => self.own.iter().find(|o| o.id == id).and_then(|o| o.partial_for(source)).cloned(),
        };
        if let Some(partial) = partial {
            self.settings = Settings::default();
            partial.apply(&mut self.settings);
        }
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
                shell.convert.zip = None;
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Packs the converted files into one ZIP beside them.
    pub(crate) fn convert_pack(&mut self, cx: &mut Context<Self>) {
        let files: Vec<(String, PathBuf)> = self.convert.made.iter().filter_map(|m| m.result.as_ref().ok()).map(|(p, _)| (p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), p.clone())).collect();
        let Some(dir) = files.first().and_then(|(_, p)| p.parent().map(PathBuf::from)) else { return };
        self.convert.packing = true;
        self.convert.zip = None;
        cx.notify();
        Self::pack_in_background(cx, files, dir, "Umgewandelt".to_string(), |shell, result, cx| {
            shell.convert.packing = false;
            shell.convert.zip = Some(result);
            cx.notify();
        });
    }

    /// For tests: types a name for a template.
    pub fn convert_name_for_test(&mut self, cx: &mut Context<Self>, text: &str) {
        self.convert.name.update(cx, |field, cx| field.set_text(text.to_string(), cx));
    }

    /// Keeps the settings as they are now under the name in the field (without the trim, as the website does).
    pub(crate) fn convert_save_own(&mut self, cx: &mut Context<Self>) {
        let label = self.convert.name.read(cx).text().to_string();
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        if let Some(own) = new_own(&label, &self.convert.settings, stamp) {
            self.convert.preset = Some(own.id.clone());
            self.convert.own.push(own);
            self.convert.keep_own();
            self.convert.name.update(cx, |field, cx| field.set_text("", cx));
        }
        cx.notify();
    }

    /// The page.
    pub(crate) fn convert_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.convert;
        let busy = s.run.is_some();
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Umwandeln", "Dateien in ein anderes Format bringen — Ton, Video, Bild. Gerechnet wird auf Ihrem Gerät; keine Datei wird hochgeladen."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        // The files.
        let choose = {
            let me = me.clone();
            ui.button("umwandeln-dateien", if s.files.is_empty() { "Dateien wählen" } else { "Andere Dateien wählen" }).primary_when(s.files.is_empty()).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_convert_files(cx)))
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
            presets = presets.child(ui.chip(format!("vorlage-{id}"), preset.label, s.preset.as_deref() == Some(id)).accessible_name(format!("Vorlage {}: {}", preset.label, preset.hint)).on_click(move |_, app| Self::convert_do(&me, app, move |s| s.choose_preset(id))));
        }
        // Templates of one's own: the settings under a name, and a way to take one away again.
        for own in &s.own {
            let (me, gone) = (me.clone(), me.clone());
            let (id, drop_id) = (own.id.clone(), own.id.clone());
            presets = presets.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(ui.chip(format!("vorlage-{}", own.id), own.label.clone(), s.preset.as_deref() == Some(own.id.as_str())).accessible_name(format!("Eigene Vorlage {}", own.label)).on_click(move |_, app| {
                        let id = id.clone();
                        Self::convert_do(&me, app, move |s| s.choose_preset(&id))
                    }))
                    .child(ui.button(format!("vorlage-weg-{}", own.id), "×").small().ghost().accessible_name(format!("Vorlage {} löschen", own.label)).on_click(move |_, app| {
                        let id = drop_id.clone();
                        Self::convert_do(&gone, app, move |s| {
                            s.own.retain(|o| o.id != id);
                            if s.preset.as_deref() == Some(id.as_str()) {
                                s.preset = None;
                            }
                            s.keep_own();
                        })
                    })),
            );
        }
        let can_save = !s.name.read(cx).text().trim().is_empty();
        let save = {
            let me = me.clone();
            ui.button("vorlage-speichern", "Als Vorlage speichern").small().disabled(!can_save || busy).on_click(move |_, app| me.update(app, |shell, cx| shell.convert_save_own(cx)))
        };
        let own_row = div().flex().flex_wrap().items_center().gap(px(8.)).child(div().w(px(260.)).child(s.name.clone())).child(save);
        let mut formats = div().flex().flex_wrap().gap(px(6.));
        for format in FORMATS.iter() {
            let me = me.clone();
            let id = format.id;
            formats = formats.child(ui.chip(format!("format-{id}"), format.label, s.settings.format_id == id).accessible_name(format!("Format {}: {}", format.label, format.hint)).on_click(move |_, app| Self::convert_do(&me, app, move |s| s.choose_format(id))));
        }
        page = page.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Vorlage")).child(presets).child(own_row)).child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Format")).child(formats));
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
                    Ok((path, bytes)) => {
                        let drive_note = match self.drive_saves.get(path) {
                            Some(crate::drive_hub::Line::Failed(why)) => format!(" · Drive: {why}"),
                            _ => String::new(),
                        };
                        (path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), format!("{} · {}{drive_note}", path.display(), size_text(*bytes)), Some(path.clone()))
                    }
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
                    if self.drive.as_ref().is_some_and(|d| d.configured) {
                        let save = me.clone();
                        let target = path.clone();
                        let state = self.drive_saves.get(&path);
                        let (label, busy_now) = match &state {
                            Some(crate::drive_hub::Line::Busy(Some(f))) => (format!("Drive {} %", (f * 100.0).round() as i32), true),
                            Some(crate::drive_hub::Line::Busy(None)) => ("Drive …".to_string(), true),
                            Some(crate::drive_hub::Line::Done) => ("In Drive gespeichert".to_string(), false),
                            Some(crate::drive_hub::Line::Already) => ("Schon in Drive".to_string(), false),
                            Some(crate::drive_hub::Line::Failed(_)) => ("Erneut versuchen".to_string(), false),
                            None => ("In Drive".to_string(), false),
                        };
                        actions = actions.child(ui.button(format!("fertig-drive-{n}"), label).small().disabled(busy_now).accessible_name(format!("{name} in Drive speichern")).on_click(move |_, app| {
                            let p = target.clone();
                            save.update(app, |shell, cx| shell.save_to_drive(p, cx))
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
            let mut done = div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Fertig"))).child(rows);
            // Two or more results: one ZIP of them all, beside them.
            let made_ok = s.made.iter().filter(|m| m.result.is_ok()).count();
            if made_ok >= 2 {
                let pack = {
                    let me = me.clone();
                    ui.button("alle-als-zip", "Alle als ZIP speichern").small().disabled(s.packing || busy).on_click(move |_, app| me.update(app, |shell, cx| shell.convert_pack(cx)))
                };
                let mut line = div().flex().flex_wrap().items_center().gap(px(12.)).child(pack);
                match &s.zip {
                    Some(Ok((path, bytes))) => line = line.child(ui.prose(format!("ZIP gespeichert: {} · {}", path.display(), size_text(*bytes)))),
                    Some(Err(message)) => line = line.child(ui.notice(NoticeKind::Warning, message.clone())),
                    None if s.packing => line = line.child(ui.prose("Das ZIP wird geschrieben …")),
                    None => {}
                }
                done = done.child(line);
            }
            page = page.child(done);
        }
        page.into_any_element()
    }
}
