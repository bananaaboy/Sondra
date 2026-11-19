//! What the list says about itself: how long was watched and how long is left, the statistics, the sort
//! orders, a pick for „Würfeln“, and a plan to the end (`calculateMerklisteStats`, `sortMerkItems`,
//! `calculateBingePlan`, … in `merkliste.ts`). German text, Swiss numbers: `1'234.5 Std.`

use std::cmp::Ordering;

use unicode_normalization::UnicodeNormalization;

use crate::model::{Item, Status};
use crate::progress::{caught_up, item_progress, season_progress, seasons_of};

/// `toLocaleString('de-CH')` for a number with at most one decimal: an apostrophe between thousands, a
/// point before the decimal.
pub fn de_ch_number(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    let negative = rounded < 0.0;
    let abs = rounded.abs();
    let whole = abs.trunc() as u64;
    let tenth = ((abs - abs.trunc()) * 10.0).round() as u64;
    let digits = whole.to_string();
    let mut grouped = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(ch);
    }
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.push_str(&grouped);
    if tenth > 0 {
        out.push('.');
        out.push_str(&tenth.to_string());
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTime {
    pub short: String,
    pub long: String,
}

pub fn format_watch_minutes(total_minutes: i64) -> WatchTime {
    if total_minutes <= 0 {
        return WatchTime {
            short: "0 Std.".into(),
            long: "0 Stunden".into(),
        };
    }
    let total_hours = (total_minutes as f64 / 60.0 * 10.0).round() / 10.0;
    let days = total_minutes / (60 * 24);
    let rest = total_minutes % (60 * 24);
    let (hours, minutes) = (rest / 60, rest % 60);
    let short = if total_hours < 1.0 {
        format!("{total_minutes} Min.")
    } else {
        format!("{} Std.", de_ch_number(total_hours))
    };
    let mut parts: Vec<String> = Vec::new();
    if days > 0 {
        parts.push(format!("{days} {}", if days == 1 { "Tag" } else { "Tage" }));
    }
    if hours > 0 {
        parts.push(format!("{hours} Std."));
    }
    if minutes > 0 {
        parts.push(format!("{minutes} Min."));
    }
    let long = if parts.is_empty() {
        format!("{} Std.", total_hours)
    } else {
        parts.join(", ")
    };
    WatchTime { short, long }
}

/// The duration of an episode in minutes, accounting for film duration and exceptions.
pub fn duration_of_episode(item: &Item, season: i64, episode: i64) -> i64 {
    if let Some(d) = item
        .durations
        .as_ref()
        .and_then(|m| m.get(&format!("{season}:{episode}")))
        .and_then(|v| v.as_f64())
        .filter(|d| *d > 0.0)
    {
        return (d + 0.5).floor() as i64;
    }
    if season == 0 {
        item.film_duration.unwrap_or(90)
    } else {
        item.episode_duration.unwrap_or(24)
    }
}

/// The total watched duration of a series in minutes, taking exceptions into account.
pub fn item_watched_minutes(item: &Item) -> i64 {
    seasons_of(item)
        .iter()
        .flat_map(|s| s.watched.iter().map(move |e| (s.number, *e)))
        .map(|(s, e)| duration_of_episode(item, s, e))
        .sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Remaining {
    pub minutes: i64,
    pub known: bool,
    pub remaining_count: i64,
}

/// The remaining duration of unseen episodes in known seasons of a series.
pub fn item_remaining_minutes(item: &Item) -> Remaining {
    let (mut minutes, mut known, mut count) = (0, true, 0);
    for season in seasons_of(item) {
        let Some(total) = season.episodes else {
            known = false;
            continue;
        };
        for ep in 1..=total {
            if !season.watched.contains(&ep) {
                minutes += duration_of_episode(item, season.number, ep);
                count += 1;
            }
        }
    }
    Remaining {
        minutes,
        known,
        remaining_count: count,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub total_series: usize,
    pub watching_count: usize,
    pub later_count: usize,
    pub paused_count: usize,
    pub done_count: usize,
    pub dropped_count: usize,
    pub watching_percent: i64,
    pub later_percent: i64,
    pub done_percent: i64,
    pub seen_total: i64,
    pub known_total_episodes: i64,
    pub known_watched_episodes: i64,
    pub open_episodes_count: i64,
    pub overall_progress_percent: Option<i64>,
    pub watch_minutes: i64,
    pub watch_time: WatchTime,
    pub total_seasons: i64,
    pub completed_seasons: i64,
    pub film_count: i64,
    pub films_seen: i64,
    pub rated_count: usize,
    pub avg_rating: Option<String>,
    /// Stars 5 down to 1, and how many entries have that rating.
    pub rating_distribution: Vec<(i64, usize)>,
    /// The ids of the three entries opened or changed last.
    pub recent: Vec<String>,
}

/// `Math.round` of a percentage: halves go up.
fn percent(part: usize, whole: usize) -> i64 {
    if whole == 0 {
        0
    } else {
        ((part as f64 / whole as f64) * 100.0 + 0.5).floor() as i64
    }
}

fn last_active(item: &Item) -> i64 {
    item.last_opened_at.unwrap_or(item.updated_at)
}

pub fn calculate_stats(items: &[Item]) -> Stats {
    let count = |status: Status| items.iter().filter(|i| i.status == status).count();
    let (watching, later, done, paused, dropped) = (
        count(Status::Watching),
        count(Status::Later),
        count(Status::Done),
        count(Status::Paused),
        count(Status::Dropped),
    );
    let total = items.len();
    let seen_total: i64 = items.iter().map(|i| item_progress(i).watched).sum();

    let (mut known_total, mut known_watched) = (0i64, 0i64);
    for item in items {
        let p = item_progress(item);
        if let Some(t) = p.total.filter(|t| *t > 0) {
            known_total += t;
            known_watched += p.watched;
        }
    }
    let open = (known_total - known_watched).max(0);
    let overall = (known_total > 0).then(|| {
        (((known_watched as f64 / known_total as f64) * 100.0 + 0.5).floor() as i64).min(100)
    });
    let watch_minutes: i64 = items.iter().map(item_watched_minutes).sum();

    let (mut total_seasons, mut completed, mut films, mut films_seen) = (0, 0, 0, 0);
    for item in items {
        for season in seasons_of(item) {
            if season.number == 0 {
                films += season.episodes.unwrap_or(season.watched.len() as i64);
                films_seen += season.watched.len() as i64;
            } else {
                total_seasons += 1;
                if season_progress(&season).complete {
                    completed += 1;
                }
            }
        }
    }

    let rated: Vec<&Item> = items
        .iter()
        .filter(|i| i.rating.is_some_and(|r| r > 0))
        .collect();
    let avg = (!rated.is_empty()).then(|| {
        let sum: i64 = rated.iter().map(|i| i.rating.unwrap_or(0)).sum();
        to_fixed_1(sum as f64 / rated.len() as f64)
    });
    let distribution = (1..=5)
        .rev()
        .map(|stars| {
            (
                stars,
                rated.iter().filter(|i| i.rating == Some(stars)).count(),
            )
        })
        .collect();

    let mut recent: Vec<&Item> = items.iter().collect();
    recent.sort_by_key(|i| std::cmp::Reverse(last_active(i)));
    Stats {
        total_series: total,
        watching_count: watching,
        later_count: later,
        paused_count: paused,
        done_count: done,
        dropped_count: dropped,
        watching_percent: percent(watching, total),
        later_percent: percent(later, total),
        done_percent: percent(done, total),
        seen_total,
        known_total_episodes: known_total,
        known_watched_episodes: known_watched,
        open_episodes_count: open,
        overall_progress_percent: overall,
        watch_minutes,
        watch_time: format_watch_minutes(watch_minutes),
        total_seasons,
        completed_seasons: completed,
        film_count: films,
        films_seen,
        rated_count: rated.len(),
        avg_rating: avg,
        rating_distribution: distribution,
        recent: recent.iter().take(3).map(|i| i.id.clone()).collect(),
    }
}

/// `Number.prototype.toFixed(1)`.
fn to_fixed_1(value: f64) -> String {
    format!("{:.1}", (value * 10.0 + 1e-9).round() / 10.0)
}

/* Sorting -------------------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sort {
    Recent,
    Title,
    Rating,
    Progress,
    Remaining,
    Episodes,
}

pub const SORT_OPTIONS: [(Sort, &str); 6] = [
    (Sort::Recent, "Zuletzt aktiv"),
    (Sort::Title, "Titel (A–Z)"),
    (Sort::Rating, "Beste Bewertung (★)"),
    (Sort::Progress, "Höchster Fortschritt (%)"),
    (Sort::Remaining, "Am wenigsten übrig"),
    (Sort::Episodes, "Meiste Folgen"),
];

/// A letter as the German collation sees it at the base level: no case, no accents, ß as ss.
fn base_chars(text: &str) -> Vec<char> {
    let mut out = Vec::new();
    for ch in text.nfd() {
        if ('\u{300}'..='\u{36f}').contains(&ch) {
            continue;
        }
        for lower in ch.to_lowercase() {
            if lower == 'ß' {
                out.extend(['s', 's']);
            } else {
                out.push(lower);
            }
        }
    }
    out
}

/// Spaces and signs first, then digits, then letters — the order of the collation's root.
fn class_of(ch: char) -> u8 {
    if ch.is_alphabetic() {
        2
    } else if ch.is_numeric() {
        1
    } else {
        0
    }
}

/// `localeCompare(b, 'de', { sensitivity: 'base' })`, as near as a few lines get: case and accents do not
/// count; punctuation sorts before digits, digits before letters.
pub fn compare_de(a: &str, b: &str) -> Ordering {
    let (x, y) = (base_chars(a), base_chars(b));
    for (p, q) in x.iter().zip(y.iter()) {
        let order = class_of(*p).cmp(&class_of(*q)).then(p.cmp(q));
        if order != Ordering::Equal {
            return order;
        }
    }
    x.len().cmp(&y.len())
}

fn fraction_for_sort(item: &Item) -> f64 {
    let p = item_progress(item);
    p.fraction.unwrap_or(if p.watched > 0 { 0.01 } else { 0.0 })
}

pub fn sort_items(items: &[Item], by: Sort) -> Vec<Item> {
    let mut copy = items.to_vec();
    match by {
        Sort::Title => copy.sort_by(|a, b| compare_de(&a.title, &b.title)),
        Sort::Rating => copy.sort_by(|a, b| {
            b.rating
                .unwrap_or(0)
                .cmp(&a.rating.unwrap_or(0))
                .then(last_active(b).cmp(&last_active(a)))
        }),
        Sort::Progress => copy.sort_by(|a, b| {
            fraction_for_sort(b)
                .partial_cmp(&fraction_for_sort(a))
                .unwrap_or(Ordering::Equal)
                .then(last_active(b).cmp(&last_active(a)))
        }),
        Sort::Remaining => {
            // What is left to watch, in time; an entry without known lengths goes last.
            let left = |item: &Item| -> i64 {
                let rest = item_remaining_minutes(item);
                if rest.known {
                    rest.minutes
                } else if rest.minutes != 0 {
                    rest.minutes
                } else {
                    i64::MAX
                }
            };
            copy.sort_by(|a, b| left(a).cmp(&left(b)).then(compare_de(&a.title, &b.title)));
        }
        Sort::Episodes => copy.sort_by(|a, b| {
            let total = |i: &Item| {
                let p = item_progress(i);
                p.total.unwrap_or(p.watched)
            };
            total(b).cmp(&total(a))
        }),
        Sort::Recent => copy.sort_by(|a, b| last_active(b).cmp(&last_active(a))),
    }
    copy
}

/// The entries „Würfeln“ picks from: those not yet caught up (all of them when there are none), and not
/// the one just shown when another is left. The pick itself is a random index into this list.
pub fn random_pool<'a>(items: &'a [Item], exclude: Option<&str>) -> Vec<&'a Item> {
    let unfinished: Vec<&Item> = items
        .iter()
        .filter(|i| !caught_up(&seasons_of(i)))
        .collect();
    let pool: Vec<&Item> = if unfinished.is_empty() {
        items.iter().collect()
    } else {
        unfinished
    };
    match exclude {
        Some(id) if pool.len() > 1 => pool.into_iter().filter(|i| i.id != id).collect(),
        _ => pool,
    }
}

/* The plan to the end --------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BingePlan {
    pub episodes_remaining: i64,
    pub watch_time: WatchTime,
    /// How many days ahead the end lies at one, two and three episodes a day.
    pub days_at: [i64; 3],
}

pub fn calculate_binge_plan(
    episodes_remaining: i64,
    minutes_per_episode: i64,
    exact_minutes: Option<i64>,
) -> BingePlan {
    let count = episodes_remaining.max(0);
    let total = match exact_minutes {
        Some(m) if m > 0 => m,
        _ => count * minutes_per_episode,
    };
    BingePlan {
        episodes_remaining: count,
        watch_time: format_watch_minutes(total),
        days_at: [count, (count + 1) / 2, (count + 2) / 3],
    }
}

/// A day as the Swiss German short form reads: „Do., 19. Nov.“ — the weekday of a date and its month.
pub fn short_date_label(year: i32, month: u32, day: u32) -> String {
    const WEEKDAYS: [&str; 7] = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
    const MONTHS: [&str; 12] = [
        "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.",
        "Dez.",
    ];
    // Zeller-like day of the week (0 = Sunday) for the proleptic Gregorian calendar.
    let (y, m) = if month < 3 {
        (year - 1, month + 12)
    } else {
        (year, month)
    };
    let k = y.rem_euclid(100);
    let j = y.div_euclid(100);
    let h = (day as i32 + (13 * (m as i32 + 1)) / 5 + k + k / 4 + j / 4 + 5 * j).rem_euclid(7);
    let weekday = (h + 6).rem_euclid(7); // Zeller gives 0 = Saturday
    format!(
        "{}., {day}. {}",
        WEEKDAYS[weekday as usize],
        MONTHS[(month - 1) as usize]
    )
}
