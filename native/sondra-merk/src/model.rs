//! The entry as the web app keeps it (`SavedLinkItem` in `src/lib/merkliste.ts`), with the same names on
//! the wire: what is written here is read there, and the other way round.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Where an entry stands: being watched, for later, paused, finished, given up.
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
    pub fn parse(text: &str) -> Option<Status> {
        Some(match text {
            "watching" => Status::Watching,
            "later" => Status::Later,
            "paused" => Status::Paused,
            "done" => Status::Done,
            "dropped" => Status::Dropped,
            _ => return None,
        })
    }
}

/// The part of a cover a tile shows: where the picture sits (0–100 % across and down) and how far it is
/// zoomed in (1–3).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CoverFrame {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

/// A part of a season — „Teil 1“ — a tile of its own; the episodes keep counting through the season.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub episodes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_frame: Option<CoverFrame>,
}

/// One season of an entry; `number` 0 holds the films.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Season {
    pub number: i64,
    /// How many episodes (or films) it has, when someone has said so.
    pub episodes: Option<i64>,
    /// The episode numbers marked as seen.
    pub watched: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_frame: Option<CoverFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<Vec<Part>>,
}

impl Season {
    pub fn new(number: i64, episodes: Option<i64>, watched: Vec<i64>) -> Season {
        Season {
            number,
            episodes,
            watched,
            ..Season::default()
        }
    }
}

/// A point someone wants to reach in a series: „bis Staffel 3, Folge 12“, by a day if they said one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub season: i64,
    pub episode: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
    pub set_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intro {
    pub print: String,
    pub seconds: f64,
    pub learned_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub season: i64,
    pub episode: i64,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Online {
    pub max_season: i64,
    pub max_episode: i64,
    pub checked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_new: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    /// May be empty: an entry can be followed without anything to load.
    pub url: String,
    pub title: String,
    pub language: String,
    /// Where someone is: the season (0 = films) and the episode to watch next.
    pub season: i64,
    pub episode: Option<i64>,
    pub mode: String,
    pub audio_format: String,
    pub video_pref: String,
    pub audio_pref: String,
    pub auto_transcribe: bool,
    pub updated_at: i64,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seasons: Option<Vec<Season>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_frame: Option<CoverFrame>,
    /// Absent means a film poster; `"manga"` a volume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// 0–5; 0 is unrated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rating: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_duration: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub film_duration: Option<i64>,
    /// How long the opening runs, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opening: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intros: Option<Vec<Intro>>,
    /// Episode-specific durations in minutes, keyed `season:episode`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durations: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<HistoryEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online_available: Option<Online>,
}

/// The opening of an episode: 1:30 unless the series says otherwise.
pub const OPENING_DEFAULT: i64 = 90;
pub const OPENING_MIN: i64 = 10;
pub const OPENING_MAX: i64 = 600;
/// How many openings by ear an entry keeps.
pub const INTROS_KEPT: usize = 4;
