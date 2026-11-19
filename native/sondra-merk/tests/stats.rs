//! Statistics, sort orders and the plan, against the web app's answers.

use serde_json::{json, Value};
use sondra_merk::stats::*;
use sondra_merk::Item;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
}

fn items_named(g: &Value, name: &str) -> Vec<Item> {
    let read: Vec<Item> = g["read"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| serde_json::from_value(c["item"].clone()).unwrap())
        .collect();
    match name {
        "alle" => read,
        "leer" => vec![],
        "fünf" => read.into_iter().take(5).collect(),
        "mit Staffeln" => read
            .into_iter()
            .filter(|i| i.seasons.as_ref().is_some_and(|s| !s.is_empty()))
            .collect(),
        "bewertet" => read.into_iter().filter(|i| i.rating.is_some()).collect(),
        "Titel" => g["stats"]["titled"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let title = t.as_str().unwrap();
                let mut item: Item = serde_json::from_value(g["read"][0]["item"].clone()).unwrap();
                item.id = format!("ti{i}");
                item.title = if title.is_empty() {
                    "Leer?".into()
                } else {
                    title.into()
                };
                item.updated_at = 1_700_000_000_000 + i as i64;
                item.status = sondra_merk::Status::Watching;
                item
            })
            .collect(),
        other => panic!("unknown set {other}"),
    }
}

#[test]
fn watch_times_read_like_the_web_apps() {
    let g = golden();
    for case in g["stats"]["minutes"].as_array().unwrap() {
        let m = case["m"].as_i64().unwrap();
        let t = format_watch_minutes(m);
        assert_eq!(
            t.short,
            case["t"]["short"].as_str().unwrap(),
            "short of {m}"
        );
        assert_eq!(t.long, case["t"]["long"].as_str().unwrap(), "long of {m}");
    }
}

#[test]
fn the_statistics_are_the_web_apps() {
    let g = golden();
    for case in g["stats"]["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let items = items_named(&g, name);
        let s = calculate_stats(&items);
        let t = &case["stats"];
        let int = |k: &str| t[k].as_i64().unwrap();
        assert_eq!(s.total_series as i64, int("totalSeries"), "{name}");
        for (mine, key) in [
            (s.watching_count, "watchingCount"),
            (s.later_count, "laterCount"),
            (s.paused_count, "pausedCount"),
            (s.done_count, "doneCount"),
            (s.dropped_count, "droppedCount"),
            (s.rated_count, "ratedCount"),
        ] {
            assert_eq!(mine as i64, int(key), "{name}: {key}");
        }
        for (mine, key) in [
            (s.watching_percent, "watchingPercent"),
            (s.later_percent, "laterPercent"),
            (s.done_percent, "donePercent"),
            (s.seen_total, "seenTotal"),
            (s.known_total_episodes, "knownTotalEpisodes"),
            (s.known_watched_episodes, "knownWatchedEpisodes"),
            (s.open_episodes_count, "openEpisodesCount"),
            (s.watch_minutes, "watchMinutes"),
            (s.total_seasons, "totalSeasons"),
            (s.completed_seasons, "completedSeasons"),
            (s.film_count, "filmCount"),
            (s.films_seen, "filmsSeen"),
        ] {
            assert_eq!(mine, int(key), "{name}: {key}");
        }
        assert_eq!(
            s.overall_progress_percent,
            t["overallProgressPercent"].as_i64(),
            "{name}: overall"
        );
        assert_eq!(
            s.watch_time.short,
            t["watchTime"]["short"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            s.watch_time.long,
            t["watchTime"]["long"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            s.avg_rating.as_deref(),
            t["avgRating"].as_str(),
            "{name}: avg"
        );
        let dist: Vec<Value> = s
            .rating_distribution
            .iter()
            .map(|(stars, count)| json!({"stars": stars, "count": count}))
            .collect();
        assert_eq!(
            Value::Array(dist),
            t["ratingDistribution"],
            "{name}: distribution"
        );
        let recent: Vec<Value> = s.recent.iter().map(|id| json!(id)).collect();
        assert_eq!(Value::Array(recent), t["recentItems"], "{name}: recent");
        for m in case["minutes"].as_array().unwrap() {
            let item = items
                .iter()
                .find(|i| i.id == m["id"].as_str().unwrap())
                .unwrap();
            assert_eq!(
                item_watched_minutes(item),
                m["watched"].as_i64().unwrap(),
                "{name}/{}: watched",
                item.id
            );
            let r = item_remaining_minutes(item);
            assert_eq!(
                r.minutes,
                m["remaining"]["minutes"].as_i64().unwrap(),
                "{name}/{}: remaining",
                item.id
            );
            assert_eq!(r.known, m["remaining"]["known"].as_bool().unwrap());
            assert_eq!(
                r.remaining_count,
                m["remaining"]["remainingCount"].as_i64().unwrap()
            );
        }
    }
}

#[test]
fn every_sort_order_gives_the_web_apps_order() {
    let g = golden();
    for case in g["stats"]["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let items = items_named(&g, name);
        for (sort, key) in [
            (Sort::Recent, "recent"),
            (Sort::Title, "title"),
            (Sort::Rating, "rating"),
            (Sort::Progress, "progress"),
            (Sort::Remaining, "remaining"),
            (Sort::Episodes, "episodes"),
        ] {
            let mine: Vec<String> = sort_items(&items, sort).into_iter().map(|i| i.id).collect();
            let theirs: Vec<String> = case["sorted"][key]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(mine, theirs, "{name}: sorted by {key}");
        }
    }
}

#[test]
fn durations_the_plan_and_the_dates_are_the_web_apps() {
    let g = golden();
    let items = items_named(&g, "alle");
    for case in g["stats"]["durations"].as_array().unwrap() {
        let item = items
            .iter()
            .find(|i| i.id == case["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            duration_of_episode(
                item,
                case["s"].as_i64().unwrap(),
                case["e"].as_i64().unwrap()
            ),
            case["minutes"].as_i64().unwrap()
        );
    }
    for case in g["stats"]["plans"].as_array().unwrap() {
        let exact = (case["n"].as_i64() == Some(7)).then_some(333);
        let p = calculate_binge_plan(
            case["n"].as_i64().unwrap(),
            case["m"].as_i64().unwrap(),
            exact,
        );
        assert_eq!(
            p.episodes_remaining,
            case["plan"]["episodesRemaining"].as_i64().unwrap()
        );
        assert_eq!(
            p.watch_time.short,
            case["plan"]["watchTime"]["short"].as_str().unwrap()
        );
        assert_eq!(
            p.watch_time.long,
            case["plan"]["watchTime"]["long"].as_str().unwrap()
        );
    }
    for case in g["stats"]["dates"].as_array().unwrap() {
        let label = short_date_label(
            case["y"].as_i64().unwrap() as i32,
            case["m"].as_u64().unwrap() as u32,
            case["d"].as_u64().unwrap() as u32,
        );
        assert_eq!(label, case["label"].as_str().unwrap());
    }
}

#[test]
fn the_pick_for_wuerfeln_leaves_out_the_finished_and_the_one_just_shown() {
    let g = golden();
    let items = items_named(&g, "alle");
    let pool = random_pool(&items, None);
    assert!(!pool.is_empty() && pool.len() <= items.len());
    let first = pool[0].id.clone();
    let without = random_pool(&items, Some(&first));
    assert!(without.iter().all(|i| i.id != first));
    assert_eq!(without.len(), pool.len() - 1);
    // One left: it is still the one.
    let one = &items[..1];
    assert_eq!(random_pool(one, Some(&one[0].id)).len(), 1);
    assert!(random_pool(&[], None).is_empty());
}

#[test]
fn swiss_numbers_have_an_apostrophe_and_a_point() {
    assert_eq!(de_ch_number(1234.5), "1'234.5");
    assert_eq!(de_ch_number(12.0), "12");
    assert_eq!(de_ch_number(1_234_567.8), "1'234'567.8");
    assert_eq!(de_ch_number(0.5), "0.5");
}
