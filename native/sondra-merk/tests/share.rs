//! Sharing against the web app's answers (`scripts/make-share-golden.mts`): what is packed here is what
//! is packed there byte for byte, a link made there opens here, and a link made here opens there
//! (`scripts/verify-native-share.mts`).

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Value};
use sondra_merk::cover::*;
use sondra_merk::share::*;
use sondra_merk::{Item, Status};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/share.json")).unwrap()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn status(v: &Value) -> Option<Status> {
    v.as_str().and_then(Status::parse)
}

fn num(v: &Value) -> Option<i64> {
    v.as_f64().map(|f| f as i64)
}

fn list_from(v: &Value) -> SharedList {
    SharedList {
        name: v["name"].as_str().unwrap().to_string(),
        items: v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| SharedItem {
                title: i["title"].as_str().unwrap().to_string(),
                status: status(&i["status"]),
                rating: num(&i["rating"]),
                season: num(&i["season"]),
                episode: num(&i["episode"]),
                seen: num(&i["seen"]),
                thumb: i["thumb"].as_str().map(unhex),
                manga: i["tile"] == "manga",
            })
            .collect(),
    }
}

fn plain(list: &SharedList) -> Value {
    json!({
        "name": list.name,
        "items": list.items.iter().map(|i| {
            let mut m = serde_json::Map::new();
            m.insert("title".into(), json!(i.title));
            if let Some(s) = i.status { m.insert("status".into(), serde_json::to_value(s).unwrap()); }
            if let Some(r) = i.rating { m.insert("rating".into(), json!(r)); }
            if let Some(s) = i.season { m.insert("season".into(), json!(s)); }
            if let Some(e) = i.episode { m.insert("episode".into(), json!(e)); }
            if let Some(s) = i.seen { m.insert("seen".into(), json!(s)); }
            if let Some(t) = &i.thumb { m.insert("thumb".into(), json!(hex(t))); if i.manga { m.insert("tile".into(), json!("manga")); } }
            Value::Object(m)
        }).collect::<Vec<_>>(),
    })
}

/// A list as the web app's JSON has it: `undefined` is a missing key.
fn theirs(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        other => {
            let mut c = other.clone();
            if let Some(items) = c["items"].as_array_mut() {
                for i in items {
                    if let Some(o) = i.as_object_mut() {
                        o.retain(|_, v| !v.is_null());
                    }
                }
            }
            c
        }
    }
}

#[test]
fn a_list_is_packed_byte_for_byte_as_the_web_app_packs_it() {
    for case in golden()["packed"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        // The list as the sharer built it — read back through the web's own `unpacked`, which is what a
        // reader sees; packing that must give the same bytes again.
        let list = list_from(&case["list"]);
        assert_eq!(
            hex(&pack_list(&list)),
            case["packed"].as_str().unwrap(),
            "{key}: packed"
        );
        let unpacked = unpack_list(&unhex(case["packed"].as_str().unwrap()));
        assert_eq!(
            unpacked.as_ref().map(plain),
            Some(theirs(&case["unpacked"])),
            "{key}: unpacked"
        );
    }
}

#[test]
fn links_and_files_made_by_the_web_app_open_here() {
    for case in golden()["packed"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        let decoded = decode_share(case["link"].as_str().unwrap());
        assert_eq!(
            decoded.as_ref().map(plain),
            Some(theirs(&case["decoded"])),
            "{key}: link"
        );
        let file = read_share_file(&unhex(case["file"].as_str().unwrap()));
        assert_eq!(
            file.as_ref().map(plain),
            Some(theirs(&case["fileRead"])),
            "{key}: file"
        );
    }
}

#[test]
fn links_and_files_made_here_read_back_the_same() {
    for case in golden()["packed"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        let list = unpack_list(&unhex(case["packed"].as_str().unwrap())).unwrap();
        let link = encode_share(&list);
        assert_eq!(
            decode_share(&link).as_ref().map(plain),
            Some(plain(&list)),
            "{key}"
        );
        assert_eq!(
            read_share_file(&share_file(&list)).as_ref().map(plain),
            Some(plain(&list)),
            "{key}: file"
        );
        // Not much longer than the web's: the same bytes, another compressor.
        let web = case["link"].as_str().unwrap().len();
        assert!(
            link.len() <= web + web / 5 + 16,
            "{key}: {} against {web}",
            link.len()
        );
    }
}

#[test]
fn what_is_cut_off_or_wrong_is_nothing_not_a_guess() {
    for case in golden()["broken"].as_array().unwrap() {
        let bytes = unhex(case["bytes"].as_str().unwrap());
        let mine = unpack_list(&bytes);
        assert_eq!(
            mine.as_ref().map(plain),
            if case["list"].is_null() {
                None
            } else {
                Some(theirs(&case["list"]))
            },
            "{}",
            case["what"]
        );
    }
}

#[derive(Default)]
struct Memory(BTreeMap<String, Gathered>);
impl PartStore for Memory {
    fn read(&self) -> BTreeMap<String, Gathered> {
        self.0.clone()
    }
    fn write(&mut self, all: &BTreeMap<String, Gathered>) {
        self.0 = all.clone();
    }
}

#[test]
fn parts_are_gathered_in_any_order_as_the_web_app_gathers_them() {
    let g = golden();
    let now = 1_700_000_000_000i64;
    for case in g["parts"]["cases"].as_array().unwrap() {
        let mut store = Memory::default();
        for (n, (part, step)) in case["parts"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["steps"].as_array().unwrap())
            .enumerate()
        {
            let r = read_shared(part.as_str().unwrap(), &mut store, now + n as i64);
            match (&r, step["kind"].as_str().unwrap()) {
                (Reading::Parts { got, of }, "parts") => {
                    assert_eq!(json!(got), step["got"]);
                    assert_eq!(*of as i64, step["of"].as_i64().unwrap());
                }
                (Reading::List(list), "list") => assert_eq!(plain(list), theirs(&step["list"])),
                other => panic!("step {n}: {other:?} against {step}"),
            }
        }
    }
    let parts = g["parts"]["links"].as_array().unwrap();
    let prefix = format!("{}/#g=", g["parts"]["origin"].as_str().unwrap());
    let part = |i: usize| {
        parts[i]
            .as_str()
            .unwrap()
            .strip_prefix(&prefix)
            .unwrap()
            .to_string()
    };
    // A part that waited more than two days is forgotten.
    let mut store = Memory::default();
    assert_eq!(
        read_shared(&part(0), &mut store, now),
        Reading::Parts {
            got: vec![1],
            of: 5
        }
    );
    assert_eq!(
        read_shared(&part(1), &mut store, now + 3 * 24 * 60 * 60 * 1000),
        Reading::Parts {
            got: vec![2],
            of: 5
        }
    );
    for odd in [
        "abcd.0.3.xyz",
        "abcd.4.3.xyz",
        "abcd.1.1.xyz",
        "nonsense!",
        "",
    ] {
        assert_eq!(
            read_shared(odd, &mut Memory::default(), now),
            Reading::Broken,
            "{odd:?}"
        );
    }
}

#[test]
fn links_are_cut_by_the_room_they_have_and_named_after_their_content() {
    let g = golden();
    let origin = g["parts"]["origin"].as_str().unwrap();
    let big = list_from(
        &g["packed"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["key"] == "big")
            .unwrap()["list"],
    );
    let one = share_links(&list_from(&g["packed"][1]["list"]), origin, LINK_MAX);
    assert_eq!(one.len(), 1);
    assert!(one[0].starts_with(&format!("{origin}/#g=")));
    let links = share_links(&big, origin, 700);
    assert!(links.len() > 2 && links.len() <= MAX_PARTS);
    assert!(links.iter().all(|l| l.len() <= 700));
    // The name is the web's name of the same text: FNV over what the parts carry.
    let web_links = g["parts"]["links"].as_array().unwrap();
    let web_text: String = web_links
        .iter()
        .map(|l| l.as_str().unwrap().rsplit('.').next().unwrap().to_string())
        .collect();
    let web_name = web_links[0]
        .as_str()
        .unwrap()
        .split('=')
        .nth(1)
        .unwrap()
        .split('.')
        .next()
        .unwrap();
    assert_eq!(name_of(&web_text), web_name);
    // Put back together here.
    let mut store = Memory::default();
    let prefix = format!("{origin}/#g=");
    let mut last = Reading::Broken;
    for link in &links {
        last = read_shared(link.strip_prefix(&prefix).unwrap(), &mut store, 1);
    }
    assert_eq!(
        match last {
            Reading::List(l) => Some(plain(&l)),
            _ => None,
        },
        Some(plain(&unpack_list(&pack_list(&big)).unwrap()))
    );
    // Too much for messages: no links, the file is the way.
    let heavy = SharedList {
        name: String::new(),
        items: (0..500)
            .map(|i| SharedItem {
                title: format!("{i} {:x}", (i as u64).wrapping_mul(0x9e3779b97f4a7c15)),
                thumb: Some({
                    let mut t = vec![KIND_RAW];
                    t.extend((0..33).map(|k| ((i * 31 + k * 17) ^ (i * k)) as u8));
                    t
                }),
                ..SharedItem::default()
            })
            .collect(),
    };
    assert!(share_links(&heavy, origin, 300).is_empty());
    assert_eq!(shared_from_hash("#g=abc"), Some("abc"));
    assert_eq!(shared_from_hash("#geteilt=abc"), Some("abc"));
    assert_eq!(shared_from_hash("#g="), None);
    assert_eq!(shared_from_hash("#x=abc"), None);
}

#[test]
fn the_text_for_anyone_to_read_is_the_web_apps() {
    for case in golden()["packed"].as_array().unwrap() {
        let key = case["key"].as_str().unwrap();
        let list = list_from(&case["list"]);
        assert_eq!(
            share_text(&list, &[]),
            case["text"].as_str().unwrap(),
            "{key}"
        );
        let two = vec![
            "https://x.example/#g=aaaa".to_string(),
            "https://x.example/#g=bbbb".to_string(),
        ];
        assert_eq!(
            share_text(&list, &two),
            case["textWithLinks"].as_str().unwrap(),
            "{key}"
        );
        assert_eq!(
            share_text(&list, &two[..1]),
            case["textWithOne"].as_str().unwrap(),
            "{key}"
        );
    }
}

#[test]
fn titles_compare_without_case_and_accents_and_lists_are_set_beside_each_other() {
    let g = golden();
    for case in g["keys"].as_array().unwrap() {
        assert_eq!(
            title_key(case["k"].as_str().unwrap()),
            case["key"].as_str().unwrap(),
            "{}",
            case["k"]
        );
    }
    let read: Vec<Item> = serde_json::from_value(json!(g["compare"]["mine"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            let mut item: Value = serde_json::from_str(include_str!("golden/merk.json"))
                .map(|v: Value| v["read"][0]["item"].clone())
                .unwrap();
            item["id"] = m["id"].clone();
            item["title"] = m["title"].clone();
            item
        })
        .collect::<Vec<_>>()))
    .unwrap();
    let small = list_from(
        &g["packed"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["key"] == "small")
            .unwrap()["list"],
    );
    let c = compare_shared(&small, &read);
    let titles = |v: &[SharedItem]| v.iter().map(|i| i.title.clone()).collect::<Vec<_>>();
    assert_eq!(json!(titles(&c.both)), g["compare"]["both"]);
    assert_eq!(json!(titles(&c.fresh)), g["compare"]["fresh"]);
    assert_eq!(
        c.only_mine as i64,
        g["compare"]["onlyMine"].as_i64().unwrap()
    );
    // „Später“ takes the title and the picture and nothing of how far it was.
    let one = &small.items[1];
    let later = entry_from_shared(one, Take::Later);
    assert_eq!(
        (later.status, later.season, later.rating),
        (Some(Status::Later), None, None)
    );
    let there = entry_from_shared(one, Take::AsThere);
    assert_eq!(
        (there.status, there.season, there.episode, there.rating),
        (Some(Status::Done), Some(3), Some(8), Some(5))
    );
}

#[test]
fn a_list_to_share_leaves_out_addresses_and_notes_and_can_leave_out_progress() {
    let merk: Value = serde_json::from_str(include_str!("golden/merk.json")).unwrap();
    let mut item: Item = serde_json::from_value(merk["read"][2]["item"].clone()).unwrap();
    item.notes = Some("geheim".into());
    item.rating = Some(4);
    item.title = "Frieren".into();
    let with = shareable_list(
        std::slice::from_ref(&item),
        "  Mia  ",
        true,
        &HashMap::new(),
    );
    assert_eq!(with.name, "Mia");
    assert_eq!(with.items[0].title, "Frieren");
    assert_eq!(with.items[0].rating, Some(4));
    assert!(with.items[0].season.is_some());
    let without = shareable_list(std::slice::from_ref(&item), "Mia", false, &HashMap::new());
    assert!(
        without.items[0].season.is_none()
            && without.items[0].rating.is_none()
            && without.items[0].seen.is_none()
    );
    // Nothing of the address or the notes is in what is packed.
    let packed = String::from_utf8_lossy(&pack_list(&with)).to_string();
    assert!(!packed.contains("geheim") && !packed.contains("aniworld"));
    let mut thumbs = HashMap::new();
    thumbs.insert(item.id.clone(), vec![KIND_RAW; 1]);
    assert!(
        shareable_list(std::slice::from_ref(&item), "x", true, &thumbs).items[0]
            .thumb
            .is_some()
    );
}

#[test]
fn the_tiny_picture_is_34_bytes_and_comes_back_as_a_blur_of_the_same_colours() {
    assert_eq!(RAW_BYTES, 34);
    // A red top, a green middle, a blue bottom, as 6 × 9 pixels.
    let mut rgba = Vec::new();
    for row in 0..9 {
        for _col in 0..6 {
            rgba.extend(match row / 3 {
                0 => [200u8, 30, 30, 255],
                1 => [30, 200, 30, 255],
                _ => [30, 30, 200, 255],
            });
        }
    }
    let packed = pack_raw(&rgba).unwrap();
    assert_eq!(packed.len(), RAW_BYTES);
    assert!(valid_thumb(&packed));
    let back = unpack_raw(&packed[1..]).unwrap();
    let px = |row: usize, col: usize| &back[(row * 6 + col) * 4..(row * 6 + col) * 4 + 3];
    // Red stays the strongest in the top rows, green in the middle, blue at the bottom.
    assert!(px(0, 0)[0] > px(0, 0)[1] && px(0, 0)[0] > px(0, 0)[2]);
    assert!(px(4, 2)[1] > px(4, 2)[0] && px(4, 2)[1] > px(4, 2)[2]);
    assert!(px(8, 5)[2] > px(8, 5)[0] && px(8, 5)[2] > px(8, 5)[1]);
    // Never trusted by its size or its first bytes alone.
    assert!(!valid_thumb(&[KIND_RAW; 5]));
    assert!(!valid_thumb(&[
        KIND_WEBP, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
    ]));
    assert!(!valid_thumb(&[7; 40]));
    assert!(!valid_thumb(&vec![KIND_JPEG; THUMB_MAX + 1]));
    assert!(valid_thumb(&[KIND_JPEG, 0xff, 0xd8, 0xff, 0xe0, 1]));
}

/// What the web app reads in CI: links and files made here, and the lists they must read as.
#[test]
fn leaves_links_and_files_for_the_web_app_to_read() {
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("merk-interop");
    std::fs::create_dir_all(&dir).unwrap();
    let cases: Vec<Value> = golden()["packed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let list = unpack_list(&unhex(case["packed"].as_str().unwrap())).unwrap();
            json!({
                "key": case["key"],
                "list": plain(&list),
                "link": encode_share(&list),
                "file": hex(&share_file(&list)),
            })
        })
        .collect();
    std::fs::write(
        dir.join("share.json"),
        serde_json::to_string(&cases).unwrap(),
    )
    .unwrap();
}
