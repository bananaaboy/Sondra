//! Where the Merkliste lives on this computer: one SQLite file in the format the website and the Windows
//! app write (`sondra-merk`), so a copy of it opens in all of them. A file that cannot be read is never
//! written over — whatever is in it is someone's list.

use std::path::{Path, PathBuf};

use sondra_merk::merge::Removed;
use sondra_merk::normalize::Context;
use sondra_merk::sqlite::{read_shared, write_sqlite, Snapshot};
use sondra_merk::Item;

pub struct MerkStore {
    path: PathBuf,
}

/// What reading the file gave.
pub enum Loaded {
    /// The list, as it was written (empty when there is no file yet).
    List(Snapshot),
    /// The file is there and is not a Merkliste (or could not be read); it stays untouched.
    Unreadable(String),
}

impl MerkStore {
    pub fn at(path: impl Into<PathBuf>) -> MerkStore {
        MerkStore { path: path.into() }
    }

    /// `Merkliste.sqlite` in Sondra's data folder: `SONDRA_DATA` if set, else the user's application data
    /// (`%APPDATA%\Sondra\native` on Windows, `$XDG_DATA_HOME/sondra` elsewhere).
    pub fn default_location() -> Option<MerkStore> {
        Some(MerkStore::at(data_dir()?.join("Merkliste.sqlite")))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Loaded {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::List(Snapshot::default()),
            Err(e) => return Loaded::Unreadable(format!("Die Merkliste konnte nicht gelesen werden: {e}")),
        };
        if bytes.is_empty() {
            return Loaded::List(Snapshot::default());
        }
        match read_shared(&bytes, &mut Context::system()) {
            Ok(snapshot) => Loaded::List(snapshot),
            Err(_) => Loaded::Unreadable("Die Datei ist keine Merkliste von Sondra. Sie bleibt, wie sie ist.".into()),
        }
    }

    /// Written to a neighbour first and put in place after, so a crash leaves the old list whole.
    pub fn save(&self, items: &[Item], removed: &Removed, app_state: &std::collections::BTreeMap<String, sondra_merk::sqlite::AppEntry>) -> std::io::Result<()> {
        let bytes = write_sqlite(&Snapshot {
            items: items.to_vec(),
            removed: removed.clone(),
            app_state: app_state.clone(),
        })
        .map_err(|e| std::io::Error::other(e.to_string()))?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let staged = self.path.with_extension("sqlite.neu");
        std::fs::write(&staged, bytes)?;
        std::fs::rename(&staged, &self.path)
    }
}

/// Sondra's data folder on this computer.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SONDRA_DATA") {
        return Some(PathBuf::from(dir));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("Sondra").join("native"));
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
        .map(|d| d.join("sondra"))
}

/// What the Ordner page remembers (`sondra-merk::folder_memory`), kept in one small JSON file: names to
/// text, the way `localStorage` keeps them on the web. Only a convenience — a file that cannot be read or
/// written just means the page forgets.
pub struct FileStore {
    path: PathBuf,
    map: std::collections::BTreeMap<String, String>,
}

impl FileStore {
    pub fn open(path: impl Into<PathBuf>) -> FileStore {
        let path = path.into();
        let map = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        FileStore { path, map }
    }

    pub fn default_location() -> Option<FileStore> {
        Some(FileStore::open(data_dir()?.join("Ordner.json")))
    }
}

impl sondra_merk::folder_memory::Store for FileStore {
    fn get_item(&self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }

    fn set_item(&mut self, key: &str, value: String) {
        self.map.insert(key.to_string(), value);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let staged = self.path.with_extension("json.neu");
        if serde_json::to_vec(&self.map).ok().is_some_and(|bytes| std::fs::write(&staged, bytes).is_ok()) {
            let _ = std::fs::rename(&staged, &self.path);
        }
    }
}
