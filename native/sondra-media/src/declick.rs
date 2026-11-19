//! Clicks and crackle out (`src/lib/declick.ts`): vinyl ticks, a cable touched, a mouth click on a microphone.
//!
//! A click is a few samples that jump where the waveform cannot: the second difference of the signal spikes far
//! above its local level (a median per block, so loud music raises the bar with it). Spikes close together become
//! one region; regions longer than a few milliseconds are left alone — a drum, a consonant, a pluck. A region is
//! filled by prediction: a linear predictor learned from the samples just before it runs forward into the gap, one
//! learned from just after runs backward, and the two are crossfaded. Channels are repaired at the same places, so
//! a stereo click does not move.

use crate::audio::AudioData;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickStrength {
    Soft,
    Medium,
    Strong,
}

impl ClickStrength {
    /// How far above its surroundings a spike must stand, and how long a region may be (ms).
    fn settings(self) -> (f64, f64) {
        match self {
            ClickStrength::Soft => (11.0, 2.0),
            ClickStrength::Medium => (7.5, 3.0),
            ClickStrength::Strong => (5.0, 5.0),
        }
    }
}

const BLOCK: usize = 2048;
const ORDER: usize = 16;
const CONTEXT: usize = 512;

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Median of |second difference| per block, from every fourth sample.
fn block_scale(diff: &[f32]) -> Vec<f32> {
    let blocks = diff.len().div_ceil(BLOCK);
    (0..blocks)
        .map(|b| {
            let mut picks: Vec<f32> = (b * BLOCK..diff.len().min((b + 1) * BLOCK)).step_by(4).map(|i| diff[i].abs()).collect();
            picks.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
            if picks.is_empty() {
                0.0
            } else {
                picks[picks.len() / 2]
            }
        })
        .collect()
}

/// Prediction coefficients from `samples` by least squares over the samples themselves (the covariance method).
fn predictor(samples: &[f32], order: usize) -> Vec<f64> {
    let n = order;
    let mut matrix = vec![vec![0f64; n + 1]; n];
    for t in order..samples.len() {
        for i in 0..n {
            let xi = f64::from(samples[t - 1 - i]);
            matrix[i][n] += xi * f64::from(samples[t]);
            for j in i..n {
                matrix[i][j] += xi * f64::from(samples[t - 1 - j]);
            }
        }
    }
    let mut trace = 0f64;
    for i in 0..n {
        for j in 0..i {
            matrix[i][j] = matrix[j][i];
        }
        trace += matrix[i][i];
    }
    let mut coefficients = vec![0f64; order + 1];
    if trace <= 1e-12 {
        return coefficients;
    }
    // A whisper of ridge keeps silence and pure tones from making it singular.
    for (i, row) in matrix.iter_mut().enumerate() {
        row[i] += (trace / n as f64) * 1e-6;
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..n {
        let mut pivot = col;
        for row in col + 1..n {
            if matrix[row][col].abs() > matrix[pivot][col].abs() {
                pivot = row;
            }
        }
        matrix.swap(col, pivot);
        let lead = matrix[col][col];
        if lead.abs() < 1e-18 {
            return coefficients;
        }
        for row in col + 1..n {
            let factor = matrix[row][col] / lead;
            for k in col..=n {
                let sub = factor * matrix[col][k];
                matrix[row][k] -= sub;
            }
        }
    }
    for row in (0..n).rev() {
        let mut value = matrix[row][n];
        for k in row + 1..n {
            value -= matrix[row][k] * coefficients[k + 1];
        }
        coefficients[row + 1] = value / matrix[row][row];
    }
    coefficients
}

/// Continues `history` (oldest first) by `count` samples.
fn extrapolate(history: &[f32], coefficients: &[f64], count: usize) -> Vec<f32> {
    let order = coefficients.len() - 1;
    let mut buffer = vec![0f32; history.len() + count];
    buffer[..history.len()].copy_from_slice(history);
    for n in history.len()..buffer.len() {
        let mut value = 0f64;
        for j in 1..=order {
            value += coefficients[j] * f64::from(buffer[n - j]);
        }
        buffer[n] = value as f32;
    }
    buffer[history.len()..].to_vec()
}

/// A smooth curve from the last good sample before to the first after.
fn bridge(channel: &mut [f32], from: usize, to: usize) {
    let gap = to - from;
    let left = if from > 0 { channel[from - 1] } else { channel.get(to).copied().unwrap_or(0.0) };
    let right = if to < channel.len() { channel[to] } else { left };
    for i in 0..gap {
        let t = (i + 1) as f64 / (gap + 1) as f64;
        let s = t * t * (3.0 - 2.0 * t);
        channel[from + i] = (f64::from(left) + (f64::from(right) - f64::from(left)) * s) as f32;
    }
}

fn repair(channel: &mut [f32], from: usize, to: usize) {
    let gap = to - from;
    let before: Vec<f32> = channel[from.saturating_sub(CONTEXT)..from].to_vec();
    let after: Vec<f32> = channel[to..channel.len().min(to + CONTEXT)].to_vec();
    if before.len() < ORDER * 2 || after.len() < ORDER * 2 {
        return bridge(channel, from, to);
    }
    let mut ceiling = 0f32;
    for v in before.iter().chain(after.iter()) {
        ceiling = ceiling.max(v.abs());
    }
    // A predictor that runs away from what surrounds the gap is not trusted: a tone does not suddenly grow
    // louder inside a two-millisecond hole.
    let sane = |values: &[f32]| values.iter().all(|v| v.is_finite() && f64::from(v.abs()) <= f64::from(ceiling) * 1.25 + 1e-4);
    let forward = extrapolate(&before, &predictor(&before, ORDER), gap);
    let reversed_after: Vec<f32> = after.iter().rev().copied().collect();
    let mut backward = extrapolate(&reversed_after, &predictor(&reversed_after, ORDER), gap);
    backward.reverse();
    let (forward_ok, backward_ok) = (sane(&forward), sane(&backward));
    if !forward_ok && !backward_ok {
        return bridge(channel, from, to);
    }
    for i in 0..gap {
        let w = (i + 1) as f64 / (gap + 1) as f64;
        let a = if forward_ok { forward[i] } else { backward[i] };
        let b = if backward_ok { backward[i] } else { forward[i] };
        channel[from + i] = (f64::from(a) * (1.0 - w) + f64::from(b) * w) as f32;
    }
}

/// The repaired audio and how many places were repaired.
pub fn remove_clicks(audio: &AudioData, strength: ClickStrength) -> (AudioData, usize) {
    let (factor, max_ms) = strength.settings();
    let rate = f64::from(audio.sample_rate);
    let length = audio.channels.first().map_or(0, Vec::len);
    let margin = (js_round(rate * 0.0001) as usize).max(2);
    let join = js_round(rate * 0.001) as usize;
    let longest = js_round(rate * max_ms / 1000.0) as usize;

    // Where any channel jumps.
    let mut flagged = vec![false; length];
    let diffs: Vec<Vec<f32>> = audio
        .channels
        .iter()
        .map(|channel| {
            let mut diff = vec![0f32; length];
            for i in 2..length {
                diff[i] = (f64::from(channel[i]) - 2.0 * f64::from(channel[i - 1]) + f64::from(channel[i - 2])) as f32;
            }
            let scale = block_scale(&diff);
            for i in 2..length {
                let level = scale[i / BLOCK];
                if f64::from(diff[i].abs()) > factor * f64::from(level).max(1e-5) {
                    flagged[i] = true;
                }
            }
            diff
        })
        .collect();
    let near = js_round(rate * 0.005) as usize;
    // A click stands out against the few milliseconds right around it, too. A snare or a hiss is just as rough
    // on both sides and is left alone.
    let isolated = |from: usize, to: usize| {
        diffs.iter().any(|diff| {
            let peak = diff[from..to].iter().fold(0f32, |p, v| p.max(v.abs()));
            let mut around: Vec<f32> = Vec::new();
            for k in from.saturating_sub(near).max(2)..from {
                around.push(diff[k].abs());
            }
            for k in to..length.min(to + near) {
                around.push(diff[k].abs());
            }
            if around.len() < 8 {
                return true;
            }
            around.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
            f64::from(peak) > factor * f64::from(around[around.len() / 2]).max(1e-5)
        })
    };

    // Flags into regions: widened a little, near ones joined, long ones dropped.
    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < length {
        if !flagged[i] {
            i += 1;
            continue;
        }
        let mut end = i;
        let mut j = i;
        while j < length && j - end <= join {
            if flagged[j] {
                end = j;
            }
            j += 1;
        }
        let from = i.saturating_sub(margin);
        let to = length.min(end + margin + 1);
        if to - from <= longest && isolated(from, to) {
            regions.push((from, to));
        }
        i = j;
    }

    let channels = audio
        .channels
        .iter()
        .map(|channel| {
            let mut copy = channel.clone();
            for &(from, to) in &regions {
                repair(&mut copy, from, to);
            }
            copy
        })
        .collect();
    (AudioData { channels, sample_rate: audio.sample_rate }, regions.len())
}
