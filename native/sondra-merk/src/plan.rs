//! „Bis wohin?“ (`src/lib/watchPlan.ts`): how much there is to watch from where someone stands to a point
//! they choose — episodes, time, when they get there at a pace, or what pace gets them there by a date.
//! Every figure is counted from the entry itself; where it does not know (a season without a number of
//! episodes) the result says so instead of guessing.
//!
//! Dates are the person's own days: the functions take the time zone (`Local` in the app, a fixed one in
//! tests) and count in local days, so a night with the clock changed is still one day.

use chrono::{Datelike, Duration, NaiveDate, TimeZone};

use crate::model::{Goal, Item, Season, OPENING_DEFAULT};
use crate::progress::{season_name, seasons_of};
use crate::stats::duration_of_episode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanPoint {
    pub season: i64,
    pub episode: i64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlanOptions {
    /// From where the entry stands (what is seen does not count), or from the first episode.
    pub from_stand: bool,
    /// Playback speed, as in the player: 1 to 2.
    pub speed: f64,
    /// Seconds of opening skipped in each episode (not in films); 0 for none.
    pub skip_opening: f64,
}

pub const PLAN_DEFAULTS: PlanOptions = PlanOptions {
    from_stand: true,
    speed: 1.0,
    skip_opening: 0.0,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKind {
    Seen,
    Planned,
    Open,
}

/// A stretch of a season's episodes that share one state, for drawing the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanRun {
    pub kind: RunKind,
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanSeason {
    pub number: i64,
    pub name: String,
    /// Episodes on the line: the known number, else as far as anything reaches.
    pub count: i64,
    pub known: bool,
    pub runs: Vec<PlanRun>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WatchPlan {
    /// Episodes still to watch up to and including the target.
    pub episodes: i64,
    /// Their time after speed and skipped openings, in whole minutes.
    pub minutes: i64,
    /// Their plain length, as the entry gives it.
    pub raw_minutes: i64,
    pub first: Option<PlanPoint>,
    /// Seasons on the way without a number of episodes: counted without them, so the result is a least.
    pub unknown: Vec<i64>,
    /// Planned episodes with a length of their own.
    pub exceptions: i64,
    /// Planned films among the episodes.
    pub films: i64,
    /// The target lies behind the stand: nothing left to watch to get there.
    pub behind: bool,
    pub bar: Vec<PlanSeason>,
}

/// Seasons in their order of watching: 1, 2, 3 …, the films after them.
fn rank(season: i64) -> i64 {
    if season == 0 {
        i64::MAX
    } else {
        season
    }
}

fn before(a: PlanPoint, b: PlanPoint) -> bool {
    rank(a.season) < rank(b.season) || (a.season == b.season && a.episode < b.episode)
}

/// `Math.round`: halves go up.
fn round(f: f64) -> i64 {
    (f + 0.5).floor() as i64
}

/// Where the entry stands, as a point: the episode to watch next.
pub fn stand_point(item: &Item) -> PlanPoint {
    PlanPoint {
        season: item.season,
        episode: item.episode.unwrap_or(1),
    }
}

/// The last episode the entry knows of: the end of its last season with a length (films not counted).
pub fn last_point(item: &Item) -> Option<PlanPoint> {
    seasons_of(item)
        .iter()
        .filter(|s| s.number > 0)
        .rev()
        .find_map(|s| {
            let end = s
                .episodes
                .or_else(|| s.watched.iter().copied().max())
                .filter(|e| *e != 0);
            end.map(|episode| PlanPoint {
                season: s.number,
                episode,
            })
        })
}

/// The end of the season the entry stands in, if its length is known.
pub fn season_end(item: &Item, season: Option<i64>) -> Option<PlanPoint> {
    let number = season.unwrap_or(item.season);
    seasons_of(item)
        .iter()
        .find(|s| s.number == number)
        .and_then(|s| s.episodes.filter(|e| *e != 0))
        .map(|episode| PlanPoint {
            season: number,
            episode,
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpeningSource {
    /// Learned by ear in the player.
    Heard,
    Series,
    Player,
}

/// The opening skipped per episode, and where its length comes from: learned by ear (the middle of what
/// was found), set on the series, or the player's own setting.
pub fn opening_of(item: &Item, fallback: Option<i64>) -> (i64, OpeningSource) {
    let mut heard: Vec<f64> = item
        .intros
        .iter()
        .flatten()
        .map(|i| i.seconds)
        .filter(|s| *s > 0.0)
        .collect();
    heard.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if !heard.is_empty() {
        return (round(heard[heard.len() / 2]), OpeningSource::Heard);
    }
    if let Some(o) = item.opening.filter(|o| *o != 0) {
        return (o, OpeningSource::Series);
    }
    (fallback.unwrap_or(OPENING_DEFAULT), OpeningSource::Player)
}

pub fn watch_plan(item: &Item, target: PlanPoint, options: PlanOptions) -> WatchPlan {
    let seasons = seasons_of(item);
    let stand = stand_point(item);
    let from_stand = options.from_stand;
    let (mut episodes, mut raw_minutes, mut exceptions, mut films) = (0i64, 0.0f64, 0i64, 0i64);
    let mut minutes = 0.0f64;
    let mut first: Option<PlanPoint> = None;
    let mut unknown = Vec::new();
    let mut bar = Vec::new();

    let counts = |season: &Season, episode: i64| -> bool {
        let point = PlanPoint {
            season: season.number,
            episode,
        };
        if before(target, point) {
            return false;
        }
        if from_stand && (before(point, stand) || season.watched.contains(&episode)) {
            return false;
        }
        true
    };

    for season in &seasons {
        let known = season.episodes.is_some();
        let reach = [
            season.episodes.unwrap_or(0),
            season.watched.iter().copied().max().unwrap_or(0),
            if season.number == target.season {
                target.episode
            } else {
                0
            },
            if season.number == stand.season {
                stand.episode
            } else {
                0
            },
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        // A season of unknown length that the plan runs through, not up to a point in it.
        let through = rank(season.number) < rank(target.season)
            && (!from_stand || rank(season.number) >= rank(stand.season));
        if !known && through {
            unknown.push(season.number);
        }
        // Inside a season of unknown length nothing past what is known is counted.
        let last = if let Some(e) = season.episodes {
            e
        } else if season.number == target.season {
            target.episode
        } else if from_stand {
            0
        } else {
            reach
        };
        let mut runs: Vec<PlanRun> = Vec::new();
        let count = reach.max(1);
        for episode in 1..=count {
            let planned = episode <= last && counts(season, episode);
            let kind = if planned {
                RunKind::Planned
            } else if season.watched.contains(&episode) {
                RunKind::Seen
            } else {
                RunKind::Open
            };
            match runs.last_mut() {
                Some(run) if run.kind == kind && run.to == episode - 1 => run.to = episode,
                _ => runs.push(PlanRun {
                    kind,
                    from: episode,
                    to: episode,
                }),
            }
            if !planned {
                continue;
            }
            episodes += 1;
            if first.is_none() {
                first = Some(PlanPoint {
                    season: season.number,
                    episode,
                });
            }
            let length = duration_of_episode(item, season.number, episode) as f64;
            raw_minutes += length;
            if item
                .durations
                .as_ref()
                .and_then(|m| m.get(&format!("{}:{episode}", season.number)))
                .and_then(|v| v.as_f64())
                .is_some_and(|d| d != 0.0)
            {
                exceptions += 1;
            }
            if season.number == 0 {
                films += 1;
                minutes += length;
            } else {
                // An opening is never more than half an episode.
                minutes += (length / 2.0).max(length - options.skip_opening / 60.0);
            }
        }
        // Films only stand on the line when they are the goal or already seen.
        if season.number == 0 && target.season != 0 && season.watched.is_empty() {
            continue;
        }
        bar.push(PlanSeason {
            number: season.number,
            name: season_name(season),
            count,
            known,
            runs,
        });
    }

    let speed = if options.speed == 0.0 || options.speed.is_nan() {
        1.0
    } else {
        options.speed
    }
    .clamp(1.0, 2.0);
    let behind = episodes == 0
        && from_stand
        && (before(target, stand)
            || seasons
                .iter()
                .any(|s| s.number == target.season && s.watched.contains(&target.episode)));
    WatchPlan {
        episodes,
        minutes: round(minutes / speed),
        raw_minutes: round(raw_minutes),
        first,
        unknown,
        exceptions,
        films,
        behind,
        bar,
    }
}

/* Pace and dates ------------------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaceUnit {
    Day,
    Week,
}

pub const DAY_MS: i64 = 86_400_000;

/// The local day a moment falls on.
pub fn local_day<Tz: TimeZone>(tz: &Tz, ms: i64) -> NaiveDate {
    tz.timestamp_millis_opt(ms)
        .single()
        .map(|t| t.date_naive())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).expect("a fixed date"))
}

/// Whole days from one day to another (0 for the same day).
pub fn days_between(from: NaiveDate, to: NaiveDate) -> i64 {
    (to - from).num_days()
}

/// „2026-11-14“ as a day, or none — and a day that does not exist rolls over as a JS `Date` does
/// (the 31st of November is the 1st of December).
pub fn parse_day(text: Option<&str>) -> Option<NaiveDate> {
    let t = text?;
    let b = t.as_bytes();
    if b.len() != 10
        || !b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return None;
    }
    let (y, m, d): (i32, i64, i64) = (
        t[0..4].parse().ok()?,
        t[5..7].parse().ok()?,
        t[8..10].parse().ok()?,
    );
    let months = m - 1;
    let year = y + months.div_euclid(12) as i32;
    let month = months.rem_euclid(12) as u32 + 1;
    NaiveDate::from_ymd_opt(year, month, 1).map(|first| first + Duration::days(d - 1))
}

/// A day as „2026-11-14“, for a date field.
pub fn day_text(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// When the last of `episodes` is watched at a pace, starting today: the number of days it takes (today
/// counting as the first) and that day.
pub fn finish_at(episodes: i64, rate: f64, unit: PaceUnit, today: NaiveDate) -> (i64, NaiveDate) {
    let per_day = (if unit == PaceUnit::Week {
        rate / 7.0
    } else {
        rate
    })
    .max(0.01);
    let days = if episodes <= 0 {
        0
    } else {
        (episodes as f64 / per_day - 1e-9).ceil() as i64
    };
    (days, today + Duration::days((days - 1).max(0)))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pace {
    pub days: i64,
    pub per_day: f64,
    pub per_week: f64,
    pub minutes_per_day: f64,
}

/// What it takes to have watched `episodes` (of `minutes`) by a day, today included.
pub fn pace_for(episodes: i64, minutes: i64, by: NaiveDate, today: NaiveDate) -> Option<Pace> {
    let days = days_between(today, by) + 1;
    if days < 1 {
        return None;
    }
    Some(Pace {
        days,
        per_day: episodes as f64 / days as f64,
        per_week: episodes as f64 / days as f64 * 7.0,
        minutes_per_day: minutes as f64 / days as f64,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecentPace {
    pub per_day: f64,
    pub count: usize,
    pub days: i64,
}

/// How fast this series was watched lately: the episodes ticked off in the last four weeks, over the days
/// since the first of them (a week at least, so one evening's binge is not taken for a habit). None below
/// two.
pub fn recent_pace(item: &Item, now: i64) -> Option<RecentPace> {
    let since = now - 28 * DAY_MS;
    let recent: Vec<i64> = item
        .history
        .iter()
        .flatten()
        .map(|e| e.at)
        .filter(|at| *at >= since && *at <= now)
        .collect();
    if recent.len() < 2 {
        return None;
    }
    let oldest = recent.iter().copied().min()?;
    let days = (((now - oldest) as f64 / DAY_MS as f64).ceil() as i64).clamp(7, 28);
    Some(RecentPace {
        per_day: recent.len() as f64 / days as f64,
        count: recent.len(),
        days,
    })
}

/// A pace as the stepper shows it: whole episodes, per day from one a day, else per week.
pub fn pace_setting(per_day: f64) -> (i64, PaceUnit) {
    if per_day >= 1.0 {
        (round(per_day).max(1), PaceUnit::Day)
    } else {
        (round(per_day * 7.0).max(1), PaceUnit::Week)
    }
}

/* A goal kept on the entry --------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GoalState {
    /// Episodes still to watch to reach it.
    pub left: i64,
    pub minutes: i64,
    pub reached: bool,
    /// With a date: the days left (today counting), and the pace that gets there.
    pub days: Option<i64>,
    pub per_day: Option<f64>,
    /// With a date: episodes ahead of an even pace since it was set (negative: behind).
    pub ahead: Option<i64>,
    pub overdue: bool,
}

pub fn goal_state<Tz: TimeZone>(
    tz: &Tz,
    item: &Item,
    goal: &Goal,
    options: PlanOptions,
    today: NaiveDate,
) -> GoalState {
    let plan = watch_plan(
        item,
        PlanPoint {
            season: goal.season,
            episode: goal.episode,
        },
        PlanOptions {
            from_stand: true,
            ..options
        },
    );
    let reached = plan.episodes == 0;
    let by = parse_day(goal.by.as_deref());
    let Some(by) = by.filter(|_| !reached) else {
        return GoalState {
            left: plan.episodes,
            minutes: plan.minutes,
            reached,
            days: None,
            per_day: None,
            ahead: None,
            overdue: false,
        };
    };
    let days = days_between(today, by) + 1;
    let overdue = days < 1;
    // Where an even pace from the day it was set would have them by now.
    let set = local_day(tz, goal.set_at);
    let total = (days_between(set, by) + 1).max(1);
    let gone = days_between(set, today).clamp(0, total);
    let expected_left = goal
        .count
        .filter(|c| *c != 0)
        .map(|c| c as f64 * (1.0 - gone as f64 / total as f64));
    GoalState {
        left: plan.episodes,
        minutes: plan.minutes,
        reached,
        days: Some(if overdue { 0 } else { days }),
        per_day: (!overdue).then(|| plan.episodes as f64 / days as f64),
        ahead: expected_left.map(|e| round(e - plan.episodes as f64)),
        overdue,
    }
}

/* Words ---------------------------------------------------------------------------------------- */

/// „Staffel 3, Folge 12“, „Film 2“.
pub fn point_label(point: PlanPoint) -> String {
    if point.season == 0 {
        format!("Film {}", point.episode)
    } else {
        format!("Staffel {}, Folge {}", point.season, point.episode)
    }
}

/// „1.5“, „2“ — a number the way it is read here (Swiss: a point, an apostrophe between thousands),
/// rounded as the browser rounds: on the shortest decimal text of the number, halves away from zero —
/// so 1.005 is „1.01“ to two places, as it reads.
pub fn decimal(value: f64, digits: u32) -> String {
    let text = format!("{}", value.abs());
    let (int_part, frac_part) = text.split_once('.').unwrap_or((&text, ""));
    let keep = digits as usize;
    let mut frac: String = frac_part.chars().take(keep).collect();
    while frac.len() < keep {
        frac.push('0');
    }
    let round_up = frac_part.chars().nth(keep).is_some_and(|c| c >= '5');
    let mut scaled: u128 = format!("{int_part}{frac}").parse().unwrap_or(0);
    if round_up {
        scaled += 1;
    }
    let all = format!("{:0>width$}", scaled, width = keep + 1);
    let (whole, fraction) = all.split_at(all.len() - keep);
    let fraction = fraction.trim_end_matches('0');
    let mut grouped = String::new();
    for (i, ch) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push('\'');
        }
        grouped.push(ch);
    }
    let is_zero = scaled == 0;
    let sign = if value < 0.0 && !is_zero { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{fraction}")
    }
}

/// „3 Std. 12 Min.“, „45 Min.“, „2 Tage 4 Std.“ — a length of watching time.
pub fn length_label(minutes: f64) -> String {
    let total = round(minutes.max(0.0));
    if total < 60 {
        return format!("{total} Min.");
    }
    let days = total / 1440;
    let hours = (total % 1440) / 60;
    let rest = total % 60;
    if days > 0 {
        let unit = if days == 1 { "Tag" } else { "Tage" };
        let h = if hours != 0 {
            format!(" {hours} Std.")
        } else {
            String::new()
        };
        return format!("{days} {unit}{h}");
    }
    let r = if rest != 0 {
        format!(" {rest} Min.")
    } else {
        String::new()
    };
    format!("{hours} Std.{r}")
}

/// „Do., 20. Nov.“, with the year when it is not this one; „heute“, „morgen“.
pub fn day_label(date: NaiveDate, today: NaiveDate) -> String {
    match days_between(today, date) {
        0 => "heute".into(),
        1 => "morgen".into(),
        _ => {
            let base = crate::stats::short_date_label(date.year(), date.month(), date.day());
            if date.year() == today.year() {
                base
            } else {
                format!("{base} {}", date.year())
            }
        }
    }
}

/// „in 3 Tagen“, „in 2 Wochen“, „in 4 Monaten“.
pub fn in_label(days: i64) -> String {
    if days <= 1 {
        "heute".into()
    } else if days == 2 {
        "morgen".into()
    } else if days < 14 {
        format!("in {} Tagen", days - 1)
    } else if days < 63 {
        format!("in {} Wochen", round((days - 1) as f64 / 7.0))
    } else {
        format!("in {} Monaten", round((days - 1) as f64 / 30.4))
    }
}
