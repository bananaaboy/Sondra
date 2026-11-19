//! The calibration of `scripts/verify-loudness.mts`, and the numbers the web app's own engine gives
//! for the same signals (`npm run native:golden`).

use serde::Deserialize;
use sondra_media::loudness::*;

const RATE: u32 = 48000;
const GOLDEN: &str = include_str!("golden/loudness.json");

fn sine(hz: f64, peak: f64, seconds: u32) -> Vec<f32> {
    (0..RATE * seconds)
        .map(|i| {
            (peak * (2.0 * std::f64::consts::PI * hz * f64::from(i) / f64::from(RATE)).sin()) as f32
        })
        .collect()
}
fn stereo(c: Vec<f32>) -> AudioData {
    AudioData {
        channels: vec![c.clone(), c],
        sample_rate: RATE,
    }
}
fn mono(c: Vec<f32>) -> AudioData {
    AudioData {
        channels: vec![c],
        sample_rate: RATE,
    }
}
fn measure(a: &AudioData) -> LoudnessReport {
    measure_loudness(a, &mut |_| {})
}
fn near(label: &str, actual: f64, expected: f64, tolerance: f64) {
    assert!(
        (actual - expected).abs() <= tolerance,
        "{label}: {actual:.3} (expected {expected:.3} ±{tolerance})"
    );
}

/* The calibration ------------------------------------------------------------------------------ */

#[test]
fn a_one_kilohertz_sine_reads_its_own_peak_level() {
    for dbfs in [0.0, -14.0, -23.0] {
        let r = measure(&stereo(sine(1000.0, 10f64.powf(dbfs / 20.0), 8)));
        near(
            &format!("1 kHz stereo at {dbfs} dBFS"),
            r.integrated_lufs,
            dbfs,
            0.1,
        );
    }
    near(
        "1 kHz mono at 0 dBFS",
        measure(&mono(sine(1000.0, 1.0, 8))).integrated_lufs,
        -3.01,
        0.1,
    );
}

#[test]
fn silence_after_the_programme_is_gated_out() {
    let mut padded = vec![0.0f32; (RATE * 24) as usize];
    let tone = sine(1000.0, 10f64.powf(-23.0 / 20.0), 8);
    padded[..tone.len()].copy_from_slice(&tone);
    near(
        "8 s tone followed by 16 s of silence",
        measure(&stereo(padded)).integrated_lufs,
        -23.0,
        0.2,
    );
}

fn inter_sample() -> Vec<f32> {
    let n = RATE as usize;
    (0..n)
        .map(|i| {
            let envelope = (i.min(n - 1 - i) as f64 / 2000.0).min(1.0);
            (0.5 * envelope
                * (2.0 * std::f64::consts::PI * 12000.0 * i as f64 / f64::from(RATE)
                    + std::f64::consts::FRAC_PI_4)
                    .sin()) as f32
        })
        .collect()
}

#[test]
fn the_true_peak_finds_what_the_sample_peak_misses() {
    let r = measure(&mono(inter_sample()));
    near(
        "sample peak of an inter-sample tone",
        r.sample_peak_dbfs,
        -9.03,
        0.1,
    );
    near("true peak of the same tone", r.true_peak_dbtp, -6.02, 0.3);
    let constant = measure(&mono(vec![0.5; RATE as usize]));
    near(
        "true peak of a constant signal",
        constant.true_peak_dbtp,
        -6.02,
        1.1,
    );
}

#[test]
fn the_gain_move_reaches_the_target_and_respects_the_ceiling() {
    for target in [-23.0, -16.0, -9.0] {
        let music = AudioData {
            channels: vec![sine(220.0, 0.4, 6), sine(224.0, 0.4, 6)],
            sample_rate: RATE,
        };
        let before = measure(&music);
        let settings = NormalizationSettings {
            target_lufs: target,
            ..NormalizationSettings::default()
        };
        let (audio, _) = apply_normalization(&music, &before, &settings);
        let after = measure(&audio);
        near(
            &format!("gain move to {target} LUFS"),
            after.integrated_lufs,
            target,
            0.1,
        );
        assert!(
            after.true_peak_dbtp <= settings.true_peak_ceiling_dbtp + 0.05,
            "ceiling breached at {target}: {}",
            after.true_peak_dbtp
        );
    }
}

#[test]
fn silence_measures_as_silence_and_asks_for_no_gain() {
    let silent = mono(vec![0.0; (RATE * 2) as usize]);
    let r = measure(&silent);
    assert_eq!(r.integrated_lufs, f64::NEG_INFINITY);
    assert_eq!(r.sample_peak_dbfs, f64::NEG_INFINITY);
    assert_eq!(r.loudness_range_lu, 0.0);
    let (out, plan) = apply_normalization(&silent, &r, &NormalizationSettings::default());
    assert_eq!(plan.applied_db, 0.0, "no gain is invented for silence");
    assert!(out.channels[0].iter().all(|s| *s == 0.0));
    // The input is untouched, and a clip too short for one block has no loudness.
    let short = measure(&mono(vec![0.1; 100]));
    assert_eq!(short.integrated_lufs, f64::NEG_INFINITY);
}

#[test]
fn the_limiter_holds_a_hot_signal_under_the_ceiling() {
    let hot = AudioData {
        channels: vec![sine(300.0, 0.3, 4)],
        sample_rate: RATE,
    };
    let before = measure(&hot);
    let settings = NormalizationSettings {
        target_lufs: -3.0,
        use_limiter: true,
        ..NormalizationSettings::default()
    };
    let (audio, plan) = apply_normalization(&hot, &before, &settings);
    assert!(plan.limiter_engaged);
    let after = measure(&audio);
    assert!(
        after.true_peak_dbtp <= -1.0 + 0.3,
        "{}",
        after.true_peak_dbtp
    );
}

#[test]
fn progress_reaches_the_end() {
    let mut seen = Vec::new();
    measure_loudness(&stereo(sine(440.0, 0.3, 3)), &mut |f| seen.push(f));
    assert_eq!(seen.last(), Some(&1.0));
    assert!(seen.windows(2).all(|w| w[0] <= w[1]));
}

/* The numbers of the web app ------------------------------------------------------------------ */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldReport {
    integrated_lufs: Option<f64>,
    loudness_range_lu: Option<f64>,
    momentary_max_lufs: Option<f64>,
    short_term_max_lufs: Option<f64>,
    sample_peak_dbfs: Option<f64>,
    true_peak_dbtp: Option<f64>,
    duration_seconds: f64,
}
#[derive(Deserialize)]
struct GoldSignal {
    name: String,
    report: GoldReport,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoldPlan {
    target_lufs: f64,
    use_limiter: bool,
    requested_db: f64,
    applied_db: f64,
    reduced_by_ceiling: bool,
    limiter_engaged: bool,
    predicted_peak_dbtp: Option<f64>,
    after_integrated: Option<f64>,
}
#[derive(Deserialize)]
struct Golden {
    loudness: Vec<GoldSignal>,
    plans: Vec<GoldPlan>,
}

/// The same signals the web app's script makes, by the same formulas.
fn signal(name: &str) -> AudioData {
    let pi = std::f64::consts::PI;
    match name {
        "stereo-1k-minus14" => stereo(sine(1000.0, 10f64.powf(-14.0 / 20.0), 8)),
        "mono-1k-0" => mono(sine(1000.0, 1.0, 8)),
        "padded" => {
            let mut p = vec![0.0f32; (RATE * 24) as usize];
            let t = sine(1000.0, 10f64.powf(-23.0 / 20.0), 8);
            p[..t.len()].copy_from_slice(&t);
            stereo(p)
        }
        "inter-sample" => mono(inter_sample()),
        "constant" => mono(vec![0.5; RATE as usize]),
        "music" => AudioData {
            channels: vec![sine(220.0, 0.4, 6), sine(224.0, 0.4, 6)],
            sample_rate: RATE,
        },
        "swell" => {
            let mut state: u32 = 12345;
            let samples = (0..RATE * 20)
                .map(|i| {
                    state = state.wrapping_mul(1103515245).wrapping_add(12345);
                    let white = f64::from(state >> 8) / 16777216.0 * 2.0 - 1.0;
                    (0.3 * (0.35
                        + 0.65
                            * (2.0 * pi * f64::from(i) / (f64::from(RATE) * 4.0))
                                .sin()
                                .abs())
                        * white) as f32
                })
                .collect();
            mono(samples)
        }
        "silence" => mono(vec![0.0; (RATE * 2) as usize]),
        other => panic!("unknown signal {other}"),
    }
}

fn same(label: &str, mine: f64, theirs: Option<f64>) {
    match theirs {
        None => assert_eq!(mine, f64::NEG_INFINITY, "{label}"),
        Some(t) => assert!((mine - t).abs() < 1e-3, "{label}: {mine} vs {t}"),
    }
}

#[test]
fn every_measurement_matches_the_web_apps_engine() {
    let golden: Golden = serde_json::from_str(GOLDEN).unwrap();
    assert!(golden.loudness.len() >= 8);
    for g in &golden.loudness {
        let r = measure(&signal(&g.name));
        let n = &g.name;
        same(
            &format!("{n} integrated"),
            r.integrated_lufs,
            g.report.integrated_lufs,
        );
        // The range of a steady tone is a rounding residue on both sides (1e-11): compare absolutely.
        assert!(
            (r.loudness_range_lu - g.report.loudness_range_lu.unwrap_or(0.0)).abs() < 1e-3,
            "{n} range"
        );
        same(
            &format!("{n} momentary"),
            r.momentary_max_lufs,
            g.report.momentary_max_lufs,
        );
        same(
            &format!("{n} short-term"),
            r.short_term_max_lufs,
            g.report.short_term_max_lufs,
        );
        same(
            &format!("{n} sample peak"),
            r.sample_peak_dbfs,
            g.report.sample_peak_dbfs,
        );
        same(
            &format!("{n} true peak"),
            r.true_peak_dbtp,
            g.report.true_peak_dbtp,
        );
        assert!(
            (r.duration_seconds - g.report.duration_seconds).abs() < 1e-9,
            "{n} length"
        );
    }
}

#[test]
fn every_gain_plan_matches_the_web_apps_engine() {
    let golden: Golden = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(golden.plans.len(), 6);
    let music = signal("music");
    let before = measure(&music);
    for g in &golden.plans {
        let settings = NormalizationSettings {
            target_lufs: g.target_lufs,
            use_limiter: g.use_limiter,
            ..NormalizationSettings::default()
        };
        let (audio, plan) = apply_normalization(&music, &before, &settings);
        let label = format!("{} LUFS, limiter {}", g.target_lufs, g.use_limiter);
        assert!(
            (plan.requested_db - g.requested_db).abs() < 1e-3,
            "{label} requested"
        );
        assert!(
            (plan.applied_db - g.applied_db).abs() < 1e-3,
            "{label} applied"
        );
        assert_eq!(plan.reduced_by_ceiling, g.reduced_by_ceiling, "{label}");
        assert_eq!(plan.limiter_engaged, g.limiter_engaged, "{label}");
        same(
            &format!("{label} predicted peak"),
            plan.predicted_peak_dbtp,
            g.predicted_peak_dbtp,
        );
        same(
            &format!("{label} after"),
            measure(&audio).integrated_lufs,
            g.after_integrated,
        );
    }
}
