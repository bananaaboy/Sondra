//! The two files of the list, both ways: what the web app writes is read here the way it reads it, and
//! what is written here is read by the web app (`scripts/verify-native-sqlite.mts`, run in CI on the file
//! this test leaves in `target/tmp`).

use std::collections::BTreeMap;

use serde_json::{json, Value};
use sondra_merk::merge::{travelling, Removed};
use sondra_merk::normalize::Context;
use sondra_merk::sqlite::*;
use sondra_merk::Item;

const T: i64 = 1_700_000_000_000;

fn ctx() -> Context {
    Context {
        now: T,
        random: Box::new(|| "rnd00".into()),
    }
}

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/merk.json")).unwrap()
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

#[test]
fn the_file_the_web_app_writes_is_read_the_way_the_web_app_reads_it() {
    let g = golden();
    let raw = read_sqlite_raw(include_bytes!("golden/web.sqlite")).expect("a Merkliste");
    let theirs = &g["sqlite"];
    let mine = json!({
        "items": raw.items,
        "removed": raw.removed,
        "appState": raw.app_state.iter().map(|(k, e)| (k.clone(), json!({"value": e.value, "updatedAt": e.updated_at}))).collect::<BTreeMap<_, _>>(),
    });
    assert!(
        same(&mine, theirs),
        "\n  mine:   {mine}\n  theirs: {theirs}"
    );
    // And made whole it is the list that went in.
    let snapshot = read_shared(include_bytes!("golden/web.sqlite"), &mut ctx()).unwrap();
    assert!(!snapshot.items.is_empty());
    assert_eq!(
        snapshot.removed.len(),
        theirs["removed"].as_object().unwrap().len()
    );
}

fn sample() -> (Vec<Item>, Removed, BTreeMap<String, AppEntry>) {
    let g = golden();
    let items: Vec<Item> =
        serde_json::from_value(g["mergeShared"][1]["shared"]["items"].clone()).unwrap();
    let removed: Removed =
        serde_json::from_value(g["mergeShared"][1]["shared"]["removed"].clone()).unwrap();
    let mut state = BTreeMap::new();
    state.insert(
        "ansicht".to_string(),
        AppEntry {
            value: json!("liste"),
            updated_at: T,
        },
    );
    state.insert(
        "sortierung".to_string(),
        AppEntry {
            value: json!({"by": "titel", "up": true}),
            updated_at: T + 1,
        },
    );
    (items, removed, state)
}

#[test]
fn a_file_written_here_reads_back_the_same_list() {
    let (items, mut removed, state) = sample();
    removed.insert("weg-1".into(), T + 7);
    let bytes = write_sqlite(&Snapshot {
        items: items.clone(),
        removed: removed.clone(),
        app_state: state.clone(),
    })
    .unwrap();
    assert!(bytes.starts_with(b"SQLite format 3\0"));
    let back = read_shared(&bytes, &mut ctx()).unwrap();
    let expected: Vec<Item> = items.iter().map(travelling).collect();
    assert_eq!(
        serde_json::to_value(&back.items).unwrap().to_string().len() > 100,
        true
    );
    assert!(same(
        &serde_json::to_value(&back.items).unwrap(),
        &serde_json::to_value(&expected).unwrap()
    ));
    assert_eq!(back.removed, removed);
    assert_eq!(back.app_state, state);
    assert!(
        holds_same(&back, &items, &removed),
        "a file that holds the list need not be written again"
    );
    let mut other = items.clone();
    other[0].updated_at += 1;
    assert!(!holds_same(&back, &other, &removed));
}

#[test]
fn the_older_json_file_reads_and_writes() {
    let (items, removed, _) = sample();
    let text = write_json(&items, &removed, "2026-11-19T00:00:00.000Z");
    let back = read_shared(text.as_bytes(), &mut ctx()).unwrap();
    let expected: Vec<Item> = items.iter().map(travelling).collect();
    assert!(same(
        &serde_json::to_value(&back.items).unwrap(),
        &serde_json::to_value(&expected).unwrap()
    ));
    assert_eq!(back.removed, removed);
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["kind"], "sondra-merkliste");
    assert_eq!(v["version"], 2);
}

#[test]
fn a_file_that_is_no_merkliste_is_refused_and_never_written_over() {
    assert!(matches!(
        read_shared(b"hello", &mut ctx()),
        Err(Error::NotAMerkliste)
    ));
    assert!(matches!(
        read_shared(b"{\"a\":1}", &mut ctx()),
        Err(Error::NotAMerkliste)
    ));
    assert!(matches!(
        read_shared(b"", &mut ctx()),
        Err(Error::NotAMerkliste)
    ));
    // A database with other tables is none either.
    let other = {
        let f = tempfile::NamedTempFile::new().unwrap();
        let db = rusqlite::Connection::open(f.path()).unwrap();
        db.execute("CREATE TABLE x (a)", []).unwrap();
        db.close().unwrap();
        std::fs::read(f.path()).unwrap()
    };
    assert!(matches!(
        read_shared(&other, &mut ctx()),
        Err(Error::NotAMerkliste)
    ));
}

/// The file the web app reads in CI: what this writer makes, and the list it should read as.
#[test]
fn leaves_a_file_for_the_web_app_to_read() {
    let (items, removed, state) = sample();
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("merk-interop");
    std::fs::create_dir_all(&dir).unwrap();
    let bytes = write_sqlite(&Snapshot {
        items: items.clone(),
        removed: removed.clone(),
        app_state: state.clone(),
    })
    .unwrap();
    std::fs::write(dir.join("native.sqlite"), bytes).unwrap();
    let expected = json!({
        "items": items.iter().map(travelling).collect::<Vec<_>>(),
        "removed": removed,
        "appState": state.iter().map(|(k, e)| (k.clone(), json!({"value": e.value, "updatedAt": e.updated_at}))).collect::<BTreeMap<_, _>>(),
    });
    std::fs::write(
        dir.join("native.json"),
        serde_json::to_string_pretty(&expected).unwrap(),
    )
    .unwrap();
}
