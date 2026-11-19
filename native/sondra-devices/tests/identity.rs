//! The identity of a device against what the web app's own `deviceIdentity.ts` makes with real WebCrypto
//! keys (`npm run native:golden`), and the other way round: what this crate signs, written out for the web
//! app's code to read (`npm run verify:native-devices`).

use serde_json::{json, Value};
use sondra_devices::*;

const GOLDEN: &str = include_str!("golden/devices.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

#[test]
fn canonical_json_is_the_web_apps_character_for_character() {
    for case in golden()["canon"].as_array().unwrap() {
        assert_eq!(canonical(&case["value"]), case["text"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn ids_are_the_hash_of_the_key_as_the_web_app_makes_them() {
    for case in golden()["ids"].as_array().unwrap() {
        let id = device_id_of(&case["jwk"]);
        assert_eq!(id, case["id"].as_str().unwrap());
        assert!(is_device_id(&id));
    }
    assert_eq!(short_id("ABCDEFGH"), "ABCD");
}

#[test]
fn records_the_browser_signed_are_believed_and_every_forgery_is_not() {
    let g = golden();
    for case in g["believed"].as_array().unwrap() {
        let got = check_record(&case["raw"]).is_some();
        assert_eq!(got, case["ok"].as_bool().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn the_devices_of_an_account_are_the_believable_records_seen_last() {
    let g = golden();
    let r = &g["records"];
    let raws = vec![r["laptopRecord"].clone(), r["laptopOlder"].clone(), r["laptopCaps"].clone(), r["phoneRecord"].clone(), r["intruderRecord"].clone(), json!("junk"), Value::Null];
    let picked = pick_devices(&raws);
    let want: Vec<(String, f64)> = g["picked"].as_array().unwrap().iter().map(|p| (p["id"].as_str().unwrap().to_string(), p["seen"].as_f64().unwrap())).collect();
    let got: Vec<(String, f64)> = picked.iter().map(|p| (p["id"].as_str().unwrap().to_string(), p["seen"].as_f64().unwrap())).collect();
    assert_eq!(got, want);
    // The laptop's newest record has its capabilities.
    assert!(can(picked.iter().find(|p| p["id"] == g["laptopId"]), "resume"));
    assert!(!can(picked.iter().find(|p| p["id"] == g["phoneId"]), "resume"));
    assert!(!can(None, "text"));
}

#[test]
fn messages_are_opened_or_refused_as_in_the_web_app() {
    let g = golden();
    let devices: Vec<Value> = {
        let r = &g["records"];
        pick_devices(&[r["laptopCaps"].clone(), r["phoneRecord"].clone()])
    };
    assert_eq!(devices.iter().map(|d| d["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), g["devices"].as_array().unwrap().iter().map(|d| d.as_str().unwrap().to_string()).collect::<Vec<_>>());
    for case in g["messages"].as_array().unwrap() {
        let seen_ids: Vec<String> = case["seenIds"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
        let got = open_message(&case["raw"], g["phoneId"].as_str().unwrap(), &devices, case["now"].as_f64().unwrap(), &|id| seen_ids.iter().any(|s| s == id));
        let word = match got {
            Ok(_) => "ok",
            Err(MessageProblem::Malformed) => "malformed",
            Err(MessageProblem::NotForMe) => "not-for-me",
            Err(MessageProblem::UnknownSender) => "unknown-sender",
            Err(MessageProblem::Forged) => "forged",
            Err(MessageProblem::Stale) => "stale",
            Err(MessageProblem::Replayed) => "replayed",
        };
        assert_eq!(word, case["result"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn names_are_cleaned_and_kept_apart_as_in_the_web_app() {
    for case in golden()["names"].as_array().unwrap() {
        let others: Vec<String> = case["others"].as_array().unwrap().iter().map(|o| o.as_str().unwrap().to_string()).collect();
        let wanted = case["wanted"].as_str().unwrap();
        assert_eq!(clean_name(wanted), case["cleaned"].as_str().unwrap(), "{wanted:?}");
        assert_eq!(unique_name(wanted, &others), case["unique"].as_str().unwrap(), "{wanted:?}");
    }
}

fn fields(name: &str, seen: f64, caps: &[&str]) -> RecordFields {
    RecordFields { name: name.into(), kind: "windows".into(), platform: "Windows-App".into(), created: 1_800_000_000_000.0, seen, caps: caps.iter().map(|c| c.to_string()).collect() }
}

#[test]
fn what_this_crate_signs_it_believes_and_a_change_breaks_it() {
    let keys = DeviceKeys::generate();
    let record = sign_record(&keys, &fields("Laptop", 1_800_000_000_500.0, &["text", "folder"]));
    assert!(is_device_id(record["id"].as_str().unwrap()));
    assert_eq!(record["id"], json!(keys.id()));
    assert!(check_record(&record).is_some());
    let mut changed = record.clone();
    changed["name"] = json!("Anderes");
    assert!(check_record(&changed).is_none());
    let mut more = record.clone();
    more["caps"] = json!(["text", "folder", "play"]);
    assert!(check_record(&more).is_none(), "the capabilities are signed too");
    // Without capabilities the field is not there at all, as in a record of an older version.
    let plain = sign_record(&keys, &fields("Laptop", 1.0, &[]));
    assert!(plain.get("caps").is_none() && check_record(&plain).is_some());
    // The private scalar comes back as the same device.
    let again = DeviceKeys::from_bytes(&keys.secret_bytes()).unwrap();
    assert_eq!(again.id(), keys.id());
    assert!(check_record(&sign_record(&again, &fields("Laptop", 2.0, &[]))).is_some());
}

#[test]
fn messages_are_sealed_and_opened_between_two_devices() {
    let laptop = DeviceKeys::generate();
    let phone = DeviceKeys::generate();
    let devices = vec![sign_record(&laptop, &fields("Laptop", 10.0, &[])), sign_record(&phone, &fields("Handy", 10.0, &[]))];
    let id = random_id();
    assert_eq!(id.len(), 20);
    let message = seal_message(&laptop, &id, &laptop.id(), &phone.id(), 1000.0, "offer", "T1", json!({ "files": [{ "name": "a" }] }));
    assert!(open_message(&message, &phone.id(), &devices, 1000.0, &|_| false).is_ok());
    assert_eq!(open_message(&message, &phone.id(), &devices, 1000.0 + MESSAGE_MAX_AGE + 1.0, &|_| false).unwrap_err(), MessageProblem::Stale);
    assert_eq!(open_message(&message, &laptop.id(), &devices, 1000.0, &|_| false).unwrap_err(), MessageProblem::NotForMe);
    assert_eq!(open_message(&message, &phone.id(), &devices, 1000.0, &|i| i == id).unwrap_err(), MessageProblem::Replayed);
}

/// What this crate writes for the web app to read: `npm run verify:native-devices` opens it with
/// `deviceIdentity.ts` and has to believe every record and message, and refuse every forgery.
#[test]
fn leaves_records_and_messages_for_the_web_app_to_read() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/tmp/devices-interop");
    std::fs::create_dir_all(&dir).unwrap();
    let laptop = DeviceKeys::generate();
    let phone = DeviceKeys::generate();
    let laptop_record = sign_record(&laptop, &fields("Laptop ✓ „x“", 1_800_000_000_100.0, &["play", "text", "folder"]));
    let phone_record = sign_record(&phone, &RecordFields { kind: "android".into(), platform: "Android-App".into(), ..fields("Handy", 1_800_000_000_200.0, &[]) });
    let message = seal_message(&laptop, &random_id(), &laptop.id(), &phone.id(), 1_800_000_000_300.0, "offer", "T1", json!({ "note": "Umlaute äöü 日本 🎵", "n": 5, "list": [1, 2, { "b": 1, "a": 2 }] }));
    let mut forged_record = laptop_record.clone();
    forged_record["platform"] = json!("Etwas anderes");
    let mut forged_message = message.clone();
    forged_message["body"]["n"] = json!(6);
    let out = json!({
        "records": [laptop_record, phone_record],
        "forgedRecords": [forged_record],
        "messages": [message],
        "forgedMessages": [forged_message],
        "phoneId": phone.id(),
        "at": 1_800_000_000_300.0_f64,
    });
    std::fs::write(dir.join("devices.json"), serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
