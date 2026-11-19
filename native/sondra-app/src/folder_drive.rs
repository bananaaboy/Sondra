//! The Ordner page with Google Drive as its source: „Sondra“ in Drive, its subfolders walked through, as the same list
//! of files (`FolderScan` with `drive: true`). Only what Sondra put there is seen (`drive.file`), and the page says so.
//! Playing fetches the file into a folder of this program first (and keeps it); deleting puts the file into Drive's own
//! bin — 30 days to take it back — and „Endgültig löschen“ is not offered there.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gpui::{AppContext, Context};
use sondra_drive::write::Tree;
use sondra_drive::DriveClient;
use sondra_merk::folder::{hint_of, hint_properties, kind_from_mime, season_path, unfiled_episodes, DriveInfo, FolderFile, FolderScan, ListingOptions};
use sondra_merk::matching::EpisodeHint;

use crate::drive_hub::says;
use crate::shell::Shell;

/// The files of a tree as the list of the page: the date is Drive's, the kind comes from its media type.
pub fn scan_of(tree: &Tree) -> FolderScan {
    let mut files: Vec<FolderFile> = tree
        .files
        .iter()
        .map(|entry| {
            let name = entry.file.name.clone();
            let dir = entry.path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
            let mime = entry.file.mime_type.clone().unwrap_or_default();
            let properties: HashMap<String, String> = entry.notes.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            let modified = entry.file.modified_time.as_deref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map_or(0, |t| t.timestamp_millis());
            FolderFile {
                kind: kind_from_mime(&mime, &name),
                path: entry.path.clone(),
                name,
                dir,
                size: entry.file.size.unwrap_or(0),
                modified,
                drive: Some(DriveInfo { id: entry.file.id.clone(), mime, parent: Some(entry.parent.clone()), hint: hint_of(&properties) }),
            }
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    FolderScan { name: "Sondra".to_string(), files, dirs: tree.dirs.clone(), truncated: tree.truncated, drive: true }
}

/// Where the files fetched from Drive are kept.
pub fn cache_dir() -> PathBuf {
    crate::store::data_dir().unwrap_or_else(std::env::temp_dir).join("Drive-Ablage")
}

/// The program's small server for films in Drive: one for each Drive it talks to, started when first needed.
fn stream_for(drive: &crate::drive_hub::Drive) -> Result<Arc<sondra_drive::DriveStream>, String> {
    static STREAM: std::sync::Mutex<Option<(String, Arc<sondra_drive::DriveStream>)>> = std::sync::Mutex::new(None);
    let mut held = STREAM.lock().unwrap();
    if let Some((api, stream)) = held.as_ref() {
        if *api == drive.api {
            return Ok(stream.clone());
        }
    }
    let stream = Arc::new(sondra_drive::DriveStream::start(DriveClient::new(drive.tokens.clone(), drive.api.clone())).map_err(|e| format!("Der Film lässt sich nicht aus Drive öffnen: {e}"))?);
    *held = Some((drive.api.clone(), stream.clone()));
    Ok(stream)
}

impl Shell {
    /// Reads Sondra's folder in Drive in the background, signing in first when that is needed.
    pub fn open_drive_folder(&mut self, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        let f = &mut self.folder;
        f.cancel.store(true, Ordering::Relaxed);
        f.cancel = Arc::new(AtomicBool::new(false));
        f.generation += 1;
        f.reading = true;
        f.error = None;
        f.root = None;
        f.only_new = false;
        f.reopen_dir = None;
        f.thumbs.borrow_mut().clear_waiting();
        let (cancel, generation) = (f.cancel.clone(), f.generation);
        let task = cx.background_spawn(async move {
            if !(drive.connected)() {
                (drive.sign_in)()?;
            }
            let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
            client.tree(20_000, &cancel, |_| {}).map(|t| scan_of(&t)).map_err(|e| says(&e))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |shell, cx| shell.drive_folder_read(generation, result, cx)).ok();
        })
        .detach();
        cx.notify();
    }

    fn drive_folder_read(&mut self, generation: u64, result: Result<FolderScan, String>, cx: &mut Context<Self>) {
        if generation != self.folder.generation {
            return;
        }
        match result {
            Ok(scan) => self.folder_read(generation, Ok(scan), cx),
            Err(why) => {
                let f = &mut self.folder;
                f.reading = false;
                f.scan = None;
                f.error = Some(why);
                cx.notify();
            }
        }
    }

    /// Plays the chosen films and songs of Drive: each is fetched into the folder of this program (one that is there with
    /// the same size is kept), then the Player takes the list.
    pub(crate) fn play_selected_from_drive(&mut self, cx: &mut Context<Self>) {
        let (true, Some(scan)) = (self.drive.is_some(), self.folder.scan.clone()) else { return };
        let f = &self.folder;
        let options = ListingOptions { dir: f.dir.clone(), deep: f.prefs.deep, filter: f.prefs.filter, query: f.search.read(cx).text().to_string(), sort: f.prefs.sort, descending: f.prefs.descending };
        let wanted: Vec<FolderFile> = sondra_merk::folder::listing(&scan, &options)
            .files
            .into_iter()
            .filter(|file| f.selected.contains(&file.path) && file.drive.is_some() && matches!(file.kind, sondra_merk::folder::AssetKind::Video | sondra_merk::folder::AssetKind::Audio))
            .collect();
        if wanted.is_empty() {
            self.folder.notice = Some("Unter den gewählten Dateien ist nichts, was sich abspielen lässt.".into());
            cx.notify();
            return;
        }
        let films = wanted
            .into_iter()
            .filter_map(|file| file.drive.as_ref().map(|d| sondra_devices::engine::PlayItem { id: d.id.clone(), name: file.name.clone(), size: file.size, mime: d.mime.clone() }))
            .collect();
        self.play_drive_films(films, cx);
    }

    /// Films that lie in Drive go to the Player: read from Drive where they lie, in ranges, so each starts at
    /// once (signing in first when that is needed). What goes wrong is said on the Ordner page and on the
    /// Geräte page, whichever the person is looking at.
    pub(crate) fn play_drive_films(&mut self, films: Vec<sondra_devices::engine::PlayItem>, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else {
            let why = "Drive ist hier nicht eingerichtet, der Film lässt sich nicht öffnen.".to_string();
            self.folder.notice = Some(why.clone());
            self.devices.problem = Some(why);
            cx.notify();
            return;
        };
        self.folder.busy = true;
        self.folder.notice = Some(if films.len() == 1 { "Der Film wird aus Drive geöffnet …".into() } else { format!("{} Dateien werden aus Drive geöffnet …", films.len()) });
        cx.notify();
        let dir = cache_dir();
        Self::in_background(
            cx,
            move || -> Result<Vec<PathBuf>, String> {
                if !(drive.connected)() {
                    (drive.sign_in)()?;
                }
                let stream = stream_for(&drive)?;
                let mut paths = Vec::new();
                for film in films {
                    // A file kept from an earlier time is played as it is, anything else is read from Drive where
                    // it lies, in ranges, so the film starts at once.
                    let path = dir.join(format!("{}-{}", film.id, crate::drive_hub::safe_name(&film.name)));
                    let kept = std::fs::metadata(&path).is_ok_and(|m| m.len() == film.size && film.size > 0);
                    if !kept {
                        if film.size == 0 {
                            // Without a size no range can be asked for.
                            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                            let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
                            client.download_to(&film.id, &path, &AtomicBool::new(false), |_, _| {}).map_err(|e| says(&e))?;
                        } else {
                            sondra_playback::register_source(&path, &stream.url(&film.id, &film.name, film.size, &film.mime));
                        }
                    }
                    paths.push(path);
                }
                Ok(paths)
            },
            |shell, result, cx| {
                shell.folder.busy = false;
                match result {
                    Ok(paths) => {
                        shell.folder.notice = None;
                        shell.go(crate::nav::Panel::Player, cx);
                        shell.play_files(paths, cx);
                    }
                    Err(why) => {
                        shell.folder.notice = Some(why.clone());
                        shell.devices.problem = Some(why);
                        cx.notify();
                    }
                }
            },
        );
    }

    /// The chosen files of Drive into Drive's bin.
    pub(crate) fn trash_chosen_in_drive(&mut self, cx: &mut Context<Self>) {
        let (Some(drive), Some(files)) = (self.drive.clone(), self.folder.confirm.clone()) else { return };
        self.folder.busy = true;
        Self::in_background(
            cx,
            move || -> (Vec<String>, Vec<String>) {
                let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
                let (mut gone, mut failed) = (Vec::new(), Vec::new());
                for file in files {
                    let Some(id) = file.drive.as_ref().map(|d| d.id.clone()) else { continue };
                    match client.trash(&id) {
                        Ok(()) => gone.push(file.path),
                        Err(e) => failed.push(format!("{}: {}", file.name, says(&e))),
                    }
                }
                (gone, failed)
            },
            |shell, (gone, failed), cx| shell.deleted(true, gone, Vec::new(), failed, cx),
        );
        cx.notify();
    }
}

impl Shell {
    /// „3 Folgen liegen noch lose“ over the list of a Drive folder, with „Einordnen“: what the Merkliste knows by name and
    /// that carries no note yet goes into `Serien/<Titel>/Staffel n`, one click for all of it.
    pub(crate) fn filing_section(&self, ui: sondra_ui::Ui, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        use gpui::{div, prelude::*, px};
        let scan = self.folder.scan.as_ref().filter(|s| s.drive)?;
        let groups = unfiled_episodes(&scan.files, &self.merk.items);
        let total: usize = groups.iter().map(|g| g.files.len()).sum();
        if total == 0 {
            return None;
        }
        let me = cx.entity();
        let busy = self.folder.busy;
        let titles: Vec<String> = groups.iter().map(|g| g.title.clone()).collect();
        let says = format!("{}. Einordnen legt sie in „Serien“ in Ordner je Serie und Staffel; umbenannt wird nichts.", titles.join(", "));
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .p(px(16.))
                .rounded(px(sondra_ui::radius::CARD))
                .bg(ui.c.panel_soft)
                .child(div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(ui.subheading(if total == 1 { "1 Folge liegt noch lose".to_string() } else { format!("{total} Folgen liegen noch lose") })).child(ui.button("einordnen", if busy { "Ordnet ein …" } else { "Einordnen" }).small().primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.file_loose_episodes(cx)))))
                .child(ui.prose(says))
                .into_any_element(),
        )
    }

    /// Moves the loose episodes of Drive into their season folders (with the note of what they are), then reads the folder
    /// again. There is no „Rückgängig“: the files lie in the season's folder afterwards.
    pub(crate) fn file_loose_episodes(&mut self, cx: &mut Context<Self>) {
        let (Some(drive), Some(scan)) = (self.drive.clone(), self.folder.scan.clone()) else { return };
        let groups = unfiled_episodes(&scan.files, &self.merk.items);
        if groups.is_empty() || self.folder.busy {
            return;
        }
        self.folder.busy = true;
        cx.notify();
        Self::in_background(
            cx,
            move || -> Result<usize, String> {
                let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
                let mut done = 0;
                for group in groups {
                    let [serien, series, season] = season_path(&group.title, group.season);
                    let target = client.ensure_path(&["Sondra", &serien, &series, &season]).map_err(|e| says(&e))?;
                    for (file, episode) in group.files {
                        let Some(info) = file.drive else { continue };
                        let hint = EpisodeHint { series: group.item.clone(), season: group.season, episode };
                        client.move_file(&info.id, &target, info.parent.as_deref(), &hint_properties(&hint)).map_err(|e| says(&e))?;
                        done += 1;
                    }
                }
                Ok(done)
            },
            |shell, result, cx| {
                shell.folder.busy = false;
                match result {
                    Ok(n) => {
                        shell.folder.notice = Some(format!("{n} {} eingeordnet (Sondra/Serien).", if n == 1 { "Folge" } else { "Folgen" }));
                        shell.open_drive_folder(cx);
                    }
                    Err(why) => {
                        shell.folder.notice = Some(why);
                        cx.notify();
                    }
                }
            },
        );
    }
}
