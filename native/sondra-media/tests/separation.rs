//! The stems against what the web app's own `separation.ts` gives for the same song
//! (`npm run native:golden`), and what they must do whatever the code says: add back to the original.

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::separation::*;

#[derive(Deserialize)]
struct Pair {
    left: Vec<f64>,
    right: Vec<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Opts {
    fft_size: usize,
    hop_size: usize,
    time_kernel: usize,
    freq_kernel: usize,
    mask_exponent: f64,
    vocal_focus: f64,
    segment_seconds: f64,
    overlap_seconds: f64,
}
#[derive(Deserialize)]
struct Inst {
    left: Vec<f64>,
}
#[derive(Deserialize)]
struct File {
    rate: u32,
    options: Opts,
    frames: usize,
    stems: std::collections::BTreeMap<String, Pair>,
    mono: std::collections::BTreeMap<String, Vec<f64>>,
    instrumental: Inst,
}

fn song(rate: u32, seconds: u32) -> AudioData {
    let n = (rate * seconds) as usize;
    let (mut left, mut right) = (vec![0.0f32; n], vec![0.0f32; n]);
    let mut state: u32 = 5150;
    let tau = 2.0 * std::f64::consts::PI;
    for i in 0..n {
        state = state.wrapping_mul(1103515245).wrapping_add(12345);
        let noise = (f64::from(state >> 8) / 16777216.0) * 2.0 - 1.0;
        let t = i as f64 / f64::from(rate);
        let voice = 0.3 * (tau * (330.0 + 40.0 * (tau * 0.7 * t).sin()) * t).sin() * (0.6 + 0.4 * (tau * 3.0 * t).sin());
        let bass = 0.35 * (tau * 55.0 * t).sin();
        let chord = 0.15 * ((tau * 440.0 * t).sin() + (tau * 554.4 * t).sin());
        let drum = 0.5 * noise * (-(t % 0.5) * 40.0).exp();
        left[i] = (voice + bass + 0.5 * chord + drum) as f32;
        right[i] = (voice + bass + chord + 0.7 * drum) as f32;
    }
    AudioData { channels: vec![left, right], sample_rate: rate }
}

fn picked(v: &[f32], k: usize) -> Vec<f32> {
    v.iter().copied().enumerate().filter(|(i, _)| i % k == 0).map(|(_, x)| x).collect()
}

fn near(label: &str, got: &[f32], want: &[f64], tolerance: f64) {
    assert_eq!(got.len(), want.len(), "{label}: how many");
    let worst = got.iter().zip(want).map(|(g, w)| (f64::from(*g) - w).abs()).fold(0.0, f64::max);
    assert!(worst <= tolerance, "{label}: worst difference {worst}");
}

#[test]
fn the_four_stems_are_the_ones_of_the_web_app_and_they_add_back_to_the_song() {
    let g: File = serde_json::from_str(include_str!("golden/separation.json")).unwrap();
    let o = SeparationOptions { fft_size: g.options.fft_size, hop_size: g.options.hop_size, time_kernel: g.options.time_kernel, freq_kernel: g.options.freq_kernel, mask_exponent: g.options.mask_exponent, vocal_focus: g.options.vocal_focus, segment_seconds: g.options.segment_seconds, overlap_seconds: g.options.overlap_seconds };
    let audio = song(g.rate, 5);
    assert_eq!(audio.frames(), g.frames);
    let mut shares = Vec::new();
    let stems = separate(&audio, &o, &mut |share, _| shares.push(share));
    assert!(shares.windows(2).all(|w| w[0] < w[1]) && *shares.last().unwrap() == 1.0, "{shares:?}");
    for (i, id) in STEM_IDS.iter().enumerate() {
        let want = &g.stems[*id];
        near(&format!("{id} links"), &picked(&stems[i].channels[0], 97), &want.left, 2e-4);
        near(&format!("{id} rechts"), &picked(&stems[i].channels[1], 97), &want.right, 2e-4);
    }
    // The four stems sum to the song, sample for sample (to the precision of the transform).
    for c in 0..2 {
        let worst = (0..audio.frames()).map(|k| (f64::from(audio.channels[c][k]) - stems.iter().map(|s| f64::from(s.channels[c][k])).sum::<f64>()).abs()).fold(0.0, f64::max);
        assert!(worst < 2e-3, "channel {c}: the stems sum to within {worst}");
    }
    // Mono: no image to measure, the band weights lead.
    let mono = AudioData { channels: vec![audio.channels[0].clone()], sample_rate: g.rate };
    let m = separate(&mono, &SeparationOptions { segment_seconds: 4.0, overlap_seconds: 0.5, ..o }, &mut |_, _| {});
    for (i, id) in STEM_IDS.iter().enumerate() {
        near(&format!("{id} mono"), &picked(&m[i].channels[0], 89), &g.mono[*id], 2e-4);
    }
    // The instrumental is the song minus the voice.
    let inst = to_instrumental(&audio, &stems[0]);
    near("Instrumental", &picked(&inst.channels[0], 97), &g.instrumental.left, 2e-4);
    // Silence in, silence out.
    let none = separate(&AudioData { channels: vec![vec![], vec![]], sample_rate: g.rate }, &o, &mut |_, _| {});
    assert!(none.iter().all(|s| s.frames() == 0));
}
