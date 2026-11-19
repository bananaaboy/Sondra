//! Tempo estimation and beat gridding. A port of `src/lib/tempo.ts`.
//!
//! The method is autocorrelation of the onset strength envelope: how much the spectrum rises from
//! frame to frame, and which lag makes that signal line up with itself best. A drum loop has a very
//! strong peak at its beat period; the returned confidence says whether the material had one.

use crate::audio::{mix_to_mono, AudioData};
use crate::fft::{magnitude_of, stft};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoEstimate {
    pub bpm: f64,
    /// 0–1. Below roughly 0.3 the estimate is a guess, and the UI should say so.
    pub confidence: f64,
    /// Seconds from the file start to the first beat of the grid.
    pub offset_seconds: f64,
}

const FFT_SIZE: usize = 1024;
const HOP_SIZE: usize = 256;
/// The range of tempos worth considering, in BPM.
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;

struct Envelope {
    envelope: Vec<f32>,
    frame_rate: f64,
    /// Mean spectral change relative to spectral level — how transient the material is.
    activity: f64,
}

fn onset_envelope(audio: &AudioData) -> Envelope {
    let mono = mix_to_mono(audio);
    let spec = stft(&mono, FFT_SIZE, HOP_SIZE).expect("a power of two");
    let magnitude = magnitude_of(&spec);
    let (frames, bins) = (spec.frames, spec.bins);

    let mut envelope = vec![0.0f32; frames];
    let mut flux_total = 0.0f64;
    let mut level_total = 0.0f64;
    for f in 1..frames {
        let (mut sum, mut level) = (0.0f32, 0.0f32);
        for b in 0..bins {
            let now = magnitude[f * bins + b];
            let delta = now - magnitude[(f - 1) * bins + b];
            if delta > 0.0 {
                sum += delta;
            }
            level += now;
        }
        envelope[f] = sum;
        flux_total += f64::from(sum);
        level_total += f64::from(level);
    }
    // A sustained tone barely changes frame to frame; a drum loop changes a lot.
    let activity = if level_total > 0.0 {
        flux_total / level_total
    } else {
        0.0
    };

    // Subtract a local mean so a loud section does not dominate the correlation.
    let window = 16usize;
    let smoothed: Vec<f32> = (0..frames)
        .map(|f| {
            let from = f.saturating_sub(window);
            let to = frames.min(f + window);
            let mut mean = 0.0f64;
            for v in &envelope[from..to] {
                mean += f64::from(*v);
            }
            mean /= (to - from) as f64;
            (f64::from(envelope[f]) - mean).max(0.0) as f32
        })
        .collect();
    Envelope {
        envelope: smoothed,
        frame_rate: f64::from(audio.sample_rate) / HOP_SIZE as f64,
        activity,
    }
}

const GUESS: TempoEstimate = TempoEstimate {
    bpm: 120.0,
    confidence: 0.0,
    offset_seconds: 0.0,
};

/// Estimates tempo and where the grid starts.
pub fn estimate_tempo(audio: &AudioData) -> TempoEstimate {
    let Envelope {
        envelope,
        frame_rate,
        activity,
    } = onset_envelope(audio);
    let frames = envelope.len();
    if frames < 64 {
        return GUESS;
    }
    let min_lag = ((60.0 / MAX_BPM) * frame_rate).floor() as usize;
    let max_lag = (frames - 1).min(((60.0 / MIN_BPM) * frame_rate).ceil() as usize);
    if max_lag <= min_lag {
        return GUESS;
    }
    let energy: f64 = envelope.iter().map(|v| f64::from(*v) * f64::from(*v)).sum();
    if energy <= 0.0 {
        return GUESS;
    }

    let mut best_lag = min_lag;
    let mut best_score = f64::NEG_INFINITY;
    let mut scores = vec![0.0f64; max_lag + 1];
    let correlate = |lag: usize| -> f64 {
        let mut sum = 0.0f64;
        for f in lag..frames {
            sum += f64::from(envelope[f]) * f64::from(envelope[f - lag]);
        }
        sum
    };
    for lag in min_lag..=max_lag {
        // Normalise by overlap length, or long lags would always look weaker.
        let mut score = correlate(lag) / (frames - lag) as f64;
        // A tempo whose double also correlates is more likely the real one.
        let doubled = lag * 2;
        if doubled <= max_lag {
            score += (0.5 * correlate(doubled)) / (frames - doubled).max(1) as f64;
        }
        scores[lag] = score;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }

    // Confidence: how far the winning lag stands above the typical lag.
    let count = (max_lag - min_lag + 1) as f64;
    let mean = scores[min_lag..=max_lag].iter().sum::<f64>() / count.max(1.0);
    let variance: f64 = scores[min_lag..=max_lag]
        .iter()
        .map(|s| (s - mean) * (s - mean))
        .sum();
    let deviation = (variance / count.max(1.0)).sqrt();
    let sharpness = if deviation > 0.0 {
        ((best_score - mean) / (6.0 * deviation)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    // Both have to hold: the correlation peak must stand out *and* the material must have transients.
    let transient = (activity / 0.035).clamp(0.0, 1.0);

    let bpm = 60.0 * frame_rate / best_lag as f64;
    TempoEstimate {
        bpm: (bpm * 10.0).round() / 10.0,
        confidence: sharpness * transient,
        offset_seconds: grid_offset(&envelope, frame_rate, best_lag),
    }
}

/// Which phase of the beat grid lines up with the onsets. Without this the grid starts at sample zero,
/// which is only right when the recording begins exactly on a downbeat.
fn grid_offset(envelope: &[f32], frame_rate: f64, lag: usize) -> f64 {
    let mut best_phase = 0usize;
    let mut best_sum = f64::NEG_INFINITY;
    for phase in 0..lag {
        let mut sum = 0.0f64;
        let mut f = phase;
        while f < envelope.len() {
            sum += f64::from(envelope[f]);
            f += lag;
        }
        if sum > best_sum {
            best_sum = sum;
            best_phase = phase;
        }
    }
    best_phase as f64 / frame_rate
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridOptions {
    pub bpm: f64,
    pub offset_seconds: f64,
    /// 1 = one slice per beat, 0.5 = per eighth, 4 = per bar in 4/4.
    pub beats_per_slice: f64,
    pub duration_seconds: f64,
}

/// Slice boundaries on a tempo grid, in seconds.
pub fn beat_grid(o: GridOptions) -> Vec<f64> {
    let step = (60.0 / o.bpm) * o.beats_per_slice;
    if !step.is_finite() || step <= 0.01 {
        return vec![0.0];
    }
    // Walk backwards from the detected phase so the grid covers the head of the file too.
    let mut start = o.offset_seconds;
    while start - step > 0.0 {
        start -= step;
    }
    let mut points = Vec::new();
    let mut at = start;
    while at < o.duration_seconds - 0.01 {
        points.push(at.max(0.0));
        at += step;
    }
    if points.is_empty() {
        vec![0.0]
    } else {
        points
    }
}

/// Nudges a cut to the nearest rising zero crossing, at most `window_ms` away: cutting mid-waveform
/// leaves a step, and a step is a click.
pub fn snap_to_zero_crossing(audio: &AudioData, seconds: f64, window_ms: f64) -> f64 {
    let frames = audio.frames();
    if frames == 0 {
        return seconds;
    }
    let rate = f64::from(audio.sample_rate);
    let target = (seconds * rate + 0.5).floor() as isize;
    let radius = ((window_ms / 1000.0) * rate + 0.5).floor() as isize;
    let channel = &audio.channels[0];

    let mut best = target;
    let mut best_distance = isize::MAX;
    let from = (target - radius).max(1);
    let to = (frames as isize - 1).min(target + radius);
    let mut i = from;
    while i <= to {
        // A rising crossing keeps consecutive slices in phase with each other.
        let crosses = channel[(i - 1) as usize] <= 0.0 && channel[i as usize] > 0.0;
        if crosses {
            let distance = (i - target).abs();
            if distance < best_distance {
                best_distance = distance;
                best = i;
            }
        }
        i += 1;
    }
    best as f64 / rate
}
