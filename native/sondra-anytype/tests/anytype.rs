//! The link, the page and the round against a stand-in for Anytype (`scripts/verify-anytype.mts`, ported).

use serde_json::{json, Value};
use sondra_anytype::fake::{FakeAnytype, CODE, KEY, READ_ONLY, SCOPED_KEY};
use sondra_anytype::{load_from_anytype, merkliste_from_markdown, merkliste_to_markdown, sync_merkliste, Anytype, Kind, PAGE_NAME};
use sondra_drive::keystore::FileKeyStore;
use sondra_merk::merge::{Removed, LOCAL_PICTURE};
use sondra_merk::model::Item;
use sondra_merk::normalize::{normalize, Context};

fn item(value: Value) -> Item {
    normalize(&value, &mut Context::system())
}

fn range(a: i64, b: i64) -> Vec<i64> {
    (a..=b).collect()
}

fn link_in(dir: &std::path::Path, api: &str) -> Anytype {
    Anytype::new(dir, api, Box::new(FileKeyStore::new(dir.join("anytype-schluessel.bin"))))
}

struct Device {
    items: Vec<Item>,
    removed: Removed,
}

impl Device {
    fn round(&mut self, link: &Anytype) -> sondra_anytype::Result<sondra_anytype::Sync> {
        let sync = sync_merkliste(link, &self.items, &self.removed)?;
        self.items = sync.items.clone();
        self.removed = sync.removed.clone();
        Ok(sync)
    }
    fn remove(&mut self, id: &str, now: i64) {
        self.removed.insert(id.into(), now);
        self.items.retain(|i| i.id != id);
    }
}

fn paired(fake: &FakeAnytype, dir: &std::path::Path) -> Anytype {
    let link = link_in(dir, &fake.api());
    let challenge = link.challenge().unwrap();
    link.pair(&challenge, CODE).unwrap();
    link
}

fn two_series() -> Vec<Item> {
    vec![
        item(json!({ "id": "jojo", "title": "JoJo", "season": 2, "episode": 3, "cover": "data:image/webp;base64,AAAA", "updatedAt": 100,
            "seasons": [{ "number": 1, "episodes": 26, "watched": range(1, 26) }, { "number": 2, "episodes": 39, "watched": [1, 2] }] })),
        item(json!({ "id": "dark", "title": "Dark", "season": 1, "episode": 1, "status": "later", "cover": "https://bild.example/dark.jpg", "updatedAt": 100,
            "seasons": [{ "number": 1, "episodes": 10, "watched": [] }] })),
    ]
}

#[test]
fn connecting_and_choosing_a_space() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let closed = link_in(dir.path(), "http://127.0.0.1:9");
    assert!(!closed.status().reachable);

    let link = link_in(dir.path(), &fake.api());
    let status = link.status();
    assert!(status.reachable && !status.paired && status.space.is_none() && status.note.is_none());
    let challenge = link.challenge().unwrap();
    assert_eq!(challenge, "challenge-1");
    assert_eq!(link.pair(&challenge, "0000").unwrap_err().kind, Kind::WrongCode);
    assert_eq!(link.pair(&challenge, "12").unwrap_err().kind, Kind::Rejected);
    link.pair(&challenge, CODE).unwrap();
    // On Windows the key is sealed with the account's own key; elsewhere it is a file only its owner can read.
    let kept = std::fs::read(dir.path().join("anytype-schluessel.bin")).unwrap();
    if cfg!(windows) {
        assert!(!kept.windows(KEY.len()).any(|w| w == KEY.as_bytes()), "not in the clear");
    } else {
        assert_eq!(kept, KEY.as_bytes());
    }

    let spaces = link.spaces().unwrap();
    assert_eq!(spaces.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Privat", "Familie"]);
    assert_eq!(link.read().unwrap_err().kind, Kind::NoSpace);
    assert!(link.list_notes(Some("space-a")).unwrap().is_empty());
    link.use_space("space-a", "Privat", None, None).unwrap();
    assert_eq!(link.read().unwrap(), None);

    // A new run of the app keeps the key and the space.
    let again = link_in(dir.path(), &fake.api());
    let status = again.status();
    assert!(status.paired);
    assert_eq!(status.space.unwrap().name, "Privat");
}

#[test]
fn the_page_carries_the_list_and_survives_the_editor() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    let mut me = Device { items: two_series(), removed: Removed::new() };

    me.round(&link).unwrap();
    let pages = fake.live_pages();
    assert_eq!(pages.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), [PAGE_NAME]);
    let md = fake.markdown(&pages[0].id);
    assert!(md.contains("**JoJo** — Staffel 2, Folge 3 · 28 von 65 gesehen"), "{md}");
    assert!(md.contains("## Später"));
    let back = merkliste_from_markdown(&md).unwrap();
    assert_eq!(back.items.iter().map(|i| (i.id.as_str(), i.episode)).collect::<Vec<_>>(), [("jojo", Some(3)), ("dark", Some(1))]);
    // Anytype drops the language of a code block.
    let stripped = merkliste_from_markdown(&md.replace("```sondra-merkliste", "```")).unwrap();
    assert_eq!(stripped.items.len(), 2);
    assert_eq!(back.items[0].cover.as_deref(), Some(LOCAL_PICTURE));
    assert_eq!(back.items[1].cover.as_deref(), Some("https://bild.example/dark.jpg"));

    // Unchanged: nothing written, nothing received.
    let again = me.round(&link).unwrap();
    assert_eq!((again.received, again.wrote), (0, false));
    assert_eq!(fake.seen().patches, 0);
}

#[test]
fn notes_in_a_space_are_listed_and_made() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    let mut me = Device { items: two_series(), removed: Removed::new() };
    me.round(&link).unwrap();
    let first = fake.live_pages()[0].id.clone();

    let notes = link.list_notes(Some("space-a")).unwrap();
    assert_eq!(notes.iter().map(|n| (n.name.as_str(), n.item_count)).collect::<Vec<_>>(), [(PAGE_NAME, 2)]);
    let made = link.create_note(Some("space-a"), "Sondra · Merkliste (Gerät 2)", "Privat", "").unwrap();
    assert_eq!(made.name, "Sondra · Merkliste (Gerät 2)");
    assert_eq!(fake.live_pages().len(), 2);
    assert_eq!(link.status().note.unwrap().name, "Sondra · Merkliste (Gerät 2)");
    link.use_space("space-a", "Privat", Some(&first), Some(PAGE_NAME)).unwrap();
    assert_eq!(link.status().note.unwrap().id, first);
}

#[test]
fn rounds_merge_both_ways() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    let mut me = Device { items: two_series(), removed: Removed::new() };
    me.round(&link).unwrap();
    let id = fake.live_pages()[0].id.clone();

    // Another computer ticks off an episode and adds a series, then writes.
    let mut other = merkliste_from_markdown(&fake.markdown(&id)).unwrap();
    other.items[0].episode = Some(4);
    other.items[0].updated_at = 200;
    other.items[0].seasons.as_mut().unwrap()[1].watched = vec![1, 2, 3];
    other.items.push(item(json!({ "id": "frieren", "title": "Frieren", "season": 1, "episode": 1, "updatedAt": 150, "seasons": [{ "number": 1, "episodes": 28, "watched": [] }] })));
    fake.set_markdown(&id, &merkliste_to_markdown(&other.items, &Removed::new()));
    let sync = me.round(&link).unwrap();
    assert!(sync.received >= 2);
    assert_eq!(me.items.iter().find(|i| i.id == "jojo").unwrap().episode, Some(4));
    let mut ids: Vec<&str> = me.items.iter().map(|i| i.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["dark", "frieren", "jojo"]);
    assert_eq!(me.items.iter().find(|i| i.id == "jojo").unwrap().cover.as_deref(), Some("data:image/webp;base64,AAAA"));

    // A second, empty device loads everything instead of deleting.
    let mut empty = Device { items: vec![], removed: Removed::new() };
    empty.round(&link).unwrap();
    assert_eq!(empty.items.len(), 3);
    assert_eq!(merkliste_from_markdown(&fake.markdown(&id)).unwrap().items.len(), 3);

    // Removed here: it must not come back from the page.
    me.remove("dark", 300);
    me.round(&link).unwrap();
    me.round(&link).unwrap();
    assert!(me.items.iter().all(|i| i.id != "dark"));
    assert!(merkliste_from_markdown(&fake.markdown(&id)).unwrap().items.iter().all(|i| i.id != "dark"));

    // An older list written elsewhere does not overwrite the newer one here.
    let mut old = other.items[0].clone();
    old.episode = Some(2);
    old.updated_at = 50;
    fake.set_markdown(&id, &merkliste_to_markdown(&[old], &Removed::new()));
    me.round(&link).unwrap();
    assert_eq!(me.items.iter().find(|i| i.id == "jojo").unwrap().episode, Some(4));
    assert_eq!(merkliste_from_markdown(&fake.markdown(&id)).unwrap().items.iter().find(|i| i.id == "jojo").unwrap().episode, Some(4));
}

#[test]
fn an_unreadable_data_block_is_never_written_over() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    let mut me = Device { items: two_series(), removed: Removed::new() };
    me.round(&link).unwrap();
    let id = fake.live_pages()[0].id.clone();
    let intact = fake.markdown(&id);
    let start = intact.find("```").unwrap();
    let bent = format!("{}```\nkaputt\n```\n", &intact[..start]);
    fake.set_markdown(&id, &bent);
    let before = fake.markdown(&id);
    assert_eq!(me.round(&link).unwrap_err().kind, Kind::Unreadable);
    assert_eq!(fake.markdown(&id), before);
    assert_eq!(load_from_anytype(&link, &me.items, &me.removed).unwrap_err().kind, Kind::Unreadable);
}

#[test]
fn loading_from_anytype_replaces_this_list() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    let mut other = Device { items: two_series(), removed: Removed::new() };
    other.round(&link).unwrap();

    let mine = vec![item(json!({ "id": "nur-hier", "title": "Nur hier", "updatedAt": 500 })), two_series().remove(0)];
    let loaded = load_from_anytype(&link, &mine, &Removed::new()).unwrap();
    assert!(!loaded.empty);
    assert_eq!(loaded.loaded, 2);
    let mut ids: Vec<&str> = loaded.items.iter().map(|i| i.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["dark", "jojo"]);
    // This device's picture from a file is put back.
    assert_eq!(loaded.items.iter().find(|i| i.id == "jojo").unwrap().cover.as_deref(), Some("data:image/webp;base64,AAAA"));

    // Nothing there yet: empty, nothing changes.
    fake.clear_pages();
    let none = load_from_anytype(&link, &mine, &Removed::new()).unwrap();
    assert!(none.empty);
    assert_eq!(none.items.len(), 2);
}

#[test]
fn problems_are_named() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    let mut me = Device { items: two_series(), removed: Removed::new() };

    // Reading rights only: the round says so, the key stays.
    link.use_space(READ_ONLY, "Geteilt", None, None).unwrap();
    let error = me.round(&link).unwrap_err();
    assert_eq!(error.kind, Kind::Forbidden);
    assert!(error.detail.contains("403"));
    assert!(link.status().paired);

    // The page deleted for good (410): found missing, made anew.
    link.use_space("space-a", "Privat", None, None).unwrap();
    me.round(&link).unwrap();
    let gone = fake.live_pages()[0].id.clone();
    fake.delete_for_good(&gone);
    me.round(&link).unwrap();
    assert_eq!(fake.live_pages().len(), 1);
    assert_ne!(fake.live_pages()[0].id, gone);

    // The page deleted in Anytype: the next round makes a new one.
    fake.clear_pages();
    me.round(&link).unwrap();
    assert_eq!(fake.pages().len(), 1);

    // The key withdrawn in Anytype: the round says so, and the key is gone.
    fake.set_valid_key("anderer-schluessel");
    assert_eq!(me.round(&link).unwrap_err().kind, Kind::Unauthorized);
    assert!(!link.status().paired);
    assert!(!dir.path().join("anytype-schluessel.bin").exists());
}

#[test]
fn a_key_for_chosen_spaces_goes_over_v2() {
    let fake = FakeAnytype::start();
    fake.issue_scoped(true);
    fake.set_valid_key(SCOPED_KEY);
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    let config = || serde_json::from_slice::<Value>(&std::fs::read(dir.path().join("anytype.json")).unwrap_or_default()).unwrap_or_default();

    let spaces = link.spaces().unwrap();
    assert_eq!(spaces.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["space-a"]);
    assert_eq!(link.settings().api.as_deref(), Some("v2"));
    link.use_space("space-a", "Privat", None, None).unwrap();
    assert_eq!(config()["api"], "v2");
    let v1_before = fake.seen().v1_scoped;
    let mut me = Device { items: two_series(), removed: Removed::new() };
    me.round(&link).unwrap();
    assert_eq!(fake.seen().v1_scoped, v1_before, "no /v1 after the switch");
    let page = fake.live_pages().into_iter().find(|p| p.space == "space-a").unwrap();
    assert_eq!(merkliste_from_markdown(&fake.markdown(&page.id)).unwrap().items.len(), 2);

    // A long list: more blocks than one op, later more ops than one PATCH.
    let many: Vec<Item> = (0..600).map(|i| item(json!({ "id": format!("serie-{i}"), "title": format!("Serie {i}"), "updatedAt": 1000 + i }))).collect();
    me.items = many;
    me.round(&link).unwrap();
    assert_eq!(merkliste_from_markdown(&fake.markdown(&page.id)).unwrap().items.len(), 602);
    assert!(fake.seen().max_blocks <= 256);
    let patches = fake.seen().patches;
    me.items.iter_mut().find(|i| i.id == "serie-7").unwrap().episode = Some(9);
    me.items.iter_mut().find(|i| i.id == "serie-7").unwrap().updated_at = 5000;
    me.round(&link).unwrap();
    assert!(fake.seen().max_ops <= 512 && fake.seen().patches - patches > 1);
    let after = merkliste_from_markdown(&fake.markdown(&page.id)).unwrap();
    assert_eq!(after.items.len(), 602);
    assert_eq!(after.items.iter().find(|i| i.id == "serie-7").unwrap().episode, Some(9));
    let blocks = FakeAnytype::split(&fake.markdown(&page.id));
    assert_eq!(blocks.iter().filter(|b| b.starts_with("## Sondra-Daten")).count(), 1);

    // A space chosen before, which this key was not given.
    link.use_space("space-b", "Familie", None, None).unwrap();
    assert_eq!(me.round(&link).unwrap_err().kind, Kind::NotGranted);
    link.use_space("space-a", "Privat", Some(&page.id), Some(PAGE_NAME)).unwrap();

    // The next run of the app goes to /v2 straight away.
    let restarted = link_in(dir.path(), &fake.api());
    let v1 = fake.seen().v1_scoped;
    me.round(&restarted).unwrap();
    assert_eq!(fake.seen().v1_scoped, v1);

    // Pages over /v2.
    let note = link.create_note(Some("space-a"), "Sondra · Merkliste (Gerät 3)", "Privat", "").unwrap();
    assert_eq!(note.name, "Sondra · Merkliste (Gerät 3)");
    let notes = link.list_notes(Some("space-a")).unwrap();
    assert_eq!(notes.iter().find(|n| n.name == PAGE_NAME).unwrap().item_count, 602);
}

#[test]
fn forgetting_removes_key_and_link() {
    let fake = FakeAnytype::start();
    let dir = tempfile::tempdir().unwrap();
    let link = paired(&fake, dir.path());
    link.use_space("space-a", "Privat", None, None).unwrap();
    link.forget();
    assert!(!dir.path().join("anytype-schluessel.bin").exists());
    assert!(!dir.path().join("anytype.json").exists());
    let status = link.status();
    assert!(!status.paired && status.space.is_none());
}

#[test]
fn runs_of_markdown_are_cut_between_blocks() {
    let mut text = String::new();
    for i in 0..30 {
        text.push_str(&format!("- Eintrag {i}\n  zweite Zeile\n"));
    }
    text.push_str("\n```x\nzeile eins\n\nzeile zwei\n```\n");
    let runs = sondra_anytype::markdown_runs(&text, 10);
    assert!(runs.len() > 1);
    assert!(runs.iter().all(|r| !r.contains("zeile eins") || r.contains("zeile zwei")), "the fence stays whole");
    // Nothing is lost when the runs are put back together.
    let joined = runs.join("\n");
    for i in 0..30 {
        assert!(joined.contains(&format!("- Eintrag {i}")));
    }
}
