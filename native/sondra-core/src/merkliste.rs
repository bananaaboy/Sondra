//! The shared Merkliste, read from the file Drive holds.
//!
//! Two formats exist: the SQLite database `Sondra-Merkliste.sqlite` and the
//! older JSON `Sondra-Merkliste.json`. Both are read into the same [`Shared`].
//! Fields this version does not know stay in [`Item::extra`], so that a
//! future writer can hand them back untouched.

use std::collections::BTreeMap;
use std::io::Write;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("the file is no Merkliste")]
    NotAMerkliste,
    #[error("the database could not be read: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("the file could not be staged: {0}")]
    Io(#[from] std::io::Error),
}

/// Where a series stands. Anything unknown is treated as `Watching`, the way
/// the web app does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Watching,
    Later,
    Paused,
    Done,
    Dropped,
}

impl Status {
    fn parse(text: Option<&str>) -> Status {
        match text {
            Some("later") => Status::Later,
            Some("paused") => Status::Paused,
            Some("done") => Status::Done,
            Some("dropped") => Status::Dropped,
            _ => Status::Watching,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Season {
    pub number: u32,
    /// How many episodes it has, when someone has said so.
    pub episodes: Option<u32>,
    pub watched: Vec<u32>,
}

/// The newest episode the last online check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Online {
    pub max_season: u32,
    pub max_episode: u32,
    #[serde(default)]
    pub checked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(skip)]
    pub status: Status,
    #[serde(default)]
    pub season: u32,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub seasons: Vec<Season>,
    #[serde(default)]
    pub online_available: Option<Online>,
    /// Everything else, as it was.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Item {
    /// Has this episode been marked as seen?
    pub fn has_seen(&self, season: u32, episode: u32) -> bool {
        self.seasons
            .iter()
            .any(|s| s.number == season && s.watched.contains(&episode))
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shared {
    pub items: Vec<Item>,
    /// Entries removed on some device, with the time of the removal.
    pub removed: BTreeMap<String, i64>,
}

const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// Reads a Merkliste file, whichever of the two formats it is in.
pub fn read_shared(bytes: &[u8]) -> Result<Shared, ReadError> {
    if bytes.starts_with(SQLITE_MAGIC) {
        read_sqlite(bytes)
    } else {
        read_json(bytes)
    }
}

fn read_json(bytes: &[u8]) -> Result<Shared, ReadError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ReadError::NotAMerkliste)?;
    let object = value.as_object().ok_or(ReadError::NotAMerkliste)?;
    let list = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or(ReadError::NotAMerkliste)?;
    let mut items = Vec::new();
    for raw in list {
        if !raw.is_object() {
            continue;
        }
        let Ok(mut item) = serde_json::from_value::<Item>(raw.clone()) else {
            continue;
        };
        item.status = Status::parse(raw.get("status").and_then(Value::as_str));
        // `status` is read above; keep the written form out of `extra` twice.
        item.extra.remove("status");
        items.push(item);
    }
    let mut removed = BTreeMap::new();
    if let Some(map) = object.get("removed").and_then(Value::as_object) {
        for (id, at) in map {
            if let Some(at) = at.as_i64() {
                removed.insert(id.clone(), at);
            }
        }
    }
    Ok(Shared { items, removed })
}

fn json_column<T: serde::de::DeserializeOwned>(text: Option<String>) -> Option<T> {
    text.filter(|t| !t.trim().is_empty())
        .and_then(|t| serde_json::from_str(&t).ok())
}

fn read_sqlite(bytes: &[u8]) -> Result<Shared, ReadError> {
    // SQLite opens files, not buffers: stage the bytes and open them read-only.
    let mut staged = tempfile::NamedTempFile::new()?;
    staged.write_all(bytes)?;
    staged.flush()?;
    let db = Connection::open_with_flags(staged.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let mut seasons: BTreeMap<String, Vec<(i64, Season)>> = BTreeMap::new();
    if let Ok(mut query) = db.prepare(
        "SELECT item_id, season_number, episodes, watched_json, sort_order FROM merkliste_seasons",
    ) {
        let rows = query.query_map([], |row| {
            let watched: Option<String> = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(4).unwrap_or(0),
                Season {
                    number: row.get::<_, i64>(1)?.max(0) as u32,
                    episodes: row.get::<_, Option<i64>>(2)?.map(|n| n.max(0) as u32),
                    watched: json_column(watched).unwrap_or_default(),
                },
            ))
        })?;
        for row in rows {
            let (id, order, season) = row?;
            seasons.entry(id).or_default().push((order, season));
        }
    }

    let mut items = Vec::new();
    {
        let mut query = db
            .prepare(
                "SELECT id, url, title, season, episode, updated_at, status, online_available_json
                 FROM merkliste_items ORDER BY sort_order",
            )
            .map_err(|_| ReadError::NotAMerkliste)?;
        let rows = query.query_map([], |row| {
            let id: String = row.get(0)?;
            let status: Option<String> = row.get(6)?;
            let online: Option<String> = row.get(7)?;
            Ok(Item {
                id,
                url: row.get(1)?,
                title: row.get(2)?,
                status: Status::parse(status.as_deref()),
                season: row.get::<_, i64>(3)?.max(0) as u32,
                episode: row.get::<_, Option<i64>>(4)?.map(|n| n.max(0) as u32),
                updated_at: row.get(5)?,
                seasons: Vec::new(),
                online_available: json_column(online),
                extra: Map::new(),
            })
        })?;
        for row in rows {
            let mut item = row?;
            if let Some(mut list) = seasons.remove(&item.id) {
                list.sort_by_key(|(order, _)| *order);
                item.seasons = list.into_iter().map(|(_, season)| season).collect();
            }
            items.push(item);
        }
    }

    let mut removed = BTreeMap::new();
    if let Ok(mut query) = db.prepare("SELECT item_id, removed_at FROM merkliste_removals") {
        let rows = query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (id, at) = row?;
            removed.insert(id, at);
        }
    }
    Ok(Shared { items, removed })
}

impl Shared {
    /// The entries that are still on the list: not removed after their last change.
    pub fn alive(&self) -> impl Iterator<Item = &Item> {
        self.items.iter().filter(|item| {
            self.removed
                .get(&item.id)
                .is_none_or(|removed_at| *removed_at < item.updated_at)
        })
    }
}
