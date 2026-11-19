//! Reading a real folder from disk.

use std::fs;
use std::sync::atomic::AtomicBool;

use sondra_merk::folder::AssetKind;
use sondra_merk::scan::{scan_dir, scan_dir_limited};

fn write(root: &std::path::Path, path: &str, bytes: usize) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, vec![0u8; bytes]).unwrap();
}

#[test]
fn a_folder_is_read_with_its_subfolders_kinds_and_sizes_and_without_what_systems_leave() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Anime");
    write(&root, "Frieren/Staffel 1/Frieren S01E01.mkv", 1000);
    write(&root, "Frieren/Staffel 1/Frieren S01E01.srt", 10);
    write(&root, "Frieren/Staffel 1/Frieren S01E02.mkv", 2000);
    write(&root, "Musik/lied.flac", 5);
    write(&root, "Bilder/poster.PNG", 7);
    write(&root, "notizen.txt", 3);
    write(&root, ".versteckt/x.mkv", 1);
    write(&root, "Thumbs.db", 1);
    write(&root, "desktop.ini", 1);
    write(&root, "Sondra-Papierkorb/alt.mkv", 1);
    write(&root, "$RECYCLE.BIN/x.mkv", 1);
    fs::create_dir_all(root.join("Leer")).unwrap();

    let mut seen = Vec::new();
    let scan = scan_dir(&root, &AtomicBool::new(false), |n| seen.push(n)).unwrap();
    assert_eq!(scan.name, "Anime");
    assert!(!scan.truncated && !scan.drive);
    let mut paths: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "Bilder/poster.PNG",
            "Frieren/Staffel 1/Frieren S01E01.mkv",
            "Frieren/Staffel 1/Frieren S01E01.srt",
            "Frieren/Staffel 1/Frieren S01E02.mkv",
            "Musik/lied.flac",
            "notizen.txt",
        ]
    );
    let mut dirs = scan.dirs.clone();
    dirs.sort();
    assert_eq!(dirs, ["", "Bilder", "Frieren", "Frieren/Staffel 1", "Leer", "Musik"], "empty folders count, skipped ones do not");
    let film = scan.files.iter().find(|f| f.name == "Frieren S01E02.mkv").unwrap();
    assert_eq!((film.dir.as_str(), film.size, film.kind), ("Frieren/Staffel 1", 2000, AssetKind::Video));
    assert!(film.modified > 1_600_000_000_000, "milliseconds since 1970");
    let kinds: Vec<_> = ["poster.PNG", "lied.flac", "Frieren S01E01.srt"].iter().map(|n| scan.files.iter().find(|f| f.name == *n).unwrap().kind).collect();
    assert_eq!(kinds[0], AssetKind::Image);
    assert_eq!(kinds[1], AssetKind::Audio);
    assert_eq!(*seen.last().unwrap(), 6, "the count is told at the end");
}

#[test]
fn a_folder_too_big_stops_and_says_so_and_a_missing_one_is_an_error_and_cancel_throws_away() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Viel");
    for i in 0..10 {
        write(&root, &format!("a/{i}.mkv"), 1);
        write(&root, &format!("b/{i}.mkv"), 1);
    }
    let scan = scan_dir_limited(&root, 7, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(scan.files.len(), 7);
    assert!(scan.truncated);

    assert!(scan_dir(&tmp.path().join("gibt-es-nicht"), &AtomicBool::new(false), |_| {}).is_err());

    let stop = AtomicBool::new(true);
    let error = scan_dir(&root, &stop, |_| {}).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Interrupted);
}
