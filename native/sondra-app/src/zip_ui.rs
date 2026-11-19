//! Packing files into one ZIP next to them: the archive of the website (`sondra-media::zip`, byte for byte), written
//! away from the window from the files on disk (never all in memory), named like the website names it, and never
//! over a ZIP that is already there.

use std::path::{Path, PathBuf};

use chrono::{Datelike, Local, TimeZone, Timelike};
use gpui::Context;
use sondra_media::run::unique_path;
use sondra_media::zip::{write_zip, zip_name, ZipFile};

use crate::shell::Shell;

/// The date a file carries into the archive: its own, as the clock of this computer shows it.
pub fn file_date(path: &Path) -> [u32; 6] {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    let local = modified.and_then(|d| Local.timestamp_opt(d.as_secs() as i64, 0).single()).unwrap_or_else(Local::now);
    [local.year().max(1980) as u32, local.month(), local.day(), local.hour(), local.minute(), local.second()]
}

/// Writes `files` (name inside, path) into a ZIP in `dir`, named from `suggestion` (a folder or a series: the name
/// the person would give it). Returns where it lies and how big it is.
pub fn pack(files: Vec<(String, PathBuf)>, dir: &Path, suggestion: &str) -> Result<(PathBuf, u64), String> {
    if files.is_empty() {
        return Err("Es gibt nichts zu packen.".into());
    }
    let (_, stem) = zip_name("", suggestion);
    let path = unique_path(dir, &stem, "zip");
    let entries: Vec<ZipFile> = files.into_iter().map(|(name, path)| ZipFile { date: file_date(&path), name, path }).collect();
    let part = path.with_extension("zip.teil");
    let result = (|| -> std::io::Result<u64> {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&part)?);
        write_zip(&mut out, &entries)?;
        std::io::Write::flush(&mut out)?;
        drop(out);
        std::fs::rename(&part, &path)?;
        Ok(std::fs::metadata(&path)?.len())
    })();
    match result {
        Ok(bytes) => Ok((path, bytes)),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(format!("Das ZIP konnte nicht geschrieben werden: {e}"))
        }
    }
}

impl Shell {
    /// Packs in the background; `then` gets the answer.
    pub(crate) fn pack_in_background(cx: &mut Context<Self>, files: Vec<(String, PathBuf)>, dir: PathBuf, suggestion: String, then: impl FnOnce(&mut Shell, Result<(PathBuf, u64), String>, &mut Context<Shell>) + 'static) {
        Self::in_background(cx, move || pack(files, &dir, &suggestion), then);
    }
}
