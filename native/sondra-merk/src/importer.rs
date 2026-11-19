//! Reading a file into a list (`importMalXml`, `importAniListJson`, `readMerklisteFile`, … in
//! `merkliste.ts`): the SQLite file, the JSON export, a MyAnimeList XML and an AniList JSON. What the file
//! says about status and score is made into this list's own words; what it does not say stays open (a
//! series of unknown length stays unknown — never guessed).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::model::Item;
use crate::normalize::{normalize, Context};
use crate::sqlite::read_sqlite_raw;

macro_rules! rx {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).expect("a fixed pattern"))
    }};
}

/// `Math.round`: halves go up.
fn round(f: f64) -> i64 {
    (f + 0.5).floor() as i64
}

/// The seen marks of a series of `episodes` (or unknown length) after `watched` episodes.
fn season_json(episodes: Option<i64>, watched: i64) -> Value {
    let marks: Vec<i64> = (1..=watched.max(0))
        .filter(|n| episodes.is_none_or(|e| *n <= e))
        .collect();
    json!({ "number": 1, "episodes": episodes, "watched": marks })
}

fn next_episode(episodes: Option<i64>, watched: i64) -> i64 {
    match episodes {
        Some(e) if watched >= e => e,
        _ => watched + 1,
    }
}

/// An entry from MyAnimeList's XML export.
pub fn import_mal_xml(xml: &str, ctx: &mut Context) -> Vec<Item> {
    let mut items = Vec::new();
    for block in rx!(r"(?is)<anime>([\s\S]*?)</anime>").captures_iter(xml) {
        let block = &block[1];
        let Some(title) =
            rx!(r"(?is)<series_title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</series_title>")
                .captures(block)
        else {
            continue;
        };
        let title = title[1]
            .replace("&#039;", "'")
            .replace("&amp;", "&")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let count = |pattern: &Regex| -> Option<i64> {
            pattern.captures(block).and_then(|c| c[1].parse().ok())
        };
        let episodes =
            count(rx!(r"(?i)<series_episodes>(\d+)</series_episodes>")).filter(|e| *e > 0);
        let watched =
            count(rx!(r"(?i)<my_watched_episodes>(\d+)</my_watched_episodes>")).unwrap_or(0);
        let score = count(rx!(r"(?i)<my_score>(\d+)</my_score>")).unwrap_or(0);
        let rating = (score > 0).then(|| round(score as f64 / 2.0).clamp(1, 5));
        let status_text = rx!(r"(?is)<my_status>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</my_status>")
            .captures(block)
            .map(|c| c[1].trim().to_lowercase())
            .unwrap_or_default();
        let has = |words: &[&str]| words.iter().any(|w| status_text.contains(w));
        let status = if has(&["completed", "fertig"]) {
            "done"
        } else if has(&["on-hold", "pausiert"]) {
            "paused"
        } else if has(&["dropped", "abgebrochen"]) {
            "dropped"
        } else if has(&["plan to watch", "später"]) {
            "later"
        } else {
            "watching"
        };
        let mut raw = Map::new();
        raw.insert("title".into(), json!(title));
        raw.insert("status".into(), json!(status));
        if let Some(r) = rating {
            raw.insert("rating".into(), json!(r));
        }
        raw.insert("season".into(), json!(1));
        raw.insert("episode".into(), json!(next_episode(episodes, watched)));
        raw.insert("tags".into(), json!(["MAL"]));
        raw.insert("seasons".into(), json!([season_json(episodes, watched)]));
        items.push(normalize(&Value::Object(raw), ctx));
    }
    items
}

fn object_entries(list: &[Value]) -> impl Iterator<Item = &Map<String, Value>> {
    list.iter().filter_map(Value::as_object)
}

/// The first of these that holds text.
fn first_text<'a>(map: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| {
        map.get(*k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    })
}

/// An entry from AniList's JSON export, in any of the shapes it comes in.
pub fn import_anilist_json(text: &str, ctx: &mut Context) -> Vec<Item> {
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return vec![];
    };
    let mut entries: Vec<&Map<String, Value>> = Vec::new();
    match &parsed {
        Value::Array(list) => entries.extend(object_entries(list)),
        Value::Object(obj) => {
            if let Some(list) = obj.get("entries").and_then(Value::as_array) {
                entries.extend(object_entries(list));
            } else if let Some(lists) = obj.get("lists").and_then(Value::as_array) {
                for raw in lists {
                    if let Some(inner) = raw.get("entries").and_then(Value::as_array) {
                        entries.extend(object_entries(inner));
                    }
                }
            }
        }
        _ => {}
    }
    let mut items = Vec::new();
    for entry in entries {
        let media = entry
            .get("media")
            .and_then(Value::as_object)
            .unwrap_or(entry);
        let title: String = match media.get("title") {
            Some(Value::Object(t)) => {
                first_text(t, &["userPreferred", "english", "romaji", "native"])
                    .unwrap_or("")
                    .to_string()
            }
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        let title = if title.is_empty() {
            entry
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            title
        };
        if title.trim().is_empty() {
            continue;
        }
        let episodes = media
            .get("episodes")
            .and_then(Value::as_f64)
            .filter(|e| *e > 0.0)
            .map(|e| e as i64);
        let progress = entry
            .get("progress")
            .and_then(Value::as_f64)
            .filter(|p| *p >= 0.0)
            .map_or(0, |p| p as i64);
        let raw_score = entry
            .get("score")
            .and_then(Value::as_f64)
            .or_else(|| {
                entry
                    .get("scoreRaw")
                    .and_then(Value::as_f64)
                    .map(|s| s / 10.0)
            })
            .unwrap_or(0.0);
        let rating = (raw_score > 0.0).then(|| {
            round(if raw_score <= 5.0 {
                raw_score
            } else {
                raw_score / 2.0
            })
            .clamp(1, 5)
        });
        let status = match entry
            .get("status")
            .map(|s| match s {
                Value::String(t) => t.to_uppercase(),
                Value::Null => String::new(),
                other => other.to_string().to_uppercase(),
            })
            .unwrap_or_default()
            .as_str()
        {
            "COMPLETED" => "done",
            "PAUSED" => "paused",
            "DROPPED" => "dropped",
            "PLANNING" => "later",
            _ => "watching",
        };
        let cover = media
            .get("coverImage")
            .and_then(Value::as_object)
            .and_then(|c| first_text(c, &["large", "medium"]));
        let mut raw = Map::new();
        raw.insert("title".into(), json!(title.trim()));
        raw.insert("status".into(), json!(status));
        if let Some(r) = rating {
            raw.insert("rating".into(), json!(r));
        }
        if let Some(c) = cover {
            raw.insert("cover".into(), json!(c));
        }
        raw.insert("season".into(), json!(1));
        raw.insert("episode".into(), json!(next_episode(episodes, progress)));
        raw.insert("tags".into(), json!(["AniList"]));
        raw.insert("seasons".into(), json!([season_json(episodes, progress)]));
        items.push(normalize(&Value::Object(raw), ctx));
    }
    items
}

/// What reading a file can come to — each with the sentence the person is told.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FileError {
    #[error("Die Merkliste in der SQLite-Datei ist leer.")]
    EmptySqlite,
    #[error("Die MyAnimeList-Exportdatei enthält keine Anime-Einträge.")]
    EmptyMal,
    #[error(
        "Die Datei ist keine Merkliste — sie lässt sich weder als SQLite noch als JSON lesen."
    )]
    Unreadable,
    #[error("In der Datei steht keine Merkliste.")]
    NoList,
    #[error("Die Merkliste in der Datei ist leer.")]
    EmptyList,
}

/// Reads a SQLite file, a JSON export of the list, or a MyAnimeList XML / AniList JSON file.
pub fn read_merkliste_file(bytes: &[u8], ctx: &mut Context) -> Result<Vec<Item>, FileError> {
    if bytes.starts_with(b"SQLite format 3\0") {
        let snapshot = read_sqlite_raw(bytes).map_err(|_| FileError::Unreadable)?;
        if snapshot.items.is_empty() {
            return Err(FileError::EmptySqlite);
        }
        return Ok(snapshot.items.iter().map(|v| normalize(v, ctx)).collect());
    }
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.starts_with('<') && (trimmed.contains("<myanimelist") || trimmed.contains("<anime>"))
    {
        let mal = import_mal_xml(trimmed, ctx);
        return if mal.is_empty() {
            Err(FileError::EmptyMal)
        } else {
            Ok(mal)
        };
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|_| FileError::Unreadable)?;
    if let Some(obj) = parsed.as_object() {
        let lists = obj.get("lists").is_some_and(Value::is_array);
        let entries_only = obj.get("entries").is_some_and(Value::is_array)
            && !obj.get("items").is_some_and(Value::is_array);
        if lists || entries_only {
            let anilist = import_anilist_json(&text, ctx);
            if !anilist.is_empty() {
                return Ok(anilist);
            }
        }
    }
    let list: &[Value] = match &parsed {
        Value::Array(list) => list,
        Value::Object(o) => o
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or(FileError::NoList)?,
        _ => return Err(FileError::NoList),
    };
    let entries: Vec<&Value> = list.iter().filter(|v| v.is_object()).collect();
    if entries.is_empty() {
        return Err(FileError::EmptyList);
    }
    Ok(entries.into_iter().map(|v| normalize(v, ctx)).collect())
}

/// Every distinct tag across the entries, in alphabetical order (case and accents do not count).
pub fn all_tags(list: &[Item]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for tag in list.iter().flat_map(|i| i.tags.iter().flatten()) {
        let t = tag.trim().to_string();
        if !t.is_empty() && !tags.contains(&t) {
            tags.push(t);
        }
    }
    tags.sort_by(|a, b| crate::stats::compare_de(a, b));
    tags
}

/// All watch history entries across the entries, newest first: the entry's id, then the history entry.
pub fn all_history(list: &[Item]) -> Vec<(&Item, &crate::model::HistoryEntry)> {
    let mut all: Vec<(&Item, &crate::model::HistoryEntry)> = list
        .iter()
        .flat_map(|i| i.history.iter().flatten().map(move |h| (i, h)))
        .collect();
    all.sort_by_key(|(_, h)| std::cmp::Reverse(h.at));
    all
}
