//! Reading files into a list (MyAnimeList, AniList, the exports, the SQLite file), tags and the history
//! across entries — against the web app's answers.

use serde_json::{json, Value};
use sondra_merk::importer::*;
use sondra_merk::normalize::Context;
use sondra_merk::Item;

const T: i64 = 1_700_000_000_000;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
}

fn ctx() -> Context {
    Context {
        now: T,
        random: Box::new(|| "rnd00".into()),
    }
}

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

fn volatile_stripped(item: &Item) -> Value {
    let mut v = serde_json::to_value(item).unwrap();
    let o = v.as_object_mut().unwrap();
    o.remove("id");
    o.remove("updatedAt");
    v
}

#[test]
fn every_file_reads_as_the_web_app_reads_it_or_fails_with_its_sentence() {
    let g = golden();
    let web_sqlite = include_bytes!("golden/web.sqlite");
    for case in g["files"]["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes: Vec<u8> = match case["input"].as_str() {
            Some(text) => text.as_bytes().to_vec(),
            None => web_sqlite.to_vec(),
        };
        let mine = read_merkliste_file(&bytes, &mut ctx());
        match (&mine, case.get("error")) {
            (Err(e), Some(sentence)) => {
                assert_eq!(e.to_string(), sentence.as_str().unwrap(), "{name}")
            }
            (Ok(items), None) => {
                let theirs = case["items"].as_array().unwrap();
                assert_eq!(items.len(), theirs.len(), "{name}: how many");
                for (i, (m, t)) in items.iter().zip(theirs).enumerate() {
                    let m = volatile_stripped(m);
                    assert!(same(&m, t), "{name} #{i}\n  mine:   {m}\n  theirs: {t}");
                }
            }
            (m, e) => panic!("{name}: {m:?} against {e:?}"),
        }
    }
}

#[test]
fn tags_and_history_across_the_list_are_the_web_apps() {
    let g = golden();
    let read: Item = serde_json::from_value(g["read"][0]["item"].clone()).unwrap();
    let tags: Vec<Item> = g["files"]["tags"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let mut i = read.clone();
            i.id = t["id"].as_str().unwrap().into();
            i.tags = serde_json::from_value(t["tags"].clone()).ok();
            i
        })
        .collect();
    assert_eq!(json!(all_tags(&tags)), g["files"]["tags"]["result"]);
    let history: Vec<Item> = g["files"]["history"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let mut i = read.clone();
            i.id = t["id"].as_str().unwrap().into();
            i.history = serde_json::from_value(t["history"].clone()).ok();
            i
        })
        .collect();
    let mine: Vec<Value> = all_history(&history)
        .iter()
        .map(|(i, h)| json!([i.id, h.id]))
        .collect();
    assert_eq!(Value::Array(mine), g["files"]["history"]["result"]);
}
