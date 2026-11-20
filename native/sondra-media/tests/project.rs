//! `.sondra` projects: the website's archive read (stored, deflated, Zip64) and a project written that has the
//! website's manifest.

use sondra_media::project::{read, read_zip, write};
use sondra_media::zip::{create_zip, ZipEntry};

const DEFLATED: &[u8] = include_bytes!("golden/projekt-deflate.sondra");

#[test]
fn a_deflated_archive_made_elsewhere_is_read_with_the_files_the_manifest_names() {
    let project = read(DEFLATED, "x.sondra").unwrap();
    assert_eq!(project.panel.as_deref(), Some("normalize"));
    // The second asset is named but not in the archive: it is left out, not an error.
    assert_eq!(project.assets.len(), 1);
    assert_eq!(project.assets[0].name, "Lied.wav");
    assert_eq!(project.assets[0].mime, "audio/wav");
    assert_eq!(project.assets[0].bytes, [b"RIFF".as_slice(), &b"abc".repeat(400)].concat());
}

#[test]
fn the_websites_own_archive_writer_is_read_back_with_its_zip64_fields() {
    let entries = vec![
        ZipEntry { name: "a.txt".into(), data: b"eins".to_vec(), date: [2026, 11, 20, 8, 0, 0] },
        ZipEntry { name: "ordner/b.bin".into(), data: (0..5000u32).map(|i| (i % 251) as u8).collect(), date: [2026, 11, 20, 8, 0, 0] },
    ];
    let bytes = create_zip(&entries);
    let read = read_zip(&bytes).unwrap();
    assert_eq!(read.len(), 2);
    assert_eq!(read[0], ("a.txt".to_string(), b"eins".to_vec()));
    assert_eq!(read[1].1, entries[1].data);
}

#[test]
fn what_is_no_archive_or_no_project_is_said_in_words() {
    assert!(read_zip(b"nichts").unwrap_err().contains("kein gültiges ZIP"));
    let not_a_project = create_zip(&[ZipEntry { name: "project.json".into(), data: br#"{"format":"anders"}"#.to_vec(), date: [2026, 1, 1, 0, 0, 0] }]);
    assert!(read(&not_a_project, "x.sondra").unwrap_err().contains("keine unterstützte Sondra-Projektdatei"));
    let no_manifest = create_zip(&[ZipEntry { name: "a.txt".into(), data: b"x".to_vec(), date: [2026, 1, 1, 0, 0, 0] }]);
    assert!(read(&no_manifest, "y.sondra").unwrap_err().contains("keine Sondra-Projektbeschreibung"));
}

#[test]
fn a_written_project_has_the_websites_manifest_and_comes_back_whole() {
    let dir = tempfile::tempdir().unwrap();
    let (a, b) = (dir.path().join("Lied: eins.wav"), dir.path().join("Bild.png"));
    std::fs::write(&a, vec![7u8; 3000]).unwrap();
    std::fs::write(&b, b"png").unwrap();
    let out = dir.path().join("Projekt.sondra");
    assert_eq!(write(&out, &[a.clone(), b.clone()], "stems", [2026, 11, 20, 9, 30, 0]).unwrap(), 2);
    assert!(!dir.path().join("Projekt.sondra.json.tmp").exists() && !dir.path().join("Projekt.sondra.json.tmp").is_file());
    // For the check against the website's own reader (`scripts/verify-native-project.mts`).
    if let Ok(keep) = std::env::var("SONDRA_PROJECT_OUT") {
        std::fs::copy(&out, keep).unwrap();
    }
    let bytes = std::fs::read(&out).unwrap();
    let entries = read_zip(&bytes).unwrap();
    let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["project.json", "assets/0_Lied_ eins.wav", "assets/1_Bild.png"]);
    let manifest: serde_json::Value = serde_json::from_slice(&entries[0].1).unwrap();
    assert_eq!(manifest["format"], "sondra-project");
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["panel"], "stems");
    assert_eq!(manifest["assets"][0]["kind"], "audio");
    assert_eq!(manifest["assets"][0]["name"], "Lied: eins.wav");
    assert_eq!(manifest["assets"][1]["kind"], "image");
    let project = read(&bytes, "Projekt.sondra").unwrap();
    assert_eq!(project.assets.len(), 2);
    assert_eq!(project.assets[0].bytes, vec![7u8; 3000]);
    // A file that is gone makes no half archive.
    let broken = dir.path().join("Kaputt.sondra");
    assert!(write(&broken, &[dir.path().join("fehlt.wav")], "start", [2026, 1, 1, 0, 0, 0]).is_err());
    assert!(!broken.exists());
}

#[test]
fn what_the_website_kept_per_tool_travels_through_a_project_opened_and_saved_again() {
    use sondra_media::project::write_with;
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.wav");
    std::fs::write(&a, vec![1u8; 100]).unwrap();
    let states = serde_json::json!({ "merkliste": [{ "id": "x", "title": "Frieren", "watched": { "1": [1, 2] } }], "converter": { "format": "mp3" } });
    let out = dir.path().join("mit.sondra");
    write_with(&out, &[a.clone()], "umwandeln", [2026, 11, 20, 9, 30, 0], Some(&states)).unwrap();
    let read_back = read(&std::fs::read(&out).unwrap(), "mit.sondra").unwrap();
    assert_eq!(read_back.tool_states, Some(states));
    // A project written without any has none, as the website's empty `{}` reads.
    let plain = dir.path().join("ohne.sondra");
    write(&plain, &[a], "umwandeln", [2026, 11, 20, 9, 30, 0]).unwrap();
    assert_eq!(read(&std::fs::read(&plain).unwrap(), "ohne.sondra").unwrap().tool_states, None);
}
