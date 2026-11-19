//! The words on one line of the Merkliste: where a series stands and what is left of it — the web app's
//! `src/lib/merkRows.ts`, sentence for sentence.

use crate::plan::length_label;
use crate::progress::{caught_up, item_progress, seasons_of};
use crate::stats::item_remaining_minutes;
use crate::urlinfo::parse_link_episode_info;
use crate::{Item, Status};
use regex::Regex;
use std::sync::LazyLock;

/// What kind of numbering an address carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpisodeKind {
    /// Seasons and episodes.
    Series,
    /// A place in a playlist.
    List,
}

static SEASONAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)staffel|season|filme?(?:/|-|$)|/s\d{1,2}e\d{1,3}").unwrap());
static LISTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[?&](?:list|index)=").unwrap());

/// What kind of numbering an address carries: seasons and episodes, a place in a playlist, or none — a
/// single video, where season and episode controls would do nothing.
pub fn episode_kind_of(url: &str) -> Option<EpisodeKind> {
    if url.trim().is_empty() || !parse_link_episode_info(url).is_episodic_url {
        return None;
    }
    let seasonal = SEASONAL.is_match(url);
    Some(if LISTED.is_match(url) && !seasonal { EpisodeKind::List } else { EpisodeKind::Series })
}

/// Where an entry stands, in words: „Staffel 2, Folge 8“, „Film 3“, „Staffel 1, alle Folgen“.
pub fn position_label(season: i64, episode: Option<i64>, kind: EpisodeKind) -> String {
    let episode = episode.filter(|e| *e != 0);
    match (kind, season, episode) {
        (EpisodeKind::List, _, Some(e)) => format!("Nr. {e}"),
        (EpisodeKind::List, _, None) => "ganze Liste".into(),
        (_, 0, Some(e)) => format!("Film {e}"),
        (_, 0, None) => "Alle Filme".into(),
        (_, s, Some(e)) => format!("Staffel {s}, Folge {e}"),
        (_, s, None) => format!("Staffel {s}, alle Folgen"),
    }
}

/// Where a series stands, as a line of the list.
pub fn stand_label(item: &Item) -> String {
    let seasons = seasons_of(item);
    let kind = episode_kind_of(&item.url).unwrap_or(EpisodeKind::Series);
    if caught_up(&seasons) {
        return "Alles gesehen".into();
    }
    if item.status == Status::Done {
        return format!("{} gesehen", item_progress(item).watched);
    }
    if item.status == Status::Later && item_progress(item).watched == 0 {
        return "Nicht angefangen".into();
    }
    position_label(item.season, item.episode, kind)
}

/// „noch 6 · 2 Std. 15 Min.“: what is left of a series, in episodes and time.
pub fn left_label(item: &Item) -> Option<String> {
    let left = item_remaining_minutes(item);
    if left.remaining_count == 0 {
        return None;
    }
    Some(format!("noch {} · {}{}", left.remaining_count, length_label(left.minutes as f64), if left.known { "" } else { " +" }))
}
