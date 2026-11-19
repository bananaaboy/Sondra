//! Where to cut — one plan for every way of cutting. A port of `src/lib/chop.ts`: one settings object, one
//! planner, the slices rather than just the cut points (cutting at silence and leaving the silence out does
//! not tile the file). The expensive part, the spectral flux of the whole file, is made once per file
//! ([`Flux::of`]) and kept by the caller, because the planner runs on every change of a setting.

use crate::audio::{mix_to_mono, AudioData};
use crate::fft::{magnitude_of, stft};
use crate::tempo::{beat_grid, snap_to_zero_crossing, GridOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChopMethod {
    Auto,
    Hits,
    Grid,
    Even,
    Length,
    Silence,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChopSettings {
    pub method: ChopMethod,
    /// Hits and auto: how far above its surroundings a hit must stand, 0.5 to 3.
    pub sensitivity: f64,
    /// Hits: the shortest distance between two cuts.
    pub min_gap_ms: f64,
    /// Auto: how many of the strongest hits. Even: how many parts.
    pub count: f64,
    /// Grid: tempo, slice length in beats (⅓ and ⅔ are triplets), and a shift.
    pub bpm: f64,
    pub beats_per_slice: f64,
    pub grid_offset_ms: f64,
    /// Length: every slice this long.
    pub length_ms: f64,
    /// Silence: what counts as quiet, and for how long.
    pub silence_db: f64,
    pub silence_ms: f64,
    /// Silence: leave the quiet out, so a pad starts with its sound and ends with it.
    pub drop_silence: bool,
    /// Every method: each cut this much earlier, so the run-up to a hit stays on its pad.
    pub pre_roll_ms: f64,
    /// Every method: a slice shorter than this joins the one before it.
    pub min_length_ms: f64,
    /// Every method: cuts move to the nearest rising zero crossing.
    pub snap: bool,
}

impl Default for ChopSettings {
    fn default() -> Self {
        ChopSettings {
            method: ChopMethod::Hits,
            sensitivity: 1.4,
            min_gap_ms: 80.0,
            count: 16.0,
            bpm: 120.0,
            beats_per_slice: 1.0,
            grid_offset_ms: 0.0,
            length_ms: 500.0,
            silence_db: -45.0,
            silence_ms: 120.0,
            drop_silence: true,
            pre_roll_ms: 0.0,
            min_length_ms: 30.0,
            snap: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlannedSlice {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChopPlan {
    pub slices: Vec<PlannedSlice>,
    /// More slices were found than are worth laying out; the rest were dropped.
    pub capped: bool,
}

/// More than this is not a kit any more, and the waveform cannot show it.
pub const MAX_PLANNED: usize = 128;

const FFT_SIZE: usize = 1024;
const HOP: usize = 256;

/// Rising spectral energy per frame, with its local mean: it spikes exactly where a new sound starts.
#[derive(Debug, Clone, PartialEq)]
pub struct Flux {
    pub flux: Vec<f32>,
    pub seconds_per_frame: f64,
    /// The local mean around each frame, for the adaptive threshold.
    pub mean: Vec<f32>,
}

impl Flux {
    /// `None` for a file too short to have any.
    pub fn of(audio: &AudioData) -> Option<Flux> {
        let mono = mix_to_mono(audio);
        if mono.len() < FFT_SIZE * 2 {
            return None;
        }
        let spec = stft(&mono, FFT_SIZE, HOP).ok()?;
        let magnitude = magnitude_of(&spec);
        let (frames, bins) = (spec.frames, spec.bins);
        let mut flux = vec![0f32; frames];
        for f in 1..frames {
            let mut sum = 0f64;
            for b in 0..bins {
                // Only rising energy counts: a decay is not a new event.
                let delta = f64::from(magnitude[f * bins + b]) - f64::from(magnitude[(f - 1) * bins + b]);
                if delta > 0.0 {
                    sum += delta;
                }
            }
            flux[f] = sum as f32;
        }
        // A running mean over ±24 frames, so a quiet passage still yields hits and a loud one does not
        // yield hundreds.
        let window = 24usize;
        let mut mean = vec![0f32; frames];
        let (mut total, mut from, mut to) = (0f64, 0usize, 0usize);
        for f in 0..frames {
            let want_from = f.saturating_sub(window);
            let want_to = frames.min(f + window);
            while to < want_to {
                total += f64::from(flux[to]);
                to += 1;
            }
            while from < want_from {
                total -= f64::from(flux[from]);
                from += 1;
            }
            mean[f] = (total / (1usize.max(to - from)) as f64) as f32;
        }
        Some(Flux { flux, seconds_per_frame: HOP as f64 / f64::from(audio.sample_rate), mean })
    }
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Peaks of the flux that stand out from their surroundings, with their strength.
fn hits(flux: Option<&Flux>, sensitivity: f64, min_gap_seconds: f64) -> Vec<(f64, f64)> {
    let Some(data) = flux else { return Vec::new() };
    let gap = 1.0f64.max(js_round(min_gap_seconds / data.seconds_per_frame)) as isize;
    let mut found = Vec::new();
    let mut last: isize = -gap;
    let n = data.flux.len();
    for f in 1..n {
        let peak = data.flux[f] > data.flux[f - 1] && (f + 1 >= n || data.flux[f] >= data.flux[f + 1]);
        if !peak || (f as isize) - last < gap {
            continue;
        }
        let ratio = if data.mean[f] > 0.0 { f64::from(data.flux[f]) / f64::from(data.mean[f]) } else { 0.0 };
        if ratio > sensitivity {
            found.push((f as f64 * data.seconds_per_frame, ratio * f64::from(data.flux[f])));
            last = f as isize;
        }
    }
    found
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PlanContext {
    /// Cut only inside this stretch; the rest of the file is left alone.
    pub range: Option<(f64, f64)>,
    /// Where the detected tempo puts its first beat.
    pub tempo_offset_seconds: f64,
}

/// A stretch of quiet, in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Silence {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// `detectSilence` of `src/lib/edit.ts`: stretches where the peak stays under the threshold for at least
/// `minimum_seconds`, in windows of 20 ms.
pub fn detect_silence(audio: &AudioData, threshold_db: f64, minimum_seconds: f64) -> Vec<Silence> {
    let threshold = 10f64.powf(threshold_db / 20.0);
    let frames = audio.frames();
    let rate = f64::from(audio.sample_rate);
    let window = 1usize.max(js_round(rate * 0.02) as usize);
    let mut ranges = Vec::new();
    let mut quiet_from: Option<usize> = None;
    let mut at = 0;
    while at < frames {
        let until = frames.min(at + window);
        let mut peak = 0f64;
        for channel in &audio.channels {
            for i in at..until {
                let value = f64::from(channel[i]).abs();
                if value > peak {
                    peak = value;
                }
            }
        }
        if peak < threshold {
            if quiet_from.is_none() {
                quiet_from = Some(at);
            }
        } else if let Some(from) = quiet_from.take() {
            ranges.push(Silence { start_seconds: from as f64 / rate, end_seconds: at as f64 / rate });
        }
        at += window;
    }
    if let Some(from) = quiet_from {
        ranges.push(Silence { start_seconds: from as f64 / rate, end_seconds: frames as f64 / rate });
    }
    ranges.into_iter().filter(|r| r.end_seconds - r.start_seconds >= minimum_seconds).collect()
}

fn snapped(audio: &AudioData, settings: &ChopSettings, at: f64) -> f64 {
    if settings.snap {
        snap_to_zero_crossing(audio, at, 12.0)
    } else {
        at
    }
}

fn cap(mut slices: Vec<PlannedSlice>) -> ChopPlan {
    if slices.len() > MAX_PLANNED {
        slices.truncate(MAX_PLANNED);
        ChopPlan { slices, capped: true }
    } else {
        ChopPlan { slices, capped: false }
    }
}

/// The stretches between silences, inside the range.
fn sounding_ranges(audio: &AudioData, settings: &ChopSettings, from: f64, to: f64) -> Vec<PlannedSlice> {
    let quiet = detect_silence(audio, settings.silence_db, 0.02f64.max(settings.silence_ms / 1000.0));
    let mut sounding = Vec::new();
    let mut cursor = from;
    for gap in quiet {
        if gap.end_seconds <= from {
            continue;
        }
        if gap.start_seconds >= to {
            break;
        }
        if gap.start_seconds > cursor {
            sounding.push(PlannedSlice { start: cursor, end: to.min(gap.start_seconds) });
        }
        cursor = cursor.max(gap.end_seconds);
    }
    if cursor < to {
        sounding.push(PlannedSlice { start: cursor, end: to });
    }
    sounding.into_iter().filter(|p| p.end - p.start > 0.01).collect()
}

/// The plan. `flux` is [`Flux::of`] of the same audio (made once, kept).
pub fn plan_chop(audio: &AudioData, flux: Option<&Flux>, settings: &ChopSettings, context: &PlanContext) -> ChopPlan {
    let duration = audio.channels.first().map_or(0, Vec::len) as f64 / f64::from(audio.sample_rate);
    let (range_start, range_end) = context.range.unwrap_or((0.0, duration));
    let from = 0f64.max(duration.min(range_start));
    let to = from.max(duration.min(range_end));
    if to - from < 0.01 {
        return ChopPlan { slices: Vec::new(), capped: false };
    }
    let inside = |at: f64| at > from + 1e-4 && at < to - 1e-4;

    // Silence with the gaps left out is the one method that does not tile.
    if settings.method == ChopMethod::Silence && settings.drop_silence {
        let sounding = sounding_ranges(audio, settings, from, to);
        let pre_roll = settings.pre_roll_ms / 1000.0;
        let slices: Vec<PlannedSlice> = sounding
            .into_iter()
            .map(|part| PlannedSlice { start: snapped(audio, settings, from.max(part.start - pre_roll)), end: part.end })
            .filter(|part| part.end - part.start >= settings.min_length_ms / 1000.0)
            .collect();
        return cap(slices);
    }

    let points: Vec<f64> = match settings.method {
        ChopMethod::Auto => {
            let mut strongest: Vec<(f64, f64)> = hits(flux, settings.sensitivity, 0.06).into_iter().filter(|h| inside(h.0)).collect();
            // `sort((a, b) => b.score - a.score)` is stable: equal scores keep their order.
            strongest.sort_by(|a, b| b.1.total_cmp(&a.1));
            strongest.into_iter().take((settings.count - 1.0).max(0.0) as usize).map(|h| h.0).collect()
        }
        ChopMethod::Hits => hits(flux, settings.sensitivity, settings.min_gap_ms / 1000.0).into_iter().map(|h| h.0).filter(|t| inside(*t)).collect(),
        ChopMethod::Grid => beat_grid(GridOptions { bpm: settings.bpm, offset_seconds: context.tempo_offset_seconds + settings.grid_offset_ms / 1000.0, beats_per_slice: settings.beats_per_slice, duration_seconds: duration }).into_iter().filter(|t| inside(*t)).collect(),
        ChopMethod::Even => {
            let parts = 1usize.max(js_round(settings.count) as usize);
            (0..parts - 1).map(|index| from + ((to - from) * (index + 1) as f64) / parts as f64).collect()
        }
        ChopMethod::Length => {
            let step = 0.01f64.max(settings.length_ms / 1000.0);
            let mut points = Vec::new();
            let mut at = from + step;
            while at < to - 1e-4 && points.len() < MAX_PLANNED * 4 {
                points.push(at);
                at += step;
            }
            points
        }
        ChopMethod::Silence => sounding_ranges(audio, settings, from, to).into_iter().map(|p| p.start).filter(|t| inside(*t)).collect(),
    };

    // Grid and equal parts are positions in time, not sounds: a run-up before them would only shift the
    // grid. The others move to keep the attack.
    let pre_roll = if matches!(settings.method, ChopMethod::Grid | ChopMethod::Even | ChopMethod::Length) { 0.0 } else { settings.pre_roll_ms / 1000.0 };
    // `[...new Set(...)]`: the same number twice is one cut, the first one's place kept.
    let mut cuts: Vec<f64> = Vec::new();
    for at in points {
        let value = snapped(audio, settings, from.max(at - pre_roll));
        if !cuts.iter().any(|c| *c == value) {
            cuts.push(value);
        }
    }
    let mut cuts: Vec<f64> = cuts.into_iter().filter(|t| inside(*t)).collect();
    cuts.sort_by(|a, b| a.total_cmp(b));

    let mut edges = vec![from];
    edges.extend(cuts);
    edges.push(to);
    let mut slices: Vec<PlannedSlice> = Vec::new();
    let shortest = 0.015f64.max(settings.min_length_ms / 1000.0);
    for index in 0..edges.len() - 1 {
        let slice = PlannedSlice { start: edges[index], end: edges[index + 1] };
        // Too short to be a pad: it joins the slice before it, or, at the very start, the one after.
        if slice.end - slice.start < shortest && !slices.is_empty() {
            let last = slices.len() - 1;
            slices[last].end = slice.end;
        } else {
            slices.push(slice);
        }
    }
    if slices.len() > 1 && slices[0].end - slices[0].start < shortest {
        slices[1].start = slices[0].start;
        slices.remove(0);
    }
    cap(slices)
}

/// What the plan does, in words, for the log and the button.
pub fn describe_method(settings: &ChopSettings) -> String {
    match settings.method {
        ChopMethod::Auto => format!("Die {} stärksten Schläge", crate::convert::js_number(settings.count)),
        ChopMethod::Hits => "Anschläge".into(),
        ChopMethod::Grid => format!("Raster {} BPM", js_round(settings.bpm) as i64),
        ChopMethod::Even => format!("{} gleiche Teile", crate::convert::js_number(settings.count)),
        ChopMethod::Length => format!("Je {} ms", crate::convert::js_number(settings.length_ms)),
        ChopMethod::Silence => if settings.drop_silence { "Zwischen Stille, ohne die Stille" } else { "An der Stille" }.into(),
    }
}
