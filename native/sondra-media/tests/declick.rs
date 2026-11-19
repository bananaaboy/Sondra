//! Clicks out, checked against `declick.ts` on a signal with known damage: which samples change, and to what.

use sondra_media::audio::AudioData;
use sondra_media::declick::{remove_clicks, ClickStrength};

fn signal(rate: u32, n: usize) -> AudioData {
    let (mut left, mut right) = (vec![0f32; n], vec![0f32; n]);
    let mut seed: u32 = 11;
    let r = f64::from(rate);
    for i in 0..n {
        seed = (u64::from(seed) * 1_664_525 + 1_013_904_223) as u32;
        let noise = (f64::from(seed) / f64::from(0xffff_ffffu32) - 0.5) * 0.02;
        let t = i as f64;
        left[i] = (0.4 * (2.0 * std::f64::consts::PI * 220.0 * t / r).sin() + 0.15 * (2.0 * std::f64::consts::PI * 1330.0 * t / r).sin() + noise) as f32;
        right[i] = (0.3 * (2.0 * std::f64::consts::PI * 330.0 * t / r).sin() + noise) as f32;
    }
    // The same damage as the table: one, two and four samples, one in the other channel, and a burst that is
    // a drum and stays.
    let spikes: [(bool, usize, &[f64]); 4] = [(true, 2000, &[0.9]), (true, 4000, &[0.8, -0.7]), (true, 6000, &[0.7, -0.6, 0.8, -0.5]), (false, 8000, &[-0.9])];
    for (is_left, at, values) in spikes {
        let channel = if is_left { &mut left } else { &mut right };
        for (k, v) in values.iter().enumerate() {
            channel[at + k] = (f64::from(channel[at + k]) + v) as f32;
        }
    }
    for k in 0..80 {
        let kk = k as f64;
        left[10000 + k] = (f64::from(left[10000 + k]) + 0.6 * (kk * 0.9).sin() * (1.0 - kk / 80.0)) as f32;
    }
    AudioData { channels: vec![left, right], sample_rate: rate }
}

#[test]
fn clicks_are_found_and_filled_as_the_web_app_does() {
    let table: serde_json::Value = serde_json::from_str(include_str!("golden/declick.json")).unwrap();
    let audio = signal(table["rate"].as_u64().unwrap() as u32, table["n"].as_u64().unwrap() as usize);
    for case in table["strengths"].as_array().unwrap() {
        let name = case["strength"].as_str().unwrap();
        let strength = match name {
            "sanft" => ClickStrength::Soft,
            "mittel" => ClickStrength::Medium,
            _ => ClickStrength::Strong,
        };
        let (out, repaired) = remove_clicks(&audio, strength);
        assert_eq!(repaired as u64, case["repaired"].as_u64().unwrap(), "{name}: places repaired");
        for (c, changed) in case["changed"].as_array().unwrap().iter().enumerate() {
            let want: Vec<(usize, f32)> = changed.as_array().unwrap().iter().map(|p| (p[0].as_u64().unwrap() as usize, p[1].as_f64().unwrap() as f32)).collect();
            let got: Vec<(usize, f32)> = out.channels[c].iter().enumerate().filter(|(i, v)| **v != audio.channels[c][*i]).map(|(i, v)| (i, *v)).collect();
            assert_eq!(got.iter().map(|p| p.0).collect::<Vec<_>>(), want.iter().map(|p| p.0).collect::<Vec<_>>(), "{name}, channel {c}: which samples were touched");
            let worst = got.iter().zip(&want).map(|(a, b)| (a.1 - b.1).abs()).fold(0f32, f32::max);
            assert!(worst < 1e-4, "{name}, channel {c}: repaired values differ by up to {worst}");
        }
    }
}

#[test]
fn a_clean_signal_is_left_alone() {
    let mut audio = signal(16000, 12000);
    // Without the damage: take the clean tone of the first thousand samples only.
    for c in &mut audio.channels {
        c.truncate(1500);
    }
    let (out, repaired) = remove_clicks(&audio, ClickStrength::Medium);
    assert_eq!(repaired, 0);
    assert_eq!(out.channels, audio.channels);
}
