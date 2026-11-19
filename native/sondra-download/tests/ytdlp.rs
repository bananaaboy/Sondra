use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use sondra_download::ytdlp::{self, YtdlpError};
use sondra_download::{Cancel, Progress};

fn fake() -> ytdlp::Tool {
    ytdlp::Tool { bin: PathBuf::from(env!("CARGO_BIN_EXE_fake-ytdlp")), version: "2099.01.01".into() }
}

#[test]
fn a_download_reports_its_progress_and_names_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut seen: Vec<Progress> = Vec::new();
    let file = ytdlp::download(&fake(), "https://portal.example/watch", dir.path(), None, &Cancel::new(), &mut |p| seen.push(p)).unwrap();
    assert_eq!(file.size, 4000);
    assert_eq!(file.path, dir.path().join("Ein Film.mp4"));
    assert_eq!(seen.last(), Some(&Progress { loaded: 4000, total: Some(4000) }));
    assert!(seen.windows(2).all(|w| w[0].loaded <= w[1].loaded));
}

#[test]
fn what_yt_dlp_complains_about_is_said_in_a_sentence() {
    let dir = tempfile::tempdir().unwrap();
    let run = |address: &str| ytdlp::download(&fake(), address, dir.path(), None, &Cancel::new(), &mut |_| {}).unwrap_err();
    assert_eq!(run("https://portal.example/private"), YtdlpError::Private);
    assert_eq!(run("https://portal.example/unsupported"), YtdlpError::Unsupported);
}

#[test]
fn stopping_kills_the_process_and_sweeps_the_part_file() {
    let dir = tempfile::tempdir().unwrap();
    let cancel = Cancel::new();
    let heard = Arc::new(Mutex::new(false));
    let (c, h) = (cancel.clone(), heard.clone());
    let path = dir.path().to_path_buf();
    let started = Instant::now();
    let worker = thread::spawn(move || ytdlp::download(&fake(), "https://portal.example/slow", &path, None, &c, &mut |_| *h.lock().unwrap() = true));
    // Stop once it has said something: the process is certainly running then.
    while !*heard.lock().unwrap() && started.elapsed() < Duration::from_secs(20) {
        thread::sleep(Duration::from_millis(20));
    }
    cancel.cancel();
    assert_eq!(worker.join().unwrap().unwrap_err(), YtdlpError::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(30), "the 60 s of the stand-in were not waited out");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_missing_program_is_its_own_error() {
    let dir = tempfile::tempdir().unwrap();
    let tool = ytdlp::Tool { bin: dir.path().join("nicht-da"), version: String::new() };
    let error = ytdlp::download(&tool, "https://portal.example/watch", dir.path(), None, &Cancel::new(), &mut |_| {}).unwrap_err();
    assert_eq!(error, YtdlpError::Missing);
}

/// Serves `/SHA2-256SUMS` and the program under its release name.
fn releases(program: &'static [u8], claimed: String) -> (String, thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", server.server_addr().to_ip().unwrap());
    let asset = ytdlp::asset_name();
    let handle = thread::spawn(move || {
        for _ in 0..2 {
            let Ok(request) = server.recv() else { return };
            let url = request.url().to_string();
            let body: Vec<u8> = if url.ends_with("SHA2-256SUMS") { format!("{claimed}  {asset}\n").into_bytes() } else { program.to_vec() };
            let _ = request.respond(tiny_http::Response::from_data(body));
        }
    });
    (base, handle)
}

#[test]
fn the_program_is_kept_only_when_it_matches_the_published_sum() {
    static PROGRAM: &[u8] = b"#!/bin/sh\necho 2099.01.01\n";
    let right: String = Sha256::digest(PROGRAM).iter().map(|b| format!("{b:02x}")).collect();

    let good = tempfile::tempdir().unwrap();
    let (base, server) = releases(PROGRAM, right.clone());
    // Loopback is refused by the shared agent only for redirects; a direct fetch to a test server is fine.
    let own = ytdlp::install(good.path(), &base, &Cancel::new()).unwrap();
    server.join().unwrap();
    assert_eq!(std::fs::read(&own).unwrap(), PROGRAM);
    assert!(!good.path().join(format!("{}.partial", ytdlp::own_name())).exists());

    let bad = tempfile::tempdir().unwrap();
    let (base, server) = releases(PROGRAM, "0".repeat(64));
    let error = ytdlp::install(bad.path(), &base, &Cancel::new()).unwrap_err();
    server.join().unwrap();
    assert!(matches!(error, YtdlpError::Install(_)), "{error:?}");
    assert_eq!(std::fs::read_dir(bad.path()).unwrap().count(), 0, "nothing is kept when the sums differ");
}

#[test]
fn a_named_program_is_found_and_a_missing_one_is_not() {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_YTDLP", env!("CARGO_BIN_EXE_fake-ytdlp"));
    assert_eq!(ytdlp::locate(dir.path(), false).map(|t| t.version), Some("2099.01.01".into()));
    std::env::remove_var("SONDRA_YTDLP");
}
