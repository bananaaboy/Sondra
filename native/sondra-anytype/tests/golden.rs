//! The page the website writes (`tests/golden/page.json`, made by `npm run native:golden`): read here, and
//! written here with the same readable part.

use serde_json::Value;
use sondra_anytype::{merkliste_from_markdown, merkliste_to_markdown};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/page.json")).unwrap()
}

#[test]
fn reads_the_page_the_website_wrote() {
    let golden = golden();
    let remote = merkliste_from_markdown(golden["markdown"].as_str().unwrap()).expect("a page of the website reads");
    let ids: Vec<&str> = remote.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, golden["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>());
    let titles: Vec<&str> = remote.items.iter().map(|i| i.title.as_str()).collect();
    assert_eq!(titles, golden["titles"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>());
    assert_eq!(remote.removed.get("alt"), Some(&77));
    // The picture from a file stays on its device.
    assert_eq!(remote.items[0].cover.as_deref(), Some("sondra:lokal"));
}

#[test]
fn writes_the_same_readable_part() {
    let golden = golden();
    let theirs = golden["markdown"].as_str().unwrap();
    let remote = merkliste_from_markdown(theirs).unwrap();
    let mine = merkliste_to_markdown(&remote.items, &remote.removed);
    let readable = |text: &str| text.split("## Sondra-Daten").next().unwrap().to_owned();
    assert_eq!(readable(&mine), readable(theirs));
    // And what is written here reads back to the same list.
    let again = merkliste_from_markdown(&mine).unwrap();
    assert_eq!(again, remote);
}
