//! Timing maths: the cases of `scripts/verify-tempo.mts`, and the web app's own numbers for a
//! drum pattern without randomness.

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::onsets::*;
use sondra_media::tempo::*;

const GOLDEN: &str = include_str!("golden/tempo.json");
const SR: u32 = 44100;

/// Kick on every beat, hats on eighths, a quiet tone under it; the hat noise from an integer generator.
fn drums(bpm: f64, seconds: f64, offset: f64) -> AudioData {
    let frames = (f64::from(SR) * seconds).round() as usize;
    let beat = 60.0 / bpm;
    let mut state: u32 = 987654321;
    let mut channel = vec![0.0f32; frames];
    for (i, out) in channel.iter_mut().enumerate() {
        let t = i as f64 / f64::from(SR) - offset;
        if t < 0.0 {
            continue;
        }
        // JavaScript's `%` on doubles is fmod, as Rust's.
        let in_beat = t % beat;
        let in_eighth = t % (beat / 2.0);
        let mut value = 0.0f64;
        if in_beat < 0.05 {
            value +=
                0.9 * (2.0 * std::f64::consts::PI * 60.0 * in_beat).sin() * (-in_beat * 60.0).exp();
        }
        if in_eighth < 0.02 {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            value += 0.35
                * (f64::from(state >> 8) / 16777216.0 * 2.0 - 1.0)
                * (-in_eighth * 220.0).exp();
        }
        value += 0.05 * (2.0 * std::f64::consts::PI * 220.0 * t).sin();
        *out = value as f32;
    }
    AudioData {
        channels: vec![channel.clone(), channel],
        sample_rate: SR,
    }
}

fn mono(c: Vec<f32>) -> AudioData {
    AudioData {
        channels: vec![c],
        sample_rate: SR,
    }
}

/* verify-tempo ------------------------------------------------------------------------------- */

#[test]
fn a_drum_loop_is_found_at_its_tempo_or_half_or_double() {
    for bpm in [90.0, 120.0, 128.0, 140.0, 174.0] {
        let e = estimate_tempo(&drums(bpm, 8.0, 0.0));
        let ratio = e.bpm / bpm;
        assert!(
            [0.5, 1.0, 2.0].iter().any(|f| (ratio - f).abs() < 0.03),
            "{bpm} BPM: got {} (confidence {:.2})",
            e.bpm,
            e.confidence
        );
    }
}

#[test]
fn confidence_tells_rhythm_from_the_lack_of_it() {
    assert!(estimate_tempo(&drums(120.0, 8.0, 0.0)).confidence > 0.8);
    let tone: Vec<f32> = (0..SR * 4)
        .map(|i| {
            (0.3 * (2.0 * std::f64::consts::PI * 220.0 * f64::from(i) / f64::from(SR)).sin()) as f32
        })
        .collect();
    assert!(estimate_tempo(&mono(tone)).confidence < 0.5);
    // Too short, and silence: a guess, said as one.
    assert_eq!(
        estimate_tempo(&mono(vec![0.0; 1000])),
        TempoEstimate {
            bpm: 120.0,
            confidence: 0.0,
            offset_seconds: 0.0
        }
    );
    assert_eq!(
        estimate_tempo(&mono(vec![0.0; SR as usize * 3])).confidence,
        0.0
    );
}

#[test]
fn the_grid_phase_is_found() {
    let e = estimate_tempo(&drums(120.0, 8.0, 0.25));
    // The beat is 0.5 s, so any phase congruent to 0.25 is right.
    assert!(
        ((e.offset_seconds % 0.5) - 0.25).abs() < 0.05,
        "{}",
        e.offset_seconds
    );
}

#[test]
fn the_beat_grid_has_the_right_number_of_slices() {
    for (beats, expected) in [(0.5, 16), (1.0, 8), (4.0, 2)] {
        let grid = beat_grid(GridOptions {
            bpm: 120.0,
            offset_seconds: 0.0,
            beats_per_slice: beats,
            duration_seconds: 4.0,
        });
        assert_eq!(grid.len(), expected, "{beats} beats per slice");
    }
    assert_eq!(
        beat_grid(GridOptions {
            bpm: 0.0,
            offset_seconds: 0.0,
            beats_per_slice: 1.0,
            duration_seconds: 4.0
        }),
        vec![0.0]
    );
    assert_eq!(
        beat_grid(GridOptions {
            bpm: 120.0,
            offset_seconds: 0.0,
            beats_per_slice: 1.0,
            duration_seconds: 0.0
        }),
        vec![0.0]
    );
}

#[test]
fn a_cut_moves_to_the_nearest_rising_zero_crossing() {
    let sine: Vec<f32> = (0..SR)
        .map(|i| (2.0 * std::f64::consts::PI * 100.0 * f64::from(i) / f64::from(SR)).sin() as f32)
        .collect();
    let audio = mono(sine.clone());
    for at in [0.1234, 0.777] {
        let snapped = snap_to_zero_crossing(&audio, at, 12.0);
        let value = f64::from(sine[(snapped * f64::from(SR)).round() as usize]).abs();
        assert!(value < 0.1, "{at} → {snapped}: {value}");
        assert!((snapped - at).abs() * 1000.0 <= 12.0 + 0.1);
    }
    // No audio: the position stays.
    assert_eq!(snap_to_zero_crossing(&mono(vec![]), 0.5, 12.0), 0.5);
}

/* The web app's numbers --------------------------------------------------------------------- */

#[derive(Deserialize)]
struct GoldEstimate {
    bpm: f64,
    confidence: f64,
    #[serde(rename = "offsetSeconds")]
    offset_seconds: f64,
}
#[derive(Deserialize)]
struct GoldTempo {
    name: String,
    bpm: f64,
    seconds: f64,
    offset: f64,
    estimate: GoldEstimate,
}
#[derive(Deserialize)]
struct GoldGrid {
    beats: f64,
    grid: Vec<f64>,
}
#[derive(Deserialize)]
struct GoldSnap {
    at: f64,
    snapped: f64,
}
#[derive(Deserialize)]
struct Golden {
    tempo: Vec<GoldTempo>,
    held: GoldEstimate,
    grids: Vec<GoldGrid>,
    snaps: Vec<GoldSnap>,
    onsets: Vec<f64>,
    chop: Vec<f64>,
}

fn golden() -> Golden {
    serde_json::from_str(GOLDEN).unwrap()
}

#[test]
fn tempo_confidence_and_phase_are_the_web_apps() {
    let g = golden();
    assert_eq!(g.tempo.len(), 4);
    for t in &g.tempo {
        let e = estimate_tempo(&drums(t.bpm, t.seconds, t.offset));
        assert_eq!(e.bpm, t.estimate.bpm, "{}", t.name);
        assert!(
            (e.confidence - t.estimate.confidence).abs() < 1e-3,
            "{} confidence {} vs {}",
            t.name,
            e.confidence,
            t.estimate.confidence
        );
        assert!(
            (e.offset_seconds - t.estimate.offset_seconds).abs() < 1e-9,
            "{} offset",
            t.name
        );
    }
    let tone: Vec<f32> = (0..SR * 4)
        .map(|i| {
            (0.3 * (2.0 * std::f64::consts::PI * 220.0 * f64::from(i) / f64::from(SR)).sin()) as f32
        })
        .collect();
    let held = estimate_tempo(&mono(tone));
    assert_eq!(held.bpm, g.held.bpm);
    assert!((held.confidence - g.held.confidence).abs() < 1e-3);
    assert!((held.offset_seconds - g.held.offset_seconds).abs() < 1e-9);
}

#[test]
fn grids_and_snaps_are_the_web_apps() {
    let g = golden();
    for grid in &g.grids {
        let mine = beat_grid(GridOptions {
            bpm: 120.0,
            offset_seconds: 0.3,
            beats_per_slice: grid.beats,
            duration_seconds: 4.0,
        });
        assert_eq!(mine.len(), grid.grid.len(), "{} beats", grid.beats);
        for (a, b) in mine.iter().zip(&grid.grid) {
            assert!((a - b).abs() < 1e-9);
        }
    }
    let sine: Vec<f32> = (0..SR)
        .map(|i| (2.0 * std::f64::consts::PI * 100.0 * f64::from(i) / f64::from(SR)).sin() as f32)
        .collect();
    for s in &g.snaps {
        assert!(
            (snap_to_zero_crossing(&mono(sine.clone()), s.at, 12.0) - s.snapped).abs() < 1e-12,
            "{}",
            s.at
        );
    }
}

#[test]
fn onsets_and_auto_chops_are_the_web_apps() {
    let g = golden();
    let audio = drums(120.0, 4.0, 0.0);
    let onsets = detect_onsets(&audio, &OnsetOptions::default());
    assert_eq!(onsets.len(), g.onsets.len(), "{onsets:?} vs {:?}", g.onsets);
    for (a, b) in onsets.iter().zip(&g.onsets) {
        assert!((a - b).abs() < 1e-9);
    }
    let chop = detect_auto_chop(&audio, 1.4, 16);
    assert_eq!(chop.len(), g.chop.len(), "{chop:?} vs {:?}", g.chop);
    for (a, b) in chop.iter().zip(&g.chop) {
        assert!((a - b).abs() < 1e-9);
    }
    // The start is there (or an onset right at it); very short material is one slice.
    assert!(
        onsets[0] <= 0.02,
        "the start, or an onset within 20 ms of it"
    );
    assert_eq!(
        detect_onsets(&mono(vec![0.0; 100]), &OnsetOptions::default()),
        vec![0.0]
    );
    assert_eq!(detect_auto_chop(&mono(vec![0.0; 100]), 1.4, 16), vec![0.0]);
    assert_eq!(divide_evenly(4.0, 4), vec![0.0, 1.0, 2.0, 3.0]);
}
