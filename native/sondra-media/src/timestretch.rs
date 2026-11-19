//! Phase-vocoder time stretching and pitch shifting (`src/lib/timestretch.ts`). Playback rate alone couples
//! pitch to length; stretching in the STFT domain and resampling by the inverse ratio decouples the two.

use crate::audio::AudioData;
use crate::fft::{sqrt_hann_window, Fft};

const TWO_PI: f64 = std::f64::consts::PI * 2.0;

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Wraps a phase difference into (−π, π].
fn wrap_phase(phase: f64) -> f64 {
    phase - TWO_PI * js_round(phase / TWO_PI)
}

/// Stretches a channel by `factor` (2 = twice as long) leaving the pitch alone. Phases are carried from frame to
/// frame by the instantaneous frequency, so steady tones stay coherent.
pub fn time_stretch(input: &[f32], factor: f64, fft_size: usize, analysis_hop: usize) -> Vec<f32> {
    if (factor - 1.0).abs() < 1e-6 || input.is_empty() {
        return input.to_vec();
    }
    let synthesis_hop = (js_round(analysis_hop as f64 * factor) as usize).max(1);
    let fft = Fft::new(fft_size).expect("a power of two");
    let window = sqrt_hann_window(fft_size);
    let bins = fft_size / 2 + 1;

    let frames = (((input.len() as isize - fft_size as isize) as f64 / analysis_hop as f64).floor() as isize + 1).max(1) as usize;
    let output_length = js_round(input.len() as f64 * factor) as usize + fft_size;
    let mut output = vec![0.0f64; output_length];
    let mut weight = vec![0.0f64; output_length];

    let mut last_phase = vec![0.0f64; bins];
    let mut sum_phase = vec![0.0f64; bins];
    let mut re = vec![0.0f64; fft_size];
    let mut im = vec![0.0f64; fft_size];
    let mut magnitude = vec![0.0f64; bins];
    let expected: Vec<f64> = (0..bins).map(|b| (TWO_PI * analysis_hop as f64 * b as f64) / fft_size as f64).collect();

    for f in 0..frames {
        let start = f * analysis_hop;
        im.fill(0.0);
        for i in 0..fft_size {
            let at = start + i;
            re[i] = if at < input.len() { f64::from(input[at]) } else { 0.0 } * window[i];
        }
        fft.forward(&mut re, &mut im);

        for b in 0..bins {
            let phase = im[b].atan2(re[b]);
            magnitude[b] = re[b].hypot(im[b]);
            // Deviation from the expected advance gives the true frequency.
            let deviation = wrap_phase(phase - last_phase[b] - expected[b]);
            last_phase[b] = phase;
            let true_frequency = (expected[b] + deviation) / analysis_hop as f64;
            sum_phase[b] = wrap_phase(sum_phase[b] + true_frequency * synthesis_hop as f64);
        }

        for b in 0..bins {
            re[b] = magnitude[b] * sum_phase[b].cos();
            im[b] = magnitude[b] * sum_phase[b].sin();
        }
        for b in bins..fft_size {
            re[b] = re[fft_size - b];
            im[b] = -im[fft_size - b];
        }
        fft.inverse(&mut re, &mut im);

        let out = f * synthesis_hop;
        for i in 0..fft_size {
            let at = out + i;
            if at >= output_length {
                break;
            }
            output[at] += re[i] * window[i];
            weight[at] += window[i] * window[i];
        }
    }

    let target = (js_round(input.len() as f64 * factor) as usize).max(1);
    (0..target).map(|i| if weight[i] > 1e-8 { (output[i] / weight[i]) as f32 } else { 0.0 }).collect()
}

/// Catmull-Rom resampler: `ratio` above 1 gives a shorter, higher result (the classic varispeed).
pub fn resample_by_ratio(input: &[f32], ratio: f64) -> Vec<f32> {
    if (ratio - 1.0).abs() < 1e-9 || input.is_empty() {
        return input.to_vec();
    }
    let length = ((input.len() as f64 / ratio).floor() as usize).max(1);
    let last = input.len() as isize - 1;
    let sample = |i: isize| f64::from(input[i.clamp(0, last) as usize]);
    (0..length)
        .map(|i| {
            let position = i as f64 * ratio;
            let index = position.floor();
            let t = position - index;
            let index = index as isize;
            let (p0, p1, p2, p3) = (sample(index - 1), sample(index), sample(index + 1), sample(index + 2));
            (0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)) as f32
        })
        .collect()
}

/// Transposes audio, with or without holding its length.
pub fn pitch_shift(audio: &AudioData, semitones: f64, preserve_duration: bool, fft_size: usize) -> AudioData {
    if semitones.abs() < 1e-6 {
        return audio.clone();
    }
    let ratio = 2f64.powf(semitones / 12.0);
    let channels = audio
        .channels
        .iter()
        .map(|channel| {
            if !preserve_duration {
                return resample_by_ratio(channel, ratio);
            }
            // Stretched by the pitch ratio, then played faster by the same ratio: the two changes of length cancel.
            let stretched = time_stretch(channel, ratio, fft_size, fft_size / 4);
            resample_by_ratio(&stretched, ratio)
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

/// Changes the duration without moving the pitch; `factor` 2 is half the speed.
pub fn stretch_audio(audio: &AudioData, factor: f64, fft_size: usize) -> AudioData {
    if (factor - 1.0).abs() < 1e-6 {
        return audio.clone();
    }
    AudioData { channels: audio.channels.iter().map(|c| time_stretch(c, factor, fft_size, fft_size / 4)).collect(), sample_rate: audio.sample_rate }
}
