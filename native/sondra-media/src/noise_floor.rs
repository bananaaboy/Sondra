//! Where in a recording only the room is heard: the stretch to learn the noise from when nobody picks one
//! (`detectNoiseFloorRegion` in `src/lib/localAi.ts`, step for step).

use crate::audio::AudioData;

/// The stretch of the first channel with the lowest, flattest, most even sound: a window slid over the take, each
/// scored by its level, its crest (peak against level — speech has peaks, hiss has none) and its zero crossings.
/// Returns `(start, end)` in seconds. A take shorter than the window is all of it; silence is skipped.
pub fn detect_noise_floor_region(audio: &AudioData) -> (f64, f64) {
    let Some(ch0) = audio.channels.first().filter(|c| !c.is_empty()) else { return (0.0, 0.2) };
    let rate = f64::from(audio.sample_rate);
    let total = ch0.len();
    let duration = total as f64 / rate;
    let window_sec = (duration * 0.12).clamp(0.15, 0.45);
    let window = ((window_sec * rate).floor() as usize).max(256);
    let hop = (window / 3).max(128);
    if total <= window {
        return (0.0, duration);
    }
    let mut best = f64::INFINITY;
    let mut best_start = 0usize;
    let mut offset = 0usize;
    while offset + window <= total {
        let mut sum_sq = 0.0f64;
        let mut peak = 0.0f64;
        let mut crossings = 0usize;
        let mut prev = f64::from(ch0[offset]);
        for i in 0..window {
            let s = f64::from(ch0[offset + i]);
            let a = s.abs();
            sum_sq += s * s;
            if a > peak {
                peak = a;
            }
            if (s >= 0.0 && prev < 0.0) || (s < 0.0 && prev >= 0.0) {
                crossings += 1;
            }
            prev = s;
        }
        let rms = (sum_sq / window as f64).sqrt();
        // Pure digital zeros are skipped when there is a real room tone elsewhere.
        if rms >= 1e-5 {
            let crest = peak / (rms + 1e-7);
            let zcr = crossings as f64 / window as f64;
            let score = rms * 12.0 + crest * 0.15 - zcr.min(0.35) * 0.1;
            if score < best {
                best = score;
                best_start = offset;
            }
        }
        offset += hop;
    }
    (best_start as f64 / rate, duration.min((best_start + window) as f64 / rate))
}
