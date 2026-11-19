//! The addresses found in pasted text, the same as the website finds them.

use sondra_download::addresses::extract_addresses;

#[test]
fn every_text_gives_what_the_website_gives() {
    let table: serde_json::Value = serde_json::from_str(include_str!("golden/addresses.json")).unwrap();
    let cases = table.as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let text = case["text"].as_str().unwrap();
        let want: Vec<&str> = case["found"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(extract_addresses(text), want, "text: {text:?}");
    }
}
