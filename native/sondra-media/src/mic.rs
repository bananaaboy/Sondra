//! Microphone calibration: measure the room, then clean up a voice for a job. A port of
//! `src/lib/micCalibrate.ts`, number for number and word for word: two takes (silence, then the voice) give
//! the noise floor, the voice's level, the mains hum and a noise profile; the chain — high-pass, hum
//! notches, spectral noise reduction, gate, compressor, loudness — is set from those and from what the
//! recording is for, and every step says what it did with the values it used.
//!
//! Nothing touches the device: a program cannot turn a microphone's input gain, so that part is advice.

use crate::audio::AudioData;
use crate::effects::{noise_profile, reduce_noise};
use crate::fft::stft;
use crate::loudness::{apply_normalization, measure_loudness, Mode, NormalizationSettings};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Podcast,
    Streaming,
    Meeting,
    Vocals,
    Instrument,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Compressor {
    pub ratio: f64,
    pub below_speech_db: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PurposeProfile {
    pub id: Purpose,
    pub label: &'static str,
    pub hint: &'static str,
    /// What to do during the second take.
    pub prompt: &'static str,
    pub highpass_hz: Option<f64>,
    /// Deepest cut the noise reduction may make, in dB.
    pub noise_reduction_db: f64,
    /// How far pauses are pulled down by the gate, in dB; 0 turns it off.
    pub gate_range_db: f64,
    pub compressor: Option<Compressor>,
    pub target_lufs: f64,
    pub ceiling_dbtp: f64,
}

pub const PURPOSES: [PurposeProfile; 5] = [
    PurposeProfile {
        id: Purpose::Podcast,
        label: "Podcast",
        hint: "Stimme nah und ruhig, Pausen still, −16 LUFS wie bei Apple und Spotify",
        prompt: "Sprechen Sie ganz normal, als würden Sie eine Folge aufnehmen.",
        highpass_hz: Some(80.0),
        noise_reduction_db: 18.0,
        gate_range_db: 12.0,
        compressor: Some(Compressor { ratio: 3.0, below_speech_db: 8.0, attack_ms: 8.0, release_ms: 160.0 }),
        target_lufs: -16.0,
        ceiling_dbtp: -1.0,
    },
    PurposeProfile {
        id: Purpose::Streaming,
        label: "Streaming",
        hint: "Stimme über Spiel und Musik, Tastatur und Lüfter weg, −14 LUFS",
        prompt: "Sprechen Sie so, wie Sie im Stream sprechen — ruhig auch etwas lauter.",
        highpass_hz: Some(90.0),
        noise_reduction_db: 20.0,
        gate_range_db: 15.0,
        compressor: Some(Compressor { ratio: 4.0, below_speech_db: 10.0, attack_ms: 5.0, release_ms: 120.0 }),
        target_lufs: -14.0,
        ceiling_dbtp: -1.0,
    },
    PurposeProfile {
        id: Purpose::Meeting,
        label: "Videocall",
        hint: "Verständlichkeit vor Klang, Hintergrund so leise wie möglich",
        prompt: "Sprechen Sie wie in einer Besprechung.",
        highpass_hz: Some(110.0),
        noise_reduction_db: 24.0,
        gate_range_db: 18.0,
        compressor: Some(Compressor { ratio: 3.0, below_speech_db: 8.0, attack_ms: 8.0, release_ms: 180.0 }),
        target_lufs: -18.0,
        ceiling_dbtp: -1.0,
    },
    PurposeProfile {
        id: Purpose::Vocals,
        label: "Gesang",
        hint: "Natürlich bleiben, nur Rumpeln und Rauschen weg, Platz für den Mix",
        prompt: "Singen Sie eine Passage so laut, wie Sie später aufnehmen.",
        highpass_hz: Some(75.0),
        noise_reduction_db: 8.0,
        gate_range_db: 0.0,
        compressor: Some(Compressor { ratio: 2.0, below_speech_db: 6.0, attack_ms: 12.0, release_ms: 220.0 }),
        target_lufs: -18.0,
        ceiling_dbtp: -1.0,
    },
    PurposeProfile {
        id: Purpose::Instrument,
        label: "Instrument",
        hint: "Klang unangetastet, nur tiefes Rumpeln und Rauschen dezent weg",
        prompt: "Spielen Sie etwas, auch die lauteste Stelle.",
        highpass_hz: Some(30.0),
        noise_reduction_db: 6.0,
        gate_range_db: 0.0,
        compressor: None,
        target_lufs: -18.0,
        ceiling_dbtp: -1.0,
    },
];

pub fn profile_for(id: Purpose) -> PurposeProfile {
    PURPOSES.iter().copied().find(|p| p.id == id).unwrap_or(PURPOSES[0])
}

/* -- Measuring ---------------------------------------------------------------------------------- */

fn to_db(power: f64) -> f64 {
    if power > 1e-20 {
        10.0 * power.log10()
    } else {
        -200.0
    }
}

fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn round1(value: f64) -> f64 {
    js_round(value * 10.0) / 10.0
}

/// One decimal, as `toFixed(1)` after `round1`: no „−0,0“.
fn one_decimal(value: f64) -> String {
    let r = round1(value);
    if r == 0.0 {
        "0.0".to_owned()
    } else {
        format!("{r:.1}")
    }
}

/// German decimals and a real minus sign, as everywhere else in the interface; a plus for what grows.
fn fmt(value: f64) -> String {
    let text = if value > 0.0 { format!("+{}", one_decimal(value)) } else { one_decimal(value) };
    text.replacen('.', ",", 1).replacen('-', "−", 1)
}

fn fmt_abs(value: f64) -> String {
    one_decimal(value).replacen('.', ",", 1).replacen('-', "−", 1)
}

/// Mean square per frame, in dB.
fn frame_levels(samples: &[f32], rate: u32, frame_ms: f64) -> Vec<f64> {
    let size = (js_round(f64::from(rate) * frame_ms / 1000.0) as usize).max(1);
    let mut levels = Vec::new();
    let mut start = 0;
    while start + size <= samples.len() {
        let mut sum = 0f64;
        for s in &samples[start..start + size] {
            sum += f64::from(*s) * f64::from(*s);
        }
        levels.push(to_db(sum / size as f64));
        start += size;
    }
    levels
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    if values.is_empty() {
        return -200.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted[(sorted.len() - 1).min((fraction * sorted.len() as f64).floor() as usize)]
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measurement {
    /// RMS of the silent take, dBFS.
    pub noise_floor_db: f64,
    /// RMS over the frames where somebody was actually talking, dBFS.
    pub speech_db: f64,
    pub peak_db: f64,
    /// Samples at or above −0.1 dBFS.
    pub clipped: usize,
    pub snr_db: f64,
    pub hum_hz: Option<u32>,
}

/// Mains hum shows as a narrow peak at 50 or 60 Hz and its first overtone.
fn detect_hum(noise: &[f32], rate: u32) -> Option<u32> {
    let size = 16384usize;
    if noise.len() < size {
        return None;
    }
    let spec = stft(noise, size, size / 2).ok()?;
    let mut average = vec![0f64; spec.bins];
    for f in 0..spec.frames {
        for b in 0..spec.bins {
            let (re, im) = (f64::from(spec.real[f * spec.bins + b]), f64::from(spec.imag[f * spec.bins + b]));
            average[b] += (re * re + im * im).sqrt();
        }
    }
    let bin_hz = f64::from(rate) / size as f64;
    let get = |b: i64| -> f64 { if b >= 0 { average.get(b as usize).copied().unwrap_or(0.0) } else { 0.0 } };
    let strength = |hz: f64| -> f64 {
        let bin = js_round(hz / bin_hz) as i64;
        let mut peak = 0f64;
        for b in bin - 1..=bin + 1 {
            peak = peak.max(get(b));
        }
        let mut around: Vec<f64> = (bin - 12..=bin + 12).filter(|b| (b - bin).abs() > 3 && get(*b) != 0.0).map(get).collect();
        around.sort_by(|a, b| a.total_cmp(b));
        let floor = around.get(around.len() / 2).copied().filter(|v| *v != 0.0).unwrap_or(1e-12);
        20.0 * (peak / floor).log10()
    };
    for hz in [50u32, 60] {
        if strength(f64::from(hz)) > 12.0 && strength(f64::from(hz * 2)) > 6.0 {
            return Some(hz);
        }
    }
    None
}

pub fn measure_takes(noise: &[f32], speech: &[f32], rate: u32) -> Measurement {
    // The first quarter second of a take often carries the click of the start.
    let skip = js_round(f64::from(rate) * 0.25) as usize;
    let quiet = &noise[skip.min(noise.len())..];
    let noise_levels = frame_levels(quiet, rate, 50.0);
    // The median frame: a single cough in the silent take does not set the floor. No real microphone is
    // quieter than −120 dBFS; a device that delivers digital zero between sounds would otherwise report a
    // gap of 190 dB.
    let noise_floor_db = percentile(&noise_levels, 0.5).max(-120.0);

    let speech_levels = frame_levels(&speech[skip.min(speech.len())..], rate, 50.0);
    let loudest = percentile(&speech_levels, 0.98);
    let threshold = (noise_floor_db + 10.0).max(loudest - 30.0);
    let active: Vec<f64> = speech_levels.iter().copied().filter(|l| *l > threshold).collect();
    let speech_db = if active.is_empty() { -200.0 } else { to_db(active.iter().fold(0.0, |s, l| s + 10f64.powf(l / 10.0)) / active.len() as f64) };

    let (mut peak, mut clipped) = (0f64, 0usize);
    for s in speech {
        let value = f64::from(s.abs());
        if value > peak {
            peak = value;
        }
        if value >= 0.9886 {
            clipped += 1;
        }
    }
    Measurement { noise_floor_db, speech_db, peak_db: 20.0 * peak.max(1e-10).log10(), clipped, snr_db: speech_db - noise_floor_db, hum_hz: detect_hum(quiet, rate) }
}

/* -- Filters ------------------------------------------------------------------------------------ */

#[derive(Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

/// RBJ cookbook high-pass.
fn highpass(rate: f64, hz: f64, q: f64) -> Biquad {
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let alpha = w.sin() / (2.0 * q);
    let cos = w.cos();
    let a0 = 1.0 + alpha;
    Biquad { b0: (1.0 + cos) / 2.0 / a0, b1: -(1.0 + cos) / a0, b2: (1.0 + cos) / 2.0 / a0, a1: (-2.0 * cos) / a0, a2: (1.0 - alpha) / a0 }
}

/// RBJ cookbook notch.
fn notch(rate: f64, hz: f64, q: f64) -> Biquad {
    let w = (2.0 * std::f64::consts::PI * hz) / rate;
    let alpha = w.sin() / (2.0 * q);
    let cos = w.cos();
    let a0 = 1.0 + alpha;
    Biquad { b0: 1.0 / a0, b1: (-2.0 * cos) / a0, b2: 1.0 / a0, a1: (-2.0 * cos) / a0, a2: (1.0 - alpha) / a0 }
}

fn run_biquad(input: &[f32], f: Biquad) -> Vec<f32> {
    let mut out = vec![0.0f32; input.len()];
    let (mut x1, mut x2, mut y1, mut y2) = (0f64, 0f64, 0f64, 0f64);
    for (i, s) in input.iter().enumerate() {
        let x = f64::from(*s);
        let y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        out[i] = y as f32;
    }
    out
}

/// Fourth-order Butterworth high-pass as two biquads: 24 dB per octave.
fn highpass24(input: &[f32], rate: f64, hz: f64) -> Vec<f32> {
    run_biquad(&run_biquad(input, highpass(rate, hz, 0.5412)), highpass(rate, hz, 1.3066))
}

/// A downward expander: below the threshold, pauses get quieter by up to `range_db`. Holds open briefly
/// after a word so endings are not clipped.
fn gate(input: &[f32], rate: f64, threshold_db: f64, range_db: f64) -> (Vec<f32>, f64) {
    let mut out = vec![0.0f32; input.len()];
    let attack = (-1.0 / (rate * 0.002)).exp();
    let release = (-1.0 / (rate * 0.12)).exp();
    let hold_samples = js_round(rate * 0.08) as i64;
    let detector = (-1.0 / (rate * 0.005)).exp();
    let threshold = db_to_gain(threshold_db);
    let floor = db_to_gain(-range_db);
    let (mut envelope, mut gain, mut hold, mut closed) = (0f64, 1f64, 0i64, 0usize);
    for (i, s) in input.iter().enumerate() {
        let level = f64::from(s.abs());
        envelope = if level > envelope { level } else { detector * envelope + (1.0 - detector) * level };
        let mut target = 1.0;
        if envelope >= threshold {
            hold = hold_samples;
        } else if hold > 0 {
            hold -= 1;
        } else {
            target = floor;
        }
        gain = if target > gain { attack * gain + (1.0 - attack) * target } else { release * gain + (1.0 - release) * target };
        if gain < 0.5 {
            closed += 1;
        }
        out[i] = (f64::from(*s) * gain) as f32;
    }
    (out, if input.is_empty() { 0.0 } else { closed as f64 / input.len() as f64 })
}

/// Feed-forward RMS compressor with a 6 dB soft knee. Reports its deepest cut.
fn compress(input: &[f32], rate: f64, threshold_db: f64, ratio: f64, attack_ms: f64, release_ms: f64) -> (Vec<f32>, f64) {
    let mut out = vec![0.0f32; input.len()];
    let attack = (-1.0 / (rate * attack_ms * 0.001)).exp();
    let release = (-1.0 / (rate * release_ms * 0.001)).exp();
    let rms = (-1.0 / (rate * 0.01)).exp();
    let knee = 6.0f64;
    let (mut power, mut reduction, mut max_reduction) = (0f64, 0f64, 0f64);
    for (i, s) in input.iter().enumerate() {
        let x = f64::from(*s);
        power = rms * power + (1.0 - rms) * x * x;
        let level = to_db(power);
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
        out[i] = (x * db_to_gain(-reduction)) as f32;
    }
    (out, max_reduction)
}

/* -- The chain ---------------------------------------------------------------------------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
struct Settings {
    profile: PurposeProfile,
    measurement: Measurement,
    noise_seconds: f64,
}

struct Cleaned {
    out: Vec<f32>,
    compressor_cut_db: f64,
    closed_share: f64,
}

/// Everything except the final loudness move, identical for every take it is run on — so the silent take
/// can go through it too and show what is left of the room afterwards.
fn clean_chain(input: &[f32], rate: u32, s: &Settings, spectrum: &[f32], mut steps: Option<&mut Vec<Step>>, gate_threshold_db: Option<f64>) -> Cleaned {
    let rate_f = f64::from(rate);
    let (profile, measurement) = (&s.profile, &s.measurement);
    let mut signal: Vec<f32> = input.to_vec();
    let mut push = |title: String, detail: String| {
        if let Some(steps) = steps.as_deref_mut() {
            steps.push(Step { title, detail });
        }
    };

    if let Some(hz) = profile.highpass_hz.filter(|h| *h != 0.0) {
        signal = highpass24(&signal, rate_f, hz);
        push(
            format!("Tiefen unter {} Hz entfernt", num(hz)),
            format!(
                "Hochpass mit 24 dB pro Oktave: Trittschall, Tischklopfen, Luftzug und Rumpeln, die {} nicht braucht.",
                if profile.id == Purpose::Instrument { "das Instrument" } else { "die Stimme" }
            ),
        );
    }

    if let Some(hz) = measurement.hum_hz {
        let hz_f = f64::from(hz);
        for harmonic in [hz_f, hz_f * 2.0, hz_f * 3.0] {
            signal = run_biquad(&signal, notch(rate_f, harmonic, 30.0));
        }
        push(
            format!("Netzbrummen bei {hz} Hz entfernt"),
            format!("In der Ruhe-Aufnahme stand ein schmaler Ton bei {hz} und {} Hz — typisch für Strom, der ins Kabel streut. Drei schmale Kerbfilter bei {hz}, {} und {} Hz nehmen ihn heraus, der Rest bleibt unberührt.", hz * 2, hz * 2, hz * 3),
        );
    }

    if profile.noise_reduction_db > 0.0 {
        signal = reduce_noise(&signal, spectrum, profile.noise_reduction_db);
        push(
            format!("Hintergrundrauschen um bis zu {} dB gesenkt", num(profile.noise_reduction_db)),
            format!("Spektral, anhand der {} Sekunden Ruhe: was dort zu hören war — Lüfter, Rauschen, Raum —, wird in jedem Frequenzband so weit abgezogen, wie es die Stimme nicht übertönt. Behutsam geglättet, damit kein Zirpen zurückbleibt.", fmt_abs(s.noise_seconds)),
        );
    }

    let mut closed_share = 0.0;
    if let (true, Some(threshold)) = (profile.gate_range_db > 0.0, gate_threshold_db) {
        let (out, share) = gate(&signal, rate_f, threshold, profile.gate_range_db);
        signal = out;
        closed_share = share;
        push(
            format!("Pausen um weitere {} dB leiser", num(profile.gate_range_db)),
            format!("Gate mit Schwelle {} dBFS: öffnet in 2 ms, wenn Sie sprechen, bleibt 80 ms offen und schliesst dann weich — Atmer und Wortenden bleiben erhalten.", fmt_abs(threshold)),
        );
    }

    let mut compressor_cut_db = 0.0;
    if let Some(c) = profile.compressor {
        let threshold = measurement.speech_db - c.below_speech_db;
        let (out, cut) = compress(&signal, rate_f, threshold, c.ratio, c.attack_ms, c.release_ms);
        signal = out;
        compressor_cut_db = cut;
        push(
            format!("Kompressor {}:1 ab {} dBFS", num(c.ratio), fmt_abs(threshold)),
            format!("Laute Stellen werden um bis zu {} dB zurückgenommen, sodass leise und laute Passagen näher beieinander liegen (Ansprechzeit {} ms, Rückstellzeit {} ms).", fmt_abs(cut), num(c.attack_ms), num(c.release_ms)),
        );
    }
    Cleaned { out: signal, compressor_cut_db, closed_share }
}

/// A whole number as JavaScript prints it in a template (no „.0“).
fn num(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct After {
    pub noise_floor_db: f64,
    pub speech_db: f64,
    pub snr_db: f64,
    pub lufs: f64,
    pub true_peak_dbtp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Info,
    Warn,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Advice {
    pub tone: Tone,
    pub title: String,
    pub text: String,
}

pub struct Calibration {
    pub processed: AudioData,
    pub raw: AudioData,
    pub steps: Vec<Step>,
    pub before: Measurement,
    pub after: After,
    pub advice: Vec<Advice>,
    pub gate_threshold_db: f64,
    pub compressor_cut_db: f64,
    pub closed_share: f64,
    settings: Settings,
    spectrum: Vec<f32>,
    rate: u32,
}

impl Calibration {
    /// The same chain on any other recording from the same microphone and room, at the rate of the
    /// calibration (another rate is brought to it first, by the caller).
    pub fn apply(&self, audio: &AudioData) -> Result<AudioData, String> {
        if audio.sample_rate != self.rate {
            return Err(format!("Die Aufnahme muss mit {} Hz vorliegen.", self.rate));
        }
        let channels = audio.channels.iter().map(|c| clean_chain(c, self.rate, &self.settings, &self.spectrum, None, Some(self.gate_threshold_db)).out).collect();
        let cleaned = AudioData { channels, sample_rate: self.rate };
        let report = measure_loudness(&cleaned, &mut |_| {});
        Ok(apply_normalization(&cleaned, &report, &normalization(&self.settings.profile)).0)
    }
}

fn normalization(profile: &PurposeProfile) -> NormalizationSettings {
    NormalizationSettings { mode: Mode::Lufs, target_lufs: profile.target_lufs, target_peak_dbfs: -1.0, true_peak_ceiling_dbtp: profile.ceiling_dbtp, prevent_clipping: true, use_limiter: true }
}

pub fn calibrate(noise: &[f32], speech: &[f32], rate: u32, purpose: Purpose) -> Result<Calibration, String> {
    let profile = profile_for(purpose);
    let before = measure_takes(noise, speech, rate);
    if before.speech_db < -70.0 {
        return Err("In der zweiten Aufnahme war nichts zu hören. Ist das richtige Mikrofon gewählt und nicht stummgeschaltet?".into());
    }
    let settings = Settings { profile, measurement: before, noise_seconds: noise.len() as f64 / f64::from(rate) };
    let spectrum = noise_profile(noise);

    // Where the gate opens: a little above what is left of the room once the noise reduction has done its
    // part, and well below the voice.
    let noise_cleaned = clean_chain(noise, rate, &settings, &spectrum, None, None);
    let start = (js_round(f64::from(rate) * 0.25) as usize).min(noise_cleaned.out.len());
    let residual_floor = percentile(&frame_levels(&noise_cleaned.out[start..], rate, 50.0), 0.9);
    let gate_threshold_db = (residual_floor + 8.0).min(before.speech_db - 18.0);

    let mut steps = Vec::new();
    let speech_clean = clean_chain(speech, rate, &settings, &spectrum, Some(&mut steps), Some(gate_threshold_db));
    let noise_after_chain = clean_chain(noise, rate, &settings, &spectrum, None, Some(gate_threshold_db));

    // Loudness last, one gain for both takes so the comparison stays honest.
    let clean_audio = AudioData { channels: vec![speech_clean.out.clone()], sample_rate: rate };
    let report = measure_loudness(&clean_audio, &mut |_| {});
    let (normalized, plan) = apply_normalization(&clean_audio, &report, &normalization(&profile));
    let loudness_gain = db_to_gain(plan.applied_db);
    let noise_out: Vec<f32> = noise_after_chain.out.iter().map(|v| (f64::from(*v) * loudness_gain) as f32).collect();
    let speech_out = normalized.channels[0].clone();
    let after_measure = measure_takes(&noise_out, &speech_out, rate);
    let after_loudness = measure_loudness(&normalized, &mut |_| {});

    // The step reports what came out, measured — not what was aimed for. The limiter can leave a short
    // take a little under the target.
    let short = profile.target_lufs - after_loudness.integrated_lufs;
    steps.push(Step {
        title: format!("Auf {} LUFS gebracht", fmt_abs(after_loudness.integrated_lufs)),
        detail: format!(
            "Lautheit nach EBU R128 von {} LUFS angehoben ({} dB), Ziel {} LUFS, Spitzen unter {} dBTP.{}",
            fmt_abs(report.integrated_lufs),
            fmt(plan.applied_db),
            fmt_abs(profile.target_lufs),
            fmt_abs(profile.ceiling_dbtp),
            if plan.limiter_engaged {
                if short > 0.5 {
                    format!(" Der Begrenzer hat einzelne Spitzen weich zurückgenommen, deshalb liegt das Ergebnis {} dB unter dem Ziel.", fmt_abs(short))
                } else {
                    " Einzelne Spitzen hat der Begrenzer weich zurückgenommen.".to_string()
                }
            } else {
                String::new()
            }
        ),
    });

    let mut advice = Vec::new();
    if before.clipped > 0 || before.peak_db > -0.5 {
        advice.push(Advice { tone: Tone::Warn, title: "Übersteuert".into(), text: format!("{} Abtastwerte lagen am Anschlag. Das lässt sich nachträglich nicht reparieren: den Eingangspegel am Mikrofon oder in Windows (Einstellungen → System → Sound → Eingabe → Lautstärke) etwas senken und neu kalibrieren.", before.clipped) });
    } else if before.speech_db < -38.0 {
        advice.push(Advice { tone: Tone::Warn, title: "Sehr leise aufgenommen".into(), text: format!("Die Stimme lag bei {} dBFS. Nachträglich lauter machen hebt das Rauschen mit an — besser den Eingangspegel erhöhen (Windows: Einstellungen → System → Sound → Eingabe) oder näher ans Mikrofon.", fmt_abs(before.speech_db)) });
    } else if before.peak_db < -12.0 {
        advice.push(Advice { tone: Tone::Info, title: "Etwas Luft nach oben".into(), text: format!("Die lautesten Stellen lagen bei {} dBFS. Ein paar dB mehr Eingangspegel verbessern den Abstand zum Rauschen, ohne zu übersteuern.", fmt_abs(before.peak_db)) });
    }
    if before.snr_db < 20.0 {
        advice.push(Advice { tone: Tone::Warn, title: "Der Raum ist laut".into(), text: format!("Nur {} dB zwischen Stimme und Hintergrund. Die Filter holen viel heraus, aber näher ans Mikrofon, Fenster zu und Lüfter weg bringen mehr als jeder Filter.", fmt_abs(before.snr_db)) });
    } else if before.snr_db >= 45.0 {
        advice.push(Advice { tone: Tone::Info, title: "Sehr ruhige Umgebung".into(), text: format!("{} dB Abstand zwischen Stimme und Hintergrund — da mussten die Filter kaum eingreifen.", fmt_abs(before.snr_db)) });
    }

    Ok(Calibration {
        processed: AudioData { channels: vec![speech_out], sample_rate: rate },
        raw: AudioData { channels: vec![speech.to_vec()], sample_rate: rate },
        steps,
        before,
        after: After {
            noise_floor_db: after_measure.noise_floor_db,
            speech_db: after_measure.speech_db,
            snr_db: after_measure.speech_db - after_measure.noise_floor_db,
            lufs: after_loudness.integrated_lufs,
            true_peak_dbtp: after_loudness.true_peak_dbtp,
        },
        advice,
        gate_threshold_db,
        compressor_cut_db: speech_clean.compressor_cut_db,
        closed_share: speech_clean.closed_share,
        settings,
        spectrum,
        rate,
    })
}
