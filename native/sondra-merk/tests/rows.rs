//! The sentences on a Merkliste line against the web app's (`scripts/make-folder-golden.mts`, `rows`).

use serde_json::Value;
use sondra_merk::rows::*;
use sondra_merk::Item;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/folder.json")).unwrap()
}

fn kind(name: &str) -> EpisodeKind {
    if name == "list" {
        EpisodeKind::List
    } else {
        EpisodeKind::Series
    }
}

#[test]
fn kinds_positions_and_lines_are_the_web_apps() {
    let g = golden();
    let rows = &g["rows"];
    for case in rows["kinds"].as_array().unwrap() {
        let got = episode_kind_of(case["url"].as_str().unwrap()).map(|k| if k == EpisodeKind::List { "list" } else { "series" });
        assert_eq!(got, case["kind"].as_str(), "kind of {}", case["url"]);
    }
    for case in rows["positions"].as_array().unwrap() {
        let got = position_label(case["season"].as_i64().unwrap(), case["episode"].as_i64(), kind(case["kind"].as_str().unwrap()));
        assert_eq!(got, case["label"].as_str().unwrap(), "position {case}");
    }
    let items: Vec<Item> = serde_json::from_value(rows["items"].clone()).unwrap();
    let lines = rows["lines"].as_array().unwrap();
    assert_eq!(items.len(), lines.len());
    for (item, line) in items.iter().zip(lines) {
        assert_eq!(item.id, line["id"].as_str().unwrap());
        assert_eq!(stand_label(item), line["stand"].as_str().unwrap(), "stand of {} ({})", item.id, item.url);
        assert_eq!(left_label(item).as_deref(), line["left"].as_str(), "left of {}", item.id);
    }
}

#[test]
fn the_step_forward_settles_and_writes_history_like_the_web_app() {
    use sondra_merk::matching::advance;
    let g = golden();
    let items: Vec<Item> = serde_json::from_value(g["rows"]["items"].clone()).unwrap();
    let cases = g["rows"]["advanced"].as_array().unwrap();
    assert_eq!(items.len(), cases.len());
    for (item, case) in items.iter().zip(cases) {
        let want = &case["result"];
        let got = advance(item, case["now"].as_i64().unwrap(), "i");
        assert_eq!(serde_json::to_value(&got.settled.seasons).unwrap(), want["seasons"], "seasons of {}", item.id);
        assert_eq!(got.settled.season, want["season"].as_i64().unwrap(), "season of {}", item.id);
        assert_eq!(got.settled.episode, want["episode"].as_i64(), "episode of {}", item.id);
        assert_eq!(serde_json::to_value(got.settled.status).unwrap(), want["status"], "status of {}", item.id);
        assert_eq!(serde_json::to_value(&got.history).unwrap(), want["history"], "history of {}", item.id);
    }
}
