//! The folder memory against the web app's own answers (`scripts/make-memory-golden.mts`): the same
//! scenarios, step by step — what each answered and what the store held afterwards.

use serde_json::{Map, Value};
use sondra_merk::folder_memory::*;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/folder-memory.json")).unwrap()
}

fn object(v: &Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

/// The store as the web app left it, compared as values: key order inside a stored table matters, so
/// tables are compared by their ordered keys as well.
fn same_store(name: &str, i: usize, got: &MemoryStore, want: &Value) {
    let want = want.as_object().unwrap();
    assert_eq!(got.0.len(), want.len(), "{name} step {i}: keys in the store");
    for (key, text) in want {
        let mine = got.0.get(key).unwrap_or_else(|| panic!("{name} step {i}: {key} missing"));
        let (a, b): (Value, Value) = match (serde_json::from_str(mine), serde_json::from_str(text.as_str().unwrap())) {
            (Ok(a), Ok(b)) => (a, b),
            // Text that was never JSON is only ever put there by the step itself, and stays.
            _ => {
                assert_eq!(mine, text.as_str().unwrap(), "{name} step {i}: {key}");
                continue;
            }
        };
        assert_eq!(a, b, "{name} step {i}: {key}");
        // Only the two tables keep an order that means something (the oldest goes first).
        if key != "sondra:ordner" {
            assert_eq!(key_order(mine), key_order(text.as_str().unwrap()), "{name} step {i}: order of {key}");
        }
    }
}

/// The keys of the stored object in the order they were written (just the top level).
fn key_order(text: &str) -> Vec<String> {
    #[derive(Debug)]
    struct Keys(Vec<String>);
    impl<'de> serde::Deserialize<'de> for Keys {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> serde::de::Visitor<'de> for V {
                type Value = Keys;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("a value")
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Keys, A::Error> {
                    let mut keys = Vec::new();
                    while let Some((k, _)) = m.next_entry::<String, serde::de::IgnoredAny>()? {
                        keys.push(k);
                    }
                    Ok(Keys(keys))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut s: A) -> Result<Keys, A::Error> {
                    while s.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                    Ok(Keys(Vec::new()))
                }
                fn visit_str<E>(self, _: &str) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
                fn visit_f64<E>(self, _: f64) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
                fn visit_u64<E>(self, _: u64) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
                fn visit_i64<E>(self, _: i64) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
                fn visit_bool<E>(self, _: bool) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
                fn visit_unit<E>(self) -> Result<Keys, E> {
                    Ok(Keys(Vec::new()))
                }
            }
            d.deserialize_any(V)
        }
    }
    serde_json::from_str::<Keys>(text).map(|k| k.0).unwrap_or_default()
}

#[test]
fn every_scenario_answers_and_stores_as_the_web_app_does() {
    let g = golden();
    let mut steps = 0;
    for scenario in g.as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let mut store = MemoryStore::default();
        let mut session = Session::default();
        for (i, row) in scenario["trace"].as_array().unwrap().iter().enumerate() {
            let step = &row["step"];
            let want = &row["result"];
            match step["op"].as_str().unwrap() {
                "set" => store.set_item(step["key"].as_str().unwrap(), step["value"].as_str().unwrap().into()),
                "save" => save_prefs(step["key"].as_str(), &object(&step["prefs"]), &mut store),
                "prefs" => {
                    let got = prefs_for(&object(&step["defaults"]), step["key"].as_str().unwrap(), &store);
                    assert_eq!(Value::Object(got), *want, "{name} step {i}: prefs");
                }
                "visit" => {
                    let got = last_visit(step["key"].as_str().unwrap(), step["now"].as_f64().unwrap(), &mut store, &mut session);
                    assert_eq!(got.map(|n| Value::from(n)).unwrap_or(Value::Null).as_f64(), want.as_f64(), "{name} step {i}: visit");
                }
                "newSession" => session = Session::default(),
                "key" => {
                    let got = folder_key(step["name"].as_str().unwrap(), step["drive"].as_bool().unwrap());
                    assert_eq!(Value::from(got), *want, "{name} step {i}: key");
                }
                other => panic!("unknown step {other}"),
            }
            same_store(name, i, &store, &row["store"]);
            steps += 1;
        }
    }
    assert!(steps > 120, "the table has its steps: {steps}");
}

#[test]
fn only_the_forty_most_recent_folders_are_kept() {
    let mut store = MemoryStore::default();
    let prefs = object(&serde_json::json!({ "sort": "date" }));
    for i in 0..(KEEP + 7) {
        save_prefs(Some(&format!("geraet:Ordner {i}")), &prefs, &mut store);
    }
    let table: Value = serde_json::from_str(&store.0["sondra:ordner:je"]).unwrap();
    let table = table.as_object().unwrap();
    assert_eq!(table.len(), KEEP);
    assert!(!table.contains_key("geraet:Ordner 6"));
    assert!(table.contains_key("geraet:Ordner 7"));
    assert!(table.contains_key(&format!("geraet:Ordner {}", KEEP + 6)));
}
