//! Reading a folder on this computer into the list the Ordner page works on — what `scanHandle` does in
//! the browser: every file below it, the folders on the way (empty ones too), hidden files and the ones a
//! system leaves behind left out, and a stop at `SCAN_LIMIT` files, said out loud.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::folder::{is_skipped, kind_from_mime, FolderFile, FolderScan, SCAN_LIMIT};

/// The folder at `root` and everything in it. `cancel` stops it between two entries (what has been read
/// is thrown away: `Err(Interrupted)`); `progress` is told the file count every two hundred files.
pub fn scan_dir(root: &Path, cancel: &AtomicBool, progress: impl FnMut(usize)) -> std::io::Result<FolderScan> {
    scan_dir_limited(root, SCAN_LIMIT, cancel, progress)
}

pub fn scan_dir_limited(root: &Path, limit: usize, cancel: &AtomicBool, mut progress: impl FnMut(usize)) -> std::io::Result<FolderScan> {
    let name = root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
    let mut scan = FolderScan { name, dirs: vec![String::new()], ..FolderScan::default() };
    // The root must be readable: a folder that is not there is an error, one below it that cannot be
    // opened is simply not shown.
    std::fs::read_dir(root)?;
    walk(root, "", limit, cancel, &mut progress, &mut scan)?;
    progress(scan.files.len());
    Ok(scan)
}

fn walk(dir: &Path, prefix: &str, limit: usize, cancel: &AtomicBool, progress: &mut impl FnMut(usize), scan: &mut FolderScan) -> std::io::Result<()> {
    let Ok(read) = std::fs::read_dir(dir) else { return Ok(()) };
    // A stable order, so the same folder is read the same way twice.
    let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "abgebrochen"));
        }
        if scan.files.len() >= limit {
            scan.truncated = true;
            return Ok(());
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if is_skipped(&file_name) {
            continue;
        }
        let path = if prefix.is_empty() { file_name.clone() } else { format!("{prefix}/{file_name}") };
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            scan.dirs.push(path.clone());
            walk(&entry.path(), &path, limit, cancel, progress, scan)?;
        } else if kind.is_file() || (kind.is_symlink() && entry.path().is_file()) {
            // Locked or gone since the listing: not shown.
            let Ok(meta) = entry.metadata().or_else(|_| std::fs::metadata(entry.path())) else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            scan.files.push(FolderFile {
                dir: prefix.to_string(),
                kind: kind_from_mime("", &file_name),
                name: file_name,
                path,
                size: meta.len(),
                modified,
                drive: None,
            });
            if scan.files.len() % 200 == 0 {
                progress(scan.files.len());
            }
        }
    }
    Ok(())
}
