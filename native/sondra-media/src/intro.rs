//! Finding the opening of a series by ear. A port of `src/lib/introPrint.ts` and of what
//! `workers/intro.worker.ts` does with it.
//!
//! Two episodes of a series share their opening, note for note, wherever it sits. The sound of the
//! first minutes of each becomes a fingerprint — ten frames a second of 32 bits each, after Haitsma and
//! Kalker (2002): energies in 33 bands between 300 and 2000 Hz, and per band the sign of how the
//! difference to its neighbour changed since the frame before — and the longest stretch the two have in
//! common is the opening. Quiet frames carry no tune and never count as a match.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use crate::fft::Fft;

/// The rate the sound is decoded at for this; the bands end at 2000 Hz.
pub const PRINT_RATE: usize = 8000;
/// Frames per second of the fingerprint.
pub const PRINT_FPS: usize = 10;
const HOP: usize = PRINT_RATE / PRINT_FPS;
const WINDOW: usize = 2048;
const BANDS: usize = 33;
const LOW: f64 = 300.0;
const HIGH: f64 = 2000.0;
/// Bits that may differ for two frames still to count as the same.
const MAX_ERRORS: u32 = 10;
/// A gap of this many frames without a match ends a shared stretch.
const MAX_GAP: isize = 20;
/// The windows, in frames, over which a stretch's ends must match densely: three seconds, then one.
const EDGE_WINDOWS: [usize; 2] = [30, 10];
const EDGE_DENSITY: f64 = 0.6;
/// Openings are between these lengths, in seconds.
pub const INTRO_MIN: f64 = 15.0;
pub const INTRO_MAX: f64 = 200.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Print {
    /// One 32-bit word per frame.
    pub bits: Vec<u32>,
    /// Frames too quiet to carry a tune: never a match.
    pub quiet: Vec<u8>,
}

/// The fingerprint of mono sound at [`PRINT_RATE`], samples as floats.
pub fn fingerprint(samples: &[f32]) -> Print {
    fingerprint_with(samples.len(), |i| f64::from(samples[i]))
}

/// The same for 16-bit samples, as FFmpeg writes them.
pub fn fingerprint_i16(samples: &[i16]) -> Print {
    fingerprint_with(samples.len(), |i| f64::from(samples[i]) * (1.0 / 32768.0))
}

fn fingerprint_with(len: usize, sample: impl Fn(usize) -> f64) -> Print {
    let frames = if len >= WINDOW {
        (len - WINDOW) / HOP + 1
    } else {
        0
    };
    let mut bits = vec![0u32; frames];
    let mut quiet = vec![0u8; frames];
    let fft = Fft::new(WINDOW).expect("a power of two");
    let mut real = vec![0.0f64; WINDOW];
    let mut imag = vec![0.0f64; WINDOW];
    let hann: Vec<f64> = (0..WINDOW)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (WINDOW - 1) as f64).cos())
        .collect();

    // Band edges as FFT bins, spaced evenly on a log scale.
    let edges: Vec<usize> = (0..=BANDS)
        .map(|band| {
            let hz = LOW * (HIGH / LOW).powf(band as f64 / BANDS as f64);
            ((hz / PRINT_RATE as f64) * WINDOW as f64 + 0.5).floor() as usize
        })
        .collect();

    let mut previous = [0.0f64; BANDS];
    let mut current = [0.0f64; BANDS];
    let mut levels = vec![0.0f64; frames];
    for frame in 0..frames {
        let offset = frame * HOP;
        for i in 0..WINDOW {
            real[i] = sample(offset + i) * hann[i];
            imag[i] = 0.0;
        }
        fft.forward(&mut real, &mut imag);
        let mut total = 0.0;
        for band in 0..BANDS {
            let mut energy = 0.0;
            let to = (edges[band] + 1).max(edges[band + 1]);
            for bin in edges[band]..to {
                energy += real[bin] * real[bin] + imag[bin] * imag[bin];
            }
            current[band] = energy;
            total += energy;
        }
        levels[frame] = total;
        let mut word = 0u32;
        if frame > 0 {
            for band in 0..BANDS - 1 {
                let change =
                    current[band] - current[band + 1] - (previous[band] - previous[band + 1]);
                if change > 0.0 {
                    word |= 1u32 << band;
                }
            }
        }
        bits[frame] = word;
        std::mem::swap(&mut previous, &mut current);
    }

    // Quiet against this file's own loudness, so a soft mix is not all quiet.
    let mut sorted = levels.clone();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let typical = if sorted.is_empty() {
        0.0
    } else {
        sorted[(sorted.len() as f64 * 0.6).floor() as usize]
    };
    let floor = (typical * 0.002).max(1e-6);
    for frame in 0..frames {
        if levels[frame] < floor {
            quiet[frame] = 1;
        }
    }
    if frames > 0 {
        quiet[0] = 1;
    }
    Print { bits, quiet }
}

fn matches(a: &Print, i: usize, b: &Print, j: usize) -> bool {
    a.quiet[i] == 0 && b.quiet[j] == 0 && (a.bits[i] ^ b.bits[j]).count_ones() <= MAX_ERRORS
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shared {
    /// Where the stretch is in the first file, and in the second, in frames.
    pub a: usize,
    pub b: usize,
    pub frames: usize,
    /// The share of its frames that matched.
    pub score: f64,
    /// Frames that matched: what ranks one stretch over another.
    pub matched: usize,
}

/// The stretch two fingerprints share most of, if one lasts long enough to be an opening: every
/// alignment is walked, and along it matching frames are joined while no gap is longer than two
/// seconds. Ranked by frames that matched, not by length: background music that comes back under
/// other dialogue matches in patches, an opening in one piece.
pub fn longest_shared(a: &Print, b: &Print, min_seconds: f64, max_seconds: f64) -> Option<Shared> {
    let min = min_seconds * PRINT_FPS as f64;
    let max = max_seconds * PRINT_FPS as f64;
    let mut best: Option<Shared> = None;
    let (na, nb) = (a.bits.len() as isize, b.bits.len() as isize);
    let min_i = min as isize;
    let mut shift = -(na - min_i);
    while shift <= nb - min_i {
        // Frame i of a lies against frame i + shift of b.
        let from = 0.max(-shift);
        let to = na.min(nb - shift);
        let mut start: isize = -1;
        let mut last: isize = -1;
        let mut count: usize = 0;
        let close = |start: isize, last: isize, count: usize, best: &mut Option<Shared>| {
            if start < 0 {
                return;
            }
            let frames = (last - start + 1) as usize;
            let score = count as f64 / frames as f64;
            if frames as f64 >= min
                && frames as f64 <= max
                && score >= 0.5
                && best.is_none_or(|b| count > b.matched)
            {
                *best = Some(Shared {
                    a: start as usize,
                    b: (start + shift) as usize,
                    frames,
                    score,
                    matched: count,
                });
            }
        };
        let mut i = from;
        while i < to {
            if matches(a, i as usize, b, (i + shift) as usize) {
                if start < 0 || i - last > MAX_GAP {
                    close(start, last, count, &mut best);
                    start = i;
                    count = 0;
                }
                last = i;
                count += 1;
            }
            i += 1;
        }
        close(start, last, count, &mut best);
        shift += 1;
    }
    best.and_then(|found| trimmed(a, b, found, min))
}

/// [`longest_shared`] with the lengths openings come in.
pub fn longest_shared_default(a: &Print, b: &Print) -> Option<Shared> {
    longest_shared(a, b, INTRO_MIN, INTRO_MAX)
}

/// The stretch without its loose ends: each end moves inward until the three seconds next to it match
/// densely, and then until the one second next to it does.
fn trimmed(a: &Print, b: &Print, found: Shared, min: f64) -> Option<Shared> {
    let shift = found.b as isize - found.a as isize;
    let hits: Vec<u8> = (0..found.frames)
        .map(|k| {
            u8::from(matches(
                a,
                found.a + k,
                b,
                (found.a as isize + k as isize + shift) as usize,
            ))
        })
        .collect();
    let dense = |k: usize, window: usize| {
        let mut count = 0usize;
        let mut seen = 0usize;
        let mut j = k;
        while j < k + window && j < found.frames {
            seen += 1;
            count += usize::from(hits[j]);
            j += 1;
        }
        seen > 0 && count as f64 / seen as f64 >= EDGE_DENSITY
    };
    let mut start = 0usize;
    let mut end = found.frames - 1;
    for window in EDGE_WINDOWS {
        while start < end && !(hits[start] == 1 && dense(start, window)) {
            start += 1;
        }
        while end > start
            && !(hits[end] == 1 && dense(start.max((end + 1).saturating_sub(window)), window))
        {
            end -= 1;
        }
    }
    let frames = end - start + 1;
    if (frames as f64) < min {
        return None;
    }
    let matched: usize = hits[start..=end].iter().map(|h| usize::from(*h)).sum();
    Some(Shared {
        a: found.a + start,
        b: found.b + start,
        frames,
        score: matched as f64 / frames as f64,
        matched,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Located {
    /// Its first frame.
    pub at: usize,
    pub score: f64,
}

/// Where a known opening lies in a file: its first frame and how well it matched.
pub fn locate_print(reference: &Print, target: &Print) -> Option<Located> {
    let n = reference.bits.len();
    if n == 0 || (target.bits.len() as f64) < n as f64 * 0.6 {
        return None;
    }
    let usable = reference.quiet.iter().filter(|q| **q == 0).count();
    if (usable as f64) < n as f64 * 0.5 {
        return None;
    }
    let mut best: Option<Located> = None;
    // The opening may run past the end of what was decoded, by a little.
    let last = target.bits.len() as isize - (n as f64 * 0.6).floor() as isize;
    let mut at = 0isize;
    while at <= last {
        let (mut hits, mut seen) = (0usize, 0usize);
        let mut k = 0;
        while k < n && (at as usize + k) < target.bits.len() {
            if reference.quiet[k] == 0 {
                seen += 1;
                if matches(reference, k, target, at as usize + k) {
                    hits += 1;
                }
            }
            k += 1;
        }
        let score = if seen > 0 {
            hits as f64 / usable as f64
        } else {
            0.0
        };
        if best.is_none_or(|b| score > b.score) {
            best = Some(Located {
                at: at as usize,
                score,
            });
        }
        at += 1;
    }
    best.filter(|b| b.score >= 0.35)
}

/// A stretch of a fingerprint, to keep as the series' opening.
pub fn slice(print: &Print, from: usize, frames: usize) -> Print {
    let to = (from + frames).min(print.bits.len());
    Print {
        bits: print.bits[from..to].to_vec(),
        quiet: print.quiet[from..to].to_vec(),
    }
}

/// The opening as text, for the Merkliste (and with it Anytype and Drive): five bytes a frame — the
/// word, little-endian, and whether it is quiet — in base64.
pub fn encode_print(print: &Print) -> String {
    let mut bytes = Vec::with_capacity(print.bits.len() * 5);
    for (word, quiet) in print.bits.iter().zip(&print.quiet) {
        bytes.extend(word.to_le_bytes());
        bytes.push(*quiet);
    }
    STANDARD.encode(bytes)
}

pub fn decode_print(text: &str) -> Option<Print> {
    let raw = STANDARD.decode(text.trim()).ok()?;
    if raw.is_empty() || raw.len() % 5 != 0 {
        return None;
    }
    let mut bits = Vec::with_capacity(raw.len() / 5);
    let mut quiet = Vec::with_capacity(raw.len() / 5);
    for frame in raw.chunks_exact(5) {
        bits.push(u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]));
        quiet.push(u8::from(frame[4] != 0));
    }
    Some(Print { bits, quiet })
}

/// What two episodes share, as the Merkliste keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct LearnedIntro {
    pub print: String,
    pub seconds: f64,
    /// Where it starts in the first and the second episode, in seconds.
    pub a: f64,
    pub b: f64,
}

/// The opening two episodes share (`learn` of the worker), or `None` when they share none.
pub fn learn_intro(a: &[i16], b: &[i16]) -> Option<LearnedIntro> {
    let print_a = fingerprint_i16(a);
    let shared = longest_shared_default(&print_a, &fingerprint_i16(b))?;
    let fps = PRINT_FPS as f64;
    Some(LearnedIntro {
        print: encode_print(&slice(&print_a, shared.a, shared.frames)),
        seconds: shared.frames as f64 / fps,
        a: shared.a as f64 / fps,
        b: shared.b as f64 / fps,
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FoundIntro {
    pub start: f64,
    pub end: f64,
    pub score: f64,
}

/// Where one of a series' openings sits in an episode (`locate` of the worker): each opening the
/// series has is tried and the one that fits best wins.
pub fn find_intro(prints: &[String], pcm: &[i16]) -> Option<FoundIntro> {
    let target = fingerprint_i16(pcm);
    let fps = PRINT_FPS as f64;
    let mut found: Option<FoundIntro> = None;
    for text in prints {
        let Some(reference) = decode_print(text) else {
            continue;
        };
        if let Some(hit) = locate_print(&reference, &target) {
            if found.is_none_or(|f| hit.score > f.score) {
                found = Some(FoundIntro {
                    start: hit.at as f64 / fps,
                    end: (hit.at + reference.bits.len()) as f64 / fps,
                    score: hit.score,
                });
            }
        }
    }
    found
}
