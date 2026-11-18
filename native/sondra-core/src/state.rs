//! What the service has done, kept apart from the shared Merkliste.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::merkliste::Online;

/// A file the service fetched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub series_id: String,
    pub season: u32,
    pub episode: u32,
    pub path: PathBuf,
    pub size: u64,
    /// Unix milliseconds.
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub fetched: Vec<Fetched>,
    /// The newest episode this computer found online, per series. Kept here,
    /// not in the shared list, which this service only reads.
    pub online: BTreeMap<String, Online>,
}

impl State {
    pub fn has(&self, series_id: &str, season: u32, episode: u32) -> bool {
        self.fetched
            .iter()
            .any(|f| f.series_id == series_id && f.season == season && f.episode == episode)
    }

    pub fn record(&mut self, file: Fetched) {
        self.fetched.retain(|f| {
            !(f.series_id == file.series_id && f.season == file.season && f.episode == file.episode)
        });
        self.fetched.push(file);
    }

    pub fn forget(&mut self, path: &Path) {
        self.fetched.retain(|f| f.path != path);
    }

    pub fn total_size(&self) -> u64 {
        self.fetched.iter().map(|f| f.size).sum()
    }

    /// Reads the state; a missing file is an empty state, a broken one an error.
    pub fn load(path: &Path) -> io::Result<State> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e),
        }
    }

    /// Writes the state so that a crash leaves the old file or the new one,
    /// never half of each.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(&temp, path)
    }
}
