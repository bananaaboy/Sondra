//! The player's rules against the website's own answers (`scripts/make-player-golden.mts`).

use serde_json::{json, Value};
use sondra_player::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/player.json")).unwrap()
}

/// A whole number is the same number whether it was written `1` or `1.0`.
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => Value::from(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        other => other,
    }
}

fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        // JSON has no NaN: the website's writer leaves a null where one was computed.
        Value::Null => f64::NAN,
        other => other.as_f64().unwrap(),
    }
}

#[test]
fn the_lists_and_defaults_are_the_same() {
    let g = golden();
    let c = &g["constants"];
    assert_eq!(norm(json!(RATES)), norm(c["RATES"].clone()));
    assert_eq!(norm(json!(SKIPS)), norm(c["SKIPS"].clone()));
    assert_eq!(norm(json!(BOOSTS)), norm(c["BOOSTS"].clone()));
    assert_eq!(norm(json!(OPENINGS)), norm(c["OPENINGS"].clone()));
    assert_eq!(norm(json!(SLEEPS)), norm(c["SLEEPS"].clone()));
    assert_eq!(norm(json!(QUALITY_STEPS)), norm(c["QUALITY_STEPS"].clone()));
    assert_eq!(norm(serde_json::to_value(EQ_PRESETS).unwrap()), norm(c["EQ_PRESETS"].clone()));
    assert_eq!(norm(serde_json::to_value(Settings::default()).unwrap()), norm(c["DEFAULT_SETTINGS"].clone()));
}

#[test]
fn kinds_stems_and_subtitle_text() {
    let g = golden();
    for case in g["kinds"].as_array().unwrap() {
        let (name, ty) = (case["name"].as_str().unwrap(), case["type"].as_str().unwrap());
        let kind = player_kind(name, ty).map(|k| if k == Kind::Video { "video" } else { "audio" });
        assert_eq!(kind, case["kind"].as_str(), "kind of {name} ({ty})");
        assert_eq!(is_subtitle_file(name), case["subtitle"].as_bool().unwrap(), "subtitle? {name}");
        assert_eq!(stem_of(name), case["stem"].as_str().unwrap(), "stem of {name}");
    }
    for case in g["srt"].as_array().unwrap() {
        assert_eq!(srt_to_vtt(case["text"].as_str().unwrap()), case["vtt"].as_str().unwrap(), "{:?}", case["text"]);
    }
}

#[test]
fn every_saved_setting_is_checked_the_same_way() {
    let g = golden();
    for case in g["settings"].as_array().unwrap() {
        let got = norm(serde_json::to_value(Settings::from_value(&case["saved"])).unwrap());
        assert_eq!(got, norm(case["result"].clone()), "saved {}", case["saved"]);
    }
    assert_eq!(norm(serde_json::to_value(Settings::from_json(Some("{kaputt"))).unwrap()), norm(g["brokenSettings"].clone()));
    assert_eq!(norm(serde_json::to_value(Settings::from_json(None)).unwrap()), norm(g["emptySettings"].clone()));
    // What is written is read back the same.
    let some = Settings { volume: 0.4, rate: 1.5, eq_band2: -3.0, ..Settings::default() };
    assert_eq!(Settings::from_json(Some(&some.to_json())), some);
}

#[test]
fn the_place_a_file_was_left_at_keeps_the_newest_fifty() {
    let g = golden();
    let mut kept: Option<String> = None;
    for (i, case) in g["places"].as_array().unwrap().iter().enumerate() {
        kept = Some(remember_place(kept.as_deref(), &format!("film {i}.mkv"), 1000 + i as u64, Some(100.4 + i as f64)));
        let k = kept.as_deref();
        assert_eq!(remembered_place(k, &format!("film {i}.mkv"), 1000 + i as u64), case["kept"].as_f64(), "step {i}");
        assert_eq!(remembered_place(k, "film 0.mkv", 1000), case["first"].as_f64(), "first at step {i}");
        assert_eq!(remembered_place(k, "film 9.mkv", 1009), case["tenth"].as_f64(), "tenth at step {i}");
        let table: Value = serde_json::from_str(k.unwrap()).unwrap();
        assert_eq!(table.as_object().unwrap().len() as u64, case["count"].as_u64().unwrap(), "count at step {i}");
    }
    let end = &g["placesEnd"];
    kept = Some(remember_place(kept.as_deref(), "film 30.mkv", 1030, Some(7.6)));
    kept = Some(remember_place(kept.as_deref(), "film 31.mkv", 1031, None));
    kept = Some(remember_place(kept.as_deref(), "film 32.mkv", 1032, Some(0.4)));
    let k = kept.as_deref();
    let stored: Value = serde_json::from_str(k.unwrap()).unwrap();
    assert_eq!(norm(stored), norm(end["stored"].clone()));
    assert_eq!(remembered_place(k, "film 30.mkv", 1030), end["thirty"].as_f64());
    assert_eq!(remembered_place(k, "film 31.mkv", 1031), end["thirtyOne"].as_f64());
    assert_eq!(remembered_place(k, "film 32.mkv", 1032), end["thirtyTwo"].as_f64(), "a place at 0 is not worth coming back to");
    assert_eq!(remembered_place(k, "gibt es nicht", 1), end["nothing"].as_f64());
    // Strange things in the table, and a table that is no JSON.
    let odd = r#"{"a|1":"x","b|2":-3,"c|3":12}"#;
    for case in g["placesOdd"].as_array().unwrap() {
        let (name, size) = case["key"].as_str().unwrap().split_once('|').unwrap();
        assert_eq!(remembered_place(Some(odd), name, size.parse().unwrap()), case["seconds"].as_f64(), "{name}");
    }
    assert_eq!(remembered_place(Some("kein json"), "a", 1), g["placesBroken"].as_f64());
}

#[test]
fn bookmarks_are_cleaned_added_found_named_and_written_as_chapters() {
    let g = golden();
    for case in g["marksClean"].as_array().unwrap() {
        assert_eq!(norm(serde_json::to_value(clean_marks(&case["raw"])).unwrap()), norm(case["result"].clone()), "raw {}", case["raw"]);
    }
    let base = clean_marks(&g["base"]);
    assert_eq!(base.len(), 3);
    for case in g["adds"].as_array().unwrap() {
        // The web's id is the time in base 36 and luck: with the time and the luck held still, one answer.
        let (marks, added) = with_mark(&base, num(&case["at"]), 1_700_000_000_000, "i");
        assert_eq!(norm(serde_json::to_value(&marks).unwrap()), norm(case["marks"].clone()), "marks after {}", case["at"]);
        assert_eq!(norm(serde_json::to_value(&added).unwrap()), norm(case["added"].clone()), "added at {}", case["at"]);
    }
    for case in g["neighbours"].as_array().unwrap() {
        let got = neighbour_mark(&base, num(&case["time"]), case["direction"].as_i64().unwrap() > 0);
        assert_eq!(norm(serde_json::to_value(got).unwrap()), norm(case["mark"].clone()), "{} {}", case["time"], case["direction"]);
    }
    for (i, case) in g["named"].as_array().unwrap().iter().enumerate() {
        assert_eq!(mark_name(&base, i), case["name"].as_str().unwrap());
    }
    for case in g["chapters"].as_array().unwrap() {
        let marks: Vec<Mark> = serde_json::from_value(case["marks"].clone()).unwrap();
        assert_eq!(chapters_text(&marks), case["text"].as_str().unwrap(), "{}", case["marks"]);
    }
    // Kept per file, the newest hundred files.
    let mut all: Option<String> = None;
    for i in 0..105 {
        all = Some(save_marks(all.as_deref(), &format!("f{i}"), i, &base));
    }
    assert!(marks_for(all.as_deref(), "f0", 0).is_empty());
    assert_eq!(marks_for(all.as_deref(), "f5", 5).len(), 3);
    all = Some(save_marks(all.as_deref(), "f5", 5, &[]));
    assert!(marks_for(all.as_deref(), "f5", 5).is_empty(), "an empty list forgets the file");
}

#[test]
fn the_clock_the_offers_the_fade_and_the_labels() {
    let g = golden();
    for case in g["clocks"].as_array().unwrap() {
        let t = num(&case["t"]);
        assert_eq!(clock(t), case["clock"].as_str().unwrap(), "clock({t})");
        if let Some(text) = case["minutesSeconds"].as_str() {
            assert_eq!(minutes_seconds(t), text, "minutes_seconds({t})");
        }
    }
    for case in g["offers"]["opening"].as_array().unwrap() {
        let (t, d, o) = (num(&case["time"]), num(&case["duration"]), num(&case["opening"]));
        assert_eq!(opening_offered(t, d, o), case["offered"].as_bool().unwrap(), "opening_offered({t}, {d}, {o})");
    }
    for case in g["offers"]["next"].as_array().unwrap() {
        let (t, d) = (num(&case["time"]), num(&case["duration"]));
        assert_eq!(next_offered(t, d), case["offered"].as_bool().unwrap(), "next_offered({t}, {d})");
    }
    for case in g["fades"].as_array().unwrap() {
        assert_eq!(sleep_fade(num(&case["ms"])), num(&case["volume"]), "fade at {}", case["ms"]);
    }
    for case in g["rates"].as_array().unwrap() {
        assert_eq!(rate_label(num(&case["rate"])), case["label"].as_str().unwrap());
    }
}
