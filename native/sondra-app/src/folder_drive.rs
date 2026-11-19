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
use sondra_merk::folder::{hint_of, kind_from_mime, DriveInfo, FolderFile, FolderScan, ListingOptions};

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
        let (Some(drive), Some(scan)) = (self.drive.clone(), self.folder.scan.clone()) else { return };
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
        self.folder.busy = true;
        self.folder.notice = Some(if wanted.len() == 1 { "Die Datei wird aus Drive geholt …".into() } else { format!("{} Dateien werden aus Drive geholt …", wanted.len()) });
        cx.notify();
        let dir = cache_dir();
        Self::in_background(
            cx,
            move || -> Result<Vec<PathBuf>, String> {
                if !(drive.connected)() {
                    (drive.sign_in)()?;
                }
                let client = DriveClient::new(drive.tokens.clone(), drive.api.clone());
                let never = AtomicBool::new(false);
                let mut paths = Vec::new();
                for file in wanted {
                    let id = file.drive.as_ref().map(|d| d.id.clone()).unwrap_or_default();
                    let path = dir.join(format!("{id}-{}", crate::drive_hub::safe_name(&file.name)));
                    let kept = std::fs::metadata(&path).is_ok_and(|m| m.len() == file.size && file.size > 0);
                    if !kept {
                        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                        client.download_to(&id, &path, &never, |_, _| {}).map_err(|e| says(&e))?;
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
                        shell.folder.notice = Some(why);
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
