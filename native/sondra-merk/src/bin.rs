//! Deleting into a bin of Sondra's own — the web app's `binFiles`, `restoreBinned`, `listBin`,
//! `restoreFromBin` and `eraseFromBin` in `src/lib/folder.ts`. The operating system has no bin for a
//! folder the program was handed, so there is one inside it: `Sondra-Papierkorb`, at the top of the chosen
//! folder, left out of every scan. Files are moved there (a copy is made whole before the original goes,
//! when a move across disks is not possible), a note beside them remembers where each lay, and putting
//! them back never overwrites what has taken their place. Only `erase_from_bin` deletes for good.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::folder::FolderFile;
use crate::stats::compare_de;

/// At the top of the chosen folder; the scan leaves it out.
pub const BIN_NAME: &str = "Sondra-Papierkorb";
/// Where each file in the bin lay and when it went in. A dot hides it from the scan; it is best effort — a
/// bin without it still works, files then go back to the top.
const BIN_NOTES: &str = ".sondra-papierkorb.json";

#[derive(Debug, Clone, PartialEq)]
pub struct Binned {
    /// Where it lay, relative to the folder, with `/`.
    pub path: String,
    pub name: String,
    pub size: u64,
    /// The name it has in the bin.
    pub bin_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure<T> {
    pub item: T,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinItem {
    /// Its name in the bin.
    pub name: String,
    pub size: u64,
    pub modified: i64,
    /// When it went in; absent for a file somebody put there by hand.
    pub at: Option<i64>,
    /// Where it lay, relative to the folder; absent when not known — it then goes back to the top.
    pub from: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Note {
    path: String,
    at: i64,
}

type Notes = BTreeMap<String, Note>;

fn missing_bin() -> String {
    format!("Der Ordner „{BIN_NAME}“ ist nicht mehr da.")
}

fn read_notes(bin: &Path) -> Notes {
    let Ok(bytes) = std::fs::read(bin.join(BIN_NOTES)) else { return Notes::new() };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return Notes::new() };
    let mut notes = Notes::new();
    for (name, value) in map {
        let path = value.get("path").and_then(|p| p.as_str());
        let at = value.get("at").and_then(|a| a.as_f64());
        if let (Some(path), Some(at)) = (path, at) {
            notes.insert(name, Note { path: path.to_string(), at: at as i64 });
        }
    }
    notes
}

fn write_notes(bin: &Path, notes: &Notes) {
    // The notes are a convenience; the files themselves are what matters.
    if notes.is_empty() {
        let _ = std::fs::remove_file(bin.join(BIN_NOTES));
        return;
    }
    if let Ok(bytes) = serde_json::to_vec(notes) {
        let _ = std::fs::write(bin.join(BIN_NOTES), bytes);
    }
}

fn forget_notes(bin: &Path, names: &[String]) {
    let mut notes = read_notes(bin);
    let before = notes.len();
    for name in names {
        notes.remove(name);
    }
    if notes.len() != before {
        write_notes(bin, &notes);
    }
}

/// A name not yet taken in `dir`: „Film.mkv“, then „Film (2).mkv“, „Film (3).mkv“ …
fn free(name: &str, dir: &Path) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    for n in 2..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{stem} ({now}){ext}")
}

/// Moves a file; across disks it is copied whole first and the original goes after.
fn relocate(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(e) = std::fs::copy(from, to) {
        let _ = std::fs::remove_file(to);
        return Err(e);
    }
    std::fs::remove_file(from)
}

/// A part of a path from a note that may be followed: not `.`, not `..`, nothing a file name cannot hold.
fn safe_part(part: &str) -> bool {
    !(part.is_empty() || part == "." || part == ".." || part.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)))
}

/// The folder at `path` inside `root`, made where it is gone since; `.` and `..` are never followed (and
/// neither is anything that is not a plain folder name).
fn dir_at(root: &Path, path: &str) -> std::io::Result<PathBuf> {
    let mut here = root.to_path_buf();
    for part in path.split('/') {
        if !safe_part(part) {
            continue;
        }
        here.push(part);
        std::fs::create_dir_all(&here)?;
    }
    Ok(here)
}

fn reason(error: &std::io::Error) -> String {
    error.to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Into `Sondra-Papierkorb` at the top of `root`, from where `restore_binned` brings them back to the
/// folder they lay in. Nothing is lost on the way.
pub fn bin_files(root: &Path, files: &[FolderFile]) -> std::io::Result<(Vec<Binned>, Vec<Failure<FolderFile>>)> {
    let bin = root.join(BIN_NAME);
    std::fs::create_dir_all(&bin)?;
    let (mut binned, mut failed) = (Vec::new(), Vec::new());
    for file in files {
        let from = root.join(&file.path);
        let bin_name = free(&file.name, &bin);
        match relocate(&from, &bin.join(&bin_name)) {
            Ok(()) => binned.push(Binned { path: file.path.clone(), name: file.name.clone(), size: file.size, bin_name }),
            Err(e) => failed.push(Failure { item: file.clone(), reason: reason(&e) }),
        }
    }
    if !binned.is_empty() {
        let mut notes = read_notes(&bin);
        let at = now_ms();
        for item in &binned {
            notes.insert(item.bin_name.clone(), Note { path: item.path.clone(), at });
        }
        write_notes(&bin, &notes);
    }
    Ok((binned, failed))
}

/// Back where each lay; a name taken meanwhile gets a number, and nothing is overwritten.
pub fn restore_binned(root: &Path, binned: &[Binned]) -> (Vec<Binned>, Vec<Failure<Binned>>) {
    let bin = root.join(BIN_NAME);
    if !bin.is_dir() {
        return (Vec::new(), binned.iter().map(|b| Failure { item: b.clone(), reason: missing_bin() }).collect());
    }
    let (mut restored, mut failed) = (Vec::new(), Vec::new());
    for item in binned {
        let parent = match item.path.rsplit_once('/') {
            Some((dir, _)) => dir_at(root, dir),
            None => Ok(root.to_path_buf()),
        };
        let result = parent.and_then(|parent| {
            let back = free(&item.name, &parent);
            relocate(&bin.join(&item.bin_name), &parent.join(back))
        });
        match result {
            Ok(()) => restored.push(item.clone()),
            Err(e) => failed.push(Failure { item: item.clone(), reason: reason(&e) }),
        }
    }
    forget_notes(&bin, &restored.iter().map(|b| b.bin_name.clone()).collect::<Vec<_>>());
    (restored, failed)
}

/// Files in the bin; nothing if there is no bin yet.
pub fn count_bin(root: &Path) -> usize {
    let Ok(read) = std::fs::read_dir(root.join(BIN_NAME)) else { return 0 };
    read.filter_map(Result::ok).filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && e.file_name() != BIN_NOTES).count()
}

/// What lies in the bin, the last thrown away first.
pub fn list_bin(root: &Path) -> Vec<BinItem> {
    let bin = root.join(BIN_NAME);
    let Ok(read) = std::fs::read_dir(&bin) else { return Vec::new() };
    let notes = read_notes(&bin);
    let mut items = Vec::new();
    for entry in read.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == BIN_NOTES || !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
        let note = notes.get(&name);
        items.push(BinItem { size: meta.len(), modified, at: note.map(|n| n.at), from: note.map(|n| n.path.clone()), name });
    }
    items.sort_by(|a, b| {
        let key = |i: &BinItem| i.at.unwrap_or(i.modified);
        key(b).cmp(&key(a)).then_with(|| compare_de(&a.name, &b.name))
    });
    items
}

/// Back to the folder each lay in, also after the page was closed in between; a name taken meanwhile gets
/// a number.
pub fn restore_from_bin(root: &Path, items: &[BinItem]) -> (Vec<BinItem>, Vec<Failure<BinItem>>) {
    let bin = root.join(BIN_NAME);
    if !bin.is_dir() {
        return (Vec::new(), items.iter().map(|i| Failure { item: i.clone(), reason: missing_bin() }).collect());
    }
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for item in items {
        let (dir, original) = match item.from.as_deref().and_then(|f| f.rsplit_once('/')) {
            Some((dir, original)) => (dir, original),
            None => ("", item.from.as_deref().unwrap_or(&item.name)),
        };
        // A name from a note is followed only when it is a plain file name.
        let original = if safe_part(original) { original } else { item.name.as_str() };
        let result = dir_at(root, dir).and_then(|parent| {
            let back = free(original, &parent);
            relocate(&bin.join(&item.name), &parent.join(back))
        });
        match result {
            Ok(()) => done.push(item.clone()),
            Err(e) => failed.push(Failure { item: item.clone(), reason: reason(&e) }),
        }
    }
    forget_notes(&bin, &done.iter().map(|i| i.name.clone()).collect::<Vec<_>>());
    (done, failed)
}

/// For good; the only place Sondra deletes without a way back, and only on a click on exactly this.
pub fn erase_from_bin(root: &Path, items: &[BinItem]) -> (Vec<BinItem>, Vec<Failure<BinItem>>) {
    let bin = root.join(BIN_NAME);
    if !bin.is_dir() {
        return (Vec::new(), items.iter().map(|i| Failure { item: i.clone(), reason: missing_bin() }).collect());
    }
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for item in items {
        // Only a plain name inside the bin: a name that points out of it is never followed.
        if !safe_part(&item.name) {
            failed.push(Failure { item: item.clone(), reason: "Kein Name, den der Papierkorb kennt.".into() });
            continue;
        }
        match std::fs::remove_file(bin.join(&item.name)) {
            Ok(()) => done.push(item.clone()),
            Err(e) => failed.push(Failure { item: item.clone(), reason: reason(&e) }),
        }
    }
    forget_notes(&bin, &done.iter().map(|i| i.name.clone()).collect::<Vec<_>>());
    (done, failed)
}

/// Deleted for good, with no way back: only what the person said so for, and only inside the folder. A
/// path that points out of it (`..`, a drive letter) is refused. Every failure is said with its reason.
pub fn erase_files(root: &Path, files: &[FolderFile]) -> (Vec<FolderFile>, Vec<Failure<FolderFile>>) {
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for file in files {
        if !file.path.split('/').all(safe_part) {
            failed.push(Failure { item: file.clone(), reason: "Der Pfad liegt nicht in diesem Ordner.".into() });
            continue;
        }
        match std::fs::remove_file(root.join(&file.path)) {
            Ok(()) => done.push(file.clone()),
            Err(e) => failed.push(Failure { item: file.clone(), reason: reason(&e) }),
        }
    }
    (done, failed)
}
