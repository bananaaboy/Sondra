//! Stem separation that needs no model and no network. A port of `src/lib/separation.ts`: harmonic and
//! percussive separation by median filtering the magnitude spectrogram (Fitzgerald 2010), a centre-channel
//! estimate for the lead vocal, and band weights for vocal and bass; the four affinities are normalised
//! per bin, so the stems add back to the original, and the work is chunked so that memory depends on the
//! chunk and not on the length of the recording.

use crate::audio::AudioData;
use crate::fft::{apply_mask, istft, magnitude_of, stft, Spectrogram};

pub const STEM_IDS: [&str; 4] = ["vocals", "drums", "bass", "other"];

pub fn stem_label(id: &str) -> &'static str {
    match id {
        "vocals" => "Gesang",
        "drums" => "Schlagzeug",
        "bass" => "Bass",
        _ => "Übriges",
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeparationOptions {
    pub fft_size: usize,
    pub hop_size: usize,
    /// Median filter length along time, in frames. Longer = smoother harmonics.
    pub time_kernel: usize,
    /// Median filter length along frequency, in bins.
    pub freq_kernel: usize,
    /// Mask sharpness. 1 is soft, 2 is Wiener-like, higher approaches binary.
    pub mask_exponent: f64,
    /// 0 keeps a wide vocal image, 1 only keeps the dead-centre signal.
    pub vocal_focus: f64,
    /// Chunk length, which bounds peak memory regardless of file length.
    pub segment_seconds: f64,
    /// Crossfade between chunks.
    pub overlap_seconds: f64,
}

pub const DEFAULT_SEPARATION: SeparationOptions = SeparationOptions { fft_size: 4096, hop_size: 1024, time_kernel: 17, freq_kernel: 17, mask_exponent: 2.8, vocal_focus: 0.65, segment_seconds: 24.0, overlap_seconds: 1.0 };

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/* -- Sliding median ----------------------------------------------------------------------------- */

/// Removes one occurrence of `value` from a sorted window of length `k`.
fn sorted_remove(window: &mut [f32], k: usize, value: f32) {
    let (mut lo, mut hi) = (0i64, k as i64 - 1);
    let mut index: i64 = -1;
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        let m = window[mid as usize];
        if m == value {
            index = mid;
            break;
        }
        if m < value {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if index < 0 {
        index = lo.min(k as i64 - 1);
    }
    let index = index as usize;
    window.copy_within(index + 1..k, index);
}

/// Inserts `value` into a sorted window that currently holds `k - 1` entries.
fn sorted_insert(window: &mut [f32], k: usize, value: f32) {
    let (mut lo, mut hi) = (0usize, k - 1);
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if window[mid] < value {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    window.copy_within(lo..k - 1, lo + 1);
    window[lo] = value;
}

/// Median filter along one strided axis, with edge replication; the window stays sorted between steps, so
/// each output costs one removal and one insertion instead of a fresh sort.
fn median_filter_axis(source: &[f32], target: &mut [f32], base: usize, stride: usize, count: usize, k: usize, window: &mut [f32]) {
    let half = k >> 1;
    let at = |i: i64| source[base + (i.clamp(0, count as i64 - 1) as usize) * stride];
    for (i, w) in window.iter_mut().enumerate().take(k) {
        *w = at(i as i64 - half as i64);
    }
    window[..k].sort_by(|a, b| a.total_cmp(b));
    for i in 0..count {
        target[base + i * stride] = window[half];
        if i == count - 1 {
            break;
        }
        sorted_remove(window, k, at(i as i64 - half as i64));
        sorted_insert(window, k, at(i as i64 + half as i64 + 1));
    }
}

/// Harmonic estimate: median across time, per frequency bin.
fn median_over_time(mag: &[f32], frames: usize, bins: usize, k: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; mag.len()];
    let mut window = vec![0.0f32; k];
    for b in 0..bins {
        median_filter_axis(mag, &mut out, b, bins, frames, k, &mut window);
    }
    out
}

/// Percussive estimate: median across frequency, per frame.
fn median_over_frequency(mag: &[f32], frames: usize, bins: usize, k: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; mag.len()];
    let mut window = vec![0.0f32; k];
    for f in 0..frames {
        median_filter_axis(mag, &mut out, f * bins, 1, bins, k, &mut window);
    }
    out
}

/* -- Band weights ------------------------------------------------------------------------------- */

/// Raised-cosine ramp from 0 at `from` to 1 at `to`.
fn ramp(value: f64, from: f64, to: f64) -> f64 {
    if value <= from {
        0.0
    } else if value >= to {
        1.0
    } else {
        0.5 - 0.5 * (std::f64::consts::PI * (value - from) / (to - from)).cos()
    }
}

fn band_weights(bins: usize, fft_size: usize, rate: f64) -> (Vec<f32>, Vec<f32>) {
    let (mut vocal, mut bass) = (vec![0.0f32; bins], vec![0.0f32; bins]);
    for b in 0..bins {
        let hz = (b as f64 * rate) / fft_size as f64;
        // Lead vocals: nothing below the male fundamental, full through the formant range, tapering across
        // sibilance rather than cutting it off.
        vocal[b] = (ramp(hz, 70.0, 200.0) * (1.0 - 0.75 * ramp(hz, 7000.0, 16000.0))) as f32;
        // Bass: the region where bass guitar and kick fundamentals live.
        bass[b] = (1.0 - ramp(hz, 110.0, 380.0)) as f32;
    }
    (vocal, bass)
}

/* -- Masks -------------------------------------------------------------------------------------- */

/// One normalised mask per stem for a single chunk, shared across channels so each stem keeps its stereo
/// image. In the order of [`STEM_IDS`].
fn build_masks(specs: &[Spectrogram], rate: f64, o: &SeparationOptions) -> [Vec<f32>; 4] {
    let (frames, bins, fft_size) = (specs[0].frames, specs[0].bins, specs[0].fft_size);
    let cells = frames * bins;
    let magnitudes: Vec<Vec<f32>> = specs.iter().map(magnitude_of).collect();
    // Analysis runs on the channel sum, so every stem sees the same decomposition.
    let mut summed = vec![0.0f32; cells];
    for mag in &magnitudes {
        for i in 0..cells {
            summed[i] = (f64::from(summed[i]) + f64::from(mag[i])) as f32;
        }
    }
    let harmonic = median_over_time(&summed, frames, bins, o.time_kernel | 1);
    let percussive = median_over_frequency(&summed, frames, bins, o.freq_kernel | 1);
    let (vocal, bass) = band_weights(bins, fft_size, rate);
    let stereo = specs.len() >= 2;
    let (exponent, focus, epsilon) = (o.mask_exponent, o.vocal_focus, 1e-10f64);
    let mut masks = [vec![0.0f32; cells], vec![0.0f32; cells], vec![0.0f32; cells], vec![0.0f32; cells]];
    let left = &specs[0];
    let right = if stereo { &specs[1] } else { &specs[0] };
    for f in 0..frames {
        let row = f * bins;
        for b in 0..bins {
            let i = row + b;
            let h = f64::from(harmonic[i]).powf(exponent);
            let p = f64::from(percussive[i]).powf(exponent);
            let hp = h + p + epsilon;
            let (harmonic_share, percussive_share) = (h / hp, p / hp);
            // How close to the centre of the image this bin sits. Mono material has no image to measure, so
            // it stays neutral and the band weights lead.
            let mut centred = 0.5f64;
            if stereo {
                let dr = f64::from(left.real[i]) - f64::from(right.real[i]);
                let di = f64::from(left.imag[i]) - f64::from(right.imag[i]);
                let difference = dr.hypot(di);
                let total = f64::from(left.real[i]).hypot(f64::from(left.imag[i])) + f64::from(right.real[i]).hypot(f64::from(right.imag[i]));
                centred = if total > epsilon { 1.0 - difference / total } else { 0.5 };
                // `focus` sharpens the centre estimate towards a hard gate.
                centred = ((centred - focus * 0.5) / (1.0 - focus * 0.5 + epsilon)).clamp(0.0, 1.0);
            }
            let (vocal_band, bass_band) = (f64::from(vocal[b]), f64::from(bass[b]));
            let non_bass = 1.0 - bass_band;
            // Non-linear contrast enhancement for stereo centre purity.
            let centre_purity = centred.powf(1.8 + focus * 1.4);
            let h_score = harmonic_share.powf(1.2);
            let p_score = percussive_share.powf(1.2);
            let vocal_score = h_score * centre_purity * vocal_band * non_bass;
            // Bass carries the pluck as well as the note, so it draws on both layers.
            let bass_score = (0.85 * h_score + 0.15 * p_score) * bass_band;
            let drum_score = p_score * (1.0 - 0.65 * bass_band);
            let other_score = h_score * (1.0 - centre_purity * vocal_band) * non_bass;
            let total = vocal_score + bass_score + drum_score + other_score + epsilon;
            let v = (vocal_score / total).powf(1.15);
            let bs = (bass_score / total).powf(1.15);
            let d = (drum_score / total).powf(1.15);
            let ot = (other_score / total).powf(1.15);
            let sum = v + bs + d + ot + epsilon;
            masks[0][i] = (v / sum) as f32;
            masks[2][i] = (bs / sum) as f32;
            masks[1][i] = (d / sum) as f32;
            masks[3][i] = (ot / sum) as f32;
        }
    }
    masks
}

/// Separates `audio` into the four stems of [`STEM_IDS`]. Chunks are linearly crossfaded, which reconstructs
/// exactly because the two sides of an overlap carry the same signal. `progress` hears the share done.
pub fn separate(audio: &AudioData, o: &SeparationOptions, progress: &mut dyn FnMut(f64, &str)) -> [AudioData; 4] {
    let rate = audio.sample_rate;
    let frames = audio.frames();
    let channel_count = audio.channels.len();
    let mut result: [AudioData; 4] = std::array::from_fn(|_| AudioData { channels: vec![vec![0.0f32; frames]; channel_count], sample_rate: rate });
    if frames == 0 {
        return result;
    }
    let overlap = o.fft_size.max(js_round(o.overlap_seconds * f64::from(rate)) as usize);
    let segment = (overlap * 3).max(js_round(o.segment_seconds * f64::from(rate)) as usize);
    let step = segment - overlap;
    let segment_count = (((frames as f64 - overlap as f64) / step as f64).ceil().max(1.0)) as usize;
    for s in 0..segment_count {
        let start = s * step;
        let end = frames.min(start + segment);
        if end <= start {
            break;
        }
        let length = end - start;
        let specs: Vec<Spectrogram> = audio.channels.iter().map(|c| stft(&c[start..end], o.fft_size, o.hop_size).expect("a power of two")).collect();
        let masks = build_masks(&specs, f64::from(rate), o);
        for (id, mask) in masks.iter().enumerate() {
            for c in 0..channel_count {
                let rendered = istft(&apply_mask(&specs[c], mask)).expect("a power of two");
                let target = &mut result[id].channels[c];
                for i in 0..length {
                    // Fade the head of every chunk but the first, and the tail of every chunk but the last, so
                    // the crossfades sum to unity.
                    let mut weight = 1.0f64;
                    if s > 0 && i < overlap {
                        weight = i as f64 / overlap as f64;
                    }
                    if s < segment_count - 1 && i + overlap >= length && end < frames {
                        weight = weight.min((length - i) as f64 / overlap as f64);
                    }
                    target[start + i] = (f64::from(target[start + i]) + f64::from(rendered[i]) * weight) as f32;
                }
            }
        }
        progress((s + 1) as f64 / segment_count as f64, &format!("Segment {} von {}", s + 1, segment_count));
    }
    result
}

/// Karaoke-style split. Derived by subtraction rather than by a second mask pass, so vocals and
/// instrumental add back to exactly the input.
pub fn to_instrumental(original: &AudioData, vocals: &AudioData) -> AudioData {
    let channels = original
        .channels
        .iter()
        .enumerate()
        .map(|(c, channel)| channel.iter().enumerate().map(|(i, v)| (f64::from(*v) - f64::from(vocals.channels.get(c).and_then(|x| x.get(i)).copied().unwrap_or(0.0))) as f32).collect())
        .collect();
    AudioData { channels, sample_rate: original.sample_rate }
}
