//! The chopper's plans against what the web app's own `chop.ts` plans for the same drum break
//! (`npm run native:golden`): every method, with a range, with a run-up, with and without the snap.

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::chop::*;

const GOLDEN: &str = include_str!("golden/chop.json");

#[derive(Deserialize)]
struct File {
    rate: u32,
    seconds: u32,
    #[serde(rename = "hitsAt")]
    hits_at: Vec<f64>,
    plans: Vec<Plan>,
}
#[derive(Deserialize)]
struct Range {
    start: f64,
    end: f64,
}
#[derive(Deserialize)]
struct Slice {
    start: f64,
    end: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    method: String,
    sensitivity: f64,
    min_gap_ms: f64,
    count: f64,
    bpm: f64,
    beats_per_slice: f64,
    grid_offset_ms: f64,
    length_ms: f64,
    silence_db: f64,
    silence_ms: f64,
    drop_silence: bool,
    pre_roll_ms: f64,
    min_length_ms: f64,
    snap: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    name: String,
    settings: Settings,
    range: Option<Range>,
    tempo_offset_seconds: f64,
    slices: Vec<Slice>,
    capped: bool,
    words: String,
}

/// The drum break of the script, from the same integer generator.
fn break_of(rate: u32, seconds: u32, hits_at: &[f64]) -> AudioData {
    let sr = f64::from(rate);
    let mut out = vec![0f32; (rate * seconds) as usize];
    let mut state: u32 = 99;
    let mut noise = || {
        state = state.wrapping_mul(1103515245).wrapping_add(12345);
        (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0
    };
    for (k, t) in hits_at.iter().enumerate() {
        let from = (t * sr + 0.5).floor() as usize;
        let mut i = 0usize;
        while (i as f64) < 0.3 * sr && from + i < out.len() {
            let decay = (-(i as f64) / (0.06 * sr)).exp();
            let tone = if k % 2 == 0 { 0.4 * (2.0 * std::f64::consts::PI * (110.0 + 40.0 * (k % 4) as f64) * i as f64 / sr).sin() } else { 0.0 };
            let value = (0.7 - 0.05 * (k % 3) as f64) * decay * (noise() * 0.6 + tone);
            out[from + i] = (f64::from(out[from + i]) + value) as f32;
            i += 1;
        }
    }
    for x in out.iter_mut() {
        *x = (f64::from(*x) + 0.0005 * noise()) as f32;
    }
    AudioData { channels: vec![out], sample_rate: rate }
}

fn settings_of(s: &Settings) -> ChopSettings {
    ChopSettings {
        method: match s.method.as_str() {
            "auto" => ChopMethod::Auto,
            "grid" => ChopMethod::Grid,
            "even" => ChopMethod::Even,
            "length" => ChopMethod::Length,
            "silence" => ChopMethod::Silence,
            _ => ChopMethod::Hits,
        },
        sensitivity: s.sensitivity,
        min_gap_ms: s.min_gap_ms,
        count: s.count,
        bpm: s.bpm,
        beats_per_slice: s.beats_per_slice,
        grid_offset_ms: s.grid_offset_ms,
        length_ms: s.length_ms,
        silence_db: s.silence_db,
        silence_ms: s.silence_ms,
        drop_silence: s.drop_silence,
        pre_roll_ms: s.pre_roll_ms,
        min_length_ms: s.min_length_ms,
        snap: s.snap,
    }
}

#[test]
fn every_plan_is_the_one_of_the_web_app() {
    let file: File = serde_json::from_str(GOLDEN).unwrap();
    let audio = break_of(file.rate, file.seconds, &file.hits_at);
    let flux = Flux::of(&audio);
    assert!(flux.is_some());
    assert_eq!(file.plans.len(), 19);
    for plan in &file.plans {
        let settings = settings_of(&plan.settings);
        let context = PlanContext { range: plan.range.as_ref().map(|r| (r.start, r.end)), tempo_offset_seconds: plan.tempo_offset_seconds };
        let got = plan_chop(&audio, flux.as_ref(), &settings, &context);
        assert_eq!(got.capped, plan.capped, "{}", plan.name);
        assert_eq!(got.slices.len(), plan.slices.len(), "{}: {:?}", plan.name, got.slices);
        for (i, (a, b)) in got.slices.iter().zip(&plan.slices).enumerate() {
            assert!((a.start - b.start).abs() < 1e-9 && (a.end - b.end).abs() < 1e-9, "{} slice {i}: {a:?} against {}–{}", plan.name, b.start, b.end);
        }
        assert_eq!(describe_method(&settings), plan.words, "{}", plan.name);
    }
}

#[test]
fn a_file_too_short_for_a_spectrum_has_no_hits_but_still_divides_evenly() {
    let audio = AudioData { channels: vec![vec![0.1; 1500]], sample_rate: 22050 };
    assert!(Flux::of(&audio).is_none());
    // (1 500 samples are 0.07 s: two parts of 34 ms are just long enough to stay two.)
    let plan = plan_chop(&audio, None, &ChopSettings { method: ChopMethod::Even, count: 2.0, snap: false, ..ChopSettings::default() }, &PlanContext::default());
    assert_eq!(plan.slices.len(), 2);
    let none = plan_chop(&audio, None, &ChopSettings::default(), &PlanContext::default());
    assert_eq!(none.slices.len(), 1, "no hits: the whole file is one slice");
}
