//! Chroma features: how much energy sits on each of the twelve pitch classes. A port of
//! `src/lib/chroma.ts`. Everything harmonic is built on this one vector: key estimation reads its
//! long-term average, chord estimation reads it over time.

use crate::audio::{mix_to_mono, AudioData};
use crate::fft::{magnitude_of, stft};

pub const PITCH_CLASSES: [&str; 12] = [
    "C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B",
];

const FFT_SIZE: usize = 8192; // ~5.4 Hz resolution at 44.1 kHz, enough to separate low notes
const HOP_SIZE: usize = 2048;
/// Analysis range: roughly C2 to C7. Below that, bass notes blur the profile.
const MIN_HZ: f64 = 65.0;
const MAX_HZ: f64 = 2100.0;
/// Roughly C2 to C4: where root notes live.
const BASS_MAX_HZ: f64 = 260.0;
const A4_HZ: f64 = 440.0;

#[derive(Debug, Clone, PartialEq)]
pub struct ChromaResult {
    /// `frame_count × 12`, frame-major, each frame normalised to a unit maximum.
    pub frames: Vec<f32>,
    pub frame_count: usize,
    /// Seconds covered by one frame step.
    pub frame_seconds: f64,
    /// Mean over all frames, weighted by frame energy.
    pub average: [f32; 12],
    /// The same, from the bass register only: a key and its relative minor contain identical pitch
    /// classes, and which note behaves as the tonic shows in the bass.
    pub bass: [f32; 12],
    /// The opening of the piece — the clearest statement of the tonic.
    pub head: [f32; 12],
    /// The closing, a weaker cue because endings are often unresolved.
    pub tail: [f32; 12],
}

fn midi_of(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / A4_HZ).log2()
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn unit(vector: &mut [f32; 12]) {
    let peak = vector.iter().copied().fold(0.0f32, f32::max);
    if peak > 0.0 {
        for v in vector.iter_mut() {
            *v /= peak;
        }
    }
}

/// Computes a chromagram. `tuning_offset` shifts the reference in semitones, so material recorded at
/// 432 Hz or a tape that runs slightly fast still maps onto the right classes.
pub fn chromagram(audio: &AudioData, tuning_offset: f64) -> ChromaResult {
    let mono = mix_to_mono(audio);
    let spec = stft(&mono, FFT_SIZE, HOP_SIZE).expect("a power of two");
    let magnitude = magnitude_of(&spec);
    let (frames, bins) = (spec.frames, spec.bins);
    let bin_hz = f64::from(audio.sample_rate) / FFT_SIZE as f64;

    // Each bin's pitch class and weight never change.
    let mut class_of = vec![-1i8; bins];
    let mut weight_of = vec![0.0f32; bins];
    for b in 1..bins {
        let hz = b as f64 * bin_hz;
        if !(MIN_HZ..=MAX_HZ).contains(&hz) {
            continue;
        }
        let midi = midi_of(hz) - tuning_offset;
        let nearest = js_round(midi);
        let cents = (midi - nearest).abs();
        // A raised-cosine window over ±50 cents: dead centre counts fully, a quarter-tone away counts for nothing.
        weight_of[b] = (0.5 + 0.5 * (std::f64::consts::PI * (cents * 2.0).min(1.0)).cos()) as f32;
        class_of[b] = ((nearest as i64 % 12 + 12) % 12) as i8;
    }

    let mut result = vec![0.0f32; frames * 12];
    let mut average = [0.0f32; 12];
    let mut bass = [0.0f32; 12];
    let mut head = [0.0f32; 12];
    let mut tail = [0.0f32; 12];
    // The first and last eighth carry the opening and the cadence.
    let edge_frames = 1.max(js_round(frames as f64 / 8.0) as usize);

    for f in 0..frames {
        let row = f * 12;
        let offset = f * bins;
        let mut bass_row = [0.0f32; 12];
        for b in 1..bins {
            let class = class_of[b];
            if class < 0 {
                continue;
            }
            // Magnitude rather than power: power lets one loud note swamp the chord.
            let value = magnitude[offset + b] * weight_of[b];
            result[row + class as usize] += value;
            if b as f64 * bin_hz <= BASS_MAX_HZ {
                bass_row[class as usize] += value;
            }
        }

        let peak = result[row..row + 12].iter().copied().fold(0.0f32, f32::max);
        if peak > 0.0 {
            let at_head = f < edge_frames;
            let at_tail = f + edge_frames >= frames;
            for c in 0..12 {
                result[row + c] /= peak;
                // Louder frames carry more weight in the average, so silence and noise between phrases do not dilute the profile.
                average[c] += result[row + c] * peak;
                if at_head {
                    head[c] += result[row + c] * peak;
                }
                if at_tail {
                    tail[c] += result[row + c] * peak;
                }
            }
        }

        // Only the strongest bass class per frame counts.
        let mut bass_peak = 0.0f32;
        let mut bass_class: i32 = -1;
        for (c, v) in bass_row.iter().enumerate() {
            if *v > bass_peak {
                bass_peak = *v;
                bass_class = c as i32;
            }
        }
        if bass_class >= 0 {
            bass[bass_class as usize] += bass_peak;
        }
    }
    unit(&mut average);
    unit(&mut bass);
    unit(&mut head);
    unit(&mut tail);

    ChromaResult {
        frames: result,
        frame_count: frames,
        frame_seconds: HOP_SIZE as f64 / f64::from(audio.sample_rate),
        average,
        bass,
        head,
        tail,
    }
}

/// How far the recording sits from concert pitch, in semitones: the offset whose chroma is most peaked.
pub fn estimate_tuning(audio: &AudioData) -> f64 {
    let mut best = 0.0;
    let mut best_score = f64::NEG_INFINITY;
    let mut cents = -50;
    while cents <= 50 {
        let offset = f64::from(cents) / 100.0;
        let chroma = chromagram(audio, offset);
        // Sum of squares is maximal when the energy is concentrated.
        let score: f64 = chroma
            .average
            .iter()
            .map(|v| f64::from(*v) * f64::from(*v))
            .sum();
        if score > best_score {
            best_score = score;
            best = offset;
        }
        cents += 10;
    }
    best
}
