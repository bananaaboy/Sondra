//! Monophonic pitch tracking (YIN) and note segmentation. A port of `src/lib/pitch.ts`.
//!
//! Plain autocorrelation peaks just as hard an octave down as at the true period; YIN replaces the
//! correlation with a difference function divided by its running mean, which makes the first dip below
//! a threshold the right one. The differences are held as 32-bit floats, as in the web app.

use crate::audio::{mix_to_mono, AudioData};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchFrame {
    pub time_seconds: f64,
    /// Fundamental in Hz, or 0 when the frame is unvoiced.
    pub hz: f64,
    /// 0–1; how periodic the frame is.
    pub clarity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    /// MIDI note number.
    pub midi: i32,
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// 1–127, from the loudness of the note's frames.
    pub velocity: u8,
}

const DEFAULT_THRESHOLD: f64 = 0.15;
const MIN_HZ: f64 = 55.0; // A1
const MAX_HZ: f64 = 1500.0; // ~F#6

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// YIN for one buffer: the fundamental and how confident it is.
fn yin(buffer: &[f32], sample_rate: f64, threshold: f64) -> (f64, f64) {
    let size = buffer.len();
    let max_tau = (size / 2).min((sample_rate / MIN_HZ).floor() as usize);
    let min_tau = 2.max((sample_rate / MAX_HZ).floor() as usize);
    if max_tau <= min_tau {
        return (0.0, 0.0);
    }

    // Step 1: squared difference between the signal and itself, lag by lag.
    let mut difference = vec![0.0f32; max_tau + 1];
    for tau in min_tau..=max_tau {
        let mut sum = 0.0f64;
        for i in 0..size - tau {
            let delta = f64::from(buffer[i]) - f64::from(buffer[i + tau]);
            sum += delta * delta;
        }
        difference[tau] = sum as f32;
    }

    // Step 2: divide by the running mean, which kills the zero-lag answer and most octave errors.
    let mut normalized = vec![0.0f32; max_tau + 1];
    normalized[0] = 1.0;
    let mut running = 0.0f64;
    for tau in min_tau..=max_tau {
        running += f64::from(difference[tau]);
        normalized[tau] = if running > 0.0 {
            ((f64::from(difference[tau]) * (tau - min_tau + 1) as f64) / running) as f32
        } else {
            1.0
        };
    }
    let n = |i: usize| f64::from(normalized[i]);

    // Step 3: the first dip below the threshold, not the deepest one.
    let mut tau = min_tau;
    let mut found: isize = -1;
    while tau < max_tau {
        if n(tau) < threshold {
            while tau + 1 < max_tau && n(tau + 1) < n(tau) {
                tau += 1;
            }
            found = tau as isize;
            break;
        }
        tau += 1;
    }
    if found < 0 {
        // Nothing crossed the threshold: the *first* local minimum that is at all convincing.
        let ceiling = 0.6;
        for t in min_tau + 1..max_tau {
            if n(t) < ceiling && n(t) <= n(t - 1) && n(t) <= n(t + 1) {
                found = t as isize;
                break;
            }
        }
        if found < 0 {
            return (0.0, 0.0);
        }
    }
    let found = found as usize;

    // Parabolic interpolation around the dip, for sub-sample precision.
    let mut period = found as f64;
    if found > min_tau && found < max_tau {
        let (a, b, c) = (n(found - 1), n(found), n(found + 1));
        let divisor = 2.0 * (2.0 * b - a - c);
        if divisor.abs() > 1e-9 {
            period = found as f64 + (c - a) / divisor;
        }
    }
    // Guard against the remaining halving case: if half the period is nearly as good a fit, the octave above is better.
    let half = js_round(period / 2.0) as usize;
    if half >= min_tau && n(half) < n(found) * 1.25 && n(half) < 0.5 {
        period = half as f64;
    }

    let hz = sample_rate / period;
    if !(MIN_HZ..=MAX_HZ).contains(&hz) {
        return (0.0, 0.0);
    }
    let at = max_tau.min(js_round(period) as usize);
    (hz, (1.0 - n(at)).clamp(0.0, 1.0))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrackOptions {
    /// Analysis window, in seconds. Longer is steadier but blurs fast runs.
    pub window_seconds: f64,
    pub hop_seconds: f64,
    pub threshold: f64,
}

impl Default for TrackOptions {
    fn default() -> Self {
        Self {
            window_seconds: 0.046,
            hop_seconds: 0.01,
            threshold: DEFAULT_THRESHOLD,
        }
    }
}

/// Frame-wise pitch over the whole file.
pub fn track_pitch(
    audio: &AudioData,
    options: &TrackOptions,
    on_progress: &mut dyn FnMut(f64),
) -> Vec<PitchFrame> {
    let mono = mix_to_mono(audio);
    let rate = f64::from(audio.sample_rate);
    let window = js_round(options.window_seconds * rate) as usize;
    let hop = js_round(options.hop_seconds * rate) as usize;
    let count = if mono.len() >= window {
        (mono.len() - window) / hop + 1
    } else {
        0
    };
    let mut frames = Vec::with_capacity(count);
    for f in 0..count {
        let start = f * hop;
        let (hz, clarity) = yin(&mono[start..start + window], rate, options.threshold);
        frames.push(PitchFrame {
            time_seconds: start as f64 / rate,
            hz,
            clarity,
        });
        if f % 64 == 0 {
            on_progress(f as f64 / count as f64);
        }
    }
    on_progress(1.0);
    frames
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SegmentOptions {
    /// Frames below this are treated as silence.
    pub minimum_clarity: f64,
    /// Notes shorter than this are dropped as tracking noise.
    pub minimum_seconds: f64,
    /// Snap note starts to this grid, in seconds. 0 disables it.
    pub quantize_seconds: f64,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        // A clean sine gives YIN a clarity near 1.0; real material sits around 0.45–0.61, so a gate at
        // 0.55 dropped most of the melody. At 0.4 the files that already passed are unchanged.
        Self {
            minimum_clarity: 0.4,
            minimum_seconds: 0.06,
            quantize_seconds: 0.0,
        }
    }
}

fn hz_to_midi(hz: f64) -> f64 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

/// Turns frame-wise pitch into notes.
pub fn segment_notes(
    audio: &AudioData,
    frames: &[PitchFrame],
    options: &SegmentOptions,
) -> Vec<Note> {
    let mono = mix_to_mono(audio);
    let rate = f64::from(audio.sample_rate);
    let mut notes: Vec<Note> = Vec::new();
    let mut current: Option<(i32, f64)> = None; // (midi, start)

    let close = |current: &mut Option<(i32, f64)>, notes: &mut Vec<Note>, end: f64| {
        let Some((midi, start)) = current.take() else {
            return;
        };
        if end - start >= options.minimum_seconds {
            // Velocity from the peak level inside the note, so a quiet phrase does not arrive as full-scale MIDI.
            let from = ((start * rate).floor().max(0.0)) as usize;
            let to = mono.len().min((end * rate).ceil() as usize);
            let mut peak = 0.0f64;
            for s in mono.iter().take(to).skip(from) {
                peak = peak.max(f64::from(*s).abs());
            }
            let db = if peak > 0.0 {
                20.0 * peak.log10()
            } else {
                -60.0
            };
            let velocity = js_round(((db + 48.0) / 48.0) * 110.0 + 17.0).clamp(1.0, 127.0) as u8;
            notes.push(Note {
                midi,
                start_seconds: start,
                end_seconds: end,
                velocity,
            });
        }
    };

    for frame in frames {
        let voiced = frame.hz > 0.0 && frame.clarity >= options.minimum_clarity;
        if !voiced {
            close(&mut current, &mut notes, frame.time_seconds);
            continue;
        }
        let midi = js_round(hz_to_midi(frame.hz)) as i32;
        match current {
            None => current = Some((midi, frame.time_seconds)),
            Some((m, _)) if m != midi => {
                close(&mut current, &mut notes, frame.time_seconds);
                current = Some((midi, frame.time_seconds));
            }
            Some(_) => {}
        }
    }
    if current.is_some() {
        close(
            &mut current,
            &mut notes,
            frames.last().map_or(0.0, |f| f.time_seconds),
        );
    }

    if options.quantize_seconds > 0.0 {
        let grid = options.quantize_seconds;
        for note in &mut notes {
            let start = js_round(note.start_seconds / grid) * grid;
            let length = grid.max(js_round((note.end_seconds - note.start_seconds) / grid) * grid);
            note.start_seconds = start;
            note.end_seconds = start + length;
        }
    }
    notes
}

pub const MIDI_NAMES: [&str; 12] = [
    "C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B",
];

pub fn midi_name(midi: i32) -> String {
    format!(
        "{}{}",
        MIDI_NAMES[midi.rem_euclid(12) as usize],
        midi.div_euclid(12) - 1
    )
}
