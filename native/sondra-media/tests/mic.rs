//! The microphone chain against what the web app's own `micCalibrate.ts` says for the same two takes
//! (`npm run native:golden`): the measurements, the steps in words, the advice, and the samples.

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::mic::*;

const GOLDEN: &str = include_str!("golden/mic.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Before {
    noise_floor_db: f64,
    speech_db: f64,
    peak_db: f64,
    clipped: usize,
    snr_db: f64,
    hum_hz: Option<u32>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AfterJs {
    noise_floor_db: f64,
    speech_db: f64,
    snr_db: f64,
    lufs: f64,
    true_peak_dbtp: f64,
}
#[derive(Deserialize)]
struct StepJs {
    title: String,
    detail: String,
}
#[derive(Deserialize)]
struct AdviceJs {
    tone: String,
    title: String,
    text: String,
}
#[derive(Deserialize)]
struct Processed {
    frames: usize,
    samples: Vec<f64>,
}
#[derive(Deserialize)]
struct Applied {
    channels: usize,
    frames: usize,
    left: Vec<f64>,
    right: Vec<f64>,
}
#[derive(Deserialize)]
struct Result {
    purpose: String,
    steps: Vec<StepJs>,
    before: Before,
    after: AfterJs,
    advice: Vec<AdviceJs>,
    processed: Processed,
    applied: Applied,
}
#[derive(Deserialize)]
struct File {
    rate: u32,
    results: Vec<Result>,
    quiet: String,
}

fn take(rate: u32, seconds: u32, voice: bool, salt: u32) -> Vec<f32> {
    let mut state: u32 = 31337 + salt;
    let tau = 2.0 * std::f64::consts::PI;
    (0..(rate * seconds) as usize)
        .map(|i| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let noise = (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0;
            let t = i as f64 / f64::from(rate);
            let talking = voice && ((t % 1.4) < 0.8 || (t > 3.1 && t < 3.6));
            let tone = if talking { 0.3 * (tau * 190.0 * t).sin() * (0.6 + 0.4 * (tau * 3.1 * t).sin()) + 0.08 * (tau * 570.0 * t).sin() } else { 0.0 };
            (0.006 * noise + 0.01 * (tau * 50.0 * t).sin() + 0.004 * (tau * 100.0 * t).sin() + tone) as f32
        })
        .collect()
}

fn near(label: &str, got: f64, want: f64, tolerance: f64) {
    assert!((got - want).abs() <= tolerance, "{label}: {got} (expected {want} ±{tolerance})");
}

fn same_samples(label: &str, got: &[f32], every: usize, want: &[f64], tolerance: f64) {
    let picked: Vec<f32> = got.iter().copied().enumerate().filter(|(i, _)| i % every == 0).map(|(_, v)| v).collect();
    assert_eq!(picked.len(), want.len(), "{label}: how many");
    for (i, (g, w)) in picked.iter().zip(want).enumerate() {
        assert!((f64::from(*g) - w).abs() <= tolerance, "{label}[{i}]: {g} (expected {w})");
    }
}

fn purpose_of(name: &str) -> Purpose {
    match name {
        "podcast" => Purpose::Podcast,
        "streaming" => Purpose::Streaming,
        "meeting" => Purpose::Meeting,
        "vocals" => Purpose::Vocals,
        "instrument" => Purpose::Instrument,
        other => panic!("{other}"),
    }
}

#[test]
fn the_calibration_says_what_the_web_app_says_for_every_purpose() {
    let g: File = serde_json::from_str(GOLDEN).unwrap();
    let rate = g.rate;
    let (noise, speech) = (take(rate, 4, false, 1), take(rate, 6, true, 2));
    let other = AudioData { channels: vec![take(rate, 3, true, 3), take(rate, 3, true, 4)], sample_rate: rate };
    assert_eq!(g.results.len(), 5);
    for r in &g.results {
        let name = &r.purpose;
        let c = calibrate(&noise, &speech, rate, purpose_of(name)).unwrap();
        // The measurements.
        near(&format!("{name} Rauschen"), c.before.noise_floor_db, r.before.noise_floor_db, 1e-6);
        near(&format!("{name} Stimme"), c.before.speech_db, r.before.speech_db, 1e-6);
        near(&format!("{name} Spitze"), c.before.peak_db, r.before.peak_db, 1e-6);
        near(&format!("{name} Abstand"), c.before.snr_db, r.before.snr_db, 1e-6);
        assert_eq!((c.before.clipped, c.before.hum_hz), (r.before.clipped, r.before.hum_hz), "{name}");
        // What the chain did, in words: the very sentences.
        let titles: Vec<&str> = c.steps.iter().map(|s| s.title.as_str()).collect();
        let want_titles: Vec<&str> = r.steps.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, want_titles, "{name}");
        for (got, want) in c.steps.iter().zip(&r.steps) {
            assert_eq!(got.detail, want.detail, "{name}: {}", want.title);
        }
        // The advice.
        assert_eq!(c.advice.len(), r.advice.len(), "{name}");
        for (got, want) in c.advice.iter().zip(&r.advice) {
            assert_eq!((format!("{:?}", got.tone).to_lowercase(), &got.title, &got.text), (want.tone.clone(), &want.title, &want.text), "{name}");
        }
        // After.
        near(&format!("{name} nachher Rauschen"), c.after.noise_floor_db, r.after.noise_floor_db, 1e-4);
        near(&format!("{name} nachher Stimme"), c.after.speech_db, r.after.speech_db, 1e-4);
        near(&format!("{name} nachher Abstand"), c.after.snr_db, r.after.snr_db, 1e-4);
        near(&format!("{name} Lautheit"), c.after.lufs, r.after.lufs, 1e-4);
        near(&format!("{name} Spitze nachher"), c.after.true_peak_dbtp, r.after.true_peak_dbtp, 1e-4);
        // The samples.
        assert_eq!(c.processed.frames(), r.processed.frames);
        same_samples(&format!("{name} Aufnahme"), &c.processed.channels[0], 211, &r.processed.samples, 2e-5);
        let again = c.apply(&other).unwrap();
        assert_eq!((again.channels.len(), again.frames()), (r.applied.channels, r.applied.frames), "{name}");
        same_samples(&format!("{name} andere links"), &again.channels[0], 97, &r.applied.left, 2e-5);
        same_samples(&format!("{name} andere rechts"), &again.channels[1], 97, &r.applied.right, 2e-5);
    }
}

#[test]
fn a_second_take_with_nothing_in_it_is_said_so() {
    let g: File = serde_json::from_str(GOLDEN).unwrap();
    let noise = take(g.rate, 4, false, 1);
    let err = calibrate(&noise, &vec![0.0f32; (g.rate * 3) as usize], g.rate, Purpose::Podcast).err().unwrap();
    assert_eq!(err, g.quiet);
}
