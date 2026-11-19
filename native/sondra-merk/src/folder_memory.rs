//! What the Ordner page remembers about a folder on this device: how it was set (order, tiles or list,
//! groups) and when it was last looked at — the web app's `src/lib/folderMemory.ts`, same keys, same
//! limits, same answers. Nothing about the files themselves.
//!
//! Keyed by where the folder came from and its name, kept to the most recent few, so a lot of folders
//! never fill the storage. The tables are read and written in insertion order, as the web app does, so
//! the oldest entry is the first one.

use std::collections::{HashMap, HashSet};

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// A place that keeps strings by name: `localStorage` on the web, a file or the registry here.
pub trait Store {
    fn get_item(&self, key: &str) -> Option<String>;
    fn set_item(&mut self, key: &str, value: String);
}

/// A store in memory, for tests and for a first run.
#[derive(Default, Debug, Clone)]
pub struct MemoryStore(pub HashMap<String, String>);

impl Store for MemoryStore {
    fn get_item(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
    fn set_item(&mut self, key: &str, value: String) {
        self.0.insert(key.to_string(), value);
    }
}

/// The last settings: what a folder looked at for the first time starts with.
pub const PREFS_KEY: &str = "sondra:ordner";
const PER_FOLDER: &str = "sondra:ordner:je";
const VISITS: &str = "sondra:ordner:besuch";
/// Folders remembered; the oldest are forgotten first.
pub const KEEP: usize = 40;

/// A JSON object whose keys keep the order they were written in.
#[derive(Default, Debug, Clone, PartialEq)]
struct Table(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Table {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Table;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Table, A::Error> {
                let mut out: Vec<(String, Value)> = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    // A repeated key keeps its first place and its last value, as an object does.
                    match out.iter_mut().find(|(name, _)| *name == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(Table(out))
            }
        }
        d.deserialize_map(V)
    }
}

impl Table {
    fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn to_json(&self) -> String {
        let mut out = String::from("{");
        for (i, (k, v)) in self.0.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(k).unwrap_or_default());
            out.push(':');
            out.push_str(&serde_json::to_string(v).unwrap_or_default());
        }
        out.push('}');
        out
    }

    /// The key put last, the oldest ones gone beyond `KEEP`.
    fn put(&self, key: &str, value: Value) -> Table {
        let mut next: Vec<(String, Value)> = self.0.iter().filter(|(k, _)| k != key).cloned().collect();
        next.push((key.to_string(), value));
        let over = next.len().saturating_sub(KEEP);
        next.drain(..over);
        Table(next)
    }
}

/// A missing, broken or not-an-object value reads as an empty table.
fn read_table(store: &dyn Store, key: &str) -> Table {
    let text = store.get_item(key).unwrap_or_else(|| "{}".into());
    serde_json::from_str::<Table>(&text).unwrap_or_default()
}

fn write_table(store: &mut dyn Store, key: &str, table: &Table) {
    store.set_item(key, table.to_json());
}

/// A folder's key: this device's or Drive's, and its name.
pub fn folder_key(name: &str, drive: bool) -> String {
    format!("{}:{}", if drive { "drive" } else { "geraet" }, name)
}

/// The settings of this folder over the last ones used anywhere, over the defaults. Only the names the
/// defaults know come back: a key from some other version is dropped.
pub fn prefs_for(defaults: &Map<String, Value>, key: &str, store: &dyn Store) -> Map<String, Value> {
    let last: Option<Map<String, Value>> = match serde_json::from_str::<Value>(&store.get_item(PREFS_KEY).unwrap_or_else(|| "{}".into())) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    };
    let mine = read_table(store, PER_FOLDER).get(key).and_then(|v| v.as_object().cloned());
    let mut out = Map::new();
    for (name, default) in defaults {
        let value = mine
            .as_ref()
            .and_then(|m| m.get(name))
            .or_else(|| last.as_ref().and_then(|m| m.get(name)))
            .unwrap_or(default);
        out.insert(name.clone(), value.clone());
    }
    out
}

/// The settings just chosen: for this folder, and as the start for the next one.
pub fn save_prefs(key: Option<&str>, prefs: &Map<String, Value>, store: &mut dyn Store) {
    store.set_item(PREFS_KEY, serde_json::to_string(prefs).unwrap_or_default());
    if let Some(key) = key {
        let table = read_table(store, PER_FOLDER).put(key, Value::Object(prefs.clone()));
        write_table(store, PER_FOLDER, &table);
    }
}

/// What each folder's last visit was *before* this session came to it.
#[derive(Default, Debug)]
pub struct Session {
    start: HashMap<String, Option<f64>>,
    seen: HashSet<String>,
}

/// The time of the visit before this one, or `None` for a first one; the visit just starting is written
/// down. Asked again in the same session it gives the same answer — leaving the tab and coming back is no
/// new visit.
pub fn last_visit(key: &str, now: f64, store: &mut dyn Store, session: &mut Session) -> Option<f64> {
    if session.seen.contains(key) {
        return session.start.get(key).copied().flatten();
    }
    let table = read_table(store, VISITS);
    let before = table.get(key).and_then(|v| v.as_f64());
    session.seen.insert(key.to_string());
    session.start.insert(key.to_string(), before);
    // A whole number is written as one, the way JSON.stringify writes it.
    let stamp = if now.fract() == 0.0 && now.abs() < 9_007_199_254_740_992.0 {
        Value::Number(serde_json::Number::from(now as i64))
    } else {
        serde_json::Number::from_f64(now).map(Value::Number).unwrap_or(Value::Null)
    };
    let next = table.put(key, stamp);
    write_table(store, VISITS, &next);
    before
}
