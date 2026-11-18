//! What a round needs from the outside.

use std::io;
use std::path::{Path, PathBuf};

use sondra_core::merkliste::{Item, Online, Shared};
use sondra_core::plan::Want;
use sondra_core::schedule::Conditions;

/// Where the shared Merkliste comes from.
pub trait Library {
    fn read(&self) -> Result<Shared, String>;
}

/// Looks online for the newest episode of a series. `Ok(None)`: the site does
/// not say (not an error, and not "nothing new").
pub trait Checker {
    fn latest(&self, item: &Item) -> Result<Option<Online>, String>;
}

/// A file that has been fetched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedFile {
    pub path: PathBuf,
    pub size: u64,
}

pub trait Fetcher {
    /// Fetches one episode, no faster than `bandwidth_kib` KiB/s when given.
    fn fetch(&self, want: &Want, bandwidth_kib: Option<u32>) -> Result<FetchedFile, String>;
}

/// The Recycle Bin: files are put there, never erased.
pub trait Trash {
    fn trash(&self, path: &Path) -> io::Result<()>;
}

/// The computer: the clock and what it is plugged into.
pub trait Host {
    fn now_ms(&self) -> i64;
    fn conditions(&self) -> Conditions;
}
