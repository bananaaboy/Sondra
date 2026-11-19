//! Putting a file into Drive: small ones in one request, big ones in pieces of eight megabytes that go on where Drive
//! says it stands, a file that is there already (same name, same size) not sent again, a changed one written new, and
//! a stop that leaves no half file behind — against the in-process stand-in.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use sondra_drive::fake::FakeDrive;
use sondra_drive::write::{Mode, Put, CHUNK};

fn bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| ((i as u32).wrapping_mul(31).wrapping_add(u32::from(seed)) % 251) as u8).collect()
}

fn notes() -> BTreeMap<String, String> {
    [("sondraArt".to_string(), "ergebnis".to_string())].into()
}

#[test]
fn a_small_file_goes_in_one_request_with_its_notes_and_the_same_one_is_not_sent_again() {
    let drive = FakeDrive::start();
    let client = drive.client();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("klein.mp3");
    std::fs::write(&path, bytes(1000, 1)).unwrap();
    let folder = client.ensure_path(&["Sondra", "Dateien", "Ton"]).unwrap();
    let mut said = Vec::new();
    let put = client.put_file(&folder, "klein.mp3", &path, "audio/mpeg", &notes(), Mode::SkipSame, &AtomicBool::new(false), |a, b| said.push((a, b))).unwrap();
    let Put::Made(file) = put else { panic!("a new file: {put:?}") };
    assert_eq!(client.download(&file.id).unwrap(), bytes(1000, 1));
    assert_eq!(said.first(), Some(&(0, 1000)));
    assert_eq!(said.last(), Some(&(1000, 1000)));
    // The same name and size: nothing is sent.
    let before = drive.state.lock().unwrap().requests;
    let again = client.put_file(&folder, "klein.mp3", &path, "audio/mpeg", &notes(), Mode::SkipSame, &AtomicBool::new(false), |_, _| {}).unwrap();
    assert!(matches!(again, Put::Same(_)));
    assert_eq!(drive.state.lock().unwrap().requests - before, 1, "only the look at what is there");
    // Another size under the name: written new, in the same file.
    std::fs::write(&path, bytes(1500, 2)).unwrap();
    let changed = client.put_file(&folder, "klein.mp3", &path, "audio/mpeg", &notes(), Mode::SkipSame, &AtomicBool::new(false), |_, _| {}).unwrap();
    let Put::Replaced(replaced) = changed else { panic!("replaced: {changed:?}") };
    assert_eq!(replaced.id, file.id, "the file is the same, its content is new");
    assert_eq!(client.download(&file.id).unwrap(), bytes(1500, 2));
    assert_eq!(drive.file_count(), 1);
}

#[test]
fn a_big_file_goes_in_pieces_of_eight_megabytes_and_arrives_whole() {
    let drive = FakeDrive::start();
    let client = drive.client();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gross.mp4");
    let data = bytes(2 * CHUNK as usize + 12345, 3);
    std::fs::write(&path, &data).unwrap();
    let folder = client.ensure_path(&["Sondra", "Dateien", "Video"]).unwrap();
    let mut last = (0, 0);
    let put = client.put_file(&folder, "gross.mp4", &path, "video/mp4", &notes(), Mode::SkipSame, &AtomicBool::new(false), |a, b| last = (a, b)).unwrap();
    let Put::Made(file) = put else { panic!("{put:?}") };
    assert_eq!(last, (data.len() as u64, data.len() as u64));
    assert_eq!(client.download(&file.id).unwrap(), data);
    let pieces = drive.state.lock().unwrap().pieces.clone();
    assert_eq!(pieces, vec![(0, CHUNK - 1), (CHUNK, 2 * CHUNK - 1), (2 * CHUNK, data.len() as u64 - 1)], "three pieces, in order, the first two of eight megabytes");
    // The notes went along with the opening of the upload.
    let found = client.search(&sondra_drive::notes_query("sondraArt", "ergebnis")).unwrap();
    assert_eq!(found.len(), 1);
    // The same big file again: not sent.
    let again = client.put_file(&folder, "gross.mp4", &path, "video/mp4", &notes(), Mode::SkipSame, &AtomicBool::new(false), |_, _| {}).unwrap();
    assert!(matches!(again, Put::Same(_)));
    assert_eq!(drive.state.lock().unwrap().pieces.len(), 3, "no piece was sent again");
    // Replace: always written new, in the same file.
    let replaced = client.put_file(&folder, "gross.mp4", &path, "video/mp4", &notes(), Mode::Replace, &AtomicBool::new(false), |_, _| {}).unwrap();
    assert!(matches!(replaced, Put::Replaced(f) if f.id == file.id));
    assert_eq!(drive.state.lock().unwrap().pieces.len(), 6);
    assert_eq!(drive.file_count(), 1);
}

#[test]
fn a_hiccup_of_the_server_asks_where_it_stands_and_goes_on_from_there() {
    let drive = FakeDrive::start();
    let client = drive.client().with_backoff(std::time::Duration::from_millis(5));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gross.mkv");
    let data = bytes(CHUNK as usize + 777, 4);
    std::fs::write(&path, &data).unwrap();
    let folder = client.ensure_path(&["Sondra", "Dateien", "Video"]).unwrap();
    // The first two pieces are answered with a 503 and not kept.
    drive.state.lock().unwrap().hiccups = 2;
    let put = client.put_file(&folder, "gross.mkv", &path, "video/x-matroska", &notes(), Mode::SkipSame, &AtomicBool::new(false), |_, _| {}).unwrap();
    let Put::Made(file) = put else { panic!("{put:?}") };
    assert_eq!(client.download(&file.id).unwrap(), data, "whole, in spite of the hiccups");
    // Too many in a row: it gives up with a word, and nothing half-made is a file.
    let drive = FakeDrive::start();
    let client = drive.client().with_backoff(std::time::Duration::from_millis(1));
    let folder = client.ensure_path(&["Sondra", "Dateien", "Video"]).unwrap();
    drive.state.lock().unwrap().hiccups = 99;
    let error = client.put_file(&folder, "gross.mkv", &path, "video/x-matroska", &notes(), Mode::SkipSame, &AtomicBool::new(false), |_, _| {}).unwrap_err();
    assert!(matches!(error, sondra_drive::DriveError::Offline(_) | sondra_drive::DriveError::Failed(_)), "{error:?}");
    assert_eq!(drive.file_count(), 0);
}

#[test]
fn a_stop_between_pieces_ends_it_and_no_file_appears() {
    let drive = FakeDrive::start();
    let client = drive.client();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gross.wav");
    std::fs::write(&path, bytes(3 * CHUNK as usize, 5)).unwrap();
    let folder = client.ensure_path(&["Sondra", "Dateien", "Ton"]).unwrap();
    let stop = AtomicBool::new(false);
    let error = client
        .put_file(&folder, "gross.wav", &path, "audio/wav", &notes(), Mode::SkipSame, &stop, |sent, _| {
            if sent >= CHUNK {
                stop.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
    assert_eq!(error, sondra_drive::DriveError::Cancelled);
    assert_eq!(drive.file_count(), 0, "Drive makes the file only when the last piece is there");
}
