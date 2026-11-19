//! Which episode a file is — against the web app's answers on forty-odd real-looking names.

use serde_json::{json, Value};
use sondra_merk::matching::*;
use sondra_merk::Item;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
}

fn items(g: &Value) -> Vec<Item> {
    serde_json::from_value(g["matching"]["items"].clone()).unwrap()
}

#[test]
fn names_are_read_as_the_web_app_reads_them() {
    let g = golden();
    let list = items(&g);
    for case in g["matching"]["names"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let guess = guess_episode(name)
            .map(|g| json!({"title": g.title, "season": g.season, "episode": g.episode}));
        assert_eq!(
            guess.unwrap_or(Value::Null),
            case["guess"],
            "guess of {name:?}"
        );
        let m = match_episode(name, &list)
            .map(|m| json!({"item": m.item, "season": m.season, "episode": m.episode}));
        assert_eq!(m.unwrap_or(Value::Null), case["match"], "match of {name:?}");
    }
    for case in g["matching"]["titles"].as_array().unwrap() {
        assert_eq!(
            normal_title(case["t"].as_str().unwrap()),
            case["n"].as_str().unwrap(),
            "{}",
            case["t"]
        );
    }
}

#[test]
fn one_episode_seen_settles_the_place_and_is_never_ticked_twice() {
    let g = golden();
    let list = items(&g);
    for case in g["matching"]["seen"].as_array().unwrap() {
        let item = list.iter().find(|i| i.id == case["id"]).unwrap();
        let (s, e) = (case["s"].as_i64().unwrap(), case["e"].as_i64().unwrap());
        assert_eq!(already_seen(item, s, e), case["already"].as_bool().unwrap());
        let r = seen_episode(item, s, e, 1_700_000_000_000, "wh-x".into());
        assert_eq!(
            serde_json::to_value(&r.settled.seasons).unwrap(),
            case["seasons"],
            "{}: seasons",
            case["id"]
        );
        assert_eq!(r.settled.season, case["season"].as_i64().unwrap());
        assert_eq!(r.settled.episode, case["episode"].as_i64());
        assert_eq!(
            serde_json::to_value(r.settled.status).unwrap(),
            case["status"]
        );
        let hist: Vec<Value> = r
            .history
            .iter()
            .map(|h| json!({"season": h.season, "episode": h.episode}))
            .collect();
        assert_eq!(Value::Array(hist), case["history"]);
        // Ticked once more it stays one tick.
        let mut after = item.clone();
        after.seasons = Some(r.settled.seasons.clone());
        assert!(already_seen(&after, s, e));
        let again = seen_episode(&after, s, e, 1_700_000_000_001, "wh-y".into());
        let marks = |seasons: &[sondra_merk::Season]| {
            seasons
                .iter()
                .find(|x| x.number == s)
                .map(|x| x.watched.clone())
        };
        assert_eq!(marks(&again.settled.seasons), marks(&r.settled.seasons));
    }
    for case in g["matching"]["hints"].as_array().unwrap() {
        let hint = case["hint"].as_object().map(|h| EpisodeHint {
            series: h["series"].as_str().unwrap().into(),
            season: h["season"].as_i64().unwrap(),
            episode: h["episode"].as_i64().unwrap(),
        });
        let m = match_hint(hint.as_ref(), &list)
            .map(|m| json!({"item": m.item, "season": m.season, "episode": m.episode}));
        assert_eq!(m.unwrap_or(Value::Null), case["match"]);
    }
    assert!((SEEN_AT - 0.9).abs() < 1e-9);
}
