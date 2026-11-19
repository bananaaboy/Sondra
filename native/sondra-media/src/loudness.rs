//! ITU-R BS.1770-4 / EBU R128 loudness: K-weighting, gated integration, loudness range, true peak,
//! and the gain move to a target. A port of `src/lib/loudness.ts`, number for number — the filters are
//! derived for the material's own sample rate, the filtered channels are held as 32-bit floats (as the
//! web app holds them), and the gate and percentile rules are the same.

const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -10.0;
const LRA_RELATIVE_GATE_LU: f64 = -20.0;

pub use crate::audio::AudioData;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessReport {
    /// Gated programme loudness over the whole file (−∞ for silence).
    pub integrated_lufs: f64,
    /// Loudness range in LU (EBU Tech 3342).
    pub loudness_range_lu: f64,
    /// Loudest 400 ms window.
    pub momentary_max_lufs: f64,
    /// Loudest 3 s window.
    pub short_term_max_lufs: f64,
    /// Highest sample value, in dBFS.
    pub sample_peak_dbfs: f64,
    /// Highest inter-sample value at 4× oversampling, in dBTP.
    pub true_peak_dbtp: f64,
    pub sample_rate: u32,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Lufs,
    Peak,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizationSettings {
    pub mode: Mode,
    /// Target programme loudness in LUFS, used when mode is `Lufs`.
    pub target_lufs: f64,
    /// Target peak in dBFS, used when mode is `Peak`.
    pub target_peak_dbfs: f64,
    /// Ceiling the output must not exceed, in dBTP.
    pub true_peak_ceiling_dbtp: f64,
    /// Pull the gain back to respect the ceiling instead of limiting.
    pub prevent_clipping: bool,
    /// Soft-knee limiter for the peaks that survive the gain move.
    pub use_limiter: bool,
}

impl Default for NormalizationSettings {
    fn default() -> Self {
        Self {
            mode: Mode::Lufs,
            target_lufs: -14.0, // streaming-platform convention
            target_peak_dbfs: -1.0,
            true_peak_ceiling_dbtp: -1.0,
            prevent_clipping: true,
            use_limiter: false,
        }
    }
}

/// Common delivery targets, offered as presets in the UI: id, label, LUFS, ceiling.
pub const LOUDNESS_PRESETS: [(&str, &str, f64, f64); 6] = [
    ("streaming", "Streaming (Spotify, Apple)", -14.0, -1.0),
    ("youtube", "YouTube", -14.0, -1.0),
    ("broadcast", "Broadcast EBU R128", -23.0, -1.0),
    ("atsc", "Broadcast ATSC A/85", -24.0, -2.0),
    ("podcast", "Podcast", -16.0, -1.0),
    ("club", "Club / laut", -9.0, -0.3),
];

#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

/// Stage 1 of K-weighting: a +4 dB high shelf standing in for the acoustic effect of a listener's head.
fn shelving_filter(sample_rate: f64) -> Biquad {
    let f0 = 1681.974450955533;
    let gain = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (std::f64::consts::PI * f0 / sample_rate).tan();
    let vh = 10f64.powf(gain / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    Biquad {
        b0: (vh + (vb * k) / q + k * k) / a0,
        b1: (2.0 * (k * k - vh)) / a0,
        b2: (vh - (vb * k) / q + k * k) / a0,
        a1: (2.0 * (k * k - 1.0)) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    }
}

/// Stage 2 of K-weighting: an RLB high-pass at roughly 38 Hz.
fn high_pass_filter(sample_rate: f64) -> Biquad {
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (std::f64::consts::PI * f0 / sample_rate).tan();
    let a0 = 1.0 + k / q + k * k;
    Biquad {
        b0: 1.0,
        b1: -2.0,
        b2: 1.0,
        a1: (2.0 * (k * k - 1.0)) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    }
}

/// Direct-form-I biquad over a copy of the channel (the result is stored as 32-bit floats).
fn filter_channel(input: &[f32], c: Biquad) -> Vec<f32> {
    let mut out = Vec::with_capacity(input.len());
    let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for &sample in input {
        let x0 = f64::from(sample);
        let y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        out.push(y0 as f32);
        x2 = x1;
        x1 = x0;
        // The recursion runs on the double, as in the web app (only the stored result is rounded).
        y2 = y1;
        y1 = y0;
    }
    out
}

/// BS.1770 channel weights. Index order follows the WAV convention (L, R, C, LFE, Ls, Rs); the LFE
/// channel is excluded from the measurement.
fn channel_weights(count: usize) -> Vec<f64> {
    match count {
        1 => vec![1.0],
        2 => vec![1.0, 1.0],
        3 => vec![1.0, 1.0, 1.0],
        4 => vec![1.0, 1.0, 1.41, 1.41],
        6 => vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41],
        n => vec![1.0; n],
    }
}

fn loudness_of_mean_squares(mean_squares: &[f64], weights: &[f64]) -> f64 {
    let sum: f64 = mean_squares.iter().zip(weights).map(|(m, w)| w * m).sum();
    if sum > 0.0 {
        -0.691 + 10.0 * sum.log10()
    } else {
        f64::NEG_INFINITY
    }
}

struct Blocks {
    /// Per channel, per block: the mean square.
    mean_squares: Vec<Vec<f64>>,
    loudness: Vec<f64>,
    count: usize,
}

/// Sliding-window mean squares over K-weighted channels.
fn compute_blocks(
    filtered: &[Vec<f32>],
    sample_rate: f64,
    block_seconds: f64,
    step_seconds: f64,
    weights: &[f64],
) -> Blocks {
    // `Math.round`: halves go up.
    let block_size = (block_seconds * sample_rate + 0.5).floor() as usize;
    let step_size = (step_seconds * sample_rate + 0.5).floor() as usize;
    let frames = filtered.first().map_or(0, Vec::len);
    let count = if frames >= block_size {
        (frames - block_size) / step_size + 1
    } else {
        0
    };

    let mut mean_squares = Vec::with_capacity(filtered.len());
    for channel in filtered {
        // Prefix sums of x² turn every block into two lookups instead of a loop.
        let mut prefix = vec![0.0f64; frames + 1];
        for i in 0..frames {
            let x = f64::from(channel[i]);
            prefix[i + 1] = prefix[i] + x * x;
        }
        mean_squares.push(
            (0..count)
                .map(|b| {
                    (prefix[b * step_size + block_size] - prefix[b * step_size]) / block_size as f64
                })
                .collect::<Vec<_>>(),
        );
    }
    let loudness = (0..count)
        .map(|b| {
            let sum: f64 = (0..filtered.len())
                .map(|c| weights[c] * mean_squares[c][b])
                .sum();
            if sum > 0.0 {
                -0.691 + 10.0 * sum.log10()
            } else {
                f64::NEG_INFINITY
            }
        })
        .collect();
    Blocks {
        mean_squares,
        loudness,
        count,
    }
}

/// Two-stage gate from BS.1770-4: absolute at −70 LUFS, then −10 LU relative.
fn gated_loudness(blocks: &Blocks, weights: &[f64]) -> f64 {
    if blocks.count == 0 {
        return f64::NEG_INFINITY;
    }
    let channels = blocks.mean_squares.len();
    let average_over = |keep: &dyn Fn(usize) -> bool| -> Option<Vec<f64>> {
        let mut sums = vec![0.0; channels];
        let mut used = 0usize;
        for b in 0..blocks.count {
            if !keep(b) {
                continue;
            }
            used += 1;
            for c in 0..channels {
                sums[c] += blocks.mean_squares[c][b];
            }
        }
        (used > 0).then(|| sums.into_iter().map(|s| s / used as f64).collect())
    };
    let Some(absolute) = average_over(&|b| blocks.loudness[b] > ABSOLUTE_GATE_LUFS) else {
        return f64::NEG_INFINITY;
    };
    let relative_threshold = loudness_of_mean_squares(&absolute, weights) + RELATIVE_GATE_LU;
    match average_over(&|b| {
        blocks.loudness[b] > ABSOLUTE_GATE_LUFS && blocks.loudness[b] > relative_threshold
    }) {
        Some(gated) => loudness_of_mean_squares(&gated, weights),
        None => f64::NEG_INFINITY,
    }
}

/// EBU Tech 3342 loudness range: the 10th-to-95th percentile spread.
fn loudness_range(blocks: &Blocks, weights: &[f64]) -> f64 {
    if blocks.count == 0 {
        return 0.0;
    }
    let channels = blocks.mean_squares.len();
    let mut sums = vec![0.0; channels];
    let mut used = 0usize;
    for b in 0..blocks.count {
        if blocks.loudness[b] <= ABSOLUTE_GATE_LUFS {
            continue;
        }
        used += 1;
        for c in 0..channels {
            sums[c] += blocks.mean_squares[c][b];
        }
    }
    if used == 0 {
        return 0.0;
    }
    let averages: Vec<f64> = sums.iter().map(|s| s / used as f64).collect();
    let threshold = loudness_of_mean_squares(&averages, weights) + LRA_RELATIVE_GATE_LU;
    let mut above: Vec<f64> = (0..blocks.count)
        .filter(|&b| blocks.loudness[b] > ABSOLUTE_GATE_LUFS && blocks.loudness[b] > threshold)
        .map(|b| blocks.loudness[b])
        .collect();
    if above.len() < 2 {
        return 0.0;
    }
    above.sort_by(|a, b| a.total_cmp(b));
    let at = |percentile: f64| {
        let index = ((percentile * (above.len() - 1) as f64) + 0.5).floor() as usize;
        above[index.min(above.len() - 1)]
    };
    at(0.95) - at(0.1)
}

/// 4× polyphase oversampling for inter-sample peaks: a windowed-sinc kernel split into four phases,
/// each a short FIR over the original samples. The tap count per phase is odd and the kernel centred
/// on a tap, which makes phase 0 the identity, so only the three intermediate phases are evaluated.
/// Past the ends the signal is treated as silent, as a streaming meter does.
fn true_peak(channels: &[Vec<f32>]) -> f64 {
    let factor = 4usize;
    let taps = 13usize;
    let half = (taps - 1) / 2;
    let kernel_length = taps * factor;
    let center = half * factor;
    let pi = std::f64::consts::PI;

    let kernel: Vec<f64> = (0..kernel_length)
        .map(|i| {
            let x = (i as f64 - center as f64) / factor as f64;
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                (pi * x).sin() / (pi * x)
            };
            // Blackman window keeps the stop-band low enough for peak estimation.
            let w = 0.42 - 0.5 * (2.0 * pi * i as f64 / (kernel_length - 1) as f64).cos()
                + 0.08 * (4.0 * pi * i as f64 / (kernel_length - 1) as f64).cos();
            sinc * w
        })
        .collect();

    let mut phases: Vec<Vec<f64>> = Vec::new();
    for p in 1..factor {
        let mut phase: Vec<f64> = (0..taps).map(|t| kernel[t * factor + p]).collect();
        let sum: f64 = phase.iter().sum();
        // Unity DC gain, so a constant signal keeps exactly its level.
        if sum.abs() > 1e-9 {
            for v in &mut phase {
                *v /= sum;
            }
        }
        phases.push(phase);
    }

    let mut peak = 0.0f64;
    for channel in channels {
        let length = channel.len();
        for i in 0..length {
            let magnitude = f64::from(channel[i]).abs();
            if magnitude > peak {
                peak = magnitude;
            }
            for phase in &phases {
                let mut acc = 0.0f64;
                for (t, coefficient) in phase.iter().enumerate() {
                    let at = i as isize + t as isize - half as isize;
                    if at >= 0 && (at as usize) < length {
                        acc += f64::from(channel[at as usize]) * coefficient;
                    }
                }
                let value = acc.abs();
                if value > peak {
                    peak = value;
                }
            }
        }
    }
    peak
}

fn sample_peak(channels: &[Vec<f32>]) -> f64 {
    channels
        .iter()
        .flat_map(|c| c.iter())
        .fold(0.0f64, |peak, &s| peak.max(f64::from(s).abs()))
}

fn to_db(linear: f64) -> f64 {
    if linear > 0.0 {
        20.0 * linear.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// Full R128 measurement. `on_progress` is called with a 0–1 fraction.
pub fn measure_loudness(audio: &AudioData, on_progress: &mut dyn FnMut(f64)) -> LoudnessReport {
    let rate = f64::from(audio.sample_rate);
    let weights = channel_weights(audio.channels.len());

    on_progress(0.05);
    let shelf = shelving_filter(rate);
    let high_pass = high_pass_filter(rate);
    let mut filtered = Vec::with_capacity(audio.channels.len());
    for (index, channel) in audio.channels.iter().enumerate() {
        filtered.push(filter_channel(&filter_channel(channel, shelf), high_pass));
        on_progress(0.05 + 0.45 * (index + 1) as f64 / audio.channels.len() as f64);
    }

    let momentary = compute_blocks(&filtered, rate, 0.4, 0.1, &weights);
    on_progress(0.62);
    let short_term = compute_blocks(&filtered, rate, 3.0, 0.1, &weights);
    on_progress(0.74);

    let integrated = gated_loudness(&momentary, &weights);
    let range = loudness_range(&short_term, &weights);
    on_progress(0.8);

    let momentary_max = momentary
        .loudness
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let short_term_max = short_term
        .loudness
        .iter()
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);

    let peak = sample_peak(&audio.channels);
    on_progress(0.85);
    let true_peak_linear = true_peak(&audio.channels);
    on_progress(1.0);

    LoudnessReport {
        integrated_lufs: integrated,
        loudness_range_lu: range,
        momentary_max_lufs: momentary_max,
        short_term_max_lufs: short_term_max,
        sample_peak_dbfs: to_db(peak),
        // True peak can only ever be at or above sample peak; guard against rounding in the interpolator.
        true_peak_dbtp: to_db(true_peak_linear.max(peak)),
        sample_rate: audio.sample_rate,
        duration_seconds: audio.channels.first().map_or(0, Vec::len) as f64 / rate,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GainPlan {
    /// Gain the target asks for, before any ceiling is applied.
    pub requested_db: f64,
    /// Gain actually applied.
    pub applied_db: f64,
    /// True if the ceiling forced `applied_db` below `requested_db`.
    pub reduced_by_ceiling: bool,
    /// True if the limiter had to engage.
    pub limiter_engaged: bool,
    pub predicted_peak_dbtp: f64,
}

/// Works out the gain move for a measurement and applies it to a copy; the input is left untouched.
pub fn apply_normalization(
    audio: &AudioData,
    report: &LoudnessReport,
    settings: &NormalizationSettings,
) -> (AudioData, GainPlan) {
    let requested_db = match settings.mode {
        Mode::Lufs => settings.target_lufs - report.integrated_lufs,
        Mode::Peak => settings.target_peak_dbfs - report.sample_peak_dbfs,
    };
    let mut applied_db = if requested_db.is_finite() {
        requested_db
    } else {
        0.0
    };
    let mut reduced_by_ceiling = false;

    // Pulling the gain back is the transparent option; limiting is the loud one.
    let headroom_db = settings.true_peak_ceiling_dbtp - report.true_peak_dbtp;
    if settings.prevent_clipping && !settings.use_limiter && applied_db > headroom_db {
        applied_db = headroom_db;
        reduced_by_ceiling = true;
    }

    let gain = 10f64.powf(applied_db / 20.0);
    let ceiling = 10f64.powf(settings.true_peak_ceiling_dbtp / 20.0);
    let mut limiter_engaged = false;

    let mut output: Vec<Vec<f32>> = audio
        .channels
        .iter()
        .map(|c| c.iter().map(|&s| (f64::from(s) * gain) as f32).collect())
        .collect();

    if settings.use_limiter {
        limiter_engaged = soft_limit(&mut output, ceiling);
    } else if settings.prevent_clipping {
        // Hard safety net: the gain move already respects the ceiling, so this only catches interpolation error.
        let ceiling32 = ceiling as f32;
        for channel in &mut output {
            for s in channel.iter_mut() {
                if *s > ceiling32 {
                    *s = ceiling32;
                } else if *s < -ceiling32 {
                    *s = -ceiling32;
                }
            }
        }
    }

    let predicted = to_db(true_peak(&output).min(ceiling * 1.001));
    (
        AudioData {
            channels: output,
            sample_rate: audio.sample_rate,
        },
        GainPlan {
            requested_db,
            applied_db,
            reduced_by_ceiling,
            limiter_engaged,
            predicted_peak_dbtp: predicted,
        },
    )
}

/// Look-ahead peak limiter with a 5 ms attack and 50 ms release, shared across channels so the stereo
/// image does not wander.
fn soft_limit(channels: &mut [Vec<f32>], ceiling: f64) -> bool {
    let frames = channels.first().map_or(0, Vec::len);
    if frames == 0 {
        return false;
    }
    let envelope: Vec<f32> = (0..frames)
        .map(|i| channels.iter().fold(0.0f32, |m, c| m.max(c[i].abs())))
        .collect();

    let attack = 220usize; // ≈5 ms at 44.1 kHz
    let release = 2200usize;
    let mut gain_curve = vec![1.0f32; frames];
    let mut engaged = false;

    for i in 0..frames {
        let level = f64::from(envelope[i]);
        if level > ceiling {
            engaged = true;
            let required = ceiling / level;
            // Ramp into the reduction ahead of the peak so it is not audible as a click.
            let start = i.saturating_sub(attack);
            for j in start..=i {
                let ramp = (required + (1.0 - required) * ((i - j) as f64 / attack as f64)) as f32;
                if ramp < gain_curve[j] {
                    gain_curve[j] = ramp;
                }
            }
            let end = (frames - 1).min(i + release);
            for j in i..=end {
                let ramp = (required + (1.0 - required) * ((j - i) as f64 / release as f64)) as f32;
                if ramp < gain_curve[j] {
                    gain_curve[j] = ramp;
                }
            }
        }
    }
    if !engaged {
        return false;
    }
    for channel in channels {
        for (s, g) in channel.iter_mut().zip(&gain_curve) {
            *s *= *g;
        }
    }
    true
}
