//! „Bis wohin?“, pace, goals, labels and the Rückblick — against the web app's answers, counted in the
//! zone the golden was made in (Europe/Zurich, with the clocks changing on 29 March and 25 October).

use chrono::{Datelike, NaiveDate};
use chrono_tz::Europe::Zurich;
use serde_json::{json, Value};
use sondra_merk::plan::*;
use sondra_merk::recap::*;
use sondra_merk::stats::compare_de_full;
use sondra_merk::Item;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-9 * x.abs().max(1.0)
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn check(what: &str, mine: &Value, theirs: &Value) {
    assert!(
        same(mine, theirs),
        "{what}\n  mine:   {mine}\n  theirs: {theirs}"
    );
}

/// `undefined` is not `null`: the web's JSON leaves a key out where Rust has `None`.
fn drop_nulls(v: &Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), drop_nulls(v)))
                .collect(),
        ),
        Value::Array(list) => Value::Array(list.iter().map(drop_nulls).collect()),
        other => other.clone(),
    }
}

fn item(v: &Value) -> Item {
    serde_json::from_value(v.clone()).unwrap()
}

fn point(p: &Option<PlanPoint>) -> Value {
    match p {
        Some(p) => json!({"season": p.season, "episode": p.episode}),
        None => Value::Null,
    }
}

fn plan_json(p: &WatchPlan) -> Value {
    json!({
        "episodes": p.episodes, "minutes": p.minutes, "rawMinutes": p.raw_minutes,
        "first": point(&p.first), "unknown": p.unknown, "exceptions": p.exceptions,
        "films": p.films, "behind": p.behind,
        "bar": p.bar.iter().map(|s| json!({
            "number": s.number, "name": s.name, "count": s.count, "known": s.known,
            "runs": s.runs.iter().map(|r| json!({
                "kind": match r.kind { RunKind::Seen => "seen", RunKind::Planned => "planned", RunKind::Open => "open" },
                "from": r.from, "to": r.to,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn options(o: u64) -> PlanOptions {
    match o {
        0 => PlanOptions {
            from_stand: true,
            speed: 1.0,
            skip_opening: 0.0,
        },
        1 => PlanOptions {
            from_stand: false,
            speed: 1.5,
            skip_opening: 90.0,
        },
        2 => PlanOptions {
            from_stand: true,
            speed: 2.0,
            skip_opening: 300.0,
        },
        3 => PlanOptions {
            from_stand: true,
            speed: 7.0,
            skip_opening: 5000.0,
        },
        _ => PlanOptions {
            from_stand: true,
            speed: 0.0,
            skip_opening: 0.0,
        },
    }
}

fn day(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
}

#[test]
fn the_plan_to_a_point_is_the_web_apps() {
    let g = golden();
    let read = g["read"].as_array().unwrap();
    let mut n = 0;
    for case in g["plan"]["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let it = item(&read.iter().find(|r| r["item"]["id"] == id).unwrap()["item"]);
        let sp = stand_point(&it);
        check(
            &format!("{id}: stand"),
            &json!({"season": sp.season, "episode": sp.episode}),
            &case["stand"],
        );
        check(
            &format!("{id}: last"),
            &point(&last_point(&it)),
            &drop_nulls(&case["last"]),
        );
        check(
            &format!("{id}: end"),
            &point(&season_end(&it, None)),
            &drop_nulls(&case["end"]),
        );
        for (i, fallback) in [None, Some(120)].into_iter().enumerate() {
            let (seconds, source) = opening_of(&it, fallback);
            let theirs = &case["opening"][i];
            assert_eq!(
                seconds,
                theirs["seconds"].as_i64().unwrap(),
                "{id}: opening"
            );
            let name = match source {
                OpeningSource::Heard => "heard",
                OpeningSource::Series => "series",
                OpeningSource::Player => "player",
            };
            assert_eq!(
                name,
                theirs["source"].as_str().unwrap(),
                "{id}: opening source"
            );
        }
        for p in case["plans"].as_array().unwrap() {
            let target = PlanPoint {
                season: p["target"]["season"].as_i64().unwrap(),
                episode: p["target"]["episode"].as_i64().unwrap(),
            };
            let o = p["o"].as_u64().unwrap();
            let mine = plan_json(&watch_plan(&it, target, options(o)));
            check(
                &format!("{id}: plan to {target:?} with options {o}"),
                &drop_nulls(&mine),
                &drop_nulls(&p["plan"]),
            );
            n += 1;
        }
    }
    assert!(n > 500, "{n} plans checked");
}

#[test]
fn pace_dates_and_goals_are_the_web_apps() {
    let g = golden();
    let pace = &g["plan"]["pace"];
    let today = day(pace["today"].as_str().unwrap());
    for c in pace["finish"].as_array().unwrap() {
        let unit = if c["u"] == "week" {
            PaceUnit::Week
        } else {
            PaceUnit::Day
        };
        let (days, date) = finish_at(
            c["n"].as_i64().unwrap(),
            c["r"].as_f64().unwrap(),
            unit,
            today,
        );
        assert_eq!(days, c["days"].as_i64().unwrap(), "finish {c}");
        assert_eq!(day_text(date), c["date"].as_str().unwrap(), "finish {c}");
    }
    for c in pace["for"].as_array().unwrap() {
        let by = parse_day(c["by"].as_str()).unwrap();
        let mine = pace_for(
            c["n"].as_i64().unwrap(),
            c["m"].as_i64().unwrap(),
            by,
            today,
        );
        let theirs = &c["pace"];
        match (mine, theirs.is_null()) {
            (None, true) => {}
            (Some(p), false) => check(
                "paceFor",
                &json!({"days": p.days, "perDay": p.per_day, "perWeek": p.per_week, "minutesPerDay": p.minutes_per_day}),
                theirs,
            ),
            (m, _) => panic!("paceFor {c}: {m:?}"),
        }
    }
    for c in pace["parse"].as_array().unwrap() {
        let mine = parse_day(c["t"].as_str()).map(day_text);
        assert_eq!(mine.as_deref(), c["day"].as_str(), "parseDay {}", c["t"]);
    }
    for c in pace["setting"].as_array().unwrap() {
        let (rate, unit) = pace_setting(c["p"].as_f64().unwrap());
        assert_eq!(rate, c["s"]["rate"].as_i64().unwrap(), "setting {c}");
        assert_eq!(
            if unit == PaceUnit::Day { "day" } else { "week" },
            c["s"]["unit"].as_str().unwrap()
        );
    }
    for c in g["plan"]["recent"].as_array().unwrap() {
        let mut it: Item = item(&g["read"][0]["item"]);
        it.history = serde_json::from_value(c["history"].clone()).unwrap();
        let mine = recent_pace(&it, c["now"].as_i64().unwrap());
        match (mine, c["pace"].is_null()) {
            (None, true) => {}
            (Some(p), false) => check(
                "recentPace",
                &json!({"perDay": p.per_day, "count": p.count, "days": p.days}),
                &c["pace"],
            ),
            (m, _) => panic!("recentPace {}: {m:?}", c["id"]),
        }
    }
    let goal_item = item(&g["plan"]["goalItem"]);
    for c in g["plan"]["goals"].as_array().unwrap() {
        let goal: sondra_merk::Goal = serde_json::from_value(c["goal"].clone()).unwrap();
        let s = goal_state(&Zurich, &goal_item, &goal, options(0), today);
        let mine = json!({
            "left": s.left, "minutes": s.minutes, "reached": s.reached, "days": s.days,
            "perDay": s.per_day, "ahead": s.ahead, "overdue": s.overdue,
        });
        check(&format!("goal {}", c["goal"]), &mine, &c["state"]);
    }
}

#[test]
fn the_words_are_the_web_apps() {
    let g = golden();
    let l = &g["plan"]["labels"];
    let today = day(g["plan"]["pace"]["today"].as_str().unwrap());
    for c in l["point"].as_array().unwrap() {
        assert_eq!(
            point_label(PlanPoint {
                season: c["s"].as_i64().unwrap(),
                episode: c["e"].as_i64().unwrap()
            }),
            c["l"].as_str().unwrap()
        );
    }
    for c in l["decimal"].as_array().unwrap() {
        assert_eq!(
            decimal(c["v"].as_f64().unwrap(), c["d"].as_u64().unwrap() as u32),
            c["t"].as_str().unwrap(),
            "decimal {c}"
        );
    }
    for c in l["length"].as_array().unwrap() {
        assert_eq!(
            length_label(c["m"].as_f64().unwrap()),
            c["t"].as_str().unwrap(),
            "length {c}"
        );
    }
    for c in l["day"].as_array().unwrap() {
        let d = NaiveDate::from_ymd_opt(
            c["y"].as_i64().unwrap() as i32,
            c["m"].as_u64().unwrap() as u32,
            c["d"].as_u64().unwrap() as u32,
        )
        .unwrap();
        assert_eq!(day_label(d, today), c["t"].as_str().unwrap(), "day {c}");
    }
    for c in l["in"].as_array().unwrap() {
        assert_eq!(
            in_label(c["n"].as_i64().unwrap()),
            c["t"].as_str().unwrap(),
            "in {c}"
        );
    }
}

#[test]
fn the_german_order_with_accents_and_case_is_the_browsers() {
    let g = golden();
    let mut input: Vec<String> = g["fullOrder"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().into())
        .collect();
    input.sort_by(|a, b| compare_de_full(a, b));
    let theirs: Vec<&str> = g["fullOrder"]["sorted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(input.iter().map(String::as_str).collect::<Vec<_>>(), theirs);
}

#[test]
fn the_year_in_review_is_the_web_apps_across_the_changes_of_the_clock() {
    let g = golden();
    let r = &g["recap"];
    let read = g["read"][0]["item"].clone();
    // The items of the table, rebuilt from their histories.
    let mk = |id: &str, title: &str, status: &str, film: Option<i64>, history: Value| -> Item {
        let mut it = item(&read);
        it.id = id.into();
        it.title = title.into();
        it.status = serde_json::from_value(json!(status)).unwrap();
        it.film_duration = film;
        it.history = serde_json::from_value(history).ok();
        it
    };
    let recap_items: Vec<Item> = r["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            mk(
                i["id"].as_str().unwrap(),
                i["title"].as_str().unwrap(),
                i["status"].as_str().unwrap(),
                i["filmDuration"].as_i64(),
                i["history"].clone(),
            )
        })
        .collect();
    let years: Vec<i32> = recap_years(&Zurich, &recap_items);
    assert_eq!(
        years,
        r["years"]
            .as_array()
            .unwrap()
            .iter()
            .map(|y| y.as_i64().unwrap() as i32)
            .collect::<Vec<_>>()
    );
    assert_eq!(recorded_since(&recap_items), r["since"].as_i64());
    for c in r["recaps"].as_array().unwrap() {
        let year = c["year"].as_i64().unwrap() as i32;
        let m = year_recap(&Zurich, &recap_items, year);
        let top: Vec<Value> = m.top.iter().map(|t| json!({"id": t.id, "title": t.title, "episodes": t.episodes, "minutes": t.minutes})).collect();
        let mine = json!({
            "year": m.year, "episodes": m.episodes, "minutes": m.minutes, "byMonth": m.by_month,
            "busiestMonth": m.busiest_month.map(|(month, episodes)| json!({"month": month, "episodes": episodes})),
            "busiestDay": m.busiest_day.map(|(day, episodes)| json!({"day": day, "episodes": episodes})),
            "streak": m.streak, "top": top, "finished": m.finished,
        });
        check(
            &format!("recap {year}"),
            &drop_nulls(&mine),
            &drop_nulls(&c["recap"]),
        );
    }
    assert!(recap_years(&Zurich, &[]).is_empty());
    assert_eq!(recorded_since(&[]), None);
    let _ = Datelike::year(&day("2026-01-01"));
}
