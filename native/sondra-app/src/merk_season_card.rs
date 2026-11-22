//! What a season card says beyond its numbers (the website's season cards): how far it is („10 von 39, weiter mit
//! Folge 11“), how much is left with the time it takes and the day it is done at one a day, and each episode with its
//! length — „Folge 1, gesehen (47 Min.)“.

use chrono::NaiveDate;
use sondra_merk::progress::season_progress;
use sondra_merk::stats::duration_of_episode;
use sondra_merk::{Item, Season};

/// „10 von 39, weiter mit Folge 11“, or „Alles gesehen“.
pub fn where_line(season: &Season) -> String {
    let p = season_progress(season);
    let unit = if season.number == 0 { "Film" } else { "Folge" };
    if p.complete {
        return "Alles gesehen".into();
    }
    match season.episodes {
        Some(total) => format!("{} von {total}, weiter mit {unit} {}", p.watched, p.next.max(1)),
        None => format!("{} gesehen, weiter mit {unit} {}", p.watched, p.next.max(1)),
    }
}

/// „Noch 29 Folgen (11,6 Std.) · fertig bei 1/Tag: So., 20. Dez.“ — `None` when nothing is left or the length is
/// unknown.
pub fn left_line(item: &Item, season: &Season, today: NaiveDate) -> Option<String> {
    let total = season.episodes?;
    let open: Vec<i64> = (1..=total).filter(|e| !season.watched.contains(e)).collect();
    if open.is_empty() {
        return None;
    }
    let minutes: i64 = open.iter().map(|e| duration_of_episode(item, season.number, *e)).sum();
    let hours = format!("{:.1}", minutes as f64 / 60.0).replace('.', ",");
    let units = if season.number == 0 { if open.len() == 1 { "Film" } else { "Filme" } } else if open.len() == 1 { "Folge" } else { "Folgen" };
    let end = today + chrono::Duration::days(open.len() as i64 - 1);
    Some(format!("Noch {} {units} ({hours} Std.) · fertig bei 1/Tag: {}", open.len(), sondra_merk::plan::day_label(end, today)))
}

/// The name of an episode's chip: „Folge 1, gesehen (47 Min.)“.
pub fn episode_name(item: &Item, season: &Season, episode: i64, here: bool) -> String {
    let unit = if season.number == 0 { "Film" } else { "Folge" };
    let seen = if season.watched.contains(&episode) { ", gesehen" } else { "" };
    let at = if here { ", hier sind Sie" } else { "" };
    format!("{unit} {episode}{seen}{at} ({} Min.)", duration_of_episode(item, season.number, episode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_says_where_it_stands_what_is_left_and_each_length() {
        let item = sondra_merk::normalize::normalize(
            &serde_json::json!({ "id": "fr", "title": "Frieren", "episodeDuration": 24, "durations": { "1:1": 47 },
                "seasons": [{ "number": 1, "episodes": 39, "watched": (1..=10).collect::<Vec<i64>>() }] }),
            &mut sondra_merk::normalize::Context::system(),
        );
        let season = item.seasons.as_ref().unwrap()[0].clone();
        assert_eq!(where_line(&season), "10 von 39, weiter mit Folge 11");
        let today = NaiveDate::from_ymd_opt(2026, 11, 22).unwrap();
        assert_eq!(left_line(&item, &season, today).unwrap(), format!("Noch 29 Folgen (11,6 Std.) · fertig bei 1/Tag: {}", sondra_merk::plan::day_label(today + chrono::Duration::days(28), today)));
        assert_eq!(episode_name(&item, &season, 1, false), "Folge 1, gesehen (47 Min.)");
        assert_eq!(episode_name(&item, &season, 11, true), "Folge 11, hier sind Sie (24 Min.)");
    }
}
