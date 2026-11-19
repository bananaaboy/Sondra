//! The Merkliste against the web app's own answers (`scripts/make-merk-golden.mts`): the same entries read
//! from the same odd shapes, the same progress, the same merge.

use serde_json::{json, Value};
use sondra_merk::merge::*;
use sondra_merk::normalize::{normalize, Context};
use sondra_merk::progress::*;
use sondra_merk::urlinfo::*;
use sondra_merk::*;

const T: i64 = 1_700_000_000_000;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
}

/// Equal as JSON values, with numbers compared as numbers (`1` and `1.0` are the same here).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn expect_same(what: &str, mine: &Value, theirs: &Value) {
    assert!(
        same(mine, theirs),
        "{what}\n  mine:   {mine}\n  theirs: {theirs}"
    );
}

fn ctx() -> Context {
    Context {
        now: T,
        random: Box::new(|| "rnd00".into()),
    }
}

fn to(v: &impl serde::Serialize) -> Value {
    serde_json::to_value(v).unwrap()
}

fn items(v: &Value) -> Vec<Item> {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn addresses_say_what_the_web_app_reads_from_them() {
    for case in golden()["urls"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        let info = parse_link_episode_info(url);
        let theirs = &case["info"];
        let mine = json!({
            "season": info.season,
            "episode": info.episode,
            "isEpisodicUrl": info.is_episodic_url,
            "seriesSlug": info.series_slug,
        });
        expect_same(&format!("info of {url:?}"), &mine, theirs);
        assert_eq!(
            derive_link_title(url),
            case["title"].as_str().unwrap(),
            "title of {url:?}"
        );
    }
}

#[test]
fn an_entry_is_read_the_way_the_web_app_reads_it() {
    let g = golden();
    let cases = g["read"].as_array().unwrap();
    assert!(cases.len() > 50);
    for case in cases {
        let item = normalize(&case["raw"], &mut ctx());
        let (mut mine, mut theirs) = (to(&item), case["item"].clone());
        if case["raw"].get("id").is_none() {
            // An id made on the spot differs by nature: both are „merk-<time>-<random>“.
            assert!(item.id.starts_with("merk-"));
            assert!(theirs["id"].as_str().unwrap().starts_with("merk-"));
            mine.as_object_mut().unwrap().remove("id");
            theirs.as_object_mut().unwrap().remove("id");
        }
        expect_same(&format!("entry {}", case["raw"]), &mine, &theirs);
    }
}

fn parts_json(season: &Season) -> Value {
    Value::Array(
        parts_of(season)
            .iter()
            .map(|p| {
                json!({
                    "part": {
                        "index": p.index, "from": p.from, "to": p.to, "episodes": p.part.episodes,
                        "title": p.part.title, "cover": p.part.cover, "coverFrame": p.part.cover_frame,
                    },
                    "name": part_name(season, p),
                    "progress": prog(&part_progress(season, p)),
                })
            })
            .collect(),
    )
}

fn prog(p: &SeasonProgress) -> Value {
    json!({ "watched": p.watched, "total": p.total, "fraction": p.fraction, "next": p.next, "complete": p.complete })
}

/// `undefined` is not `null`: the web app's JSON leaves a key out where Rust has `None`.
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

#[test]
fn progress_and_settling_are_the_web_apps() {
    let g = golden();
    let reads = g["read"].as_array().unwrap();
    for (case, read) in g["progress"].as_array().unwrap().iter().zip(reads) {
        let item: Item = serde_json::from_value(read["item"].clone()).unwrap();
        let id = &item.id;
        let seasons = seasons_of(&item);
        expect_same(
            &format!("{id}: seasonsOf"),
            &to(&seasons),
            &case["seasonsOf"],
        );
        let ip = item_progress(&item);
        expect_same(
            &format!("{id}: itemProgress"),
            &drop_nulls(
                &json!({"watched": ip.watched, "total": ip.total, "fraction": ip.fraction}),
            ),
            &drop_nulls(&case["itemProgress"]),
        );
        for (s, theirs) in seasons.iter().zip(case["seasons"].as_array().unwrap()) {
            expect_same(
                &format!("{id}/{}: name", s.number),
                &json!(season_name(s)),
                &theirs["name"],
            );
            expect_same(
                &format!("{id}/{}: progress", s.number),
                &prog(&season_progress(s)),
                &theirs["progress"],
            );
            expect_same(
                &format!("{id}/{}: parts", s.number),
                &drop_nulls(&parts_json(s)),
                &drop_nulls(&theirs["parts"]),
            );
            expect_same(
                &format!("{id}/{}: stored", s.number),
                &to(&stored_parts(s)),
                &theirs["stored"],
            );
            expect_same(
                &format!("{id}/{}: split", s.number),
                &to(&split_season(s)),
                &theirs["split"],
            );
            for probe in theirs["ofEpisode"].as_array().unwrap() {
                let e = probe["e"].as_i64();
                assert_eq!(
                    part_of_episode(s, e).index as i64,
                    probe["index"].as_i64().unwrap(),
                    "{id}/{}: part of episode {e:?}",
                    s.number
                );
            }
        }
        assert_eq!(
            caught_up(&seasons),
            case["caughtUp"].as_bool().unwrap(),
            "{id}: caughtUp"
        );
        for t in case["toggled"].as_array().unwrap() {
            let e = t["e"].as_i64().unwrap();
            expect_same(
                &format!("{id}: toggle {e}"),
                &to(&toggle_watched(&item, item.season, e)),
                &t["seasons"],
            );
        }
        for t in case["upTo"].as_array().unwrap() {
            let e = t["e"].as_i64().unwrap();
            expect_same(
                &format!("{id}: up to {e}"),
                &to(&watched_up_to(&item, item.season, e)),
                &t["seasons"],
            );
        }
        expect_same(
            &format!("{id}: range"),
            &to(&mark_range(&item, item.season, 3, 8, true)),
            &case["range"],
        );
        expect_same(
            &format!("{id}: unrange"),
            &to(&mark_range(&item, item.season, 3, 8, false)),
            &case["unrange"],
        );
        for s in case["settled"].as_array().unwrap() {
            let from = s["from"].as_i64().unwrap();
            let settled = settle(&item, &seasons, from);
            let mine = json!({
                "seasons": settled.seasons, "season": settled.season,
                "episode": settled.episode, "status": settled.status,
            });
            expect_same(
                &format!("{id}: settle from {from}"),
                &drop_nulls(&mine),
                &drop_nulls(&s["settled"]),
            );
        }
        if !seasons.is_empty() {
            let three = [
                Part {
                    episodes: Some(5),
                    ..Part::default()
                },
                Part {
                    episodes: None,
                    ..Part::default()
                },
                Part {
                    episodes: Some(3),
                    ..Part::default()
                },
            ];
            expect_same(
                &format!("{id}: withParts"),
                &to(&with_parts(&seasons[0], &three)),
                &case["withParts"],
            );
            let one = [Part {
                episodes: Some(9),
                cover: Some("https://one/part.jpg".into()),
                ..Part::default()
            }];
            expect_same(
                &format!("{id}: withOne"),
                &to(&with_parts(&seasons[0], &one)),
                &case["withOne"],
            );
        }
    }
}

#[test]
fn two_lists_merge_the_way_the_web_app_merges_them() {
    let g = golden();
    for case in g["import"].as_array().unwrap() {
        let r = merge_merkliste(&items(&case["current"]), &items(&case["incoming"]));
        let mine = json!({
            "items": r.items, "added": r.added, "updated": r.updated, "same": r.same, "kept": r.kept,
        });
        expect_same("import", &mine, &case["result"]);
    }
    for case in g["travelling"].as_array().unwrap() {
        let item: Item = serde_json::from_value(case["item"].clone()).unwrap();
        expect_same(
            &format!("travelling {}", item.id),
            &to(&travelling(&item)),
            &case["travelling"],
        );
    }
    let local = items(&g["import"][0]["current"]);
    let remote = items(&g["import"][0]["incoming"]);
    for case in g["mergeShared"].as_array().unwrap() {
        let lr: Removed = serde_json::from_value(case["localRemoved"].clone()).unwrap();
        let rr: Removed = serde_json::from_value(case["remoteRemoved"].clone()).unwrap();
        let (merged, removed) = merge_shared(&local, &lr, &remote, &rr);
        let mine = json!({ "items": merged, "removed": removed });
        expect_same(
            &format!("mergeShared {lr:?} {rr:?}"),
            &mine,
            &case["shared"],
        );
        expect_same("sharedKey", &shared_key(&merged, &removed), &case["key"]);
    }
    expect_same(
        "takeShared",
        &to(&take_shared(
            &items(&g["takeShared"]["current"]),
            &items(&g["takeShared"]["remote"]),
        )),
        &g["takeShared"]["result"],
    );
}
