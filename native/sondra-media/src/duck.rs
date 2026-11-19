//! Voice over music, with the music stepping back whenever someone speaks — what radio calls ducking. A
//! port of `src/lib/duck.ts`, number for number: the voice is measured in 10 ms frames, speech is what rises
//! clearly above the recording's own floor, a short hold bridges the gaps between words, the music starts to
//! move a little before the first syllable, and the gain glides in decibels.
//!
//! The music has to be at the voice's rate already (the web app resamples it inside; here FFmpeg does it
//! while decoding: [`crate::audio::decode_file`] with a rate). The arrays are 32-bit floats, as there.

use crate::audio::AudioData;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DuckSettings {
    /// The music's level under no speech, relative to the file.
    pub music_db: f64,
    /// How far the music drops while someone speaks.
    pub duck_db: f64,
    /// 0 to 1; higher catches quieter speech.
    pub sensitivity: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    /// Music alone before the voice starts, in seconds.
    pub lead_in: f64,
    /// Music after the voice ends, fading out over that time.
    pub tail: f64,
    /// Repeat the music when it is shorter than the mix.
    pub loop_music: bool,
}

impl Default for DuckSettings {
    fn default() -> Self {
        DuckSettings { music_db: -14.0, duck_db: 12.0, sensitivity: 0.5, attack_ms: 120.0, release_ms: 600.0, lead_in: 2.0, tail: 3.0, loop_music: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DuckReport {
    pub voice_seconds: f64,
    pub speech_seconds: f64,
    pub threshold_db: f64,
    pub total_seconds: f64,
    /// Before the safety trim.
    pub peak_db: f64,
    /// How much the whole mix was turned down to stay under −1 dBFS.
    pub trim_db: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DuckResult {
    pub audio: AudioData,
    /// Per 10 ms of the output: the voice level in dB, −100 where silent.
    pub voice_db: Vec<f32>,
    /// Per 10 ms of the output: the music's gain in dB.
    pub music_gain_db: Vec<f32>,
    pub report: DuckReport,
}

const FRAME_SECONDS: f64 = 0.01;
const HOLD_SECONDS: f64 = 0.25;
const CEILING_DB: f64 = -1.0;

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return -100.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted[(sorted.len() - 1).min((fraction * sorted.len() as f64).floor() as usize)]
}

/// The voice's level per frame, all channels together.
fn frame_levels(voice: &AudioData, frame: usize) -> Vec<f32> {
    let length = voice.channels.first().map_or(0, Vec::len);
    let count = length.div_ceil(frame);
    let mut levels = vec![0f32; count];
    for (f, level) in levels.iter_mut().enumerate() {
        let (mut sum, mut n) = (0f64, 0usize);
        for channel in &voice.channels {
            for i in f * frame..length.min((f + 1) * frame) {
                let x = f64::from(channel[i]);
                sum += x * x;
                n += 1;
            }
        }
        *level = if n > 0 { (10.0 * (sum / n as f64 + 1e-12).log10()) as f32 } else { -100.0 };
    }
    levels
}

pub fn mix_with_ducking(voice: &AudioData, music: &AudioData, settings: &DuckSettings) -> DuckResult {
    let rate = voice.sample_rate;
    let rate_f = f64::from(rate);
    let frame = js_round(rate_f * FRAME_SECONDS) as usize;
    let voice_frames = voice.channels.first().map_or(0, Vec::len);
    let music_frames = music.channels.first().map_or(0, Vec::len);
    let lead = js_round(settings.lead_in.max(0.0) * rate_f) as usize;
    let tail = js_round(settings.tail.max(0.0) * rate_f) as usize;
    let total = lead + voice_frames + tail;

    // Where the voice speaks.
    let levels = frame_levels(voice, frame);
    let audible: Vec<f64> = levels.iter().map(|l| f64::from(*l)).filter(|l| *l > -90.0).collect();
    let floor = percentile(&audible, 0.1);
    let loud = percentile(&audible, 0.95);
    let threshold = loud - (loud - floor) * (0.25 + 0.6 * settings.sensitivity.clamp(0.0, 1.0));
    let mut speaking = vec![0u8; levels.len()];
    let hold = js_round(HOLD_SECONDS / FRAME_SECONDS) as usize;
    let ahead = 1usize.max(js_round(settings.attack_ms / 1000.0 / FRAME_SECONDS) as usize);
    for f in 0..levels.len() {
        if f64::from(levels[f]) <= threshold {
            continue;
        }
        for flag in &mut speaking[f.saturating_sub(ahead)..=(levels.len() - 1).min(f + hold)] {
            *flag = 1;
        }
    }
    // What counts as speaking is the held span, gaps between words included.
    let speech_frames: usize = speaking.iter().map(|v| *v as usize).sum();

    // The music's gain per output frame, gliding in dB.
    let out_frames = total.div_ceil(frame) + 1;
    let mut music_gain_db = vec![0f32; out_frames];
    let mut voice_db = vec![-100f32; out_frames];
    let lead_frames = lead as f64 / frame as f64;
    let down = 1.0 - (-FRAME_SECONDS / 0.005f64.max(settings.attack_ms / 1000.0)).exp();
    let up = 1.0 - (-FRAME_SECONDS / 0.005f64.max(settings.release_ms / 1000.0)).exp();
    let mut duck = 0f64;
    let tail_start = (lead + voice_frames) as f64 / frame as f64;
    let tail_frames = tail as f64 / frame as f64;
    for f in 0..out_frames {
        let v = (f as f64 - lead_frames).floor();
        let talking = v >= 0.0 && (v as usize) < speaking.len() && speaking[v as usize] == 1;
        if v >= 0.0 && (v as usize) < levels.len() {
            voice_db[f] = levels[v as usize];
        }
        let target = if talking { -settings.duck_db.max(0.0) } else { 0.0 };
        duck += (target - duck) * if target < duck { down } else { up };
        let mut fade = 0.0;
        if tail_frames > 0.0 && f as f64 > tail_start {
            fade = 20.0 * (1e-5f64.max(1.0 - (f as f64 - tail_start) / tail_frames)).log10();
        }
        music_gain_db[f] = (settings.music_db + duck + fade) as f32;
    }

    // The mix: voice in the middle of the timeline, music under all of it.
    let channels = 2;
    let mut out: Vec<Vec<f32>> = vec![vec![0f32; total]; channels];
    let music_gain: Vec<f32> = music_gain_db.iter().map(|db| 10f64.powf(f64::from(*db) / 20.0) as f32).collect();
    let pick = |a: &AudioData, c: usize| -> Option<usize> { if a.channels.is_empty() { None } else { Some(c.min(a.channels.len() - 1)) } };
    for (c, target) in out.iter_mut().enumerate() {
        let v = pick(voice, c).map(|k| &voice.channels[k]);
        let m = pick(music, c).map(|k| &music.channels[k]);
        for (i, slot) in target.iter_mut().enumerate() {
            let position = i as f64 / frame as f64;
            let f = position.floor() as usize;
            let t = position - f as f64;
            let g0 = f64::from(music_gain[f]);
            let g1 = f64::from(music_gain[(out_frames - 1).min(f + 1)]);
            let gain = g0 + (g1 - g0) * t;
            let mi = if settings.loop_music && music_frames > 0 { i % music_frames } else { i };
            let music_sample = match m {
                Some(m) if mi < music_frames => f64::from(m[mi]),
                _ => 0.0,
            };
            let voice_sample = match v {
                Some(v) if i >= lead && i - lead < voice_frames => f64::from(v[i - lead]),
                _ => 0.0,
            };
            *slot = (voice_sample + music_sample * gain) as f32;
        }
    }

    // Never over full scale: the whole mix steps down if it has to.
    let mut peak = 0f64;
    for channel in &out {
        for x in channel {
            peak = peak.max(f64::from(*x).abs());
        }
    }
    let peak_db = 20.0 * (peak + 1e-12).log10();
    let trim_db = if peak_db > CEILING_DB { peak_db - CEILING_DB } else { 0.0 };
    if trim_db > 0.0 {
        let gain = 10f64.powf(-trim_db / 20.0);
        for channel in &mut out {
            for x in channel.iter_mut() {
                *x = (f64::from(*x) * gain) as f32;
            }
        }
    }

    DuckResult {
        audio: AudioData { channels: out, sample_rate: rate },
        voice_db,
        music_gain_db,
        report: DuckReport {
            voice_seconds: voice_frames as f64 / rate_f,
            speech_seconds: speech_frames as f64 * FRAME_SECONDS,
            threshold_db: threshold,
            total_seconds: total as f64 / rate_f,
            peak_db,
            trim_db,
        },
    }
}
