//! „Ein-Klick-Sprachverbesserung“: the website's `enhanceSpeechAudioData` (`src/lib/speechEnhance.ts`), number for
//! number — a filter cascade (85 Hz high-pass, −2,5 dB at 185 Hz, +3,2 dB presence at 2,85 kHz, 12,5 kHz low-pass),
//! a gain per 15-ms frame from the noise floor (lone clicks pulled down, the room's tail after speech shortened),
//! smoothed forwards and backwards, then a soft-knee normalisation to −1 dBFS. Runs on this computer.

use crate::audio::AudioData;

#[derive(Debug, Clone, Copy)]
pub struct SpeechEnhance {
    /// Strength of the background noise suppression, 0–1.
    pub noise_reduction: f32,
    /// Strength of the room-tail suppression, 0–1.
    pub de_reverb: f32,
    pub clarity_boost: bool,
    pub normalize: bool,
}

impl Default for SpeechEnhance {
    fn default() -> Self {
        SpeechEnhance { noise_reduction: 0.85, de_reverb: 0.65, clarity_boost: true, normalize: true }
    }
}

fn biquad(samples: &mut [f32], b0: f64, b1: f64, b2: f64, a1: f64, a2: f64) {
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for s in samples.iter_mut() {
        let x0 = f64::from(*s);
        let y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        *s = y0 as f32;
    }
}

fn omega(rate: f64, freq: f64) -> f64 {
    2.0 * std::f64::consts::PI * freq.min(rate * 0.45) / rate
}

fn highpass(samples: &mut [f32], rate: f64, freq: f64, q: f64) {
    let w0 = omega(rate, freq);
    let (cos, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
    let a0 = 1.0 + alpha;
    biquad(samples, (1.0 + cos) / 2.0 / a0, -(1.0 + cos) / a0, (1.0 + cos) / 2.0 / a0, -2.0 * cos / a0, (1.0 - alpha) / a0);
}

fn lowpass(samples: &mut [f32], rate: f64, freq: f64, q: f64) {
    let w0 = omega(rate, freq);
    let (cos, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
    let a0 = 1.0 + alpha;
    biquad(samples, (1.0 - cos) / 2.0 / a0, (1.0 - cos) / a0, (1.0 - cos) / 2.0 / a0, -2.0 * cos / a0, (1.0 - alpha) / a0);
}

fn peaking(samples: &mut [f32], rate: f64, freq: f64, q: f64, gain_db: f64) {
    if gain_db.abs() < 0.05 {
        return;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = omega(rate, freq);
    let (cos, alpha) = (w0.cos(), w0.sin() / (2.0 * q));
    let a0 = 1.0 + alpha / a;
    biquad(samples, (1.0 + alpha * a) / a0, -2.0 * cos / a0, (1.0 - alpha * a) / a0, -2.0 * cos / a0, (1.0 - alpha / a) / a0);
}

/// The enhanced copy of `input`; the input is left as it was.
pub fn enhance_speech(input: &AudioData, options: SpeechEnhance) -> AudioData {
    let channels = input.channels.len();
    let rate = if input.sample_rate == 0 { 48_000 } else { input.sample_rate };
    let length = input.frames();
    if channels == 0 || length == 0 {
        return input.clone();
    }
    let r = f64::from(rate);
    let (nr, dr) = (options.noise_reduction, options.de_reverb);
    let mut filtered: Vec<Vec<f32>> = input
        .channels
        .iter()
        .map(|ch| {
            let mut copy = ch.clone();
            highpass(&mut copy, r, 85.0, std::f64::consts::FRAC_1_SQRT_2);
            peaking(&mut copy, r, 185.0, 1.2, -2.5);
            if options.clarity_boost {
                peaking(&mut copy, r, 2850.0, 1.0, 3.2);
            }
            lowpass(&mut copy, r, 12_500.0, std::f64::consts::FRAC_1_SQRT_2);
            copy
        })
        .collect();

    let frame = ((r * 0.015).round() as usize).max(64);
    let frames = length.div_ceil(frame);
    let mut rms = vec![0f32; frames];
    for (f, value) in rms.iter_mut().enumerate() {
        let (start, end) = (f * frame, ((f + 1) * frame).min(length));
        let mut sum = 0f64;
        for ch in &filtered {
            for s in &ch[start..end] {
                sum += f64::from(*s) * f64::from(*s);
            }
        }
        *value = (sum / ((end - start) * channels).max(1) as f64).sqrt() as f32;
    }
    let mut sorted: Vec<f32> = rms.iter().copied().filter(|v| *v > 1e-6).collect();
    sorted.sort_by(f32::total_cmp);
    let noise_floor = if sorted.is_empty() { 0.001 } else { sorted[(sorted.len() - 1).min((sorted.len() as f32 * 0.2) as usize)] };
    let speech_peak = if sorted.is_empty() { 0.1 } else { sorted[(sorted.len() as f32 * 0.95) as usize] };
    let threshold = (speech_peak * 0.35).min((noise_floor * (1.4 + nr * 1.6)).max(0.0005));
    let floor_gain = (1.0 - nr * 0.92).max(0.04);

    let mut gains = vec![0f32; frames];
    let mut speech_env = 0f32;
    for f in 0..frames {
        let level = rms[f];
        let before = if f > 0 { rms[f - 1] } else { 0.0 };
        let after = if f + 1 < frames { rms[f + 1] } else { 0.0 };
        // A lone 15-ms click (keyboard, mouse) between two quiet frames.
        if level > threshold * 2.2 && before < threshold * 1.1 && after < threshold * 1.1 {
            gains[f] = floor_gain;
            continue;
        }
        if level >= threshold {
            let ratio = ((level - threshold * 0.5) / (threshold * 1.2).max(1e-6)).min(1.0);
            gains[f] = floor_gain + (1.0 - floor_gain) * ratio;
            speech_env = level;
        } else {
            let norm = level / threshold.max(1e-6);
            let tail = if speech_env > threshold { 1.0 - dr * 0.55 } else { 1.0 };
            gains[f] = floor_gain.max(norm.powf(1.5 + nr * 1.5) * tail);
            speech_env *= 0.78;
        }
    }
    // Forwards and backwards, so the start of a consonant and the end of a word stay natural.
    for f in (0..frames.saturating_sub(1)).rev() {
        if gains[f + 1] > gains[f] {
            gains[f] = gains[f].max(gains[f + 1] * 0.65);
        }
    }
    let release = 0.72 - dr * 0.22;
    for f in 1..frames {
        if gains[f] < gains[f - 1] {
            gains[f] = gains[f].max(gains[f - 1] * release);
        }
    }

    let mut loudest = 0f32;
    for ch in filtered.iter_mut() {
        for (i, s) in ch.iter_mut().enumerate() {
            let at = i / frame;
            let frac = (i % frame) as f32 / frame as f32;
            let (g0, g1) = (gains[at.min(frames - 1)], gains[(at + 1).min(frames - 1)]);
            *s *= g0 + (g1 - g0) * frac;
            loudest = loudest.max(s.abs());
        }
    }
    if options.normalize && loudest > 0.001 {
        let gain = (0.891 / loudest).min(6.0);
        for ch in filtered.iter_mut() {
            for s in ch.iter_mut() {
                let mut v = *s * gain;
                if v.abs() > 0.85 {
                    v = v.signum() * (0.85 + 0.14 * ((v.abs() - 0.85) / 0.15).tanh());
                }
                *s = v;
            }
        }
    }
    AudioData { channels: filtered, sample_rate: rate }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    #[test]
    fn quiets_the_room_keeps_the_voice_and_lands_below_minus_one() {
        let rate = 48_000u32;
        // One second of hiss, one second of a "voice" (a 300 Hz tone with a 2 kHz overtone) over the same hiss.
        let mut seed = 7u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.01
        };
        let mut samples = Vec::new();
        for i in 0..rate as usize * 2 {
            let t = i as f32 / rate as f32;
            let voice = if i >= rate as usize { 0.2 * (2.0 * std::f32::consts::PI * 300.0 * t).sin() + 0.05 * (2.0 * std::f32::consts::PI * 2000.0 * t).sin() } else { 0.0 };
            samples.push(voice + noise());
        }
        let input = AudioData { channels: vec![samples], sample_rate: rate };
        let out = enhance_speech(&input, SpeechEnhance::default());
        assert_eq!(out.frames(), input.frames());
        let half = rate as usize;
        let room_before = rms(&input.channels[0][..half]) / rms(&input.channels[0][half..]);
        let room_after = rms(&out.channels[0][..half]) / rms(&out.channels[0][half..]);
        assert!(room_after < room_before * 0.5, "the room should drop against the voice: {room_before} → {room_after}");
        let peak = out.channels[0].iter().fold(0f32, |m, s| m.max(s.abs()));
        assert!(peak <= 0.99 && peak > 0.5, "peak {peak}");
        // The input is untouched.
        assert!(input.channels[0][half..].iter().any(|s| s.abs() > 0.1));
    }

    #[test]
    fn empty_stays_empty() {
        let empty = AudioData { channels: vec![], sample_rate: 44_100 };
        assert_eq!(enhance_speech(&empty, SpeechEnhance::default()).frames(), 0);
    }
}
