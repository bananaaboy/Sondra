//! Musical key and chord estimation. A port of `src/lib/key.ts`.
//!
//! A key is a distribution over pitch classes; Krumhansl and Kessler measured what those look like by
//! asking listeners how well each note fitted a key. Correlating a piece's chroma against those
//! twenty-four profiles gets you the key. Chords use the same idea at a shorter timescale, against
//! triad templates.

use crate::chroma::{ChromaResult, PITCH_CLASSES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Dur,
    Moll,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyScore {
    pub label: String,
    pub camelot: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyEstimate {
    pub tonic: usize,
    pub mode: Mode,
    pub label: String,
    /// Camelot code, the notation harmonic mixing uses.
    pub camelot: String,
    /// 0–1, from the margin between the best fit and the runner-up.
    pub confidence: f64,
    /// The next-best candidate, often the relative major or minor.
    pub alternative: (String, String),
    /// The six best candidates, for display.
    pub scores: Vec<KeyScore>,
}

/// Krumhansl–Kessler probe-tone profiles, starting at the tonic: experimental data, not a formula.
const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
/// Camelot numbers for the twelve major keys, indexed by tonic pitch class.
const CAMELOT_MAJOR: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
/// Flat spellings read better for the keys that conventionally use them.
const KEY_NAMES: [&str; 12] = [
    "C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
];

pub fn camelot_of(tonic: usize, mode: Mode) -> String {
    match mode {
        Mode::Dur => format!("{}B", CAMELOT_MAJOR[tonic]),
        // A minor key shares its Camelot number with its relative major, three semitones up.
        Mode::Moll => format!("{}A", CAMELOT_MAJOR[(tonic + 3) % 12]),
    }
}

pub fn key_label(tonic: usize, mode: Mode) -> String {
    // German capitalises the mode as a noun: "C-Dur", not "C-dur".
    format!(
        "{}-{}",
        KEY_NAMES[tonic],
        if mode == Mode::Dur { "Dur" } else { "Moll" }
    )
}

/// Pearson correlation between a rotated profile and the chroma vector.
fn correlate(chroma: &[f32; 12], profile: &[f64; 12], rotation: usize) -> f64 {
    let chroma_mean: f64 = chroma.iter().map(|v| f64::from(*v)).sum::<f64>() / 12.0;
    let profile_mean: f64 = profile.iter().sum::<f64>() / 12.0;
    let (mut covariance, mut chroma_variance, mut profile_variance) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let a = f64::from(chroma[(i + rotation) % 12]) - chroma_mean;
        let b = profile[i] - profile_mean;
        covariance += a * b;
        chroma_variance += a * a;
        profile_variance += b * b;
    }
    let denominator = (chroma_variance * profile_variance).sqrt();
    if denominator > 0.0 {
        covariance / denominator
    } else {
        0.0
    }
}

/// Extra credit for the tonic being in the bass and at the edges: what separates a key from its
/// relative minor, which has identical pitch-class content.
const BASS_WEIGHT: f64 = 0.22;
/// The opening states the tonic; endings are often left hanging.
const HEAD_WEIGHT: f64 = 0.24;
const TAIL_WEIGHT: f64 = 0.10;
/// The fifth is the second-strongest root in the bass; worth a little.
const DOMINANT_WEIGHT: f64 = 0.05;

pub fn estimate_key(chroma: &ChromaResult) -> KeyEstimate {
    let f = |v: f32| f64::from(v);
    let evidence = |tonic: usize| {
        BASS_WEIGHT * f(chroma.bass[tonic])
            + HEAD_WEIGHT * f(chroma.head[tonic])
            + TAIL_WEIGHT * f(chroma.tail[tonic])
            + DOMINANT_WEIGHT * f(chroma.bass[(tonic + 7) % 12])
    };
    let mut candidates: Vec<(usize, Mode, f64)> = Vec::new();
    for tonic in 0..12 {
        let e = evidence(tonic);
        candidates.push((
            tonic,
            Mode::Dur,
            correlate(&chroma.average, &MAJOR_PROFILE, tonic) + e,
        ));
        candidates.push((
            tonic,
            Mode::Moll,
            correlate(&chroma.average, &MINOR_PROFILE, tonic) + e,
        ));
    }
    // Best first; equal scores keep their order (the sort is stable, as in the web app).
    candidates.sort_by(|a, b| b.2.total_cmp(&a.2));

    let best = candidates[0];
    let runner_up = candidates[1];
    // How clearly the winner won: a relative major and minor share all twelve notes and should not be reported as certain.
    let margin = ((best.2 - runner_up.2) / 0.2).clamp(0.0, 1.0);
    let strength = best.2.clamp(0.0, 1.0);
    KeyEstimate {
        tonic: best.0,
        mode: best.1,
        label: key_label(best.0, best.1),
        camelot: camelot_of(best.0, best.1),
        confidence: (margin * strength).clamp(0.0, 1.0),
        alternative: (
            key_label(runner_up.0, runner_up.1),
            camelot_of(runner_up.0, runner_up.1),
        ),
        scores: candidates
            .iter()
            .take(6)
            .map(|c| KeyScore {
                label: key_label(c.0, c.1),
                camelot: camelot_of(c.0, c.1),
                score: c.2,
            })
            .collect(),
    }
}

/* Chords ------------------------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Dur,
    Moll,
    Dim,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChordSpan {
    pub start_seconds: f64,
    pub end_seconds: f64,
    /// `—` for a stretch with no clear chord.
    pub label: String,
    /// `None` for a stretch with no clear chord.
    pub root: Option<usize>,
    pub quality: Option<Quality>,
}

/// Intervals above the root, as pitch-class offsets.
const CHORD_SHAPES: [(Quality, &str, [usize; 3]); 3] = [
    (Quality::Dur, "", [0, 4, 7]),
    (Quality::Moll, "m", [0, 3, 7]),
    (Quality::Dim, "°", [0, 3, 6]),
];

struct Template {
    label: String,
    root: usize,
    quality: Quality,
    vector: [f32; 12],
}

fn chord_templates() -> Vec<Template> {
    let mut templates = Vec::new();
    for root in 0..12 {
        for (quality, suffix, notes) in CHORD_SHAPES {
            let mut vector = [0.0f32; 12];
            for interval in notes {
                vector[(root + interval) % 12] = 1.0;
            }
            templates.push(Template {
                label: format!("{}{suffix}", PITCH_CLASSES[root]),
                root,
                quality,
                vector,
            });
        }
    }
    templates
}

/// A single note explains its own chroma almost perfectly; a triad explains a chord better than any
/// one note can. When one class beats the best triad by more than this, the window is a melody note
/// rather than harmony (measured: chords under a melody 0.86–1.11, a solo line 1.23–1.48).
const SINGLE_NOTE_RATIO: f64 = 1.15;

fn rest() -> (String, Option<usize>, Option<Quality>) {
    ("—".to_owned(), None, None)
}

/// Labels the harmony over time: chroma frames averaged into windows of `window_seconds`, matched
/// against triad templates, runs of the same label merged, and single-window blips between two
/// identical neighbours dropped.
pub fn estimate_chords(
    chroma: &ChromaResult,
    window_seconds: f64,
    minimum_score: f64,
) -> Vec<ChordSpan> {
    let templates = chord_templates();
    let frames_per_window = 1.max(((window_seconds / chroma.frame_seconds) + 0.5).floor() as usize);
    let windows = chroma.frame_count.div_ceil(frames_per_window);
    let mut labels: Vec<(String, Option<usize>, Option<Quality>)> = Vec::new();

    for w in 0..windows {
        let mut window = [0.0f32; 12];
        let from = w * frames_per_window;
        let to = chroma.frame_count.min(from + frames_per_window);
        for f in from..to {
            for c in 0..12 {
                window[c] += chroma.frames[f * 12 + c];
            }
        }
        let peak = window.iter().copied().fold(0.0f32, f32::max);
        if peak <= 0.0 {
            labels.push(rest());
            continue;
        }
        for v in &mut window {
            *v /= peak;
        }
        let norm = window
            .iter()
            .map(|v| f64::from(*v) * f64::from(*v))
            .sum::<f64>()
            .sqrt();

        let mut best = &templates[0];
        let mut best_score = f64::NEG_INFINITY;
        for template in &templates {
            // Cosine similarity: the three chord tones should carry the energy.
            let dot: f64 = (0..12)
                .map(|c| f64::from(window[c]) * f64::from(template.vector[c]))
                .sum();
            let score = if norm > 0.0 {
                dot / (norm * 3f64.sqrt())
            } else {
                0.0
            };
            if score > best_score {
                best_score = score;
                best = template;
            }
        }
        // How well the single strongest class explains the window on its own.
        let mut best_single = 0.0f64;
        for v in &window {
            let score = if norm > 0.0 {
                f64::from(*v) / norm
            } else {
                0.0
            };
            if score > best_single {
                best_single = score;
            }
        }
        let harmonic = best_score > 0.0 && best_single / best_score <= SINGLE_NOTE_RATIO;
        labels.push(if harmonic && best_score >= minimum_score {
            (best.label.clone(), Some(best.root), Some(best.quality))
        } else {
            rest()
        });
    }

    // Merge runs.
    let mut spans: Vec<ChordSpan> = Vec::new();
    let mut index = 0;
    while index < labels.len() {
        let mut end = index + 1;
        while end < labels.len() && labels[end].0 == labels[index].0 {
            end += 1;
        }
        let start_seconds = (index * frames_per_window) as f64 * chroma.frame_seconds;
        let end_seconds =
            chroma.frame_count.min(end * frames_per_window) as f64 * chroma.frame_seconds;
        spans.push(ChordSpan {
            start_seconds,
            end_seconds,
            label: labels[index].0.clone(),
            root: labels[index].1,
            quality: labels[index].2,
        });
        index = end;
    }
    // Drop single-window blips between two identical neighbours.
    let last = spans.len().saturating_sub(1);
    let keep: Vec<bool> = (0..spans.len())
        .map(|i| {
            spans[i].end_seconds - spans[i].start_seconds > window_seconds * 1.5
                || i == 0
                || i == last
                || spans[i - 1].label
                    != spans
                        .get(i + 1)
                        .map(|s| s.label.as_str())
                        .unwrap_or("\u{0}undefined")
        })
        .collect();
    spans
        .into_iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(s, _)| s)
        .collect()
}
