//! The ducking mix against the numbers the web app's own `duck.ts` gives for the same signals
//! (`npm run native:golden`).

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::duck::*;

const GOLDEN: &str = include_str!("golden/duck.json");

#[derive(Deserialize)]
struct File {
    rate: u32,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    music_db: f64,
    duck_db: f64,
    sensitivity: f64,
    attack_ms: f64,
    release_ms: f64,
    lead_in: f64,
    tail: f64,
    loop_music: bool,
}
#[derive(Deserialize)]
struct Shape {
    channels: usize,
    frames: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    voice_seconds: f64,
    speech_seconds: f64,
    threshold_db: f64,
    total_seconds: f64,
    peak_db: f64,
    trim_db: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    settings: Settings,
    voice: Shape,
    music: Shape,
    report: Report,
    frames: usize,
    left: Vec<f64>,
    right: Vec<f64>,
    voice_db: Vec<f64>,
    music_gain_db: Vec<f64>,
    out_frames: usize,
}

/// Speech-like bursts with a faint floor between them, from an integer generator — as in the script.
fn voice_of(rate: u32, seconds: u32) -> Vec<f32> {
    let n = (rate * seconds) as usize;
    let mut state: u32 = 4242;
    (0..n)
        .map(|i| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let noise = (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0;
            let t = i as f64 / f64::from(rate);
            let talking = (t % 1.7) < 0.9 || (t > 4.5 && t < 5.2);
            let tone = if talking { 0.35 * (2.0 * std::f64::consts::PI * 180.0 * t).sin() * (0.6 + 0.4 * (2.0 * std::f64::consts::PI * 3.0 * t).sin()) } else { 0.0 };
            (0.004 * noise + tone) as f32
        })
        .collect()
}
fn music(rate: u32, hz: f64, seconds: u32) -> Vec<f32> {
    (0..(rate * seconds) as usize)
        .map(|i| {
            let x = i as f64;
            let r = f64::from(rate);
            (0.5 * (2.0 * std::f64::consts::PI * hz * x / r).sin() + 0.3 * (2.0 * std::f64::consts::PI * hz * 1.5 * x / r).sin()) as f32
        })
        .collect()
}

fn inputs(name: &str, rate: u32) -> (AudioData, AudioData) {
    let audio = |c: Vec<Vec<f32>>| AudioData { channels: c, sample_rate: rate };
    match name {
        "standard" => (audio(vec![voice_of(rate, 7)]), audio(vec![music(rate, 220.0, 3), music(rate, 224.0, 3)])),
        "empfindlich" => (audio(vec![voice_of(rate, 7)]), audio(vec![music(rate, 330.0, 9)])),
        "ohne-anlauf" => (audio(vec![voice_of(rate, 6), voice_of(rate, 6)]), audio(vec![music(rate, 440.0, 4)])),
        "laut" => (audio(vec![voice_of(rate, 5)]), audio(vec![music(rate, 110.0, 5), music(rate, 112.0, 5)])),
        other => panic!("{other}"),
    }
}

fn near(label: &str, actual: f64, expected: f64, tolerance: f64) {
    assert!((actual - expected).abs() <= tolerance, "{label}: {actual} (expected {expected} ±{tolerance})");
}

#[test]
fn the_mix_is_the_one_of_the_web_app_in_every_case() {
    let file: File = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(file.cases.len(), 4);
    for case in &file.cases {
        let (voice, music) = inputs(&case.name, file.rate);
        assert_eq!((voice.channels.len(), voice.frames()), (case.voice.channels, case.voice.frames), "{}", case.name);
        assert_eq!((music.channels.len(), music.frames()), (case.music.channels, case.music.frames), "{}", case.name);
        let s = &case.settings;
        let settings = DuckSettings { music_db: s.music_db, duck_db: s.duck_db, sensitivity: s.sensitivity, attack_ms: s.attack_ms, release_ms: s.release_ms, lead_in: s.lead_in, tail: s.tail, loop_music: s.loop_music };
        let r = mix_with_ducking(&voice, &music, &settings);
        let name = &case.name;
        near(&format!("{name} Sprache"), r.report.speech_seconds, case.report.speech_seconds, 1e-9);
        near(&format!("{name} Stimme"), r.report.voice_seconds, case.report.voice_seconds, 1e-9);
        near(&format!("{name} Schwelle"), r.report.threshold_db, case.report.threshold_db, 1e-4);
        near(&format!("{name} Länge"), r.report.total_seconds, case.report.total_seconds, 1e-9);
        near(&format!("{name} Spitze"), r.report.peak_db, case.report.peak_db, 1e-4);
        near(&format!("{name} Abzug"), r.report.trim_db, case.report.trim_db, 1e-4);
        assert_eq!(r.audio.channels[0].len(), case.frames, "{name}");
        assert_eq!(r.music_gain_db.len(), case.out_frames, "{name}");
        let every = |v: &[f32], n: usize| -> Vec<f64> { v.iter().enumerate().filter(|(i, _)| i % n == 0).map(|(_, x)| f64::from(*x)).collect() };
        for (label, got, want, n) in [("links", every(&r.audio.channels[0], 211), &case.left, 211), ("rechts", every(&r.audio.channels[1], 211), &case.right, 211), ("Stimme dB", every(&r.voice_db, 7), &case.voice_db, 7), ("Gain dB", every(&r.music_gain_db, 7), &case.music_gain_db, 7)] {
            let _ = n;
            assert_eq!(got.len(), want.len(), "{name} {label}");
            for (i, (a, b)) in got.iter().zip(want).enumerate() {
                near(&format!("{name} {label}[{i}]"), *a, *b, 2e-5);
            }
        }
    }
}
