//! Onset detection by spectral flux. A port of `src/lib/onsets.ts`.
//!
//! Flux — the sum of positive frame-to-frame change across the spectrum — spikes exactly where a new
//! sound starts, which is what a sampler wants to cut on.

use crate::audio::{mix_to_mono, AudioData};
use crate::fft::{magnitude_of, stft};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OnsetOptions {
    /// Higher keeps only the clearest hits.
    pub sensitivity: f64,
    /// Shortest gap between two slices, in seconds.
    pub minimum_gap_seconds: f64,
    pub fft_size: usize,
    pub hop_size: usize,
}

impl Default for OnsetOptions {
    fn default() -> Self {
        Self {
            sensitivity: 1.4,
            minimum_gap_seconds: 0.08,
            fft_size: 1024,
            hop_size: 256,
        }
    }
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The summed positive change across the spectrum, per frame.
fn flux_of(mono: &[f32], fft_size: usize, hop_size: usize) -> Vec<f32> {
    let spec = stft(mono, fft_size, hop_size).expect("a power of two");
    let magnitude = magnitude_of(&spec);
    let (frames, bins) = (spec.frames, spec.bins);
    let mut flux = vec![0.0f32; frames];
    for f in 1..frames {
        let mut sum = 0.0f32;
        for b in 0..bins {
            // Only rising energy counts — a decay is not a new event.
            let delta = magnitude[f * bins + b] - magnitude[(f - 1) * bins + b];
            if delta > 0.0 {
                sum += delta;
            }
        }
        flux[f] = sum;
    }
    flux
}

/// The local mean of the flux around frame `f` (an adaptive threshold tracks the local level).
fn local_mean(flux: &[f32], f: usize, window: usize) -> f64 {
    let from = f.saturating_sub(window);
    let to = flux.len().min(f + window);
    let mut mean = 0.0f64;
    for v in &flux[from..to] {
        mean += f64::from(*v);
    }
    mean / (to - from) as f64
}

fn is_peak(flux: &[f32], f: usize) -> bool {
    flux[f] > flux[f - 1] && (f + 1 >= flux.len() || flux[f] >= flux[f + 1])
}

/// Onset positions in seconds, always including the start of the file.
pub fn detect_onsets(audio: &AudioData, options: &OnsetOptions) -> Vec<f64> {
    let mono = mix_to_mono(audio);
    if mono.len() < options.fft_size * 2 {
        return vec![0.0];
    }
    let flux = flux_of(&mono, options.fft_size, options.hop_size);
    let frames = flux.len();

    let seconds_per_frame = options.hop_size as f64 / f64::from(audio.sample_rate);
    let minimum_gap = (js_round(options.minimum_gap_seconds / seconds_per_frame) as isize).max(1);
    let mut last = -minimum_gap;
    let mut onsets = Vec::new();

    for f in 1..frames {
        let mean = local_mean(&flux, f, 24);
        if is_peak(&flux, f)
            && f64::from(flux[f]) > mean * options.sensitivity
            && f as isize - last >= minimum_gap
        {
            onsets.push(f as f64 * seconds_per_frame);
            last = f as isize;
        }
    }
    if onsets.is_empty() || onsets[0] > 0.02 {
        onsets.insert(0, 0.0);
    }
    onsets
}

/// Even division, for material that is already on a grid.
pub fn divide_evenly(duration_seconds: f64, count: usize) -> Vec<f64> {
    (0..count)
        .map(|i| duration_seconds * i as f64 / count as f64)
        .collect()
}

/// The most prominent onsets, at most `pad_count` of them, in order — for a 16-pad mapping.
pub fn detect_auto_chop(audio: &AudioData, sensitivity: f64, pad_count: usize) -> Vec<f64> {
    let mono = mix_to_mono(audio);
    if mono.len() < 1024 * 2 {
        return vec![0.0];
    }
    let flux = flux_of(&mono, 1024, 256);
    let frames = flux.len();
    let seconds_per_frame = 256.0 / f64::from(audio.sample_rate);
    let minimum_gap = (js_round(0.06 / seconds_per_frame) as isize).max(1);

    let mut candidates: Vec<(f64, f64)> = Vec::new(); // (time, score)
    let mut last = -minimum_gap;
    for f in 1..frames {
        let mean = local_mean(&flux, f, 24);
        let ratio = if mean > 0.0 {
            f64::from(flux[f]) / mean
        } else {
            0.0
        };
        if is_peak(&flux, f) && ratio > sensitivity && f as isize - last >= minimum_gap {
            candidates.push((f as f64 * seconds_per_frame, ratio * f64::from(flux[f])));
            last = f as isize;
        }
    }
    // Best first; equal scores keep their order (the sort is stable, as in the web app).
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut chosen: Vec<f64> = candidates
        .iter()
        .take(pad_count.saturating_sub(1))
        .map(|c| c.0)
        .collect();
    chosen.push(0.0);
    chosen.sort_by(|a, b| a.total_cmp(b));

    let mut result: Vec<f64> = Vec::new();
    for t in chosen {
        if result.last().is_none_or(|last| t - last >= 0.05) {
            result.push(t);
        }
    }
    result.truncate(pad_count);
    result
}
