//! The quiet two-tone chime that says a download is done. A port of `playCompletionChime` in
//! `src/lib/backgroundDownload.ts`: two soft sine tones, E5 (659.25 Hz) and 0.12 s later A5 (880 Hz), each
//! rising to 0.12 in 20 ms and falling exponentially to 0.0001 at 0.45 s after its start, cut at 0.48 s.

const NOTES: [f64; 2] = [659.25, 880.0];
const STEP: f64 = 0.12;
const PEAK: f64 = 0.12;
const RISE: f64 = 0.02;
const FALL_END: f64 = 0.45;
const CUT: f64 = 0.48;
const FLOOR: f64 = 0.0001;

/// The chime as mono samples at `rate`.
pub fn chime_samples(rate: u32) -> Vec<f32> {
    let rate = f64::from(rate);
    let total = ((STEP + CUT) * rate).ceil() as usize;
    let mut out = vec![0.0f32; total];
    for (n, freq) in NOTES.iter().enumerate() {
        let start = n as f64 * STEP;
        for (i, sample) in out.iter_mut().enumerate() {
            let t = i as f64 / rate - start;
            if !(0.0..CUT).contains(&t) {
                continue;
            }
            let gain = if t < RISE { PEAK * t / RISE } else { PEAK * (FLOOR / PEAK).powf(((t - RISE) / (FALL_END - RISE)).min(1.0)) };
            *sample += (gain * (2.0 * std::f64::consts::PI * freq * t).sin()) as f32;
        }
    }
    out
}
