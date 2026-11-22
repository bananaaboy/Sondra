//! What the selection of the Ordner page can do besides playing, packing and deleting — as on the website:
//! „In die Sitzung“, „In Drive“ (one upload after the other), „An Geräte senden“ (several at once), „Untertitel
//! erzeugen“ (Whisper hears each film and writes `Name.srt` beside it — never an online search); the folders opened
//! last (five, offered, never read on their own); the keyboard in the list (arrows, Space, Strg+A, Escape, Enter);
//! and the next page of a long folder as one scrolls to it.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use gpui::{canvas, deferred, div, prelude::*, px, AnyElement, Context, Entity};
use sondra_merk::folder::{listing, AssetKind, FolderFile, ListingOptions};
use sondra_merk::folder_memory::Store;
use sondra_ui::Ui;

use crate::shell::Shell;

const RECENT_KEY: &str = "sondra:ordner:zuletzt";
const RECENT_MAX: usize = 5;
/// How far before the bottom of the window the next page is fetched (the website's 900 px).
const AHEAD: f32 = 900.0;

/// The folders opened last, the newest first, without the same twice.
pub fn merge_recent(list: &[PathBuf], opened: &std::path::Path) -> Vec<PathBuf> {
    let mut next = vec![opened.to_path_buf()];
    next.extend(list.iter().filter(|p| p.as_path() != opened).cloned());
    next.truncate(RECENT_MAX);
    next
}

/// A line that a job in the background writes and the page reads.
#[derive(Default)]
pub struct Work {
    pub line: String,
    pub done: bool,
}

impl Shell {
    pub(crate) fn folder_load_recent(&mut self) {
        let list: Vec<String> = self.folder.memory.as_ref().and_then(|m| m.get_item(RECENT_KEY)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        self.folder.recent = list.into_iter().map(PathBuf::from).filter(|p| p.is_dir()).collect();
    }

    pub(crate) fn folder_note_recent(&mut self, opened: &std::path::Path) {
        let next = merge_recent(&self.folder.recent, opened);
        if let Some(store) = self.folder.memory.as_mut() {
            store.set_item(RECENT_KEY, serde_json::to_string(&next.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default());
        }
        self.folder.recent = next;
    }

    pub fn folder_recent(&self) -> &[PathBuf] {
        &self.folder.recent
    }

    /// The files in view, in the order the page shows them.
    pub(crate) fn folder_view(&self, cx: &Context<Self>) -> Vec<FolderFile> {
        let f = &self.folder;
        let Some(scan) = &f.scan else { return vec![] };
        let options = ListingOptions { dir: f.dir.clone(), deep: f.prefs.deep, filter: f.prefs.filter, query: f.search.read(cx).text().to_string(), sort: f.prefs.sort, descending: f.prefs.descending };
        let mut files = listing(scan, &options).files;
        if f.prefs.unseen {
            files.retain(|file| sondra_merk::folder::episode_of(file, &self.merk.items).is_none_or(|e| !e.seen));
        }
        if let (true, Some(since)) = (f.only_new, f.last_visit) {
            files.retain(|file| file.modified as f64 > since);
        }
        if f.prefs.group && !sondra_merk::folder::folder_episodes(&scan.files, &self.merk.items).is_empty() {
            let grouped = sondra_merk::folder::group_by_series(&files, &self.merk.items);
            if !grouped.groups.is_empty() {
                files = grouped.ordered;
            }
        }
        files
    }

    /// The chosen files of this computer, in the order of the list, and how many chosen lie in Drive.
    pub(crate) fn folder_chosen_here(&self, cx: &Context<Self>) -> (Vec<PathBuf>, usize) {
        let f = &self.folder;
        let Some(root) = f.root.clone() else {
            return (vec![], f.selected.len());
        };
        let mut here = Vec::new();
        let mut remote = 0;
        let in_view = self.folder_view(cx);
        let all = f.scan.as_ref().map(|s| s.files.clone()).unwrap_or_default();
        // In view first (in its order), then what is chosen but filtered away.
        for file in in_view.iter().chain(all.iter().filter(|file| !in_view.iter().any(|v| v.path == file.path))) {
            if !f.selected.contains(&file.path) || here.contains(&root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR))) {
                continue;
            }
            if file.drive.is_some() {
                remote += 1;
            } else {
                here.push(root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR)));
            }
        }
        (here, remote)
    }

    fn folder_say(&mut self, line: String, cx: &mut Context<Self>) {
        crate::protocol::note("ordner", line.clone());
        self.folder.notice = Some(line);
        self.folder.undo = None;
        cx.notify();
    }

    /// „In die Sitzung“: the chosen files of this computer join the session (nothing is copied).
    pub fn folder_to_session(&mut self, cx: &mut Context<Self>) {
        let (here, remote) = self.folder_chosen_here(cx);
        if here.is_empty() {
            let line = if remote > 0 { "Dateien in Drive gehen erst in die Sitzung, wenn sie auf diesem Computer liegen." } else { "Es ist nichts gewählt." };
            return self.folder_say(line.into(), cx);
        }
        let n = here.len();
        self.session_add(here, cx);
        let mut line = if n == 1 { "1 Datei ist in der Sitzung.".to_string() } else { format!("{n} Dateien sind in der Sitzung.") };
        if remote > 0 {
            line.push_str(&format!(" {remote} in Drive nicht — sie liegen nicht auf diesem Computer."));
        }
        self.folder_say(line, cx);
    }

    /// Follows a job in the background until it is done, its line under the head of the page.
    fn folder_follow(&mut self, work: Arc<Mutex<Work>>, cx: &mut Context<Self>) {
        self.folder.work = Some(work.clone());
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(150)).await;
            let done = {
                let w = work.lock().unwrap();
                (w.line.clone(), w.done)
            };
            let alive = this.update(cx, |shell, cx| {
                shell.folder.notice = Some(done.0.clone());
                if done.1 {
                    shell.folder.work = None;
                }
                cx.notify();
            });
            if done.1 || alive.is_err() {
                break;
            }
        })
        .detach();
    }

    pub fn folder_working(&self) -> bool {
        self.folder.work.is_some()
    }

    /// „In Drive“: the chosen files into the folder „Sondra“ of Drive by their kind, one after the other.
    pub fn folder_to_drive(&mut self, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        if self.folder.work.is_some() {
            return;
        }
        let (here, _) = self.folder_chosen_here(cx);
        if here.is_empty() {
            return self.folder_say("Unter den gewählten Dateien liegt keine auf diesem Computer.".into(), cx);
        }
        let work = Arc::new(Mutex::new(Work { line: format!("In Drive: 0 von {} …", here.len()), done: false }));
        let (job, saves) = (work.clone(), self.drive_saves.clone());
        std::thread::spawn(move || {
            let total = here.len();
            let (mut sent, mut already, mut failed) = (0, 0, Vec::new());
            for (i, path) in here.iter().enumerate() {
                job.lock().unwrap().line = format!("In Drive: {} von {total} — {}", i + 1, path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                let cancel = AtomicBool::new(false);
                match crate::drive_hub::save(&drive, path, &cancel, |_, _| {}) {
                    Ok(crate::drive_hub::Saved::Done) => {
                        sent += 1;
                        saves.set(path, crate::drive_hub::Line::Done);
                    }
                    Ok(crate::drive_hub::Saved::Already) => {
                        already += 1;
                        saves.set(path, crate::drive_hub::Line::Already);
                    }
                    Err(why) => {
                        saves.set(path, crate::drive_hub::Line::Failed(why.clone()));
                        failed.push(why);
                    }
                }
            }
            let mut line = format!("In Drive gespeichert: {sent} von {total}");
            if already > 0 {
                line.push_str(&format!(" · {already} waren schon dort"));
            }
            if let Some(why) = failed.first() {
                line.push_str(&format!(" · {} nicht: {why}", failed.len()));
            }
            let mut w = job.lock().unwrap();
            w.line = line;
            w.done = true;
        });
        self.folder_follow(work, cx);
    }

    /// The devices that can take files now: id and name.
    pub(crate) fn folder_devices(&self) -> Vec<(String, String)> {
        let Some(engine) = &self.devices.engine else { return vec![] };
        let now = sondra_devices::engine::now_ms();
        engine
            .snapshot()
            .devices
            .iter()
            .filter(|d| sondra_devices::registry::is_online(d, now))
            .map(|d| (d["id"].as_str().unwrap_or_default().to_owned(), d["name"].as_str().unwrap_or_default().to_owned()))
            .filter(|(id, _)| !id.is_empty())
            .collect()
    }

    /// „An Geräte senden“: the chosen files to each named device, one transfer each.
    pub fn folder_send_to(&mut self, ids: Vec<(String, String)>, cx: &mut Context<Self>) {
        let (here, _) = self.folder_chosen_here(cx);
        if here.is_empty() || ids.is_empty() {
            return;
        }
        for (id, _) in &ids {
            self.devices_send_paths(id, here.clone(), false, cx);
        }
        let names = ids.iter().map(|(_, n)| format!("„{n}“")).collect::<Vec<_>>().join(", ");
        let line = match &self.devices.problem {
            Some(problem) => problem.clone(),
            None => format!("{} {} angeboten an {names} — dort wird gefragt.", here.len(), if here.len() == 1 { "Datei" } else { "Dateien" }),
        };
        self.folder_say(line, cx);
    }

    /// „Untertitel erzeugen“: each chosen film or recording heard by the speech model of the Untertitel page (its
    /// model and language), `Name.srt` written beside it. A file that has one keeps it.
    pub fn folder_subtitles(&mut self, cx: &mut Context<Self>) {
        if self.folder.work.is_some() {
            return;
        }
        let (here, _) = self.folder_chosen_here(cx);
        let films: Vec<PathBuf> = here.into_iter().filter(|p| matches!(crate::session::kind_of(p), AssetKind::Video | AssetKind::Audio)).collect();
        if films.is_empty() {
            return self.folder_say("Unter den gewählten Dateien ist kein Film und keine Aufnahme.".into(), cx);
        }
        let s = &self.subtitles;
        let model = sondra_speech::model::model_by_id(s.model);
        if !sondra_speech::model::is_present(&s.models_dir, &model) {
            self.folder.needs_model = true;
            return self.folder_say("Dafür fehlt das Sprachmodell. Es kommt einmalig von Hugging Face — im Werkzeug „Untertitel“; der Ton verlässt dieses Gerät nie.".into(), cx);
        }
        self.folder.needs_model = false;
        let (model_path, language) = (sondra_speech::model::path_of(&s.models_dir, &model), s.language);
        let work = Arc::new(Mutex::new(Work { line: format!("Untertitel: 0 von {} …", films.len()), done: false }));
        let job = work.clone();
        std::thread::spawn(move || {
            let total = films.len();
            let mut made = Vec::new();
            let mut failed: Vec<String> = Vec::new();
            let recognizer = match sondra_speech::engine::Recognizer::load(&model_path) {
                Ok(r) => r,
                Err(e) => {
                    let mut w = job.lock().unwrap();
                    w.line = format!("Das Sprachmodell liess sich nicht öffnen: {e}");
                    w.done = true;
                    return;
                }
            };
            let Some(ff) = sondra_media::Ffmpeg::locate() else {
                let mut w = job.lock().unwrap();
                w.line = "FFmpeg ist nicht da.".into();
                w.done = true;
                return;
            };
            for (i, film) in films.iter().enumerate() {
                let name = film.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                job.lock().unwrap().line = format!("Untertitel: {} von {total} — hört „{name}“ ab …", i + 1);
                let result = sondra_media::audio::decode_file(&ff, film, Some(16000)).map_err(|e| e.to_string()).and_then(|audio| {
                    let samples = sondra_media::audio::mix_to_mono(&audio);
                    recognizer.transcribe(&samples, language, &|| false, &mut |_, _| {}, &mut |_| {}).map_err(|e| e.to_string())
                });
                match result {
                    Ok(segments) if !segments.is_empty() => {
                        let stem = film.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                        let dir = film.parent().map(PathBuf::from).unwrap_or_default();
                        let target = sondra_media::run::unique_path(&dir, &stem, "srt");
                        match std::fs::write(&target, sondra_speech::cues::to_srt(&sondra_speech::cues::to_cues(&segments))) {
                            Ok(()) => made.push(target),
                            Err(e) => failed.push(format!("{name}: {e}")),
                        }
                    }
                    Ok(_) => failed.push(format!("{name}: nichts gehört")),
                    Err(e) => failed.push(format!("{name}: {e}")),
                }
            }
            let mut line = format!("Untertitel geschrieben: {} von {total}, je neben dem Film", made.len());
            if let Some(first) = failed.first() {
                line.push_str(&format!(" · nicht: {first}{}", if failed.len() > 1 { format!(" und {} weitere", failed.len() - 1) } else { String::new() }));
            }
            let mut w = job.lock().unwrap();
            w.line = line;
            w.done = true;
        });
        self.folder_follow(work, cx);
    }

    /// A key on the Ordner page (not in a field): arrows move the chosen file (Shift extends), Space adds or takes
    /// away, Strg+A chooses all in view, Escape lets go, Enter plays. Returns whether it was taken.
    pub fn folder_key(&mut self, key: &str, control: bool, shift: bool, cx: &mut Context<Self>) -> bool {
        if self.folder.scan.is_none() || self.folder.confirm.is_some() || self.folder.bin.is_some() {
            return false;
        }
        let order: Vec<String> = self.folder_view(cx).into_iter().map(|f| f.path).collect();
        if order.is_empty() {
            return false;
        }
        let f = &mut self.folder;
        let current = f.cursor.clone().or_else(|| f.anchor.clone()).and_then(|c| order.iter().position(|p| *p == c));
        match (key, control) {
            ("a", true) => {
                f.selected = order.iter().cloned().collect();
                f.anchor = order.first().cloned();
            }
            ("escape", false) if !f.selected.is_empty() => {
                f.selected.clear();
                f.anchor = None;
            }
            ("space", false) => {
                let Some(at) = current.or(Some(0)) else { return false };
                let path = order[at].clone();
                f.select(&path, true, false, &order);
                f.cursor = Some(path);
            }
            ("enter", false) if !f.selected.is_empty() => {
                self.play_selected(cx);
                return true;
            }
            ("down" | "right" | "up" | "left", false) => {
                let forward = matches!(key, "down" | "right");
                let next = match current {
                    None => 0,
                    Some(at) if forward => (at + 1).min(order.len() - 1),
                    Some(at) => at.saturating_sub(1),
                };
                let path = order[next].clone();
                if shift {
                    let anchor = f.anchor.clone().unwrap_or_else(|| path.clone());
                    f.select(&path, false, true, &order);
                    f.anchor = Some(anchor);
                } else {
                    f.select(&path, false, false, &order);
                }
                f.cursor = Some(path);
                // The page shows at least as far as the chosen file.
                while next >= f.shown {
                    f.shown += crate::folder_page::PAGE;
                }
            }
            _ => return false,
        }
        cx.notify();
        true
    }

    /// The buttons for the selection that this file adds to the bar.
    pub(crate) fn folder_selection_buttons(&self, ui: &Ui, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let me = cx.entity();
        let f = &self.folder;
        let busy = f.busy || f.work.is_some();
        let mut out = Vec::new();
        {
            let me = me.clone();
            out.push(ui.button("auswahl-sitzung", "In die Sitzung").small().accessible_name("Gewählte Dateien in die Sitzung").on_click(move |_, app| me.update(app, |shell, cx| shell.folder_to_session(cx))).into_any_element());
        }
        if self.drive.as_ref().is_some_and(|d| d.configured) && !f.scan.as_ref().is_some_and(|s| s.drive) {
            let me = me.clone();
            out.push(ui.button("auswahl-drive", "In Drive").small().disabled(busy).accessible_name("Gewählte Dateien in Drive speichern").on_click(move |_, app| me.update(app, |shell, cx| shell.folder_to_drive(cx))).into_any_element());
        }
        {
            let me = me.clone();
            out.push(ui.button("auswahl-untertitel", "Untertitel erzeugen").small().disabled(busy).accessible_name("Untertitel für die gewählten Filme erzeugen").on_click(move |_, app| me.update(app, |shell, cx| shell.folder_subtitles(cx))).into_any_element());
        }
        let devices = self.folder_devices();
        if !devices.is_empty() && !f.scan.as_ref().is_some_and(|s| s.drive) {
            let me = me.clone();
            out.push(ui.button("auswahl-geraete", "An Geräte senden …").small().accessible_name("Gewählte Dateien an Geräte senden").on_click(move |_, app| Self::folder_do(&me, app, |f| f.send_open = !f.send_open)).into_any_element());
        }
        out
    }

    /// The menu of devices to send to, under the bar of the selection.
    pub(crate) fn folder_send_menu(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.folder.send_open {
            return None;
        }
        let me = cx.entity();
        let devices = self.folder_devices();
        let mut items: Vec<AnyElement> = devices
            .iter()
            .map(|(id, name)| {
                let me = me.clone();
                let target = vec![(id.clone(), name.clone())];
                ui.menu_item(format!("senden-an-{id}"), format!("An „{name}“"), false).on_click(move |_, app| {
                    let target = target.clone();
                    me.update(app, |shell, cx| {
                        shell.folder.send_open = false;
                        shell.folder_send_to(target, cx)
                    })
                }).into_any_element()
            })
            .collect();
        if devices.len() > 1 {
            let me = me.clone();
            let all = devices.clone();
            items.push(ui.menu_item("senden-an-alle", format!("An alle {} Geräte", devices.len()), false).on_click(move |_, app| {
                let all = all.clone();
                me.update(app, |shell, cx| {
                    shell.folder.send_open = false;
                    shell.folder_send_to(all, cx)
                })
            }).into_any_element());
        }
        let away = me.clone();
        Some(
            div()
                .relative()
                .child(deferred(div().absolute().top(px(4.)).left_0().on_mouse_down_out(move |_, _, app| Self::folder_do(&away, app, |f| f.send_open = false)).child(ui.popover("menue-geraete-senden", "An Geräte senden", items))).with_priority(10))
                .into_any_element(),
        )
    }

    /// „Zuletzt“: the other folders opened last, as a menu in the head.
    pub(crate) fn folder_recent_button(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let current = self.folder.root.clone();
        let others: Vec<PathBuf> = self.folder.recent.iter().filter(|p| Some(*p) != current.as_ref()).cloned().collect();
        if others.is_empty() {
            return None;
        }
        let me = cx.entity();
        let mut holder = div().relative();
        {
            let me = me.clone();
            holder = holder.child(ui.button("zuletzt", "Zuletzt").small().ghost().accessible_name("Zuletzt geöffnete Ordner").on_click(move |_, app| Self::folder_do(&me, app, |f| f.recent_open = !f.recent_open)));
        }
        if self.folder.recent_open {
            let items: Vec<AnyElement> = others
                .iter()
                .map(|path| {
                    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
                    let (me, path) = (me.clone(), path.clone());
                    ui.menu_item(format!("zuletzt-{}", path.display()), format!("„{name}“"), false).on_click(move |_, app| {
                        let path = path.clone();
                        me.update(app, |shell, cx| {
                            shell.folder.recent_open = false;
                            shell.open_folder(path, cx)
                        })
                    }).into_any_element()
                })
                .collect();
            let away = me.clone();
            holder = holder.child(deferred(div().absolute().top(px(36.)).right_0().on_mouse_down_out(move |_, _, app| Self::folder_do(&away, app, |f| f.recent_open = false)).child(ui.popover("menue-zuletzt", "Zuletzt geöffnet", items))).with_priority(10));
        }
        Some(holder.into_any_element())
    }

    /// On the empty page: a key per folder opened last.
    pub(crate) fn folder_recent_ways(&self, ui: &Ui, me: &Entity<Shell>) -> Vec<AnyElement> {
        self.folder
            .recent
            .iter()
            .map(|path| {
                let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
                let again = self.folder.remembered.as_ref() == Some(path);
                let (me, path) = (me.clone(), path.clone());
                ui.button(if again { "wieder-oeffnen".to_string() } else { format!("zuletzt-oeffnen-{}", path.display()) }, if again { format!("„{name}“ wieder öffnen") } else { format!("„{name}“ öffnen") }).on_click(move |_, app| {
                    let path = path.clone();
                    me.update(app, |shell, cx| shell.open_folder(path, cx))
                })
                .into_any_element()
            })
            .collect()
    }

    /// An invisible mark before „Weitere … zeigen“: when it comes within 900 px of the bottom of the window, the next
    /// page is shown — a folder is a list to scroll, not one to click through.
    pub(crate) fn folder_more_on_sight(&self, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let shown = self.folder.shown;
        canvas(
            move |bounds, window, app| {
                let bottom: f32 = window.viewport_size().height.into();
                let top: f32 = bounds.origin.y.into();
                if top < bottom + AHEAD {
                    let me = me.clone();
                    app.defer(move |app| {
                        me.update(app, |shell, cx| {
                            // Once per page: the mark of the page before must not fetch again.
                            if shell.folder.shown == shown {
                                shell.folder.shown += crate::folder_page::PAGE;
                                cx.notify();
                            }
                        })
                    });
                }
            },
            |_, _, _, _| {},
        )
        .w_full()
        .h(px(1.))
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_five_folders_newest_first_without_twins() {
        let p = |s: &str| PathBuf::from(s);
        let list = vec![p("/a"), p("/b"), p("/c"), p("/d"), p("/e")];
        assert_eq!(merge_recent(&list, &p("/c")), vec![p("/c"), p("/a"), p("/b"), p("/d"), p("/e")]);
        assert_eq!(merge_recent(&list, &p("/f")), vec![p("/f"), p("/a"), p("/b"), p("/c"), p("/d")]);
    }
}
