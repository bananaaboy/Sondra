//! The look at the sound: a tone shows up at its own frequency, silence at the floor, the wave around the middle.

use sondra_playback::analyser::{Analyser, BINS, FFT_SIZE};

fn tone(hz: f64, rate: f64, amplitude: f64) -> Vec<f32> {
    (0..FFT_SIZE).map(|i| (amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / rate).sin()) as f32).collect()
}

#[test]
fn a_tone_stands_at_its_own_bin_and_silence_at_the_floor() {
    let mut a = Analyser::new();
    let rate = 48000.0;
    let mut last = a.read(&tone(3000.0, rate, 0.5));
    // The smoothing takes a few readings to arrive, as the browser's does.
    for _ in 0..30 {
        last = a.read(&tone(3000.0, rate, 0.5));
    }
    let peak = last.frequency.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
    let expected = (3000.0 / (rate / FFT_SIZE as f64)).round() as usize;
    assert!(peak.abs_diff(expected) <= 1, "peak at {peak}, expected {expected}");
    assert!(last.frequency[peak] > 150, "a loud tone is high: {}", last.frequency[peak]);
    assert!(last.frequency[BINS - 1] < 20 && last.frequency[10] < 20, "far from it is the floor");
    // The wave swings around 128.
    assert!(last.wave.iter().any(|v| *v > 180) && last.wave.iter().any(|v| *v < 76));

    let mut quiet = Analyser::new();
    let s = quiet.read(&[]);
    assert!(s.frequency.iter().all(|v| *v == 0));
    assert!(s.wave.iter().all(|v| *v == 128));
}

#[test]
fn fewer_frames_than_a_reading_are_put_after_silence() {
    let mut a = Analyser::new();
    let s = a.read(&tone(1000.0, 48000.0, 0.5)[..300]);
    assert_eq!(s.frequency.len(), BINS);
    assert_eq!(s.wave.len(), BINS);
}
