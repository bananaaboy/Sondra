//! Files from one device to another: the parts of the protocol that are not the connection. A port of the
//! pure parts of `src/lib/deviceTransfer.ts`, with the messages of the wire (`start`, `ready`, `file`, `end`,
//! `done`, `ack`, `saved`, `cancel`, `error`) as one type that reads and writes the same JSON.
//!
//! In order: `start` (what comes), `ready` (the other side has a place for it), then per file `file`, its
//! bytes in 64 KB pieces, `end`; then `done`, and the receiver answers `saved` with where each file went.
//! The receiver says every 4 MB how far it got (`ack`); the sender stays at most 16 MB ahead of that.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The size of one piece of a file on the wire.
pub const CHUNK: usize = 64 * 1024;
/// The receiver says how far it got this often.
pub const ACK_EVERY: u64 = 4 * 1024 * 1024;
/// The sender stays at most this far ahead of the last answer.
pub const AHEAD: u64 = 16 * 1024 * 1024;

/// What is sent about each file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// Where it lay in a folder that was sent, `/`-separated and with the name last; absent for a single file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// The control messages of a transfer, as the other side reads them (`t` names the kind).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Control {
    Start {
        files: Vec<FileInfo>,
    },
    /// `done`: files the receiver has whole; `from`: how far it got with the others (bytes; the keys are the
    /// indexes as JSON writes object keys, as text).
    Ready {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        done: Option<Vec<usize>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<BTreeMap<String, u64>>,
    },
    File {
        i: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    End {
        i: usize,
    },
    Done,
    Ack {
        bytes: u64,
    },
    Saved {
        places: Vec<String>,
    },
    Cancel,
    Error {
        message: String,
    },
}

impl Control {
    /// The text that goes over the wire.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("a control message is JSON")
    }

    /// A message from the other side; text that is not one is `None`.
    pub fn from_text(text: &str) -> Option<Control> {
        serde_json::from_str(text).ok()
    }
}

/// „Film (2).mp4“ when „Film.mp4“ is taken.
pub fn free_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    // `lastIndexOf('.')` counts UTF-16 units, `dot > 0` keeps a name that is only an extension whole.
    let dot = name.rfind('.').filter(|d| *d > 0);
    let (stem, ext) = match dot {
        Some(d) => (&name[..d], &name[d..]),
        None => (name, ""),
    };
    for n in 2..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{stem} ({millis}){ext}")
}

/// A file name as every system takes it: no slashes, no reserved characters, at most 180 characters.
pub fn safe_file_name(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if matches!(c as u32, 0..=0x1f | 0x7f) || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    // `^[.\s]+|[.\s]+$` : dots and whitespace at both ends go.
    let trimmed = replaced.trim_matches(|c: char| c == '.' || c.is_whitespace() || c == '\u{feff}');
    // `slice(0, 180)` counts UTF-16 units.
    let mut units = 0;
    let mut out = String::new();
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > 180 {
            break;
        }
        out.push(c);
    }
    if out.is_empty() {
        "Datei".into()
    } else {
        out
    }
}

/// Most folder levels a received folder keeps.
const PATH_DEPTH: usize = 8;

/// A path as it came from the other device, made safe to build on disk: each part cleaned like a file name,
/// nothing that climbs out (`..`) or stands for where it is (`.`), no absolute start, at most eight levels.
/// Returns (the folder part, `/`-separated and maybe empty; the file's name).
pub fn split_path(path: Option<&str>, fallback: &str) -> (String, String) {
    let mut parts: Vec<String> = path
        .unwrap_or("")
        .split('/')
        .map(|p| p.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .map(safe_file_name)
        .take(PATH_DEPTH + 1)
        .collect();
    match parts.pop() {
        None => (String::new(), safe_file_name(fallback)),
        Some(name) => (parts.join("/"), name),
    }
}
