//! The store-only ZIP against the website's: the same bytes for the same entries and dates, the same names for what
//! was typed, the same way of telling equal names apart (`golden/zip.json`, written by `scripts/make-zip-golden.mts`).
//! And the archive is one a real unpacker reads.

use base64::Engine;
use sondra_media::zip::{create_zip, unique_entry_names, write_zip, zip_name, ZipEntry, ZipFile};

fn b64(text: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(text).unwrap()
}

#[test]
fn the_archives_are_the_websites_byte_for_byte() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("golden/zip.json")).unwrap();
    let archives = golden["archives"].as_array().unwrap();
    assert!(archives.len() >= 3);
    for (n, case) in archives.iter().enumerate() {
        let entries: Vec<ZipEntry> = case["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let d: Vec<u32> = e["date"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
                ZipEntry { name: e["name"].as_str().unwrap().to_string(), data: b64(e["data"].as_str().unwrap()), date: [d[0], d[1], d[2], d[3], d[4], d[5]] }
            })
            .collect();
        let mine = create_zip(&entries);
        let theirs = b64(case["zip"].as_str().unwrap());
        assert_eq!(mine.len(), theirs.len(), "archive {n}: length");
        let first = mine.iter().zip(&theirs).position(|(a, b)| a != b);
        assert!(first.is_none(), "archive {n}: first difference at byte {first:?}");
    }
}

#[test]
fn a_typed_name_becomes_the_same_file_and_folder_as_on_the_website() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("golden/zip.json")).unwrap();
    for case in golden["names"].as_array().unwrap() {
        let (typed, suggestion) = (case["typed"].as_str().unwrap(), case["suggestion"].as_str().unwrap());
        let (file, stem) = zip_name(typed, suggestion);
        assert_eq!((file.as_str(), stem.as_str()), (case["file"].as_str().unwrap(), case["stem"].as_str().unwrap()), "typed {typed:?} / {suggestion:?}");
    }
}

#[test]
fn equal_names_are_told_apart_as_on_the_website() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("golden/zip.json")).unwrap();
    for case in golden["unique"].as_array().unwrap() {
        let names: Vec<String> = case["in"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let out: Vec<String> = case["out"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(unique_entry_names(&names), out, "{names:?}");
    }
}

#[test]
fn a_real_unpacker_reads_what_is_written() {
    let entries = vec![
        ZipEntry { name: "Stems/Gesang.wav".into(), data: (0..5000u32).map(|i| (i % 251) as u8).collect(), date: [2026, 11, 19, 10, 30, 42] },
        ZipEntry { name: "Stems/Gesang.wav".into(), data: b"zweite".to_vec(), date: [2026, 11, 19, 10, 30, 42] },
        ZipEntry { name: "a.txt".into(), data: b"hello".to_vec(), date: [2026, 11, 19, 10, 30, 42] },
    ];
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.zip");
    std::fs::write(&path, create_zip(&entries)).unwrap();
    let Ok(out) = std::process::Command::new("unzip").arg("-t").arg(&path).output() else { return };
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{text} {}", String::from_utf8_lossy(&out.stderr));
    assert!(text.contains("No errors detected"), "{text}");
    let listing = std::process::Command::new("unzip").arg("-l").arg(&path).output().unwrap();
    let listing = String::from_utf8_lossy(&listing.stdout);
    assert!(listing.contains("Stems/Gesang.wav") && listing.contains("Stems/Gesang_2.wav") && listing.contains("a.txt"), "{listing}");
}

#[test]
fn files_on_disk_make_the_same_archive_without_being_held_in_memory() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("golden/zip.json")).unwrap();
    let case = &golden["archives"][2];
    let dir = tempfile::tempdir().unwrap();
    let mut files = Vec::new();
    for (n, e) in case["entries"].as_array().unwrap().iter().enumerate() {
        let d: Vec<u32> = e["date"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
        let path = dir.path().join(format!("f{n}"));
        std::fs::write(&path, b64(e["data"].as_str().unwrap())).unwrap();
        files.push(ZipFile { name: e["name"].as_str().unwrap().to_string(), path, date: [d[0], d[1], d[2], d[3], d[4], d[5]] });
    }
    let mut written = Vec::new();
    write_zip(&mut written, &files).unwrap();
    assert!(written == b64(case["zip"].as_str().unwrap()), "the same bytes as the website's archive");
    // A file that is gone is an error, not a half archive that looks whole.
    std::fs::remove_file(&files[0].path).unwrap();
    assert!(write_zip(&mut Vec::new(), &files).is_err());
}
