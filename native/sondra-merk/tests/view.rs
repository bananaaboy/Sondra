//! The page's filter and groups: what a typed word, a pill and „nur offene“ leave, and in which sections.

use serde_json::json;
use sondra_merk::stats::Sort;
use sondra_merk::view::*;
use sondra_merk::{Item, Status};

fn item(raw: serde_json::Value) -> Item {
    let mut base = json!({
        "id": "x", "url": "", "title": "T", "language": "auto", "season": 1, "episode": 1, "mode": "video",
        "audioFormat": "mp3", "videoPref": "best", "audioPref": "high", "autoTranscribe": false, "updatedAt": 1, "status": "watching"
    });
    base.as_object_mut().unwrap().extend(raw.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

fn list() -> Vec<Item> {
    vec![
        item(json!({ "id": "a", "title": "Frieren", "tags": ["fantasy", "ruhig"], "seasons": [{ "number": 1, "episodes": 4, "watched": [1] }] })),
        item(json!({ "id": "b", "title": "Dark", "status": "done", "notes": "Zeitreise", "seasons": [{ "number": 1, "episodes": 2, "watched": [1, 2] }] })),
        item(json!({ "id": "c", "title": "Mob Psycho", "status": "later", "tags": ["action"] })),
        item(json!({ "id": "d", "title": "Äpfel", "status": "watching", "tags": ["fantasy"] })),
    ]
}

#[test]
fn a_typed_word_is_found_in_title_notes_and_tags_without_regard_to_case() {
    let items = list();
    let ids = |q: &str| -> Vec<String> { filter_items(&items, &Filter { query: q.into(), ..Default::default() }).iter().map(|i| i.id.clone()).collect() };
    assert_eq!(ids("frie"), ["a"]);
    assert_eq!(ids("  ZEIT "), ["b"]);
    assert_eq!(ids("fantasy"), ["a", "d"]);
    assert_eq!(ids("äpf"), ["d"]);
    assert_eq!(ids(""), ["a", "b", "c", "d"]);
    assert!(ids("nichts davon").is_empty());
}

#[test]
fn pills_tags_and_only_open_narrow_further() {
    let items = list();
    let f = |filter: Filter| -> Vec<String> { filter_items(&items, &filter).iter().map(|i| i.id.clone()).collect() };
    assert_eq!(f(Filter { status: Some(Status::Done), ..Default::default() }), ["b"]);
    assert_eq!(f(Filter { tag: Some("fantasy".into()), ..Default::default() }), ["a", "d"]);
    // „Dark“ is seen to the end; „Mob Psycho“ has no seasons at all, so there is nothing seen to the end.
    assert_eq!(f(Filter { only_open: true, ..Default::default() }), ["a", "c", "d"]);
}

#[test]
fn groups_follow_the_order_of_the_stands_and_leave_out_empty_ones() {
    let items = list();
    let g = groups(&items, &Filter::default(), Sort::Title);
    let shape: Vec<(String, Vec<String>)> = g.iter().map(|g| (g.label.to_string(), g.entries.iter().map(|i| i.id.clone()).collect())).collect();
    assert_eq!(
        shape,
        vec![
            ("Am Schauen".to_string(), vec!["d".to_string(), "a".to_string()]),
            ("Später".to_string(), vec!["c".to_string()]),
            ("Fertig".to_string(), vec!["b".to_string()]),
        ]
    );
    let c = counts(&items);
    assert_eq!(c.iter().map(|(_, l, n)| format!("{l} {n}")).collect::<Vec<_>>(), ["Am Schauen 2", "Später 1", "Fertig 1"]);
    assert_eq!(all_tags(&items), ["fantasy", "ruhig", "action"]);
}
