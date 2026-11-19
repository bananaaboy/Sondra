//! The writing half of the Drive client, against the in-process stand-in.

use std::collections::BTreeMap;

use sondra_drive::fake::FakeDrive;
use sondra_drive::notes_query;

fn notes(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn folders_are_found_or_made_once_and_files_carry_their_notes() {
    let drive = FakeDrive::start();
    let client = drive.client();
    let first = client.ensure_path(&["Sondra", "Geräte"]).unwrap();
    let again = client.ensure_path(&["Sondra", "Geräte"]).unwrap();
    assert_eq!(first, again, "the second walk finds what the first made");
    let post = client.ensure_path(&["Sondra", "Geräte", "Post"]).unwrap();
    assert_ne!(post, first);

    let made = client
        .create(&first, "Gerät-ABC.json", b"{\"a\":1}", "application/json", &notes(&[("sondraArt", "geraet"), ("sondraGeraet", "ABC")]))
        .unwrap();
    assert_eq!(made.name, "Gerät-ABC.json");
    let found = client.search(&notes_query("sondraArt", "geraet")).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].notes["sondraGeraet"], "ABC");
    assert_eq!(client.download(&found[0].file.id).unwrap(), b"{\"a\":1}");
    assert!(client.search(&notes_query("sondraArt", "post")).unwrap().is_empty());

    // New content: the notes and the name stay.
    client.rewrite(&made.id, b"{\"a\":2}", "application/json").unwrap();
    let found = client.search(&notes_query("sondraGeraet", "ABC")).unwrap();
    assert_eq!(client.download(&found[0].file.id).unwrap(), b"{\"a\":2}");
    assert_eq!(found[0].notes["sondraArt"], "geraet");

    // Gone, and gone again is fine.
    client.remove(&made.id).unwrap();
    client.remove(&made.id).unwrap();
    assert!(client.search(&notes_query("sondraArt", "geraet")).unwrap().is_empty());
}

#[test]
fn a_name_with_a_quote_in_it_is_found() {
    let drive = FakeDrive::start();
    let client = drive.client();
    let folder = client.ensure_path(&["Sondra"]).unwrap();
    client.create(&folder, "x.json", b"1", "application/json", &notes(&[("sondraAn", "it's")])).unwrap();
    assert_eq!(client.search(&notes_query("sondraAn", "it's")).unwrap().len(), 1);
}
