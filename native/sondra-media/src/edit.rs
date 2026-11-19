//! The plain half of a waveform editor: gain, silence, joining, channels, sample rate. A port of
//! `src/lib/edit.ts` (and `resampleByRatio` of `timestretch.ts`). Every function returns new audio and never
//! touches its input: the editor keeps a history for undo, and that only works if nothing is mutated.

use crate::audio::AudioData;
use crate::effects::set_channels;

fn frames(audio: &AudioData) -> usize {
    audio.frames()
}

pub fn duration_of(audio: &AudioData) -> f64 {
    frames(audio) as f64 / f64::from(audio.sample_rate)
}

/// Decibels to a linear factor. −96 dB and below is silence.
pub fn db_to_gain(db: f64) -> f64 {
    if db <= -96.0 {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/// Multiplies the level, optionally only inside a range. Not clamped: clipping is a real thing people
/// sometimes want to see rather than have silently prevented, and the page shows the resulting peak.
pub fn apply_gain(audio: &AudioData, db: f64, from: f64, to: f64) -> AudioData {
    let factor = db_to_gain(db);
    let n = frames(audio);
    let rate = f64::from(audio.sample_rate);
    let start = (from * rate).floor().max(0.0) as usize;
    let end = ((to * rate).ceil().min(n as f64)).max(0.0) as usize;
    let channels = audio
        .channels
        .iter()
        .map(|source| {
            let mut next = source.clone();
            for i in start..end.min(n) {
                next[i] = (f64::from(source[i]) * factor) as f32;
            }
            next
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

/// The loudest sample, in dBFS. −∞ for digital silence.
pub fn peak_db(audio: &AudioData) -> f64 {
    let peak = audio.channels.iter().flat_map(|c| c.iter()).fold(0f64, |p, v| p.max(f64::from(v.abs())));
    if peak > 0.0 {
        20.0 * peak.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// Scales so the loudest sample lands exactly on `target_db`.
pub fn normalize_peak(audio: &AudioData, target_db: f64) -> AudioData {
    let current = peak_db(audio);
    if !current.is_finite() {
        return audio.clone();
    }
    apply_gain(audio, target_db - current, 0.0, f64::INFINITY)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Range {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// Where the recording is quieter than `threshold_db` for long enough to matter, measured on a short
/// sliding window: a single sample crossing zero is not silence, and a gate that thinks so chatters.
pub fn detect_silence(audio: &AudioData, threshold_db: f64, minimum_seconds: f64) -> Vec<Range> {
    let threshold = db_to_gain(threshold_db);
    let n = frames(audio);
    let rate = f64::from(audio.sample_rate);
    let window = ((rate * 0.02 + 0.5).floor() as usize).max(1);
    let mut ranges = Vec::new();
    let mut quiet_from: Option<usize> = None;
    let mut at = 0;
    while at < n {
        let until = n.min(at + window);
        let mut peak = 0f64;
        for channel in &audio.channels {
            for v in &channel[at..until] {
                peak = peak.max(f64::from(v.abs()));
            }
        }
        if peak < threshold {
            if quiet_from.is_none() {
                quiet_from = Some(at);
            }
        } else if let Some(from) = quiet_from.take() {
            ranges.push(Range { start_seconds: from as f64 / rate, end_seconds: at as f64 / rate });
        }
        at += window;
    }
    if let Some(from) = quiet_from {
        ranges.push(Range { start_seconds: from as f64 / rate, end_seconds: n as f64 / rate });
    }
    ranges.into_iter().filter(|r| r.end_seconds - r.start_seconds >= minimum_seconds).collect()
}

/// Removes the silence, keeping a little of it at each edge: cutting exactly at the threshold clips the
/// decay of what came before and the breath before what comes next, and the result sounds spliced.
pub fn remove_silence(audio: &AudioData, threshold_db: f64, minimum_seconds: f64, pad_seconds: f64) -> AudioData {
    let silence = detect_silence(audio, threshold_db, minimum_seconds);
    if silence.is_empty() {
        return audio.clone();
    }
    let total = duration_of(audio);
    let mut keep = Vec::new();
    let mut cursor = 0f64;
    for range in silence {
        let cut_from = total.min(range.start_seconds + pad_seconds);
        let cut_to = (range.end_seconds - pad_seconds).max(0.0);
        if cut_from > cursor {
            keep.push(Range { start_seconds: cursor, end_seconds: cut_from });
        }
        cursor = cursor.max(cut_to);
    }
    if cursor < total {
        keep.push(Range { start_seconds: cursor, end_seconds: total });
    }
    join_ranges(audio, &keep)
}

/// Keeps only the named stretches, in order, end to end.
pub fn join_ranges(audio: &AudioData, ranges: &[Range]) -> AudioData {
    let n = frames(audio);
    let rate = f64::from(audio.sample_rate);
    let spans: Vec<(usize, usize)> = ranges
        .iter()
        .map(|r| ((r.start_seconds * rate).floor().max(0.0) as usize, ((r.end_seconds * rate).ceil().min(n as f64)).max(0.0) as usize))
        .filter(|(from, to)| to > from)
        .collect();
    let channels = audio
        .channels
        .iter()
        .map(|source| {
            let mut next = Vec::with_capacity(spans.iter().map(|(f, t)| t - f).sum());
            for (from, to) in &spans {
                next.extend_from_slice(&source[*from..*to]);
            }
            next
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

/// Everything except the named stretch.
pub fn cut_range(audio: &AudioData, from: f64, to: f64) -> AudioData {
    join_ranges(audio, &[Range { start_seconds: 0.0, end_seconds: from }, Range { start_seconds: to, end_seconds: duration_of(audio) }])
}

/// Cubic interpolation by a ratio of the rates (input rate over output rate).
pub fn resample_by_ratio(input: &[f32], ratio: f64) -> Vec<f32> {
    if (ratio - 1.0).abs() < 1e-9 || input.is_empty() {
        return input.to_vec();
    }
    let length = ((input.len() as f64 / ratio).floor() as usize).max(1);
    let last = input.len() as i64 - 1;
    let sample = |i: i64| f64::from(input[i.clamp(0, last) as usize]);
    (0..length)
        .map(|i| {
            let position = i as f64 * ratio;
            let index = position.floor();
            let t = position - index;
            let index = index as i64;
            let (p0, p1, p2, p3) = (sample(index - 1), sample(index), sample(index + 1), sample(index + 2));
            (0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t * t * t)) as f32
        })
        .collect()
}

pub fn resample_audio(audio: &AudioData, target_rate: u32) -> AudioData {
    if target_rate == audio.sample_rate || target_rate == 0 {
        return audio.clone();
    }
    let ratio = f64::from(audio.sample_rate) / f64::from(target_rate);
    AudioData { sample_rate: target_rate, channels: audio.channels.iter().map(|c| resample_by_ratio(c, ratio)).collect() }
}

/// Puts several recordings end to end, at the rate and channels of the first, with an optional crossfade.
pub fn concat_audio(parts: &[AudioData], crossfade_seconds: f64) -> Result<AudioData, String> {
    let usable: Vec<&AudioData> = parts.iter().filter(|p| frames(p) > 0).collect();
    match usable.len() {
        0 => return Err("Nichts zum Aneinanderhängen.".into()),
        1 => return Ok(usable[0].clone()),
        _ => {}
    }
    let first = usable[0];
    let aligned: Vec<AudioData> = usable.iter().map(|p| set_channels(&resample_audio(p, first.sample_rate), first.channels.len())).collect();
    let fade = (crossfade_seconds * f64::from(first.sample_rate) + 0.5).floor().max(0.0) as usize;
    let length = (aligned.iter().map(frames).sum::<usize>() as i64 - (fade * (aligned.len() - 1)) as i64).max(1) as usize;
    let mut channels = vec![vec![0.0f32; length]; first.channels.len()];
    let mut at = 0usize;
    for (index, part) in aligned.iter().enumerate() {
        for (c, out) in channels.iter_mut().enumerate() {
            let source = &part.channels[c];
            for i in 0..frames(part) {
                let target = at + i;
                if target >= out.len() {
                    break;
                }
                // Inside the overlap both sides are weighted, so the sum stays level.
                if index > 0 && i < fade {
                    let ramp = i as f64 / fade as f64;
                    out[target] = (f64::from(out[target]) * (1.0 - ramp) + f64::from(source[i]) * ramp) as f32;
                } else {
                    out[target] = source[i];
                }
            }
        }
        at += frames(part) - if index < aligned.len() - 1 { fade } else { 0 };
    }
    Ok(AudioData { channels, sample_rate: first.sample_rate })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trick {
    Swap,
    Left,
    Right,
}

/// Swaps left and right, or silences one side.
pub fn channel_trick(audio: &AudioData, mode: Trick) -> AudioData {
    if audio.channels.len() < 2 {
        return audio.clone();
    }
    let (left, right) = (&audio.channels[0], &audio.channels[1]);
    let channels = match mode {
        Trick::Swap => vec![right.clone(), left.clone()],
        Trick::Left => vec![left.clone(), left.clone()],
        Trick::Right => vec![right.clone(), right.clone()],
    };
    AudioData { channels, sample_rate: audio.sample_rate }
}

/// Removes DC offset by subtracting the mean of each channel.
pub fn remove_dc_offset(audio: &AudioData) -> AudioData {
    let channels = audio
        .channels
        .iter()
        .map(|channel| {
            if channel.is_empty() {
                return Vec::new();
            }
            let mean = channel.iter().fold(0f64, |s, v| s + f64::from(*v)) / channel.len() as f64;
            channel.iter().map(|v| (f64::from(*v) - mean) as f32).collect()
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}
