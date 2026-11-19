//! Time stretching and pitch shifting, checked against `timestretch.ts` on a tone and on a mixture with
//! noise: the lengths exactly, the samples within what a different `sin` in the last place can make of a
//! chain of phases.

use sondra_media::audio::AudioData;
use sondra_media::timestretch::{pitch_shift, resample_by_ratio, stretch_audio, time_stretch};

struct Signals {
    tone: Vec<f32>,
    mixed: Vec<f32>,
}

fn signals(rate: u32, n: usize) -> Signals {
    let (mut tone, mut mixed) = (Vec::new(), Vec::new());
    let mut seed: u32 = 7;
    let rate = f64::from(rate);
    for i in 0..n {
        seed = (u64::from(seed) * 1_664_525 + 1_013_904_223) as u32;
        let noise = (f64::from(seed) / f64::from(0xffff_ffffu32) - 0.5) * 0.1;
        let t = i as f64;
        tone.push((0.5 * (2.0 * std::f64::consts::PI * 440.0 * t / rate).sin()) as f32);
        let wave = 0.3 * (2.0 * std::f64::consts::PI * 330.0 * t / rate).sin() + 0.2 * (2.0 * std::f64::consts::PI * 1250.0 * t / rate).sin() * if i % 2000 < 1000 { 1.0 } else { 0.3 } + noise;
        mixed.push(wave as f32);
    }
    Signals { tone, mixed }
}

fn every(samples: &[f32], k: usize) -> Vec<f32> {
    samples.iter().enumerate().filter(|(i, _)| i % k == 0).map(|(_, v)| *v).collect()
}

fn floats(v: &serde_json::Value) -> Vec<f32> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect()
}

fn close(got: &[f32], want: &[f32], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: count");
    let worst = got.iter().zip(want).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
    assert!(worst < 2e-3, "{what}: the samples differ by up to {worst}");
}

#[test]
fn stretching_and_shifting_are_the_web_apps() {
    let table: serde_json::Value = serde_json::from_str(include_str!("golden/timestretch.json")).unwrap();
    let rate = table["rate"].as_u64().unwrap() as u32;
    let s = signals(rate, table["n"].as_u64().unwrap() as usize);

    for case in table["stretches"].as_array().unwrap() {
        let factor = case["factor"].as_f64().unwrap();
        let out = time_stretch(&s.mixed, factor, 1024, 256);
        assert_eq!(out.len() as u64, case["stretched"]["length"].as_u64().unwrap(), "length at {factor}");
        close(&every(&out, 53), &floats(&case["stretched"]["sample"]), &format!("stretch {factor}"));
    }

    let audio = AudioData { channels: vec![s.tone.clone(), s.mixed.clone()], sample_rate: rate };
    for case in table["shifts"].as_array().unwrap() {
        let (semitones, preserve) = (case["semitones"].as_f64().unwrap(), case["preserve"].as_bool().unwrap());
        let out = pitch_shift(&audio, semitones, preserve, 1024);
        let name = format!("{semitones} semitones, preserve {preserve}");
        assert_eq!(out.channels[0].len() as u64, case["length"].as_u64().unwrap(), "{name}: length");
        close(&every(&out.channels[0], 47), &floats(&case["left"]), &format!("{name}, left"));
        close(&every(&out.channels[1], 47), &floats(&case["right"]), &format!("{name}, right"));
    }

    let half = stretch_audio(&audio, 2.0, 1024);
    assert_eq!(half.channels[0].len() as u64, table["half"]["length"].as_u64().unwrap());
    close(&every(&half.channels[0], 61), &floats(&table["half"]["left"]), "half speed");

    for case in table["resampled"].as_array().unwrap() {
        let ratio = case["ratio"].as_f64().unwrap();
        let out = resample_by_ratio(&s.mixed, ratio);
        assert_eq!(out.len() as u64, case["length"].as_u64().unwrap(), "length at ratio {ratio}");
        close(&every(&out, 31), &floats(&case["sample"]), &format!("resample {ratio}"));
    }
    // Nothing to do is nothing done.
    assert_eq!(pitch_shift(&audio, 0.0, true, 1024), audio);
    assert_eq!(stretch_audio(&audio, 1.0, 1024), audio);
}
