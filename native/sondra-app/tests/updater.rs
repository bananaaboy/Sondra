//! The update, against a stand-in release page: a newer version is found, the setup is loaded and its sum checked,
//! a setup that is not the one the page promised is thrown away, and loading can be stopped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::Engine;
use sha2::{Digest, Sha512};
use sondra_app::updater::{check, download, pick};

fn sum(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
}

/// A page at a local address that answers `latest-nativ.yml` and the setup.
fn page(version: &str, setup: Vec<u8>, promised: &[u8]) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let yaml = format!("version: {version}\nfiles:\n  - url: Sondra-Nativ-Setup-{version}.exe\n    sha512: {}\n    size: {}\n", sum(promised), promised.len());
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let body = if url.ends_with("latest-nativ.yml") { yaml.clone().into_bytes() } else if url.ends_with(".exe") { setup.clone() } else { Vec::new() };
            let status = if body.is_empty() { 404 } else { 200 };
            let _ = request.respond(tiny_http::Response::from_data(body).with_status_code(status));
        }
    });
    base
}

#[test]
fn a_newer_version_is_found_and_the_same_or_an_older_one_is_not() {
    let base = page("1.2.4", b"setup".to_vec(), b"setup");
    let found = check(&base, "1.2.3").unwrap().expect("a newer version");
    assert_eq!(found.version, "1.2.4");
    assert!(check(&base, "1.2.4").unwrap().is_none());
    assert!(check(&base, "2.0.0").unwrap().is_none());
    // A page that does not answer is an error that says so, not a version.
    let nothing = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", nothing.server_addr().to_ip().unwrap());
    std::thread::spawn(move || {
        for request in nothing.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_string("nein").with_status_code(404));
        }
    });
    let error = check(&dead, "1.0.0").unwrap_err();
    assert!(error.contains("404"), "{error}");
}

#[test]
fn the_setup_is_loaded_and_kept_only_when_its_sum_is_the_one_promised() {
    let dir = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let base = page("1.2.4", bytes.clone(), &bytes);
    let latest = check(&base, "1.0.0").unwrap().unwrap();
    let file = pick(&latest.files, false).unwrap().clone();
    let mut last = (0, None);
    let path = download(&base, &file, dir.path(), &AtomicBool::new(false), |loaded, total| last = (loaded, total)).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(last, (300_000, Some(300_000)), "progress ends at the whole");
    assert!(!dir.path().join("Sondra-Nativ-Setup-1.2.4.exe.part").exists(), "no half file is left");

    // A page that promises one sum and serves another file: refused, and nothing stays on disk.
    let other = tempfile::tempdir().unwrap();
    let mut tampered = bytes.clone();
    tampered[1000] ^= 0xFF;
    let bad = page("1.2.4", tampered, &bytes);
    let latest = check(&bad, "1.0.0").unwrap().unwrap();
    let error = download(&bad, &latest.files[0], other.path(), &AtomicBool::new(false), |_, _| {}).unwrap_err();
    assert!(error.contains("Prüfsumme"), "{error}");
    assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 0, "the refused file is gone");
}

#[test]
fn loading_can_be_stopped_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = vec![7u8; 2_000_000];
    let base = page("1.2.4", bytes.clone(), &bytes);
    let latest = check(&base, "1.0.0").unwrap().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let stop = cancel.clone();
    let error = download(&base, &latest.files[0], dir.path(), &cancel, move |loaded, _| {
        if loaded > 100_000 {
            stop.store(true, Ordering::Relaxed);
        }
    })
    .unwrap_err();
    assert_eq!(error, "Abgebrochen.");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}
