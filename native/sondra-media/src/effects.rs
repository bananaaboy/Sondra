//! Sound-shaping for the audio editor and the microphone chain: filters, EQ, dynamics, noise, space, and the
//! edits that work on a range. A port of `src/lib/effects.ts` (and the noise reduction of
//! `micCalibrate.ts`), number for number: the arithmetic runs in doubles and is stored in 32-bit floats
//! where the web app stores into a `Float32Array`, so the results agree with it to the last bit the float
//! format keeps. Only the reverb differs: the web app lets the browser's convolver do it, which this
//! cannot reproduce bit for bit; the room and the mix are the same, the tail is the same length.

use crate::audio::AudioData;
use crate::fft::{istft, stft, Fft};

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn frames(audio: &AudioData) -> usize {
    audio.frames()
}

fn at(audio: &AudioData, seconds: f64) -> usize {
    js_round(seconds * f64::from(audio.sample_rate)).clamp(0.0, frames(audio) as f64) as usize
}

fn clamp1(x: f64) -> f64 {
    x.clamp(-1.0, 1.0)
}

/* -- Biquads ----------------------------------------------------------------------------------- */

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

fn normalise(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
    Biquad { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

pub fn highpass_coefficients(rate: f64, hz: f64, q: f64) -> [f64; 5] {
    let b = highpass(rate, hz, q);
    [b.b0, b.b1, b.b2, b.a1, b.a2]
}

fn highpass(rate: f64, hz: f64, q: f64) -> Biquad {
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let alpha = w.sin() / (2.0 * q);
    let cos = w.cos();
    normalise((1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
}

fn lowpass(rate: f64, hz: f64, q: f64) -> Biquad {
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let alpha = w.sin() / (2.0 * q);
    let cos = w.cos();
    normalise((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
}

fn shelf(rate: f64, hz: f64, gain_db: f64, high: bool) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0);
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let cos = w.cos();
    let alpha = (w.sin() / 2.0) * std::f64::consts::SQRT_2;
    let root = 2.0 * a.sqrt() * alpha;
    if !high {
        return normalise(
            a * (a + 1.0 - (a - 1.0) * cos + root),
            2.0 * a * (a - 1.0 - (a + 1.0) * cos),
            a * (a + 1.0 - (a - 1.0) * cos - root),
            a + 1.0 + (a - 1.0) * cos + root,
            -2.0 * (a - 1.0 + (a + 1.0) * cos),
            a + 1.0 + (a - 1.0) * cos - root,
        );
    }
    normalise(
        a * (a + 1.0 + (a - 1.0) * cos + root),
        -2.0 * a * (a - 1.0 + (a + 1.0) * cos),
        a * (a + 1.0 + (a - 1.0) * cos - root),
        a + 1.0 - (a - 1.0) * cos + root,
        2.0 * (a - 1.0 - (a + 1.0) * cos),
        a + 1.0 - (a - 1.0) * cos - root,
    )
}

fn run(input: &[f32], f: Biquad) -> Vec<f32> {
    let mut out = vec![0.0f32; input.len()];
    let (mut x1, mut x2, mut y1, mut y2) = (0f64, 0f64, 0f64, 0f64);
    for (i, sample) in input.iter().enumerate() {
        let x = f64::from(*sample);
        let y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y as f32;
    }
    out
}

fn each_channel(audio: &AudioData, f: impl Fn(&[f32]) -> Vec<f32>) -> AudioData {
    AudioData { channels: audio.channels.iter().map(|c| f(c)).collect(), sample_rate: audio.sample_rate }
}

/// Removes what lies below `hz`, 24 dB per octave (`highpass24` in `micCalibrate.ts` is the same).
pub fn highpass_filter(audio: &AudioData, hz: f64) -> AudioData {
    let rate = f64::from(audio.sample_rate);
    each_channel(audio, |c| run(&run(c, highpass(rate, hz, 0.5412)), highpass(rate, hz, 1.3066)))
}

/// Removes what lies above `hz`, 24 dB per octave.
pub fn lowpass_filter(audio: &AudioData, hz: f64) -> AudioData {
    let rate = f64::from(audio.sample_rate);
    let top = hz.min(rate / 2.0 - 100.0);
    each_channel(audio, |c| run(&run(c, lowpass(rate, top, 0.5412)), lowpass(rate, top, 1.3066)))
}

/// A bell around `hz`: up or down by `gain_db`, as wide as `q` says (the RBJ cookbook's peaking EQ).
fn peak(rate: f64, hz: f64, q: f64, gain_db: f64) -> Biquad {
    let a = 10f64.powf(gain_db / 40.0);
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let (cos, alpha) = (w.cos(), w.sin() / (2.0 * q));
    normalise(1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a)
}

/// Three bands: bass (shelf at 120 Hz), mids (bell at 1 kHz), treble (shelf at 6 kHz).
pub fn eq3(audio: &AudioData, bass_db: f64, mid_db: f64, treble_db: f64) -> AudioData {
    let rate = f64::from(audio.sample_rate);
    let shelved = shelf_eq(audio, bass_db, treble_db);
    if mid_db == 0.0 {
        return shelved;
    }
    each_channel(&shelved, |c| run(c, peak(rate, 1000f64.min(rate / 2.0 - 500.0), 0.9, mid_db)))
}

/// Two shelves: bass around 120 Hz, treble around 6 kHz.
pub fn shelf_eq(audio: &AudioData, bass_db: f64, treble_db: f64) -> AudioData {
    let rate = f64::from(audio.sample_rate);
    each_channel(audio, |c| {
        let mut out = c.to_vec();
        if bass_db != 0.0 {
            out = run(&out, shelf(rate, 120.0, bass_db, false));
        }
        if treble_db != 0.0 {
            out = run(&out, shelf(rate, 6000f64.min(rate / 2.0 - 500.0), treble_db, true));
        }
        out
    })
}

/* -- Dynamics ----------------------------------------------------------------------------------- */

pub struct Compressed {
    pub audio: AudioData,
    pub max_reduction_db: f64,
    pub makeup_db: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct CompressOptions {
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup: bool,
}

impl Default for CompressOptions {
    fn default() -> Self {
        Self { attack_ms: 10.0, release_ms: 150.0, makeup: true }
    }
}

/// Feed-forward RMS compressor, channels linked, soft knee. With `makeup`, half the average gain it took
/// away is given back so the result is not just quieter.
pub fn compress_audio(audio: &AudioData, threshold_db: f64, ratio: f64, options: CompressOptions) -> Compressed {
    let rate = f64::from(audio.sample_rate);
    let n = frames(audio);
    let attack = (-1.0 / (rate * options.attack_ms * 0.001)).exp();
    let release = (-1.0 / (rate * options.release_ms * 0.001)).exp();
    let rms = (-1.0 / (rate * 0.01)).exp();
    let knee = 6.0f64;
    let mut gains = vec![0.0f32; n];
    let (mut power, mut reduction, mut max_reduction, mut reduction_sum) = (0f64, 0f64, 0f64, 0f64);
    for i in 0..n {
        let mut square = 0f64;
        for channel in &audio.channels {
            let v = f64::from(channel[i]);
            square = square.max(v * v);
        }
        power = rms * power + (1.0 - rms) * square;
        let level = if power > 1e-20 { 10.0 * power.log10() } else { -200.0 };
        let over = level - threshold_db;
        let mut wanted = 0f64;
        if over > knee / 2.0 {
            wanted = over * (1.0 - 1.0 / ratio);
        } else if over > -knee / 2.0 {
            wanted = ((over + knee / 2.0).powi(2) / (2.0 * knee)) * (1.0 - 1.0 / ratio);
        }
        reduction = if wanted > reduction { attack * reduction + (1.0 - attack) * wanted } else { release * reduction + (1.0 - release) * wanted };
        if reduction > max_reduction {
            max_reduction = reduction;
        }
        reduction_sum += reduction;
        gains[i] = reduction as f32;
    }
    // Make-up is half the average reduction: enough to sound level, not so much that the loud parts come
    // back over where they were.
    let makeup_db = if options.makeup && n > 0 { (reduction_sum / n as f64) * 0.5 } else { 0.0 };
    let channels = audio
        .channels
        .iter()
        .map(|channel| (0..n).map(|i| clamp1(f64::from(channel[i]) * db_to_gain(makeup_db - f64::from(gains[i]))) as f32).collect())
        .collect();
    Compressed { audio: AudioData { channels, sample_rate: audio.sample_rate }, max_reduction_db: max_reduction, makeup_db }
}

/* -- Noise -------------------------------------------------------------------------------------- */

const NR_FFT: usize = 2048;
const NR_HOP: usize = 512;

/// Average magnitude per bin of the silent take (the quietest two thirds of its frames).
pub fn noise_profile(noise: &[f32]) -> Vec<f32> {
    let spec = stft(noise, NR_FFT, NR_HOP).expect("a power of two");
    let mut profile = vec![0.0f32; spec.bins];
    let mut energies: Vec<(usize, f64)> = (0..spec.frames)
        .map(|f| {
            let mut e = 0f64;
            for b in 0..spec.bins {
                let (re, im) = (f64::from(spec.real[f * spec.bins + b]), f64::from(spec.imag[f * spec.bins + b]));
                e += re * re + im * im;
            }
            (f, e)
        })
        .collect();
    energies.sort_by(|a, b| a.1.total_cmp(&b.1));
    let keep = ((energies.len() as f64 * 0.66).round() as usize).max(1);
    for (f, _) in energies.iter().take(keep) {
        for b in 0..spec.bins {
            let (re, im) = (f64::from(spec.real[f * spec.bins + b]), f64::from(spec.imag[f * spec.bins + b]));
            profile[b] = (f64::from(profile[b]) + (re * re + im * im).sqrt()) as f32;
        }
    }
    for p in &mut profile {
        *p = (f64::from(*p) / keep as f64) as f32;
    }
    profile
}

/// Spectral subtraction with a gain floor and smoothing: each bin keeps the share of its energy that the
/// noise profile does not explain, never less than the floor; gains are smoothed over three bins and over
/// time, which keeps the leftover from turning into „musical noise“.
pub fn reduce_noise(input: &[f32], profile: &[f32], max_cut_db: f64) -> Vec<f32> {
    let mut spec = stft(input, NR_FFT, NR_HOP).expect("a power of two");
    let floor = db_to_gain(-max_cut_db);
    let oversubtract = 2.0f64;
    let mut previous = vec![1.0f32; spec.bins];
    let mut raw = vec![0.0f32; spec.bins];
    for f in 0..spec.frames {
        let offset = f * spec.bins;
        for b in 0..spec.bins {
            let (re, im) = (f64::from(spec.real[offset + b]), f64::from(spec.imag[offset + b]));
            let magnitude = (re * re + im * im).sqrt() + 1e-12;
            raw[b] = floor.max(1.0 - (oversubtract * f64::from(profile[b])) / magnitude) as f32;
        }
        for b in 0..spec.bins {
            let here = f64::from(raw[b]);
            let left = if b > 0 { f64::from(raw[b - 1]) } else { here };
            let right = if b + 1 < spec.bins { f64::from(raw[b + 1]) } else { here };
            let smooth = (left + here + right) / 3.0;
            let gain = if smooth > f64::from(previous[b]) { smooth } else { 0.6 * f64::from(previous[b]) + 0.4 * smooth };
            previous[b] = gain as f32;
            spec.real[offset + b] = (f64::from(spec.real[offset + b]) * gain) as f32;
            spec.imag[offset + b] = (f64::from(spec.imag[offset + b]) * gain) as f32;
        }
    }
    istft(&spec).expect("a power of two")
}

/// What the quiet part sounds like, bin by bin, from the channels mixed.
pub fn learn_noise(sample: &AudioData) -> Vec<f32> {
    let n = frames(sample);
    let mut mono = vec![0.0f32; n];
    let count = sample.channels.len() as f64;
    for channel in &sample.channels {
        for i in 0..n {
            mono[i] = (f64::from(mono[i]) + f64::from(channel[i]) / count) as f32;
        }
    }
    noise_profile(&mono)
}

pub fn remove_noise(audio: &AudioData, profile: &[f32], max_cut_db: f64) -> AudioData {
    each_channel(audio, |c| reduce_noise(c, profile, max_cut_db))
}

/* -- Space -------------------------------------------------------------------------------------- */

/// A feedback echo. `extend` lets the repeats ring out past the end.
pub fn echo(audio: &AudioData, delay_ms: f64, feedback: f64, mix: f64, extend: bool) -> AudioData {
    let rate = f64::from(audio.sample_rate);
    let delay = js_round((delay_ms / 1000.0) * rate).max(1.0) as usize;
    let tail = if extend {
        let by_decay = js_round(delay as f64 * 0.001f64.ln() / feedback.max(0.05).ln());
        js_round(rate * 6.0).min(by_decay) as usize
    } else {
        0
    };
    let n = frames(audio);
    each_channel(audio, |channel| {
        let mut out = vec![0.0f32; n + tail];
        let mut line = vec![0.0f32; n + tail];
        for i in 0..n + tail {
            let dry = if i < n { f64::from(channel[i]) } else { 0.0 };
            let echoed = if i >= delay { f64::from(line[i - delay]) } else { 0.0 };
            line[i] = (dry + echoed * feedback) as f32;
            out[i] = clamp1(dry + echoed * mix) as f32;
        }
        out
    })
}

/// The generated room: decaying, decorrelated noise, as the web app makes it.
fn room(seconds: f64, rate: u32, channel: u32) -> Vec<f32> {
    let length = (js_round(seconds * f64::from(rate)) as usize).max(1);
    let mut seed: u64 = 12345 + u64::from(channel) * 999;
    (0..length)
        .map(|i| {
            seed = (seed * 16807) % 2147483647;
            let noise = (seed as f64 / 2147483647.0) * 2.0 - 1.0;
            (noise * (-6.9 * i as f64 / length as f64).exp()) as f32
        })
        .collect()
}

/// The convolver's own calibration of a room, so that wet and dry have a similar loudness (the Web Audio
/// rule for `normalize = true`).
fn room_scale(rooms: &[Vec<f32>], rate: u32) -> f64 {
    let sum: f64 = rooms.iter().flat_map(|r| r.iter()).map(|x| f64::from(*x) * f64::from(*x)).sum();
    let count = (rooms.len() * rooms[0].len()) as f64;
    let mut power = (sum / count).sqrt();
    if !power.is_finite() || power < 0.000125 {
        power = 0.000125;
    }
    (1.0 / power) * 0.00125 * (44100.0 / f64::from(rate))
}

/// Full convolution through the FFT, in blocks.
fn convolve(input: &[f32], kernel: &[f32], keep: usize) -> Vec<f32> {
    let block = 8192usize;
    let size = (block + kernel.len() - 1).next_power_of_two();
    let fft = Fft::new(size).expect("a power of two");
    let (mut kr, mut ki) = (vec![0f64; size], vec![0f64; size]);
    for (i, k) in kernel.iter().enumerate() {
        kr[i] = f64::from(*k);
    }
    fft.forward(&mut kr, &mut ki);
    let mut out = vec![0f64; input.len() + kernel.len()];
    let mut start = 0;
    while start < input.len() {
        let end = (start + block).min(input.len());
        let (mut xr, mut xi) = (vec![0f64; size], vec![0f64; size]);
        for (i, x) in input[start..end].iter().enumerate() {
            xr[i] = f64::from(*x);
        }
        fft.forward(&mut xr, &mut xi);
        for i in 0..size {
            let (re, im) = (xr[i] * kr[i] - xi[i] * ki[i], xr[i] * ki[i] + xi[i] * kr[i]);
            xr[i] = re;
            xi[i] = im;
        }
        fft.inverse(&mut xr, &mut xi);
        for i in 0..(end - start + kernel.len() - 1) {
            out[start + i] += xr[i];
        }
        start = end;
    }
    out.truncate(keep);
    out.resize(keep, 0.0);
    out.into_iter().map(|v| v as f32).collect()
}

/// Convolution reverb with a generated room. The dry sound stays, the wet one comes in at `mix / 2`.
pub fn reverb(audio: &AudioData, seconds: f64, mix: f64, extend: bool) -> AudioData {
    let rate = audio.sample_rate;
    let n = frames(audio);
    let length = n + if extend { js_round(seconds * f64::from(rate)) as usize } else { 0 };
    let rooms = [room(seconds, rate, 0), room(seconds, rate, 1)];
    let scale = room_scale(&rooms, rate);
    let rooms: Vec<Vec<f32>> = rooms.iter().map(|r| r.iter().map(|x| (f64::from(*x) * scale) as f32).collect()).collect();
    let count = if audio.channels.len() == 1 { 2 } else { audio.channels.len() };
    let channels = (0..count)
        .map(|c| {
            let source = &audio.channels[c.min(audio.channels.len() - 1)];
            let wet = convolve(source, &rooms[c.min(1)], length);
            (0..length)
                .map(|i| {
                    let dry = if i < n { f64::from(source[i]) } else { 0.0 };
                    clamp1(dry + f64::from(wet[i]) * mix * 0.5) as f32
                })
                .collect()
        })
        .collect();
    AudioData { channels, sample_rate: rate }
}

/* -- Ranges and the clipboard ------------------------------------------------------------------- */

/// More or fewer channels: down to one by averaging, up by repeating the last.
pub fn set_channels(audio: &AudioData, count: usize) -> AudioData {
    if audio.channels.len() == count {
        return audio.clone();
    }
    let n = frames(audio);
    if count == 1 {
        let mut mixed = vec![0.0f32; n];
        let k = audio.channels.len() as f64;
        for channel in &audio.channels {
            for i in 0..n {
                mixed[i] = (f64::from(mixed[i]) + f64::from(channel[i]) / k) as f32;
            }
        }
        return AudioData { channels: vec![mixed], sample_rate: audio.sample_rate };
    }
    let channels = (0..count).map(|i| audio.channels[i.min(audio.channels.len() - 1)].clone()).collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

/// Runs `f` on a range only, and puts the result back with 5 ms crossfades at both seams: a filter
/// switched on and off mid-waveform would otherwise leave a step, and a step clicks.
pub fn process_range(audio: &AudioData, from: f64, to: f64, f: impl FnOnce(AudioData) -> AudioData) -> AudioData {
    let (start, end) = (at(audio, from), at(audio, to));
    if end < start + 2 {
        return audio.clone();
    }
    let part = AudioData { channels: audio.channels.iter().map(|c| c[start..end].to_vec()).collect(), sample_rate: audio.sample_rate };
    let processed = set_channels(&f(part), audio.channels.len());
    let fade = (js_round(f64::from(audio.sample_rate) * 0.005) as usize).min((end - start) / 2);
    let channels = audio
        .channels
        .iter()
        .enumerate()
        .map(|(index, channel)| {
            let mut out = channel.clone();
            let next = &processed.channels[index];
            for i in start..end {
                let k = i - start;
                let wet = if k < fade {
                    k as f64 / fade as f64
                } else if end - 1 - i < fade {
                    (end - 1 - i) as f64 / fade as f64
                } else {
                    1.0
                };
                out[i] = (f64::from(channel[i]) * (1.0 - wet) + f64::from(next.get(k).copied().unwrap_or(0.0)) * wet) as f32;
            }
            out
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

pub fn copy_range(audio: &AudioData, from: f64, to: f64) -> AudioData {
    let (start, end) = (at(audio, from), at(audio, to));
    let end = end.max(start);
    AudioData { channels: audio.channels.iter().map(|c| c[start..end].to_vec()).collect(), sample_rate: audio.sample_rate }
}

/// Puts `clip` in at `seconds`, pushing everything after it back.
pub fn insert_at(audio: &AudioData, seconds: f64, clip: &AudioData) -> AudioData {
    let index = at(audio, seconds);
    let fitted = set_channels(clip, audio.channels.len());
    let channels = audio
        .channels
        .iter()
        .enumerate()
        .map(|(c, channel)| {
            let mut out = Vec::with_capacity(channel.len() + frames(&fitted));
            out.extend_from_slice(&channel[..index]);
            out.extend_from_slice(&fitted.channels[c]);
            out.extend_from_slice(&channel[index..]);
            out
        })
        .collect();
    AudioData { channels, sample_rate: audio.sample_rate }
}

pub fn insert_silence(audio: &AudioData, seconds: f64, length: f64) -> AudioData {
    let silent = js_round(length * f64::from(audio.sample_rate)) as usize;
    insert_at(audio, seconds, &AudioData { channels: audio.channels.iter().map(|_| vec![0.0f32; silent]).collect(), sample_rate: audio.sample_rate })
}

/// The selection, played twice in a row.
pub fn duplicate_range(audio: &AudioData, from: f64, to: f64) -> AudioData {
    insert_at(audio, to, &copy_range(audio, from, to))
}

/// Silence over a range, with 5 ms ramps so the edges do not click.
pub fn mute_range(audio: &AudioData, from: f64, to: f64) -> AudioData {
    let (start, end) = (at(audio, from), at(audio, to));
    let ramp = (js_round(f64::from(audio.sample_rate) * 0.005) as usize).min(end.saturating_sub(start) / 2);
    each_channel(audio, |channel| {
        let mut out = channel.to_vec();
        for i in start..end {
            let k = i - start;
            let keep = if k < ramp {
                1.0 - k as f64 / ramp as f64
            } else if end - 1 - i < ramp {
                1.0 - (end - 1 - i) as f64 / ramp as f64
            } else {
                0.0
            };
            out[i] = (f64::from(channel[i]) * keep) as f32;
        }
        out
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fade {
    In,
    Out,
}

/// A fade across the whole selection, equal-power: a linear fade sounds as if it drops off early.
pub fn fade_range(audio: &AudioData, from: f64, to: f64, direction: Fade) -> AudioData {
    let (start, end) = (at(audio, from), at(audio, to));
    let span = end.saturating_sub(start).max(1) as f64;
    each_channel(audio, |channel| {
        let mut out = channel.to_vec();
        for i in start..end {
            let t = (i - start) as f64 / span;
            let gain = match direction {
                Fade::In => ((t * std::f64::consts::PI) / 2.0).sin(),
                Fade::Out => ((t * std::f64::consts::PI) / 2.0).cos(),
            };
            out[i] = (f64::from(channel[i]) * gain) as f32;
        }
        out
    })
}
