//! What the person has chosen for the background service.
//!
//! Everything is off until chosen: no series is fetched on its own, no file
//! is ever deleted, the computer is not kept awake.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Whether the service keeps the computer from going to sleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwake {
    /// Never; Windows decides.
    #[default]
    Off,
    /// Only while something is being fetched.
    WhileFetching,
    /// As long as the service runs. The lid closing is still Windows' to decide.
    Always,
}

/// A daily window, in whole hours of local time. `from > to` crosses midnight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub from: u8,
    pub to: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// The series that may be fetched on their own, by their id in the Merkliste.
    pub auto_series: BTreeSet<String>,
    /// How many unseen episodes to keep ready on this computer.
    pub ahead: u32,
    /// Above this many GB of fetched files, the oldest *seen* ones go to the
    /// Recycle Bin. `None`: nothing is ever deleted.
    pub storage_limit_gb: Option<u32>,
    pub keep_awake: KeepAwake,
    pub only_on_ac: bool,
    pub only_unmetered: bool,
    pub window: Option<Window>,
    /// Slows the fetching down to this many KiB per second.
    pub bandwidth_kib: Option<u32>,
    /// How often the list is checked for new episodes.
    pub check_every_minutes: u32,
    /// Shut the computer down once nothing is left to fetch. Off unless chosen.
    pub shutdown_when_done: bool,
    /// Where fetched episodes go, as `<folder>/<series>/Staffel n`. Nothing is fetched until one is
    /// chosen.
    pub folder: Option<String>,
    /// The language to prefer (`"ger_sub"`, `"ger_dub"`, `"eng_sub"`); empty takes what the site offers
    /// first.
    pub language: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            auto_series: BTreeSet::new(),
            ahead: 3,
            storage_limit_gb: None,
            keep_awake: KeepAwake::Off,
            only_on_ac: false,
            only_unmetered: false,
            window: None,
            bandwidth_kib: None,
            check_every_minutes: 180,
            shutdown_when_done: false,
            folder: None,
            language: String::new(),
        }
    }
}

impl Config {
    pub fn storage_limit_bytes(&self) -> Option<u64> {
        self.storage_limit_gb
            .map(|gb| u64::from(gb) * 1024 * 1024 * 1024)
    }
}
