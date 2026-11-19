//! „Rückblick“ (`src/lib/recap.ts`): what was watched in a year, from the dates the Merkliste keeps with
//! every episode ticked off. Nothing here is guessed: an episode counts for the day it was marked, and an
//! episode marked twice counts once. Where the dates only start recently the recap says since when — a
//! year with three weeks in it is not a year of watching.

use std::collections::{BTreeSet, HashSet};

use chrono::{Datelike, NaiveDate, TimeZone};

use crate::model::{Item, Status};
use crate::plan::local_day;
use crate::stats::{compare_de_full, duration_of_episode};

#[derive(Debug, Clone, PartialEq)]
pub struct Top {
    pub id: String,
    pub title: String,
    pub episodes: i64,
    pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recap {
    pub year: i32,
    pub episodes: i64,
    pub minutes: i64,
    /// Episodes per month, January first.
    pub by_month: [i64; 12],
    /// The month (0 = January) with the most episodes, and how many.
    pub busiest_month: Option<(usize, i64)>,
    /// Most watched in a day, as „2026-11-14“.
    pub busiest_day: Option<(String, i64)>,
    /// The longest run of days in a row with at least one.
    pub streak: i64,
    /// The five series with the most episodes this year.
    pub top: Vec<Top>,
    /// Series that went to „Fertig“ and whose last episode was in this year.
    pub finished: i64,
}

fn day_key(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Years with at least one dated episode, newest first.
pub fn recap_years<Tz: TimeZone>(tz: &Tz, items: &[Item]) -> Vec<i32> {
    let years: BTreeSet<i32> = items
        .iter()
        .flat_map(|i| i.history.iter().flatten())
        .map(|e| local_day(tz, e.at).year())
        .collect();
    years.into_iter().rev().collect()
}

/// The first moment anything was dated; none when nothing is.
pub fn recorded_since(items: &[Item]) -> Option<i64> {
    items
        .iter()
        .flat_map(|i| i.history.iter().flatten())
        .map(|e| e.at)
        .min()
}

pub fn year_recap<Tz: TimeZone>(tz: &Tz, items: &[Item], year: i32) -> Recap {
    let mut by_month = [0i64; 12];
    // In the order the days were first met, as a `Map` keeps them: of two busiest days the first wins.
    let mut per_day: Vec<(String, i64)> = Vec::new();
    let mut per_item: Vec<(String, String, i64, i64)> = Vec::new();
    let (mut minutes, mut episodes, mut finished) = (0i64, 0i64, 0i64);
    for item in items {
        // An episode ticked twice is one episode: the first time in this year counts.
        let mut seen: HashSet<(i64, i64)> = HashSet::new();
        let mut last = 0i64;
        let mut history: Vec<_> = item.history.iter().flatten().collect();
        history.sort_by_key(|e| e.at);
        for entry in history {
            last = last.max(entry.at);
            let day = local_day(tz, entry.at);
            if day.year() != year {
                continue;
            }
            if !seen.insert((entry.season, entry.episode)) {
                continue;
            }
            let length = duration_of_episode(item, entry.season, entry.episode);
            episodes += 1;
            minutes += length;
            by_month[(day.month() - 1) as usize] += 1;
            let key = day_key(day);
            match per_day.iter_mut().find(|(d, _)| *d == key) {
                Some(row) => row.1 += 1,
                None => per_day.push((key, 1)),
            }
            match per_item.iter_mut().find(|r| r.0 == item.id) {
                Some(row) => {
                    row.2 += 1;
                    row.3 += length;
                }
                None => per_item.push((item.id.clone(), item.title.clone(), 1, length)),
            }
        }
        if item.status == Status::Done
            && !seen.is_empty()
            && last > 0
            && local_day(tz, last).year() == year
        {
            finished += 1;
        }
    }
    let month_max = by_month.iter().copied().max().unwrap_or(0);
    // The first day with the most: a later day with the same count does not replace it.
    let mut busiest_day: Option<(String, i64)> = None;
    for (day, count) in &per_day {
        if busiest_day.as_ref().is_none_or(|b| *count > b.1) {
            busiest_day = Some((day.clone(), *count));
        }
    }
    // Longest run of consecutive days.
    let mut keys: Vec<&String> = per_day.iter().map(|(d, _)| d).collect();
    keys.sort();
    let days: Vec<NaiveDate> = keys
        .into_iter()
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect();
    let (mut streak, mut run) = (0i64, 0i64);
    let mut previous: Option<NaiveDate> = None;
    for day in days {
        run = match previous {
            Some(p) if (day - p).num_days() == 1 => run + 1,
            _ => 1,
        };
        streak = streak.max(run);
        previous = Some(day);
    }
    per_item.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then(b.3.cmp(&a.3))
            .then_with(|| compare_de_full(&a.1, &b.1))
    });
    Recap {
        year,
        episodes,
        minutes,
        by_month,
        busiest_month: (month_max > 0).then(|| {
            (
                by_month.iter().position(|m| *m == month_max).unwrap_or(0),
                month_max,
            )
        }),
        busiest_day,
        streak,
        top: per_item
            .into_iter()
            .take(5)
            .map(|(id, title, episodes, minutes)| Top {
                id,
                title,
                episodes,
                minutes,
            })
            .collect(),
        finished,
    }
}
