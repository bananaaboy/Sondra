//! Which Merkliste episode a played file is — read from its name (`src/lib/episodeMatch.ts`).
//! „Frieren S01E13.mkv“, „Frieren.1x13.1080p.mkv“, „[Gruppe] Frieren - 13 (1080p).mkv“, „Frieren Staffel 1
//! Folge 13.mp4“: the series is the part before the numbers, matched against the titles on the list; the
//! season is taken from the name where it says one, else from the entry. Played to 90 %, the player ticks
//! that one episode off, never others and never off again.

use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::model::{HistoryEntry, Item, Season};
use crate::progress::{seasons_of, settle, Settled};

macro_rules! rx {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).expect("a fixed pattern"))
    }};
}

/// How far into a file counts as seen.
pub const SEEN_AT: f64 = 0.9;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeGuess {
    /// The name before the numbers, tidied.
    pub title: String,
    /// None where the name gives none — anime counts episodes straight through.
    pub season: Option<i64>,
    pub episode: i64,
}

fn tidy(text: &str) -> String {
    let t = rx!(r"[._]+").replace_all(text, " ");
    let t = rx!(r"\s+").replace_all(&t, " ");
    let t = rx!(r"[\s\-–—:·|]+$").replace(&t, "");
    let t = rx!(r"^[\s\-–—:·|]+").replace(&t, "");
    t.trim().to_string()
}

/// Lowercase letters and digits only, accents dropped — for comparing names.
pub fn normal_title(text: &str) -> String {
    let folded: String = text
        .nfkd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase();
    rx!(r"[^a-z0-9]+")
        .replace_all(&folded, " ")
        .trim()
        .to_string()
}

fn int(c: &regex::Captures, i: usize) -> i64 {
    c[i].parse().unwrap_or(0)
}

/// Series, season and episode from a file name, or none when it names none.
pub fn guess_episode(file_name: &str) -> Option<EpisodeGuess> {
    // The extension, release groups in brackets, and what follows the numbers (resolution, codec) say
    // nothing about the series.
    let stem = rx!(r"(?i)\.[a-z0-9]{2,5}$").replace(file_name, "");
    let plain = rx!(r"^\s*(\[[^\]]*\]\s*)+").replace(&stem, "");
    let plain = rx!(r"(?i)\[[^\]]*\]|\((?:[^)]*(?-u:\b)(?:\d{3,4}p|x26[45]|hevc|web|bluray|dub|sub)(?-u:\b)[^)]*)\)")
        .replace_all(&plain, " ");
    let plain = rx!(r"[._]+").replace_all(&plain, " ").into_owned();

    type Read = fn(&regex::Captures) -> (Option<i64>, i64);
    let patterns: [(&Regex, Read); 6] = [
        (rx!(r"(?i)(?-u:\b)S(\d{1,2})\s?E(\d{1,4})(?-u:\b)"), |m| {
            (Some(int(m, 1)), int(m, 2))
        }),
        (rx!(r"(?i)(?-u:\b)(\d{1,2})x(\d{1,3})(?-u:\b)"), |m| {
            (Some(int(m, 1)), int(m, 2))
        }),
        (
            rx!(
                r"(?i)(?-u:\b)Staffel\s*(\d{1,2})[^0-9]{0,8}?(?:Folge|Episode|Ep)\s*(\d{1,4})(?-u:\b)"
            ),
            |m| (Some(int(m, 1)), int(m, 2)),
        ),
        (
            rx!(r"(?i)(?-u:\b)Season\s*(\d{1,2})[^0-9]{0,8}?(?:Episode|Ep)\s*(\d{1,4})(?-u:\b)"),
            |m| (Some(int(m, 1)), int(m, 2)),
        ),
        (
            rx!(r"(?i)(?-u:\b)(?:Folge|Episode|Ep)\.?\s*(\d{1,4})(?-u:\b)"),
            |m| (None, int(m, 1)),
        ),
        // Anime: „Titel - 13“, „Titel - 13v2“.
        (rx!(r"\s[-–]\s(\d{1,4})(?:v\d)?(?-u:\b)"), |m| {
            (None, int(m, 1))
        }),
    ];
    for (pattern, read) in patterns {
        let Some(m) = pattern.captures(&plain) else {
            continue;
        };
        let start = m.get(0).map_or(0, |g| g.start());
        let title = tidy(&plain[..start]);
        let (season, episode) = read(&m);
        if title.is_empty() || episode < 1 {
            continue;
        }
        return Some(EpisodeGuess {
            title,
            season,
            episode,
        });
    }
    // Last: „Titel 13“ — a bare number at the very end.
    let tidied = tidy(&plain);
    if let Some(bare) = rx!(r"^(.*[^0-9])\s(\d{1,3})\s*$").captures(&tidied) {
        let title = tidy(&bare[1]);
        if !title.is_empty() {
            return Some(EpisodeGuess {
                title,
                season: None,
                episode: int(&bare, 2),
            });
        }
    }
    None
}

/// The season an episode without one belongs to: the only season there is, the one the entry stands at
/// when the number fits it, or — counting straight through known seasons — the one it falls into.
fn season_for(item: &Item, episode: i64) -> Option<(i64, i64)> {
    let mut regular: Vec<Season> = seasons_of(item)
        .into_iter()
        .filter(|s| s.number > 0)
        .collect();
    regular.sort_by_key(|s| s.number);
    match regular.len() {
        0 => return Some((1, episode)),
        1 => return Some((regular[0].number, episode)),
        _ => {}
    }
    if let Some(here) = regular.iter().find(|s| s.number == item.season) {
        if here.episodes.is_none_or(|e| episode <= e) {
            return Some((here.number, episode));
        }
    }
    let mut before = 0;
    for season in &regular {
        let total = season.episodes?;
        if episode <= before + total {
            return Some((season.number, episode - before));
        }
        before += total;
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeMatch {
    /// The entry's id.
    pub item: String,
    pub season: i64,
    pub episode: i64,
}

/// The entry and episode a file is, when its name and the list agree.
pub fn match_episode(file_name: &str, items: &[Item]) -> Option<EpisodeMatch> {
    let guess = guess_episode(file_name)?;
    let wanted = normal_title(&guess.title);
    if wanted.chars().count() < 2 {
        return None;
    }
    // The longest title that is the file's name or stands at its start wins: „Mob Psycho 100 II“ over
    // „Mob Psycho 100“.
    let mut best: Option<&Item> = None;
    for item in items {
        let title = normal_title(&item.title);
        if title.chars().count() < 2 {
            continue;
        }
        let fits = wanted == title
            || wanted.starts_with(&format!("{title} "))
            || title.starts_with(&format!("{wanted} "));
        if fits
            && best.is_none_or(|b| title.chars().count() > normal_title(&b.title).chars().count())
        {
            best = Some(item);
        }
    }
    let best = best?;
    let (season, episode) = match guess.season {
        Some(s) => (s, guess.episode),
        None => season_for(best, guess.episode)?,
    };
    // A number past the known end is not an episode of this season.
    if let Some(total) = seasons_of(best)
        .iter()
        .find(|s| s.number == season)
        .and_then(|s| s.episodes)
    {
        if episode > total {
            return None;
        }
    }
    Some(EpisodeMatch {
        item: best.id.clone(),
        season,
        episode,
    })
}

/// What a file was filed as — in Google Drive, in a season's folder of a series: the entry by its id,
/// season and episode. Sure where a name is only a guess, so it comes first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeHint {
    pub series: String,
    pub season: i64,
    pub episode: i64,
}

/// The entry and episode a filed file is, while the entry is still on the list.
pub fn match_hint(hint: Option<&EpisodeHint>, items: &[Item]) -> Option<EpisodeMatch> {
    let hint = hint?;
    items
        .iter()
        .find(|i| i.id == hint.series)
        .map(|i| EpisodeMatch {
            item: i.id.clone(),
            season: hint.season,
            episode: hint.episode,
        })
}

/// True when this episode is already ticked off.
pub fn already_seen(item: &Item, season: i64, episode: i64) -> bool {
    seasons_of(item)
        .iter()
        .any(|s| s.number == season && s.watched.contains(&episode))
}

/// What `seen_episode` hands back: the fields of the entry that move, and the history with the new entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub settled: Settled,
    pub history: Vec<HistoryEntry>,
}

/// One episode seen, as the player reports it: ticked — a season it names that the entry lacks is added —
/// and the place settles on the first episode not yet seen.
pub fn seen_episode(
    item: &Item,
    season_number: i64,
    episode: i64,
    now: i64,
    entry_id: String,
) -> Seen {
    let have = seasons_of(item);
    let seasons: Vec<Season> = if have.iter().any(|s| s.number == season_number) {
        have.into_iter()
            .map(|mut s| {
                if s.number == season_number {
                    s.watched.push(episode);
                    s.watched.sort_unstable();
                    s.watched.dedup();
                }
                s
            })
            .collect()
    } else {
        let mut all = have;
        all.push(Season::new(season_number, None, vec![episode]));
        all
    };
    let settled = settle(item, &seasons, season_number);
    let mut history = item.history.clone().unwrap_or_default();
    history.push(HistoryEntry {
        id: entry_id,
        season: season_number,
        episode,
        at: now,
    });
    Seen { settled, history }
}

/// The step „+1“: the episode the entry stands at (and every one before it) is seen, the place settles on
/// the next, and the history gets the episode — the web app's `advance`. An entry that stands at no
/// episode only settles. The history entry's id is made from the time and four characters of luck, which
/// the caller brings.
pub fn advance(item: &Item, now: i64, luck: &str) -> Seen {
    let at = item.episode.filter(|e| *e != 0);
    let seasons = match at {
        Some(episode) => crate::progress::watched_up_to(item, item.season, episode),
        None => seasons_of(item),
    };
    let settled = settle(item, &seasons, item.season);
    let mut history = item.history.clone().unwrap_or_default();
    if let Some(episode) = at {
        history.push(HistoryEntry {
            id: format!("wh-{now}-{luck}"),
            season: item.season,
            episode,
            at: now,
        });
    }
    Seen { settled, history }
}
