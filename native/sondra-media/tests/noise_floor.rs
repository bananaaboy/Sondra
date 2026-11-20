//! The stretch the noise is learned from, against what the website's `detectNoiseFloorRegion` answers for the same
//! takes (three, made by the generator below, run through `localAi.ts` under Node).

use sondra_media::audio::AudioData;
use sondra_media::noise_floor::detect_noise_floor_region;

const RATE: u32 = 8000;

fn make(n: usize, mut f: impl FnMut(usize) -> f64) -> AudioData {
    AudioData { channels: vec![(0..n).map(|i| f(i) as f32).collect()], sample_rate: RATE }
}

fn close(got: (f64, f64), want: (f64, f64)) {
    assert!((got.0 - want.0).abs() < 1e-9 && (got.1 - want.1).abs() < 1e-9, "{got:?} is not {want:?}");
}

#[test]
fn it_finds_what_the_website_finds() {
    let sr = f64::from(RATE);
    // Loud tone with a quiet hiss from 1.0 s to 1.6 s.
    let mut seed: u64 = 1;
    let mut rnd = move || {
        seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        seed as f64 / 4_294_967_296.0 - 0.5
    };
    let hiss = make(RATE as usize * 3, |i| {
        let t = i as f64 / sr;
        if (1.0..1.6).contains(&t) {
            0.01 * rnd()
        } else {
            0.5 * (i as f64 * 0.2).sin() * (1.0 + 0.5 * (i as f64 * 0.001).sin())
        }
    });
    close(detect_noise_floor_region(&hiss), (1.2, 1.56));
    // Shorter than the window: all of it.
    close(detect_noise_floor_region(&make(RATE as usize / 10, |i| 0.1 * (i as f64 * 0.1).sin())), (0.0, 0.1));
    // A quiet start and a loud second half.
    close(detect_noise_floor_region(&make(RATE as usize * 2, |i| 0.02 * (i as f64 * 0.3).sin() + if i > RATE as usize { 0.3 * (i as f64 * 0.05).sin() } else { 0.0 })), (0.24, 0.48));
}

#[test]
fn nothing_there_is_a_short_stretch_at_the_start() {
    close(detect_noise_floor_region(&AudioData { channels: vec![], sample_rate: RATE }), (0.0, 0.2));
    close(detect_noise_floor_region(&AudioData { channels: vec![vec![]], sample_rate: RATE }), (0.0, 0.2));
}
