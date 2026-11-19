//! The list as the SQLite 3 file in Drive (`Sondra-Merkliste.sqlite`, `src/lib/sqlite.ts`) and as the older
//! JSON file (`Sondra-Merkliste.json`): both ways in and the one way out. The tables are the web app's —
//! the same `CREATE TABLE` text, the same columns, the same order — so a file written here opens there and
//! the other way round; the checks in CI do both.

use std::collections::BTreeMap;
use std::io::Write;

use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::merge::{shared_key, travelling, Removed};
use crate::model::Item;
use crate::normalize::{normalize, Context};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the file is no Merkliste")]
    NotAMerkliste,
    #[error("the database could not be read or written: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("the file could not be staged: {0}")]
    Io(#[from] std::io::Error),
}

/// A value of the app's own state kept beside the list (the last view, the sort order, …).
#[derive(Debug, Clone, PartialEq)]
pub struct AppEntry {
    pub value: Value,
    pub updated_at: i64,
}

/// What a file holds, entries still as they were stored (`normalize` makes them whole).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RawSnapshot {
    pub items: Vec<Value>,
    pub removed: Removed,
    pub app_state: BTreeMap<String, AppEntry>,
}

/// What a file holds, entries read and made whole.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Snapshot {
    pub items: Vec<Item>,
    pub removed: Removed,
    pub app_state: BTreeMap<String, AppEntry>,
}

const CREATE_ITEMS: &str = "CREATE TABLE merkliste_items (id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, language TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER, mode TEXT NOT NULL, audio_format TEXT NOT NULL, video_pref TEXT NOT NULL, audio_pref TEXT NOT NULL, auto_transcribe INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT, last_opened_at INTEGER, cover TEXT, cover_frame_json TEXT, tile_format TEXT, notes TEXT, rating REAL, episode_duration INTEGER, film_duration INTEGER, durations_json TEXT, tags_json TEXT, online_available_json TEXT, opening REAL, intros_json TEXT, goal_json TEXT, sort_order INTEGER NOT NULL)";
const CREATE_SEASONS: &str = "CREATE TABLE merkliste_seasons (item_id TEXT NOT NULL, season_number INTEGER NOT NULL, episodes INTEGER, watched_json TEXT NOT NULL, title TEXT, cover TEXT, cover_frame_json TEXT, parts_json TEXT, sort_order INTEGER NOT NULL)";
const CREATE_HISTORY: &str = "CREATE TABLE merkliste_history (entry_id TEXT NOT NULL, item_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, watched_at INTEGER NOT NULL, sort_order INTEGER NOT NULL)";
const CREATE_REMOVALS: &str =
    "CREATE TABLE merkliste_removals (item_id TEXT NOT NULL, removed_at INTEGER NOT NULL)";
const CREATE_APP_STATE: &str =
    "CREATE TABLE app_state (key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)";

/* Reading ------------------------------------------------------------------------------------- */

fn number(value: ValueRef) -> Option<Value> {
    match value {
        ValueRef::Integer(i) => Some(json!(i)),
        ValueRef::Real(f) => Some(if f.fract() == 0.0 && f.abs() < 9e15 {
            json!(f as i64)
        } else {
            json!(f)
        }),
        _ => None,
    }
}

fn text(value: ValueRef) -> Option<String> {
    match value {
        ValueRef::Text(bytes) => String::from_utf8(bytes.to_vec()).ok(),
        _ => None,
    }
}

/// `safeJsonParse`: text that is JSON, or nothing.
fn json_of(value: ValueRef) -> Option<Value> {
    let t = text(value)?;
    if t.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&t).ok()
}

fn as_string(value: ValueRef) -> Option<String> {
    match value {
        ValueRef::Text(_) => text(value),
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(f.to_string()),
        _ => None,
    }
}

/// The file as the web app's `deserializeSondraSqlite` reads it.
pub fn read_sqlite_raw(bytes: &[u8]) -> Result<RawSnapshot, Error> {
    // SQLite opens files, not buffers: stage the bytes and open them read-only.
    let mut staged = tempfile::NamedTempFile::new()?;
    staged.write_all(bytes)?;
    staged.flush()?;
    let db = Connection::open_with_flags(staged.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    // A file that is a database but no Merkliste has none of the tables.
    let has = |name: &str| -> bool {
        db.query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [name],
            |_| Ok(()),
        )
        .is_ok()
    };
    if !has("merkliste_items") {
        return Err(Error::NotAMerkliste);
    }

    let mut seasons: BTreeMap<String, Vec<(i64, Value)>> = BTreeMap::new();
    if has("merkliste_seasons") {
        let mut q = db.prepare("SELECT item_id, season_number, episodes, watched_json, title, cover, cover_frame_json, parts_json, sort_order FROM merkliste_seasons")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let item_id = r.get_ref(0).ok().and_then(as_string).unwrap_or_default();
            if item_id.is_empty() {
                continue;
            }
            let mut season = Map::new();
            season.insert(
                "number".into(),
                r.get_ref(1).ok().and_then(number).unwrap_or(json!(1)),
            );
            season.insert(
                "episodes".into(),
                r.get_ref(2).ok().and_then(number).unwrap_or(Value::Null),
            );
            season.insert(
                "watched".into(),
                r.get_ref(3).ok().and_then(json_of).unwrap_or(json!([])),
            );
            if let Some(t) = r.get_ref(4).ok().and_then(text).filter(|t| !t.is_empty()) {
                season.insert("title".into(), json!(t));
            }
            if let Some(t) = r.get_ref(5).ok().and_then(text).filter(|t| !t.is_empty()) {
                season.insert("cover".into(), json!(t));
            }
            if let Some(frame) = r.get_ref(6).ok().and_then(json_of).filter(Value::is_object) {
                season.insert("coverFrame".into(), frame);
            }
            if let Some(parts) = r.get_ref(7).ok().and_then(json_of).filter(Value::is_array) {
                season.insert("parts".into(), parts);
            }
            let order = r
                .get_ref(8)
                .ok()
                .and_then(number)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            seasons
                .entry(item_id)
                .or_default()
                .push((order, Value::Object(season)));
        }
    }

    let mut history: BTreeMap<String, Vec<(i64, Value)>> = BTreeMap::new();
    if has("merkliste_history") {
        let mut q = db.prepare("SELECT entry_id, item_id, season, episode, watched_at, sort_order FROM merkliste_history")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let item_id = r.get_ref(1).ok().and_then(as_string).unwrap_or_default();
            if item_id.is_empty() {
                continue;
            }
            let entry = json!({
                "id": r.get_ref(0).ok().and_then(as_string).unwrap_or_default(),
                "season": r.get_ref(2).ok().and_then(number).unwrap_or(json!(1)),
                "episode": r.get_ref(3).ok().and_then(number).unwrap_or(json!(1)),
                "at": r.get_ref(4).ok().and_then(number).unwrap_or(json!(0)),
            });
            let order = r
                .get_ref(5)
                .ok()
                .and_then(number)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            history.entry(item_id).or_default().push((order, entry));
        }
    }

    let mut rows_out: Vec<(i64, Value)> = Vec::new();
    {
        let mut q = db.prepare("SELECT id, url, title, language, season, episode, mode, audio_format, video_pref, audio_pref, auto_transcribe, updated_at, status, last_opened_at, cover, cover_frame_json, tile_format, notes, rating, episode_duration, film_duration, durations_json, tags_json, online_available_json, opening, intros_json, goal_json, sort_order FROM merkliste_items")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let get = |i: usize| r.get_ref(i).ok();
            let id = get(0).and_then(as_string).unwrap_or_default();
            let mut item = Map::new();
            item.insert("id".into(), json!(id));
            item.insert(
                "url".into(),
                json!(get(1).and_then(as_string).unwrap_or_default()),
            );
            item.insert(
                "title".into(),
                json!(get(2)
                    .and_then(as_string)
                    .unwrap_or_else(|| "Ohne Namen".into())),
            );
            item.insert(
                "language".into(),
                json!(get(3).and_then(as_string).unwrap_or_else(|| "auto".into())),
            );
            item.insert("season".into(), get(4).and_then(number).unwrap_or(json!(1)));
            item.insert(
                "episode".into(),
                get(5).and_then(number).unwrap_or(Value::Null),
            );
            item.insert(
                "mode".into(),
                json!(if get(6).and_then(text).as_deref() == Some("audio") {
                    "audio"
                } else {
                    "video"
                }),
            );
            item.insert(
                "audioFormat".into(),
                json!(get(7).and_then(as_string).unwrap_or_else(|| "mp3".into())),
            );
            item.insert(
                "videoPref".into(),
                json!(get(8)
                    .and_then(as_string)
                    .unwrap_or_else(|| "untouched".into())),
            );
            item.insert(
                "audioPref".into(),
                json!(get(9).and_then(as_string).unwrap_or_else(|| "high".into())),
            );
            item.insert(
                "autoTranscribe".into(),
                json!(
                    matches!(get(10), Some(ValueRef::Integer(i)) if i != 0)
                        || matches!(get(10), Some(ValueRef::Real(f)) if f != 0.0)
                ),
            );
            item.insert(
                "updatedAt".into(),
                get(11).and_then(number).unwrap_or(json!(0)),
            );
            let put_text = |item: &mut Map<String, Value>, key: &str, i: usize| {
                if let Some(t) = get(i).and_then(text).filter(|t| !t.is_empty()) {
                    item.insert(key.into(), json!(t));
                }
            };
            let put_number = |item: &mut Map<String, Value>, key: &str, i: usize| {
                if let Some(n) = get(i).and_then(number) {
                    item.insert(key.into(), n);
                }
            };
            put_text(&mut item, "status", 12);
            put_number(&mut item, "lastOpenedAt", 13);
            put_text(&mut item, "cover", 14);
            if let Some(f) = get(15).and_then(json_of).filter(Value::is_object) {
                item.insert("coverFrame".into(), f);
            }
            put_text(&mut item, "tileFormat", 16);
            put_text(&mut item, "notes", 17);
            put_number(&mut item, "rating", 18);
            put_number(&mut item, "episodeDuration", 19);
            put_number(&mut item, "filmDuration", 20);
            if let Some(d) = get(21).and_then(json_of).filter(Value::is_object) {
                item.insert("durations".into(), d);
            }
            if let Some(t) = get(22).and_then(json_of).filter(Value::is_array) {
                item.insert("tags".into(), t);
            }
            if let Some(o) = get(23).and_then(json_of).filter(Value::is_object) {
                item.insert("onlineAvailable".into(), o);
            }
            put_number(&mut item, "opening", 24);
            if let Some(i) = get(25).and_then(json_of).filter(Value::is_array) {
                item.insert("intros".into(), i);
            }
            if let Some(g) = get(26).and_then(json_of).filter(Value::is_object) {
                item.insert("goal".into(), g);
            }
            if let Some(mut list) = seasons.remove(&id) {
                list.sort_by_key(|(o, _)| *o);
                item.insert(
                    "seasons".into(),
                    Value::Array(list.into_iter().map(|(_, s)| s).collect()),
                );
            }
            if let Some(mut list) = history.remove(&id) {
                list.sort_by_key(|(o, _)| *o);
                item.insert(
                    "history".into(),
                    Value::Array(list.into_iter().map(|(_, h)| h).collect()),
                );
            }
            let order = get(27)
                .and_then(number)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            rows_out.push((order, Value::Object(item)));
        }
    }
    rows_out.sort_by_key(|(o, _)| *o);

    let mut removed = Removed::new();
    if has("merkliste_removals") {
        let mut q = db.prepare("SELECT item_id, removed_at FROM merkliste_removals")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let id = r.get_ref(0).ok().and_then(as_string).unwrap_or_default();
            if let (false, Some(at)) = (
                id.is_empty(),
                r.get_ref(1).ok().and_then(number).and_then(|v| v.as_f64()),
            ) {
                removed.insert(id, at as i64);
            }
        }
    }

    let mut app_state = BTreeMap::new();
    if has("app_state") {
        let mut q = db.prepare("SELECT key, value_json, updated_at FROM app_state")?;
        let mut rows = q.query([])?;
        while let Some(r) = rows.next()? {
            let key = r.get_ref(0).ok().and_then(as_string).unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            app_state.insert(
                key,
                AppEntry {
                    value: r.get_ref(1).ok().and_then(json_of).unwrap_or(Value::Null),
                    updated_at: r
                        .get_ref(2)
                        .ok()
                        .and_then(number)
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                },
            );
        }
    }
    Ok(RawSnapshot {
        items: rows_out.into_iter().map(|(_, v)| v).collect(),
        removed,
        app_state,
    })
}

/* Writing ------------------------------------------------------------------------------------- */

fn json_text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// The list as the SQLite file Drive holds: the entries as they travel (pictures from files stay behind),
/// what was removed, and the app's own state.
pub fn write_sqlite(snapshot: &Snapshot) -> Result<Vec<u8>, Error> {
    let staged = tempfile::NamedTempFile::new()?;
    {
        let mut db = Connection::open(staged.path())?;
        db.execute_batch(
            "PRAGMA page_size = 4096; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;",
        )?;
        let tx = db.transaction()?;
        for create in [
            CREATE_ITEMS,
            CREATE_SEASONS,
            CREATE_HISTORY,
            CREATE_REMOVALS,
            CREATE_APP_STATE,
        ] {
            tx.execute(create, [])?;
        }
        for (index, original) in snapshot.items.iter().enumerate() {
            let item = travelling(original);
            tx.execute(
                "INSERT INTO merkliste_items VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)",
                params![
                    item.id,
                    item.url,
                    item.title,
                    item.language,
                    item.season,
                    item.episode,
                    item.mode,
                    item.audio_format,
                    item.video_pref,
                    item.audio_pref,
                    i64::from(item.auto_transcribe),
                    item.updated_at,
                    serde_json::to_value(item.status).ok().and_then(|v| v.as_str().map(str::to_string)),
                    item.last_opened_at,
                    item.cover,
                    item.cover_frame.as_ref().map(json_text),
                    item.tile_format,
                    item.notes,
                    item.rating.map(|r| r as f64),
                    item.episode_duration,
                    item.film_duration,
                    item.durations.as_ref().map(json_text),
                    item.tags.as_ref().map(json_text),
                    item.online_available.as_ref().map(json_text),
                    item.opening.map(|o| o as f64),
                    item.intros.as_ref().map(json_text),
                    item.goal.as_ref().map(json_text),
                    index as i64,
                ],
            )?;
            for (s_index, season) in item.seasons.iter().flatten().enumerate() {
                tx.execute(
                    "INSERT INTO merkliste_seasons VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        item.id,
                        season.number,
                        season.episodes,
                        json_text(&season.watched),
                        season.title,
                        season.cover,
                        season.cover_frame.as_ref().map(json_text),
                        season.parts.as_ref().map(json_text),
                        s_index as i64,
                    ],
                )?;
            }
            for (h_index, entry) in item.history.iter().flatten().enumerate() {
                tx.execute(
                    "INSERT INTO merkliste_history VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        entry.id,
                        item.id,
                        entry.season,
                        entry.episode,
                        entry.at,
                        h_index as i64
                    ],
                )?;
            }
        }
        for (id, at) in &snapshot.removed {
            tx.execute(
                "INSERT INTO merkliste_removals VALUES (?1,?2)",
                params![id, at],
            )?;
        }
        for (key, entry) in &snapshot.app_state {
            tx.execute(
                "INSERT INTO app_state VALUES (?1,?2,?3)",
                params![key, json_text(&entry.value), entry.updated_at],
            )?;
        }
        tx.commit()?;
        db.close().map_err(|(_, e)| e)?;
    }
    Ok(std::fs::read(staged.path())?)
}

/// The older file, `Sondra-Merkliste.json`: the entries as they travel and what was removed.
pub fn write_json(items: &[Item], removed: &Removed, exported_at: &str) -> String {
    let value = json!({
        "kind": "sondra-merkliste",
        "version": 2,
        "exportedAt": exported_at,
        "items": items.iter().map(travelling).collect::<Vec<_>>(),
        "removed": removed,
    });
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

/* Reading, made whole -------------------------------------------------------------------------- */

/// A file in Drive read back: the SQLite database or the older JSON. `Err(NotAMerkliste)` when it is no
/// Merkliste at all — and then it is never written over.
pub fn read_shared(bytes: &[u8], ctx: &mut Context) -> Result<Snapshot, Error> {
    if bytes.starts_with(b"SQLite format 3\0") {
        let raw = read_sqlite_raw(bytes)?;
        return Ok(Snapshot {
            items: raw.items.iter().map(|v| normalize(v, ctx)).collect(),
            removed: raw.removed,
            app_state: raw.app_state,
        });
    }
    let parsed: Value = serde_json::from_slice(bytes).map_err(|_| Error::NotAMerkliste)?;
    let list = parsed
        .get("items")
        .and_then(Value::as_array)
        .ok_or(Error::NotAMerkliste)?;
    let mut removed = Removed::new();
    if let Some(map) = parsed.get("removed").and_then(Value::as_object) {
        for (id, at) in map {
            if let Some(n) = at.as_f64() {
                removed.insert(id.clone(), n as i64);
            }
        }
    }
    let items = list
        .iter()
        .filter(|v| v.is_object())
        .map(|v| normalize(v, ctx))
        .collect();
    Ok(Snapshot {
        items,
        removed,
        app_state: BTreeMap::new(),
    })
}

/// Whether the file in Drive already holds exactly this list — then it need not be written again.
/// Compared as values, never as text.
pub fn holds_same(file: &Snapshot, items: &[Item], removed: &Removed) -> bool {
    shared_key(&file.items, &file.removed) == shared_key(items, removed)
}
