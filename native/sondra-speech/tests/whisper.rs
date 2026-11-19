//! Whisper itself, with a real model and a real voice: the sample sentence of whisper.cpp's own repository
//! (eleven seconds of a speech in public domain). Runs where `SONDRA_WHISPER_DIR` names a folder holding
//! `ggml-base-q5_1.bin` and `jfk.wav` (the CI fetches both); elsewhere it says it was skipped and passes.
//! The fetch of a model is tested against a server on this computer.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

use sondra_speech::engine::{Recognizer, SpeechError};
use sondra_speech::model::{fetch, is_present, model_by_id, path_of, FetchError, Model};

fn jfk(dir: &std::path::Path) -> Vec<f32> {
    let mut bytes = Vec::new();
    std::fs::File::open(dir.join("jfk.wav")).unwrap().read_to_end(&mut bytes).unwrap();
    bytes[44..].chunks_exact(2).map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0).collect()
}

#[test]
fn a_real_voice_becomes_the_words_it_said_with_times_and_progress() {
    let Some(dir) = std::env::var_os("SONDRA_WHISPER_DIR").map(std::path::PathBuf::from) else {
        eprintln!("skipped: SONDRA_WHISPER_DIR is not set");
        return;
    };
    let model = model_by_id("base");
    assert!(is_present(&dir, &model), "the model is in {dir:?}");
    let recognizer = Recognizer::load(&path_of(&dir, &model)).unwrap();
    let samples = jfk(&dir);
    let (mut shares, mut partials) = (Vec::new(), 0);
    let segments = recognizer.transcribe(&samples, "en", &|| false, &mut |share, _| shares.push(share), &mut |_| partials += 1).unwrap();
    let text = segments.iter().map(|s| s.text.to_lowercase()).collect::<Vec<_>>().join(" ");
    assert!(text.contains("ask not what your country can do for you"), "{text}");
    assert!(segments.iter().all(|s| s.start >= 0.0 && s.end <= 11.1 && s.end >= s.start), "{segments:?}");
    assert!(segments.windows(2).all(|w| w[0].end <= w[1].start + 0.05), "in order");
    assert!(shares.first() == Some(&0.0) && shares.last() == Some(&1.0) && shares.windows(2).all(|w| w[0] <= w[1]), "{shares:?}");
    assert!(partials >= 1);
    // Language detection finds English as well.
    let auto = recognizer.transcribe(&samples, "auto", &|| false, &mut |_, _| {}, &mut |_| {}).unwrap();
    assert!(auto.iter().any(|s| s.text.to_lowercase().contains("country")));
    // Stopped before the first window: nothing is made up.
    let stopped = recognizer.transcribe(&samples, "en", &|| true, &mut |_, _| {}, &mut |_| {});
    assert_eq!(stopped.unwrap_err(), SpeechError::Cancelled);
    // Silence says nothing.
    let silent = recognizer.transcribe(&vec![0.0f32; 16000 * 6], "en", &|| false, &mut |_, _| {}, &mut |_| {}).unwrap();
    assert!(silent.iter().all(|s| s.text.chars().count() < 25), "{silent:?}");
}

fn serve(body: Vec<u8>, status: u16) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_data(body.clone()).with_status_code(status));
        }
    });
    format!("http://127.0.0.1:{port}")
}

const SMALL: Model = Model { id: "test", label: "Test", hint: "", file: "ggml-test.bin", bytes: 1000 };

#[test]
fn a_model_is_fetched_whole_under_a_temporary_name_and_a_stopped_or_short_one_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    // Whole: the file appears with its name, and the progress ends at the total.
    let source = serve(vec![7u8; 1000], 200);
    let mut seen = Vec::new();
    let path = fetch(dir.path(), &SMALL, &source, &|| false, &mut |done, total| seen.push((done, total))).unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 1000);
    assert!(is_present(dir.path(), &SMALL));
    assert_eq!(seen.last(), Some(&(1000, 1000)));
    // A server that says no.
    let other = tempfile::tempdir().unwrap();
    let err = fetch(other.path(), &SMALL, &serve(vec![], 404), &|| false, &mut |_, _| {}).unwrap_err();
    assert!(matches!(err, FetchError::Failed(m) if m.contains("404")));
    assert!(!is_present(other.path(), &SMALL));
    // A short file is not taken for a model.
    let err = fetch(other.path(), &SMALL, &serve(vec![1u8; 100], 200), &|| false, &mut |_, _| {}).unwrap_err();
    assert!(matches!(err, FetchError::Failed(_)));
    assert!(!path_of(other.path(), &SMALL).exists() && !path_of(other.path(), &SMALL).with_extension("bin.teil").exists());
    // Stopped: nothing is left either.
    let stop = AtomicBool::new(true);
    let err = fetch(other.path(), &SMALL, &serve(vec![1u8; 1000], 200), &|| stop.load(Ordering::SeqCst), &mut |_, _| {}).unwrap_err();
    assert_eq!(err, FetchError::Cancelled);
    assert_eq!(std::fs::read_dir(other.path()).unwrap().count(), 0);
}
