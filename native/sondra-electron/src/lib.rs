//! What the Windows app (Electron) left behind, so a person can take their Merkliste and settings along.
//!
//! The Windows app is a Chromium, and Chromium keeps a page's `localStorage` in a LevelDB folder
//! (`%APPDATA%\Sondra\Local Storage\leveldb`). That folder is read here — copied first, so a Sondra that is
//! still running keeps its lock and its files — and the keys the web app writes are taken out of it:
//!
//! * the Merkliste (`sondra:sqlite_db`, a SQLite file as base64, or `sondra:saved_links`, the same list as
//!   JSON when that is the newer — the app marks it with `sondra:sqlite_db_stale`), with what was removed;
//! * what the Ordner and Player pages remember, and the person's own conversion templates.
//!
//! Chromium's format: a key is `_` + origin + `\0` + a format byte (`1` Latin-1, `0` UTF-16) + the name; a
//! value is a format byte + its text the same way. Nothing is ever written to the old folder.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use rusty_leveldb::{LdbIterator, Options, DB};

/// The keys of the web app that other pages of this program keep too, by the file they live in.
pub const ORDNER_KEYS: [&str; 4] = ["sondra:ordner", "sondra:ordner:je", "sondra:ordner:besuch", "sondra:ordner:ignoriert"];
pub const PLAYER_KEYS: [&str; 4] = ["sondra:abspielen", "sondra:abspielen:stellen", "sondra:abspielen:marken", "sondra:pausieren-beim-minimieren"];
pub const CONVERT_KEY: &str = "sondra:umwandeln:vorlagen";

const SQLITE_KEY: &str = "sondra:sqlite_db";
const STALE_KEY: &str = "sondra:sqlite_db_stale";
const LINKS_KEY: &str = "sondra:saved_links";
const REMOVED_KEY: &str = "sondra:merkliste_removed";

/// The text of a stored value or key part: the format byte, then Latin-1 or UTF-16 (little endian).
pub fn chromium_text(bytes: &[u8]) -> Option<String> {
    let (format, rest) = bytes.split_first()?;
    match format {
        1 => Some(rest.iter().map(|b| char::from(*b)).collect()),
        0 if rest.len() % 2 == 0 => {
            let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// Everything in a localStorage database, by origin: origin → name → value.
pub type Storage = BTreeMap<String, BTreeMap<String, String>>;

/// Reads the localStorage database in `dir`, from a copy of its files.
pub fn read_storage(dir: &Path) -> io::Result<Storage> {
    let copy = tempfile::tempdir()?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        // The lock stays where it is; a copy needs none of its own.
        if entry.file_type()?.is_file() && name != "LOCK" {
            std::fs::copy(entry.path(), copy.path().join(&name))?;
        }
    }
    let mut options = Options::default();
    options.create_if_missing = false;
    let mut db = DB::open(copy.path(), options).map_err(|e| io::Error::other(e.to_string()))?;
    let mut iter = db.new_iter().map_err(|e| io::Error::other(e.to_string()))?;
    let mut out = Storage::new();
    let (mut key, mut value) = (Vec::new(), Vec::new());
    while iter.advance() {
        iter.current(&mut key, &mut value);
        // `_origin\0<format><name>`; META and VERSION entries are not storage.
        let Some(rest) = key.strip_prefix(b"_") else { continue };
        let Some(split) = rest.iter().position(|b| *b == 0) else { continue };
        let (Ok(origin), Some(name), Some(text)) = (std::str::from_utf8(&rest[..split]), chromium_text(&rest[split + 1..]), chromium_text(&value)) else { continue };
        out.entry(origin.to_owned()).or_default().insert(name, text);
    }
    Ok(out)
}

/// What a person's old app had, in the shapes this program takes.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Found {
    /// Where it came from (the page's address, which says the port the app ran on).
    pub origin: String,
    /// The Merkliste as a file `read_merkliste_file` reads: a SQLite database, or JSON with `items` and `removed`.
    pub merkliste: Option<Vec<u8>>,
    /// How many series that is.
    pub series: usize,
    pub ordner: BTreeMap<String, String>,
    pub player: BTreeMap<String, String>,
    pub templates: Option<String>,
}

impl Found {
    pub fn is_empty(&self) -> bool {
        self.merkliste.is_none() && self.ordner.is_empty() && self.player.is_empty() && self.templates.is_none()
    }
}

fn pick(values: &BTreeMap<String, String>, keys: &[&str]) -> BTreeMap<String, String> {
    keys.iter().filter_map(|k| values.get(*k).filter(|v| !v.is_empty()).map(|v| ((*k).to_owned(), v.clone()))).collect()
}

/// The Merkliste out of what one page stored: the SQLite copy, unless the JSON is the newer.
fn merkliste_of(values: &BTreeMap<String, String>) -> Option<(Vec<u8>, usize)> {
    let stale = values.get(STALE_KEY).is_some_and(|v| !v.is_empty() && v != "0" && v != "false");
    if !stale {
        if let Some(bytes) = values.get(SQLITE_KEY).and_then(|b| base64::engine::general_purpose::STANDARD.decode(b.trim()).ok()).filter(|b| b.starts_with(b"SQLite format 3\0")) {
            // The number of series is counted by the reader of the file; a rough count here would only mislead.
            return Some((bytes, 0));
        }
    }
    let items: serde_json::Value = serde_json::from_str(values.get(LINKS_KEY)?).ok()?;
    let list = items.as_array()?;
    if list.is_empty() {
        return None;
    }
    let removed: serde_json::Value = values.get(REMOVED_KEY).and_then(|r| serde_json::from_str(r).ok()).unwrap_or_else(|| serde_json::json!({}));
    let file = serde_json::json!({ "kind": "sondra-merkliste", "version": 2, "items": list, "removed": removed });
    Some((serde_json::to_vec(&file).ok()?, list.len()))
}

/// What the storage holds of the web app. Of several origins (the app ran on another port once) the one with
/// the most is taken — a list and settings never come half from one and half from another.
pub fn found_in(storage: &Storage) -> Found {
    let mut best = Found::default();
    let mut best_weight = 0usize;
    for (origin, values) in storage {
        let merk = merkliste_of(values);
        let found = Found {
            origin: origin.clone(),
            series: merk.as_ref().map_or(0, |m| m.1),
            merkliste: merk.map(|m| m.0),
            ordner: pick(values, &ORDNER_KEYS),
            player: pick(values, &PLAYER_KEYS),
            templates: values.get(CONVERT_KEY).filter(|v| !v.is_empty() && *v != "[]").cloned(),
        };
        let weight = found.merkliste.as_ref().map_or(0, |m| m.len() + 1) + found.ordner.len() + found.player.len() + usize::from(found.templates.is_some());
        if weight > best_weight {
            best_weight = weight;
            best = found;
        }
    }
    best
}

/// Where the Windows app keeps its localStorage: `%APPDATA%\Sondra` (installed) and `%APPDATA%\Sondra Portabel`
/// (the portable one without a folder of its own), the folders that exist.
pub fn default_dirs() -> Vec<PathBuf> {
    let Some(appdata) = std::env::var_os("APPDATA") else { return Vec::new() };
    ["Sondra", "Sondra Portabel"].iter().map(|n| PathBuf::from(&appdata).join(n).join("Local Storage").join("leveldb")).filter(|p| p.is_dir()).collect()
}

/// Reads one folder and says what is in it.
pub fn find(dir: &Path) -> io::Result<Found> {
    Ok(found_in(&read_storage(dir)?))
}

/// What one key holds after taking over the old app's value, without ever undoing what is set here: objects get
/// the entries they lack (what is there stays), lists get the items they lack, anything else stays as it is and
/// only an empty place takes the old value.
pub fn merge_value(existing: Option<&str>, incoming: &str) -> String {
    use serde_json::Value;
    let Some(existing) = existing.filter(|e| !e.trim().is_empty()) else { return incoming.to_owned() };
    let (Ok(mine), Ok(theirs)) = (serde_json::from_str::<Value>(existing), serde_json::from_str::<Value>(incoming)) else { return existing.to_owned() };
    let merged = match (mine, theirs) {
        (Value::Object(mut mine), Value::Object(theirs)) => {
            for (key, value) in theirs {
                mine.entry(key).or_insert(value);
            }
            Value::Object(mine)
        }
        (Value::Array(mut mine), Value::Array(theirs)) => {
            for value in theirs {
                if !mine.contains(&value) {
                    mine.push(value);
                }
            }
            Value::Array(mine)
        }
        (mine, _) => mine,
    };
    merged.to_string()
}

/// For tests: a localStorage database in Chromium's shape, with these values for this origin (a small write
/// buffer forces real tables, with snappy blocks, as a Chromium that has been running for a while has).
#[doc(hidden)]
pub fn write_fixture(dir: &Path, origin: &str, values: &[(&str, &str)]) -> io::Result<()> {
    let latin1 = |text: &str| -> Option<Vec<u8>> { text.chars().all(|c| (c as u32) < 256).then(|| std::iter::once(1u8).chain(text.chars().map(|c| c as u32 as u8)).collect()) };
    let utf16 = |text: &str| -> Vec<u8> { std::iter::once(0u8).chain(text.encode_utf16().flat_map(u16::to_le_bytes)).collect() };
    let mut options = Options::default();
    options.write_buffer_size = 2048;
    options.compressor = 1;
    let mut db = DB::open(dir, options).map_err(|e| io::Error::other(e.to_string()))?;
    db.put(b"VERSION", b"1").map_err(|e| io::Error::other(e.to_string()))?;
    for (name, value) in values {
        let mut key = format!("_{origin}\0").into_bytes();
        key.extend(latin1(name).unwrap_or_else(|| utf16(name)));
        db.put(&key, &latin1(value).unwrap_or_else(|| utf16(value))).map_err(|e| io::Error::other(e.to_string()))?;
    }
    db.flush().map_err(|e| io::Error::other(e.to_string()))?;
    db.close().map_err(|e| io::Error::other(e.to_string()))
}
