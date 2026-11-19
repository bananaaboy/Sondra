//! A localStorage database in Chromium's shape, written here, read back: the formats of keys and values, several
//! origins, the SQLite copy and the newer JSON, tables with snappy-compressed blocks, and a folder that is still
//! locked by the app that owns it.

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine;
use rusty_leveldb::{Options, DB};
use sondra_electron::{chromium_text, find, found_in, read_storage, Storage};

fn latin1(text: &str) -> Vec<u8> {
    let mut out = vec![1u8];
    out.extend(text.chars().map(|c| c as u32 as u8));
    out
}

fn utf16(text: &str) -> Vec<u8> {
    let mut out = vec![0u8];
    for unit in text.encode_utf16() {
        out.extend(unit.to_le_bytes());
    }
    out
}

/// The value as Chromium keeps it: Latin-1 when every character fits, else UTF-16.
fn value(text: &str) -> Vec<u8> {
    if text.chars().all(|c| (c as u32) < 256) { latin1(text) } else { utf16(text) }
}

fn key(origin: &str, name: &str) -> Vec<u8> {
    let mut out = format!("_{origin}\0").into_bytes();
    out.extend(latin1(name));
    out
}

/// Writes a database the way a Chromium would have: tables (a small write buffer forces them), snappy blocks.
fn write_db(dir: &Path, rows: &[(Vec<u8>, Vec<u8>)]) {
    let mut options = Options::default();
    options.write_buffer_size = 2048;
    options.compressor = 1;
    let mut db = DB::open(dir, options).unwrap();
    db.put(b"VERSION", b"1").unwrap();
    db.put(b"META:http://127.0.0.1:47199", b"\x08\x01").unwrap();
    for (k, v) in rows {
        db.put(k, v).unwrap();
    }
    db.flush().unwrap();
    db.close().unwrap();
}

#[test]
fn text_is_read_in_both_formats() {
    assert_eq!(chromium_text(&latin1("sondra:ordner")).unwrap(), "sondra:ordner");
    assert_eq!(chromium_text(&latin1("Frieren äöü")).unwrap(), "Frieren äöü");
    assert_eq!(chromium_text(&utf16("Frieren — 葬送")).unwrap(), "Frieren — 葬送");
    assert_eq!(chromium_text(&[]), None);
    assert_eq!(chromium_text(&[7, 1, 2]), None);
    assert_eq!(chromium_text(&[0, 1]), None, "an odd number of bytes is no UTF-16");
}

#[test]
fn a_database_is_read_by_origin_and_what_is_not_storage_is_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let origin = "http://127.0.0.1:47199";
    let filler: Vec<(Vec<u8>, Vec<u8>)> = (0..200).map(|i| (key(origin, &format!("fremd:{i}")), value(&"x".repeat(100)))).collect();
    let mut rows = vec![
        (key(origin, "sondra:ordner"), value("{\"sort\":\"name\"}")),
        (key(origin, "sondra:abspielen:marken"), value("{\"film.mp4|1\":[{\"at\":12}]}")),
        (key(origin, "sondra:merkliste_removed"), value("{}")),
    ];
    rows.extend(filler);
    write_db(dir.path(), &rows);
    // The app is still running: its lock is there, and stays.
    std::fs::write(dir.path().join("LOCK"), b"").unwrap();

    let storage = read_storage(dir.path()).unwrap();
    assert_eq!(storage.keys().collect::<Vec<_>>(), [origin], "META and VERSION are not storage");
    let values = &storage[origin];
    assert_eq!(values["sondra:ordner"], "{\"sort\":\"name\"}");
    assert_eq!(values["sondra:abspielen:marken"], "{\"film.mp4|1\":[{\"at\":12}]}");
    assert_eq!(values.len(), 203);
    assert!(dir.path().join("LOCK").exists());
}

#[test]
fn the_list_is_the_sqlite_copy_unless_the_json_is_newer() {
    let sqlite = b"SQLite format 3\0 and then the rest of a database".to_vec();
    let packed = base64::engine::general_purpose::STANDARD.encode(&sqlite);
    let json = serde_json::json!([{ "id": "a", "title": "Frieren — 葬送" }, { "id": "b", "title": "Dark" }]).to_string();
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    values.insert("sondra:sqlite_db".into(), packed);
    values.insert("sondra:saved_links".into(), json.clone());
    values.insert("sondra:merkliste_removed".into(), "{\"x\":5}".into());
    let mut storage = Storage::new();
    storage.insert("http://127.0.0.1:47199".into(), values.clone());

    let found = found_in(&storage);
    assert_eq!(found.merkliste.as_deref(), Some(sqlite.as_slice()), "the database, as the app wrote it");

    // The JSON is the newer: the app said so.
    values.insert("sondra:sqlite_db_stale".into(), "1".into());
    storage.insert("http://127.0.0.1:47199".into(), values);
    let found = found_in(&storage);
    let file: serde_json::Value = serde_json::from_slice(found.merkliste.as_ref().unwrap()).unwrap();
    assert_eq!(file["items"].as_array().unwrap().len(), 2);
    assert_eq!(file["removed"]["x"], 5);
    assert_eq!(found.series, 2);
}

#[test]
fn the_page_with_the_most_is_taken_and_a_folder_with_nothing_of_ours_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let (old, now) = ("http://127.0.0.1:50123", "http://127.0.0.1:47199");
    write_db(
        dir.path(),
        &[
            (key(old, "sondra:ordner"), value("{}")),
            (key(now, "sondra:ordner"), value("{\"sort\":\"datum\"}")),
            (key(now, "sondra:abspielen"), value("{\"volume\":0.4}")),
            (key(now, "sondra:umwandeln:vorlagen"), value("[{\"name\":\"Meine\"}]")),
            (key(now, "sondra:saved_links"), value("[{\"id\":\"a\",\"title\":\"Dark\"}]")),
            (key(now, "ganz:fremd"), value("nichts")),
        ],
    );
    let found = find(dir.path()).unwrap();
    assert_eq!(found.origin, now);
    assert_eq!(found.ordner["sondra:ordner"], "{\"sort\":\"datum\"}");
    assert_eq!(found.player["sondra:abspielen"], "{\"volume\":0.4}");
    assert_eq!(found.templates.as_deref(), Some("[{\"name\":\"Meine\"}]"));
    assert_eq!(found.series, 1);
    assert!(!found.is_empty());

    let nothing = tempfile::tempdir().unwrap();
    write_db(nothing.path(), &[(key(now, "ganz:fremd"), value("nichts"))]);
    assert!(find(nothing.path()).unwrap().is_empty());
    assert!(find(Path::new("/gibt/es/nicht")).is_err());
}

#[test]
fn what_is_set_here_is_never_undone_by_taking_over() {
    use sondra_electron::merge_value;
    // An empty place takes the old value as it is.
    assert_eq!(merge_value(None, "{\"a\":1}"), "{\"a\":1}");
    assert_eq!(merge_value(Some(""), "[1]"), "[1]");
    // Objects get what they lack; what is there stays.
    let merged: serde_json::Value = serde_json::from_str(&merge_value(Some("{\"a\":1,\"b\":2}"), "{\"b\":9,\"c\":3}")).unwrap();
    assert_eq!(merged, serde_json::json!({ "a": 1, "b": 2, "c": 3 }));
    // Lists get the items they lack.
    assert_eq!(merge_value(Some("[\"x\",\"y\"]"), "[\"y\",\"z\"]"), "[\"x\",\"y\",\"z\"]");
    // Anything else stays, and a value that is no JSON is not guessed at.
    assert_eq!(merge_value(Some("true"), "false"), "true");
    assert_eq!(merge_value(Some("kein json"), "{}"), "kein json");
}
