//! Filters, dynamics, noise reduction, echo and range edits against the numbers the web app's own
//! `effects.ts` gives for the same signals (`npm run native:golden`). Samples agree to what a 32-bit float
//! keeps; the reverb is not in the table (the browser's convolver does it there).

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::effects::*;

const GOLDEN: &str = include_str!("golden/effects.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct View {
    channels: usize,
    frames: usize,
    left: Vec<f64>,
    right: Vec<f64>,
    max_reduction_db: Option<f64>,
    makeup_db: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    rate: u32,
    highpass: View,
    lowpass: View,
    lowpass_high: View,
    shelf: View,
    shelf_bass: View,
    compress: View,
    compress_plain: View,
    profile: Vec<f64>,
    profile_length: usize,
    reduced: View,
    echo_extend: View,
    echo_plain: View,
    range: View,
    range_mono: View,
    copy: View,
    insert: View,
    insert_mono: View,
    silence: View,
    duplicate: View,
    mute: View,
    fade_in: View,
    fade_out: View,
    to_mono: View,
    to_three: View,
}

fn signal(rate: u32, seconds: u32, salt: u32) -> Vec<f32> {
    let mut state: u32 = 777 + salt;
    (0..(rate * seconds) as usize)
        .map(|i| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let noise = (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0;
            let t = i as f64 / f64::from(rate);
            let talking = t % 1.3 < 0.7;
            let tau = 2.0 * std::f64::consts::PI;
            let voice = if talking { 0.4 * (tau * f64::from(200 + 20 * salt) * t).sin() * (0.5 + 0.5 * (tau * 2.0 * t).sin()) } else { 0.0 };
            (0.02 * noise + 0.08 * (tau * 50.0 * t).sin() + voice) as f32
        })
        .collect()
}

fn every(values: &[f32], n: usize) -> Vec<f32> {
    values.iter().copied().enumerate().filter(|(i, _)| i % n == 0).map(|(_, v)| v).collect()
}

fn same(label: &str, got: &[f32], want: &[f64], tolerance: f64) {
    assert_eq!(got.len(), want.len(), "{label}: how many samples");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((f64::from(*g) - w).abs() <= tolerance, "{label}[{i}]: {g} (expected {w} ±{tolerance})");
    }
}

fn check(label: &str, audio: &AudioData, every_n: usize, want: &View, tolerance: f64) {
    assert_eq!((audio.channels.len(), audio.frames()), (want.channels, want.frames), "{label}: shape");
    same(&format!("{label} links"), &every(&audio.channels[0], every_n), &want.left, tolerance);
    same(&format!("{label} rechts"), &every(&audio.channels[audio.channels.len() - 1], every_n), &want.right, tolerance);
}

#[test]
fn every_effect_is_the_one_of_the_web_app() {
    let g: File = serde_json::from_str(GOLDEN).unwrap();
    let rate = g.rate;
    let base = AudioData { channels: vec![signal(rate, 3, 0), signal(rate, 3, 1)], sample_rate: rate };
    // Filters: the recursion keeps every digit of a double; the sample is a float. A float's last place
    // at 0.4 is 3e-8: three of them are room for the one place the sums may differ.
    let t = 1e-6;
    check("Hochpass", &highpass_filter(&base, 150.0), 97, &g.highpass, t);
    check("Tiefpass", &lowpass_filter(&base, 1500.0), 97, &g.lowpass, t);
    check("Tiefpass oben", &lowpass_filter(&base, 9000.0), 97, &g.lowpass_high, t);
    check("Klang", &shelf_eq(&base, 6.0, -4.0), 97, &g.shelf, t);
    check("Bässe", &shelf_eq(&base, -5.0, 0.0), 97, &g.shelf_bass, t);

    let c = compress_audio(&base, -24.0, 4.0, CompressOptions::default());
    check("Kompressor", &c.audio, 97, &g.compress, t);
    assert!((c.max_reduction_db - g.compress.max_reduction_db.unwrap()).abs() < 1e-6);
    assert!((c.makeup_db - g.compress.makeup_db.unwrap()).abs() < 1e-6);
    let p = compress_audio(&base, -30.0, 8.0, CompressOptions { attack_ms: 2.0, release_ms: 80.0, makeup: false });
    check("Kompressor ohne Ausgleich", &p.audio, 97, &g.compress_plain, t);
    assert_eq!(p.makeup_db, 0.0);
    assert!((p.max_reduction_db - g.compress_plain.max_reduction_db.unwrap()).abs() < 1e-6);

    // The noise profile: a hum and nothing else, learned and taken out of the first channel.
    let noise: Vec<f32> = signal(rate, 2, 5).iter().enumerate().map(|(i, _)| (0.02 * (i as f64 * 12.9898).sin() * (i as f64 * 0.37).cos()) as f32).collect();
    let profile = learn_noise(&AudioData { channels: vec![noise], sample_rate: rate });
    assert_eq!(profile.len(), g.profile_length);
    same("Rauschprofil", &every(&profile, 13), &g.profile, 1e-5);
    let mono = AudioData { channels: vec![base.channels[0].clone()], sample_rate: rate };
    check("Rauschminderung", &remove_noise(&mono, &profile, 18.0), 89, &g.reduced, 2e-5);

    check("Echo mit Nachhall", &echo(&base, 180.0, 0.5, 0.6, true), 101, &g.echo_extend, t);
    check("Echo", &echo(&base, 90.0, 0.8, 0.4, false), 101, &g.echo_plain, t);

    check("Bereich", &process_range(&base, 0.5, 2.0, |p| highpass_filter(&p, 400.0)), 97, &g.range, t);
    check("Bereich mono", &process_range(&base, 0.2, 1.1, |p| set_channels(&p, 1)), 97, &g.range_mono, t);
    check("Kopie", &copy_range(&base, 0.4, 1.7), 53, &g.copy, t);
    check("Einfügen", &insert_at(&base, 1.0, &copy_range(&base, 0.2, 0.9)), 97, &g.insert, t);
    check("Einfügen mono", &insert_at(&base, 2.5, &set_channels(&copy_range(&base, 0.2, 0.9), 1)), 97, &g.insert_mono, t);
    check("Stille", &insert_silence(&base, 0.7, 0.35), 97, &g.silence, t);
    check("Verdoppeln", &duplicate_range(&base, 1.1, 1.9), 97, &g.duplicate, t);
    check("Stumm", &mute_range(&base, 0.6, 1.4), 53, &g.mute, t);
    check("Einblenden", &fade_range(&base, 0.5, 1.5, Fade::In), 53, &g.fade_in, t);
    check("Ausblenden", &fade_range(&base, 1.0, 2.5, Fade::Out), 53, &g.fade_out, t);
    check("Mono", &set_channels(&base, 1), 97, &g.to_mono, t);
    check("Drei Kanäle", &set_channels(&base, 3), 97, &g.to_three, t);
}

#[test]
fn the_reverb_keeps_the_dry_sound_and_adds_a_tail_that_dies_away() {
    let rate = 8000;
    let mut tone = vec![0.0f32; rate as usize];
    tone[100] = 1.0;
    let mono = AudioData { channels: vec![tone], sample_rate: rate };
    let wet = reverb(&mono, 1.5, 0.8, true);
    assert_eq!(wet.channels.len(), 2, "a mono sound comes out in stereo");
    assert_eq!(wet.frames(), rate as usize + (1.5 * f64::from(rate)) as usize);
    // Before the click: silence. At it: the dry click. After it: a tail, louder near the click than far.
    assert!(wet.channels[0][..100].iter().all(|v| v.abs() < 1e-6));
    assert!(wet.channels[0][100] > 0.5, "{}", wet.channels[0][100]);
    let near: f64 = wet.channels[0][101..2000].iter().map(|v| f64::from(*v).powi(2)).sum();
    let far: f64 = wet.channels[0][9000..11000].iter().map(|v| f64::from(*v).powi(2)).sum();
    assert!(near > 0.0 && near > far * 3.0, "{near} vs {far}");
    assert!(wet.channels[0] != wet.channels[1], "the two sides of the room differ");
    assert!(wet.channels.iter().flatten().all(|v| v.abs() <= 1.0));
    let dry_only = reverb(&mono, 1.5, 0.0, false);
    assert_eq!(dry_only.frames(), rate as usize);
    assert_eq!(dry_only.channels[0], mono.channels[0]);
}
