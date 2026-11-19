//! Gain, silence, joining, channels and sample rate against what the web app's `edit.ts` gives for the
//! same signals (`npm run native:golden`).

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::edit::*;

const GOLDEN: &str = include_str!("golden/edit.json");

#[derive(Deserialize)]
struct View {
    channels: usize,
    frames: usize,
    left: Vec<f64>,
    right: Vec<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span {
    start_seconds: f64,
    end_seconds: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    rate: u32,
    gain: View,
    gain_range: View,
    gain_silent: View,
    peak: f64,
    normalize: View,
    silence: Vec<Span>,
    quiet_silence: Vec<Span>,
    remove_silence: View,
    remove_silence_none: View,
    cut: View,
    concat: View,
    concat_plain: View,
    swap: View,
    left: View,
    right: View,
    dc: View,
    up: View,
    down: View,
}

fn take(rate: u32, seconds: u32, salt: u32) -> Vec<f32> {
    let mut state: u32 = 99 + salt;
    let tau = 2.0 * std::f64::consts::PI;
    (0..(rate * seconds) as usize)
        .map(|i| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let noise = (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0;
            let t = i as f64 / f64::from(rate);
            let speaking = t % 2.0 < 0.6 || (t > 4.1 && t < 4.5);
            let tone = if speaking { 0.5 * (tau * f64::from(180 + 40 * salt) * t).sin() } else { 0.0 };
            (0.0004 * noise + 0.001 * f64::from(salt) + tone) as f32
        })
        .collect()
}

fn check(label: &str, audio: &AudioData, every: usize, want: &View) {
    assert_eq!((audio.channels.len(), audio.frames()), (want.channels, want.frames), "{label}: shape");
    for (name, channel, expected) in [("links", &audio.channels[0], &want.left), ("rechts", &audio.channels[audio.channels.len() - 1], &want.right)] {
        let picked: Vec<f32> = channel.iter().copied().enumerate().filter(|(i, _)| i % every == 0).map(|(_, v)| v).collect();
        assert_eq!(picked.len(), expected.len(), "{label} {name}");
        for (i, (g, w)) in picked.iter().zip(expected).enumerate() {
            assert!((f64::from(*g) - w).abs() <= 1e-6, "{label} {name}[{i}]: {g} (expected {w})");
        }
    }
}

fn spans(label: &str, got: &[Range], want: &[Span]) {
    assert_eq!(got.len(), want.len(), "{label}: how many");
    for (g, w) in got.iter().zip(want) {
        assert!((g.start_seconds - w.start_seconds).abs() < 1e-12 && (g.end_seconds - w.end_seconds).abs() < 1e-12, "{label}: {g:?}");
    }
}

#[test]
fn every_edit_is_the_one_of_the_web_app() {
    let g: File = serde_json::from_str(GOLDEN).unwrap();
    let rate = g.rate;
    let base = AudioData { channels: vec![take(rate, 6, 0), take(rate, 6, 1)], sample_rate: rate };
    // As in the script: eight thousand samples a second were made, and the rate said afterwards is 6000.
    let other = AudioData { channels: vec![take(rate, 2, 2)], sample_rate: 6000 };
    check("Pegel", &apply_gain(&base, -6.0, 0.0, f64::INFINITY), 97, &g.gain);
    check("Pegel im Bereich", &apply_gain(&base, 12.0, 1.0, 2.5), 97, &g.gain_range);
    check("Pegel Stille", &apply_gain(&base, -120.0, 0.5, 1.5), 97, &g.gain_silent);
    assert!((peak_db(&base) - g.peak).abs() < 1e-9);
    check("Normalisieren", &normalize_peak(&base, -1.0), 97, &g.normalize);
    spans("Pausen", &detect_silence(&base, -50.0, 0.35), &g.silence);
    spans("leise Pausen", &detect_silence(&base, -30.0, 0.1), &g.quiet_silence);
    check("Stille entfernen", &remove_silence(&base, -50.0, 0.35, 0.05), 53, &g.remove_silence);
    check("Nichts zu entfernen", &remove_silence(&base, -90.0, 0.35, 0.05), 97, &g.remove_silence_none);
    check("Schneiden", &cut_range(&base, 1.0, 2.7), 53, &g.cut);
    check("Verbinden mit Überblendung", &concat_audio(&[base.clone(), other.clone()], 0.1).unwrap(), 97, &g.concat);
    check("Verbinden", &concat_audio(&[other, base.clone()], 0.0).unwrap(), 97, &g.concat_plain);
    check("Tauschen", &channel_trick(&base, Trick::Swap), 97, &g.swap);
    check("Links", &channel_trick(&base, Trick::Left), 97, &g.left);
    check("Rechts", &channel_trick(&base, Trick::Right), 97, &g.right);
    check("Gleichspannung", &remove_dc_offset(&base), 97, &g.dc);
    check("Höhere Rate", &resample_audio(&base, 11025), 61, &g.up);
    check("Tiefere Rate", &resample_audio(&base, 3000), 61, &g.down);
    assert_eq!(concat_audio(&[], 0.0).err().unwrap(), "Nichts zum Aneinanderhängen.");
}
