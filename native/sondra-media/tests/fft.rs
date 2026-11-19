//! The FFT and the short-time transform: identities, and the web app's own numbers.

use serde::Deserialize;
use sondra_media::fft::*;

const GOLDEN: &str = include_str!("golden/fft.json");
const RATE: u32 = 48000;

/// The noise with a slow swell of the web app's golden script, from an integer generator.
fn swell(seconds: u32) -> Vec<f32> {
    let mut state: u32 = 12345;
    (0..RATE * seconds)
        .map(|i| {
            state = state.wrapping_mul(1103515245).wrapping_add(12345);
            let white = f64::from(state >> 8) / 16777216.0 * 2.0 - 1.0;
            (0.3 * (0.35
                + 0.65
                    * (2.0 * std::f64::consts::PI * f64::from(i) / (f64::from(RATE) * 4.0))
                        .sin()
                        .abs())
                * white) as f32
        })
        .collect()
}

#[test]
fn the_size_must_be_a_power_of_two() {
    assert!(Fft::new(1000).is_err());
    assert!(Fft::new(1).is_err());
    assert!(Fft::new(1024).is_ok());
    assert!(stft(&[0.0; 10], 1000, 250).is_err());
}

#[test]
fn a_sine_lands_in_its_bin_and_the_inverse_gives_the_input_back() {
    let n = 1024;
    let fft = Fft::new(n).unwrap();
    let mut re: Vec<f64> = (0..n)
        .map(|i| (2.0 * std::f64::consts::PI * 32.0 * i as f64 / n as f64).sin())
        .collect();
    let mut im = vec![0.0; n];
    let original = re.clone();
    fft.forward(&mut re, &mut im);
    let mags: Vec<f64> = re.iter().zip(&im).map(|(r, i)| r.hypot(*i)).collect();
    let loudest = (0..n / 2)
        .max_by(|a, b| mags[*a].total_cmp(&mags[*b]))
        .unwrap();
    assert_eq!(loudest, 32);
    assert!((mags[32] - n as f64 / 2.0).abs() < 1e-6, "{}", mags[32]);
    fft.inverse(&mut re, &mut im);
    for (a, b) in re.iter().zip(&original) {
        assert!((a - b).abs() < 1e-9);
    }
}

#[test]
fn the_windows_are_what_overlap_add_needs() {
    let h = hann_window(8);
    assert!(
        (h[0] - 0.0).abs() < 1e-12 && (h[4] - 1.0).abs() < 1e-12,
        "periodic: zero at 0, one in the middle"
    );
    let s = sqrt_hann_window(8);
    assert!((s[2] * s[2] - h[2]).abs() < 1e-12);
}

#[test]
fn stft_and_back_is_the_signal() {
    let signal = swell(2);
    let spec = stft(&signal, 2048, 512).unwrap();
    assert_eq!(spec.bins, 1025);
    let back = istft(&spec).unwrap();
    assert_eq!(back.len(), signal.len());
    let worst = signal
        .iter()
        .zip(&back)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(worst < 1e-5, "{worst}");
    // A mask that keeps everything changes nothing; one that keeps nothing silences.
    let all = apply_mask(&spec, &vec![1.0; spec.real.len()]);
    assert_eq!(all, spec);
    let none = istft(&apply_mask(&spec, &vec![0.0; spec.real.len()])).unwrap();
    assert!(none.iter().all(|s| s.abs() < 1e-9));
}

#[test]
fn a_signal_shorter_than_a_frame_still_has_a_frame() {
    let spec = stft(&[0.1, 0.2, 0.3], 1024, 256).unwrap();
    assert!(spec.frames >= 1);
    let back = istft(&spec).unwrap();
    assert_eq!(back.len(), 3);
    let empty = stft(&[], 1024, 256).unwrap();
    assert_eq!((empty.frames, empty.length), (1, 0));
}

#[derive(Deserialize)]
struct Pick {
    frame: usize,
    bin: usize,
    re: f64,
    im: f64,
    mag: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    frames: usize,
    bins: usize,
    padding: usize,
    length: usize,
    samples: Vec<Pick>,
    back_first: Vec<f32>,
    back_last: Vec<f32>,
}

#[test]
fn the_spectrum_is_the_web_apps_spectrum() {
    let g: Golden = serde_json::from_str(GOLDEN).unwrap();
    let signal = swell(3);
    let spec = stft(&signal, 2048, 512).unwrap();
    assert_eq!(
        (spec.frames, spec.bins, spec.padding, spec.length),
        (g.frames, g.bins, g.padding, g.length)
    );
    let mag = magnitude_of(&spec);
    for p in &g.samples {
        let at = p.frame * spec.bins + p.bin;
        let scale = p.mag.max(1.0);
        assert!(
            (f64::from(spec.real[at]) - p.re).abs() < 1e-4 * scale,
            "re at {}/{}",
            p.frame,
            p.bin
        );
        assert!(
            (f64::from(spec.imag[at]) - p.im).abs() < 1e-4 * scale,
            "im at {}/{}",
            p.frame,
            p.bin
        );
        assert!(
            (f64::from(mag[at]) - p.mag).abs() < 1e-4 * scale,
            "mag at {}/{}",
            p.frame,
            p.bin
        );
    }
    let back = istft(&spec).unwrap();
    for (a, b) in back
        .iter()
        .take(8)
        .zip(&g.back_first)
        .chain(back.iter().rev().take(8).rev().zip(&g.back_last))
    {
        assert!((a - b).abs() < 1e-5, "{a} vs {b}");
    }
}
