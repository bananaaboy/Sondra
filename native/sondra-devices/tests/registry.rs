//! Two devices of one account through the stand-in for Drive: they find each other, write each
//! other, and believe nothing that is not signed.

use std::collections::BTreeMap;

use serde_json::json;
use sondra_devices::registry::{Hardware, Registry};
use sondra_devices::DeviceKeys;
use sondra_drive::fake::{Always, FakeDrive};

const DAY: f64 = 24.0 * 60.0 * 60_000.0;

fn hardware(platform: &str) -> Hardware {
    Hardware { kind: "windows".into(), platform: platform.into(), caps: vec!["text".into(), "play".into()] }
}

fn device(drive: &FakeDrive, name: &str, created: f64) -> Registry<Always> {
    Registry::new(drive.client(), DeviceKeys::generate(), name, created, hardware("Windows-App"))
}

#[test]
fn two_devices_find_each_other_and_a_message_goes_one_way_once() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    let mut a = device(&drive, "Laptop", now - 5.0 * DAY);
    let mut b = device(&drive, "Handy", now - 1.0 * DAY);
    a.refresh_list(now, false).unwrap();
    b.refresh_list(now + 1000.0, false).unwrap();
    assert_eq!(drive.file_count(), 2, "one record each");
    assert_eq!(b.devices.len(), 1);
    assert_eq!(b.devices[0]["name"], "Laptop");
    a.refresh_list(now + 2000.0, false).unwrap();
    assert_eq!(a.devices[0]["name"], "Handy");
    assert_eq!(a.me.as_ref().unwrap()["id"], a.id());

    // B writes to A; A has not met B in this round yet, but learns of it while reading.
    let t = now + 3000.0;
    b.post(a.id(), "text", "T1", json!({"text": "Hallo"}), t).unwrap();
    let mut late = device(&drive, "Tablet", now);
    late.refresh_list(t, false).unwrap();
    // A message to a device that is nobody's yet stays in Drive for it, and only for it.
    b.post(late.id(), "text", "T2", json!({"text": "Für das Tablet"}), t).unwrap();
    let got = a.read_post(t + 10.0).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].kind.as_str(), got[0].from.as_str()), ("text", b.id()));
    assert_eq!(got[0].body["text"], "Hallo");
    assert!(a.read_post(t + 20.0).unwrap().is_empty(), "read is read: the message is gone");
    let tablet = late.read_post(t + 30.0).unwrap();
    assert_eq!(tablet.len(), 1, "the other message was for the other device");
}

#[test]
fn a_message_from_a_device_not_yet_listed_is_believed_after_a_fresh_look() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    let mut a = device(&drive, "Laptop", now - DAY);
    a.refresh_list(now, false).unwrap();
    let mut b = device(&drive, "Handy", now);
    b.refresh_list(now + 1.0, false).unwrap();
    b.post(a.id(), "text", "T1", json!({"text": "neu hier"}), now + 2.0).unwrap();
    assert!(a.devices.is_empty(), "A has not looked since B joined");
    let got = a.read_post(now + 3.0).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(a.devices.len(), 1);
}

#[test]
fn forged_records_and_messages_are_ignored_and_the_owner_writes_its_record_again() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    let mut a = device(&drive, "Laptop", now - DAY);
    let mut b = device(&drive, "Handy", now - DAY);
    a.refresh_list(now, false).unwrap();
    b.refresh_list(now, false).unwrap();
    a.refresh_list(now + 1.0, false).unwrap();

    // Someone with the account changes B's record: its name, without B's signature.
    let file = drive.files_named(&format!("Gerät-{}.json", b.id())).pop().unwrap();
    let mut forged: serde_json::Value = serde_json::from_slice(&file.data).unwrap();
    forged["name"] = json!("Verbrecher");
    let id = drive.state.lock().unwrap().entries.iter().find(|(_, e)| e.name == file.name).map(|(i, _)| i.clone()).unwrap();
    drive.client().rewrite(&id, forged.to_string().as_bytes(), "application/json").unwrap();
    a.refresh_list(now + 2.0, false).unwrap();
    assert!(a.devices.is_empty(), "a record that fails its signature is not a device");

    // B's next round sees its own record is not what it wrote, and writes it again.
    b.refresh_list(now + 3.0, false).unwrap();
    a.refresh_list(now + 4.0, false).unwrap();
    assert_eq!(a.devices.len(), 1);
    assert_eq!(a.devices[0]["name"], "Handy");

    // A message in A's name for B, unsigned: deleted, delivered to nobody.
    let post = drive.client().ensure_path(&["Sondra", "Geräte", "Post"]).unwrap();
    let notes = BTreeMap::from([("sondraAn".to_string(), b.id().to_string()), ("sondraVon".to_string(), a.id().to_string())]);
    let message = json!({"v": 1, "id": "X", "from": a.id(), "to": b.id(), "at": now as i64, "type": "text", "transfer": "T", "body": {"text": "böse"}, "sig": "AAAA"});
    drive.client().create(&post, "text-X.json", message.to_string().as_bytes(), "application/json", &notes).unwrap();
    assert!(b.read_post(now + 5.0).unwrap().is_empty());
    assert!(b.read_post(now + 6.0).unwrap().is_empty());
}

#[test]
fn the_later_device_gives_up_a_name_the_earlier_one_carried_first() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    let mut first = device(&drive, "Laptop", now - 5.0 * DAY);
    first.refresh_list(now, false).unwrap();
    let mut second = device(&drive, "Laptop", now - DAY);
    second.refresh_list(now + 1.0, false).unwrap();
    assert_eq!(second.name, "Laptop 2");
    assert_eq!(second.me.as_ref().unwrap()["name"], "Laptop 2");
    first.refresh_list(now + 2.0, false).unwrap();
    assert_eq!(first.name, "Laptop", "the earlier one keeps its name");
}

#[test]
fn a_reinstall_is_offered_its_old_entry_and_adopting_it_takes_its_name() {
    let drive = FakeDrive::start();
    let old_time = 10.0 * DAY;
    let mut old = device(&drive, "Arbeits-PC", old_time - 3.0 * DAY);
    old.refresh_list(old_time, false).unwrap();
    // A fresh install: new keys, same kind and platform, a few days later, the old one silent since.
    let now = old_time + DAY;
    let mut fresh = device(&drive, "PC", now - 60_000.0);
    fresh.refresh_list(now, false).unwrap();
    assert_eq!(fresh.former.len(), 1);
    assert_eq!(fresh.former[0]["name"], "Arbeits-PC");
    fresh.adopt_former(&old.id().to_string(), now + 1.0).unwrap();
    assert_eq!(fresh.name, "Arbeits-PC");
    assert!(fresh.former.is_empty() && fresh.devices.is_empty());
    assert_eq!(drive.file_count(), 1, "the old entry is gone, the new one stands");
    // Not asked again.
    fresh.refresh_list(now + 2.0, false).unwrap();
    assert!(fresh.former.is_empty());
}

#[test]
fn an_open_device_cannot_be_removed_and_a_silent_one_can() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    let mut a = device(&drive, "Laptop", now - 9.0 * DAY);
    let mut b = device(&drive, "Handy", now - 9.0 * DAY);
    b.refresh_list(now - 20.0 * 60_000.0, false).unwrap();
    a.refresh_list(now, false).unwrap();
    assert_eq!(a.devices.len(), 1);
    a.remove_device(&b.id().to_string(), now).unwrap();
    assert!(a.devices.is_empty(), "silent for twenty minutes: it goes");
    assert_eq!(drive.file_count(), 1);
    b.refresh_list(now + 1.0, false).unwrap();
    a.refresh_list(now + 2.0, false).unwrap();
    assert_eq!(a.devices.len(), 1, "a device in use writes its entry again");
    a.remove_device(&b.id().to_string(), now + 3.0).unwrap();
    assert_eq!(a.devices.len(), 1, "open now: not removed");
}

#[test]
fn what_a_device_left_unread_for_a_day_is_cleared_once() {
    let drive = FakeDrive::start();
    let now = 10.0 * DAY;
    drive.state.lock().unwrap().clock = (3.0 * DAY) as u64;
    let mut a = device(&drive, "Laptop", now);
    a.refresh_list(now, false).unwrap();
    let b = device(&drive, "Handy", now);
    a.post(b.id(), "offer", "T1", json!({}), now).unwrap();
    a.post(b.id(), "offer", "T2", json!({}), now).unwrap();
    let before = drive.file_count();
    let ids: Vec<String> = drive.state.lock().unwrap().entries.iter().filter(|(_, e)| e.name.starts_with("offer-")).map(|(i, _)| i.clone()).collect();
    drive.age(&ids[0], 2 * 24 * 60 * 60_000);
    // The stand-in's clock counts milliseconds from the start of 2026: this reads them back.
    let to_ms = |t: &str| -> Option<f64> {
        let (day, rest) = (t[8..10].parse::<f64>().ok()? - 1.0, &t[11..]);
        let (h, m, s) = (rest[0..2].parse::<f64>().ok()?, rest[3..5].parse::<f64>().ok()?, rest[6..8].parse::<f64>().ok()?);
        Some(((day * 24.0 + h) * 60.0 + m) * 60_000.0 + s * 1000.0 + rest[9..12].parse::<f64>().ok()?)
    };
    let now_ms = 3.0 * DAY + 1000.0;
    a.clean_up(now_ms, &to_ms).unwrap();
    assert_eq!(drive.file_count(), before - 1, "one old message went, the new one stays");
    a.clean_up(now_ms, &to_ms).unwrap();
}
