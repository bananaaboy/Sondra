//! Seasons and how far they are seen (`seasonsOf`, `seasonProgress`, `settle`, … in `merkliste.ts`).
//! Counting never goes past the end: marks beyond a known length fall away, and when everything is seen
//! the entry is finished and stays at the last episode — „Alle gesehen“ once left a series of 39 at
//! „Folge 40“.

use crate::model::{Item, Part, Season, Status};

/// Seen marks as stored: whole numbers, once each, in order — and none past the end of a season whose
/// length is known.
pub fn clean_watched(numbers: &[i64], episodes: Option<i64>) -> Vec<i64> {
    let mut seen: Vec<i64> = numbers.iter().copied().filter(|n| *n >= 1).collect();
    seen.sort_unstable();
    seen.dedup();
    seen.retain(|n| episodes.is_none_or(|e| *n <= e));
    seen
}

/// Seasons in order, the films (0) after them.
fn order(seasons: &mut [Season]) {
    seasons.sort_by_key(|s| (s.number == 0, s.number));
}

/// The seasons of an entry, as tiles want them: the ones someone set up, and at least the one they are
/// in. An entry saved before seasons existed had only a position; everything before it counts as seen.
pub fn seasons_of(item: &Item) -> Vec<Season> {
    let mut list: Vec<Season> = item
        .seasons
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_default();
    if !list.iter().any(|s| s.number == item.season) {
        let before: Vec<i64> = match item.episode {
            Some(e) if e > 1 => (1..e).collect(),
            _ => vec![],
        };
        let has_seasons = item.seasons.as_ref().is_some_and(|s| !s.is_empty());
        list.push(Season::new(
            item.season,
            None,
            if has_seasons { vec![] } else { before },
        ));
    }
    order(&mut list);
    list
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeasonProgress {
    pub watched: i64,
    pub total: Option<i64>,
    /// 0–1 when the total is known.
    pub fraction: Option<f64>,
    /// The first episode not yet seen; the last one when all are.
    pub next: i64,
    /// Every episode is seen (only when the total is known).
    pub complete: bool,
}

fn fraction(watched: i64, total: Option<i64>) -> Option<f64> {
    match total {
        Some(t) if t != 0 => Some((watched as f64 / t as f64).min(1.0)),
        _ => None,
    }
}

pub fn season_progress(season: &Season) -> SeasonProgress {
    let total = season.episodes;
    let watched = match total {
        None => season.watched.len() as i64,
        Some(t) => season.watched.iter().filter(|n| **n <= t).count() as i64,
    };
    let mut next = 1;
    while season.watched.contains(&next) {
        next += 1;
    }
    if let Some(t) = total {
        next = next.min(t);
    }
    SeasonProgress {
        watched,
        total,
        fraction: fraction(watched, total),
        next,
        complete: total.is_some_and(|t| watched >= t),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ItemProgress {
    pub watched: i64,
    pub total: Option<i64>,
    pub fraction: Option<f64>,
}

pub fn item_progress(item: &Item) -> ItemProgress {
    let seasons = seasons_of(item);
    let watched: i64 = seasons.iter().map(|s| season_progress(s).watched).sum();
    let known = seasons.iter().all(|s| s.episodes.is_some());
    let total = known.then(|| seasons.iter().map(|s| s.episodes.unwrap_or(0)).sum());
    // With one season's size still open, the bar measures the ones that are known instead of staying empty.
    let sized: Vec<&Season> = seasons.iter().filter(|s| s.episodes.is_some()).collect();
    let sized_total: i64 = sized.iter().map(|s| s.episodes.unwrap_or(0)).sum();
    let sized_watched: i64 = sized.iter().map(|s| season_progress(s).watched).sum();
    ItemProgress {
        watched,
        total,
        fraction: if sized_total != 0 {
            Some((sized_watched as f64 / sized_total as f64).min(1.0))
        } else {
            None
        },
    }
}

/// The seasons with one of them changed (or taken away, when `change` gives none).
pub fn with_season(
    item: &Item,
    number: i64,
    change: impl Fn(&Season) -> Option<Season>,
) -> Vec<Season> {
    let mut next = Vec::new();
    for season in seasons_of(item) {
        if season.number != number {
            next.push(season);
            continue;
        }
        if let Some(mut changed) = change(&season) {
            changed.watched = clean_watched(&changed.watched, changed.episodes);
            next.push(changed);
        }
    }
    next
}

/// Marks one episode as seen or not.
pub fn toggle_watched(item: &Item, season: i64, episode: i64) -> Vec<Season> {
    with_season(item, season, |s| {
        let mut changed = s.clone();
        if changed.watched.contains(&episode) {
            changed.watched.retain(|n| *n != episode);
        } else {
            changed.watched.push(episode);
        }
        Some(changed)
    })
}

/// Marks everything up to and including an episode as seen.
pub fn watched_up_to(item: &Item, season: i64, episode: i64) -> Vec<Season> {
    with_season(item, season, |s| {
        let mut changed = s.clone();
        changed.watched = s
            .watched
            .iter()
            .copied()
            .filter(|n| *n > episode)
            .chain(1..=episode)
            .collect();
        Some(changed)
    })
}

/// Marks a range of a season — a part — as seen, or as not seen.
pub fn mark_range(item: &Item, season: i64, from: i64, to: i64, seen: bool) -> Vec<Season> {
    with_season(item, season, |s| {
        let mut changed = s.clone();
        let mut rest: Vec<i64> = s
            .watched
            .iter()
            .copied()
            .filter(|n| *n < from || *n > to)
            .collect();
        if seen {
            rest.extend(from..=to);
        }
        changed.watched = rest;
        Some(changed)
    })
}

/// Every season has a known length and all of it is seen.
pub fn caught_up(seasons: &[Season]) -> bool {
    !seasons.is_empty() && seasons.iter().all(|s| season_progress(s).complete)
}

/* Parts of a season --------------------------------------------------------------------------- */

/// A part with the episode numbers it holds; `to` is open while its length is.
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonPart {
    pub part: Part,
    pub index: usize,
    pub from: i64,
    pub to: Option<i64>,
}

/// The parts of a season in order — one, the whole season, when it is not split.
pub fn parts_of(season: &Season) -> Vec<SeasonPart> {
    match &season.parts {
        Some(parts) if parts.len() >= 2 => {
            let mut from = 1;
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    let to = part.episodes.map(|e| from + e - 1);
                    let entry = SeasonPart {
                        part: part.clone(),
                        index,
                        from,
                        to,
                    };
                    from = to.unwrap_or(from) + 1;
                    entry
                })
                .collect()
        }
        _ => vec![SeasonPart {
            part: Part {
                episodes: season.episodes,
                ..Part::default()
            },
            index: 0,
            from: 1,
            to: season.episodes,
        }],
    }
}

/// How far a part is seen, counted on its own episodes.
pub fn part_progress(season: &Season, part: &SeasonPart) -> SeasonProgress {
    let inside = |n: i64| n >= part.from && part.to.is_none_or(|t| n <= t);
    let watched = season.watched.iter().filter(|n| inside(**n)).count() as i64;
    let total = part.part.episodes;
    let mut next = part.from;
    while season.watched.contains(&next) {
        next += 1;
    }
    if let Some(t) = part.to {
        next = next.min(t);
    }
    SeasonProgress {
        watched,
        total,
        fraction: fraction(watched, total),
        next,
        complete: total.is_some_and(|t| watched >= t),
    }
}

/// „Staffel 2“, „Filme“, or the season's own name.
pub fn season_name(season: &Season) -> String {
    match season.title.as_deref() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ if season.number == 0 => "Filme".into(),
        _ => format!("Staffel {}", season.number),
    }
}

/// „Staffel 2 · Teil 1“, or the part's own name; the season's name when it is one piece.
pub fn part_name(season: &Season, part: &SeasonPart) -> String {
    if season.parts.as_ref().is_none_or(|p| p.len() < 2) {
        return season_name(season);
    }
    match part.part.title.as_deref() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => format!("{} · Teil {}", season_name(season), part.index + 1),
    }
}

/// The part an episode belongs to.
pub fn part_of_episode(season: &Season, episode: Option<i64>) -> SeasonPart {
    let parts = parts_of(season);
    let Some(e) = episode else {
        return parts[0].clone();
    };
    parts
        .iter()
        .find(|p| e >= p.from && p.to.is_none_or(|t| e <= t))
        .unwrap_or(&parts[parts.len() - 1])
        .clone()
}

/// A season with new parts: the length becomes their sum, a part of unknown length before the last gets
/// one episode, and one part left is no split.
pub fn with_parts(season: &Season, parts: &[Part]) -> Season {
    let mut rest = season.clone();
    rest.parts = None;
    if parts.len() < 2 {
        let only = parts.first();
        let episodes = only.map_or(season.episodes, |p| p.episodes);
        // The last part's cover becomes the season's, if the season had none.
        if rest.cover.is_none() {
            rest.cover = only.and_then(|p| p.cover.clone());
            rest.cover_frame = only.and_then(|p| p.cover_frame);
        }
        rest.episodes = episodes;
        rest.watched = clean_watched(&season.watched, episodes);
        return rest;
    }
    let last = parts.len() - 1;
    let fixed: Vec<Part> = parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i < last && p.episodes.is_none() {
                Part {
                    episodes: Some(1),
                    ..p.clone()
                }
            } else {
                p.clone()
            }
        })
        .collect();
    let episodes = if fixed.iter().all(|p| p.episodes.is_some()) {
        Some(fixed.iter().map(|p| p.episodes.unwrap_or(0)).sum())
    } else {
        None
    };
    rest.parts = Some(fixed);
    rest.episodes = episodes;
    rest.watched = clean_watched(&season.watched, episodes);
    rest
}

/// The parts as stored, for changing one of them.
pub fn stored_parts(season: &Season) -> Vec<Part> {
    parts_of(season)
        .into_iter()
        .map(|p| Part {
            episodes: p.part.episodes,
            title: p.part.title.filter(|t| !t.is_empty()),
            cover_frame: p
                .part
                .cover
                .as_ref()
                .filter(|c| !c.is_empty())
                .and(p.part.cover_frame),
            cover: p.part.cover.filter(|c| !c.is_empty()),
        })
        .collect()
}

/// „In Teile teilen“: two parts, the known length halved; an open length keeps what is seen in the first
/// part and leaves the second open.
pub fn split_season(season: &Season) -> Season {
    let total = season.episodes;
    let highest = season.watched.iter().copied().max().unwrap_or(0);
    let first = match total {
        Some(t) => ((t as f64 / 2.0).ceil() as i64).max(1),
        None => highest.max(12),
    };
    let second = total.map(|t| (t - first).max(1));
    with_parts(
        season,
        &[
            Part {
                episodes: Some(first),
                ..Part::default()
            },
            Part {
                episodes: second,
                ..Part::default()
            },
        ],
    )
}

/* Where an entry stands --------------------------------------------------------------------- */

/// What `settle` hands back: the fields of the entry that move.
#[derive(Debug, Clone, PartialEq)]
pub struct Settled {
    pub seasons: Vec<Season>,
    pub season: i64,
    pub episode: Option<i64>,
    pub status: Status,
}

/// Where an entry stands once its seen marks changed: the first episode not yet seen, from the given
/// season on — the seasons after it first, then the gaps left before it. With everything seen there is
/// nothing left to stand at: the entry is finished and stays at the last episode.
pub fn settle(item: &Item, seasons: &[Season], from: i64) -> Settled {
    let mut ordered = seasons.to_vec();
    order(&mut ordered);
    let start = ordered.iter().position(|s| s.number == from).unwrap_or(0);
    let seen = |list: &[Season]| -> usize { list.iter().map(|s| s.watched.len()).sum() };
    for season in ordered[start..].iter().chain(ordered[..start].iter()) {
        let progress = season_progress(season);
        if progress.complete {
            continue;
        }
        // Something newly seen takes a paused or given-up series up again; a changed season length or an
        // undo does not.
        let resumed = matches!(item.status, Status::Paused | Status::Dropped)
            && seen(seasons) > seen(&seasons_of(item));
        let status = if item.status == Status::Done || resumed {
            Status::Watching
        } else {
            item.status
        };
        return Settled {
            seasons: seasons.to_vec(),
            season: season.number,
            episode: Some(progress.next),
            status,
        };
    }
    let last = ordered
        .iter()
        .find(|s| s.number == from)
        .or_else(|| ordered.last());
    Settled {
        seasons: seasons.to_vec(),
        season: last.map_or(from, |s| s.number),
        episode: last.and_then(|s| s.episodes).or(item.episode),
        status: Status::Done,
    }
}
