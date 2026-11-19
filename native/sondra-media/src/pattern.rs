//! Pads and patterns: how one slice sounds when it is hit, and how a grid of hits becomes a beat. A port of
//! `src/lib/pattern.ts`. The timing, the hits and the MIDI come out exactly as there; the voices are
//! rendered here (the web app lets the browser's audio engine do it): a sample voice with pitch, level, pan,
//! fades, loop and reverse, and the synth voices, in the same shapes — an exponential drop for the 808, a
//! struck tine over a triangle for the e-piano, a closing filter for the pluck, two oscillators for the
//! lead. The sound of a filter or an oscillator is not bit-identical to the browser's; the levels, the
//! lengths and the timing are.

use crate::audio::AudioData;
use crate::midi::{write_midi, MidiOptions};
use crate::pitch::Note;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayMode {
    OneShot,
    Gate,
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundKind {
    Sample,
    Warm,
    Sub808,
    EPiano,
    Pluck,
    Lead,
}

impl SoundKind {
    pub fn label(self) -> &'static str {
        match self {
            SoundKind::Sample => "Pad-Sample",
            SoundKind::Warm => "Warm-Filter",
            SoundKind::Sub808 => "808 Bass",
            SoundKind::EPiano => "E-Piano",
            SoundKind::Pluck => "Synth-Pluck",
            SoundKind::Lead => "Soft-Lead",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slice {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub semitones: f64,
    pub gain_db: f64,
    pub reverse: bool,
    pub mode: PlayMode,
    /// −1 hard left … 1 hard right.
    pub pan: f64,
    /// Fade-in at each hit, milliseconds.
    pub attack_ms: f64,
    /// Fade-out at the end of each hit, milliseconds.
    pub release_ms: f64,
    pub sound: SoundKind,
}

impl Slice {
    pub fn new(id: &str, start: f64, end: f64) -> Slice {
        Slice { id: id.into(), start, end, semitones: 0.0, gain_db: 0.0, reverse: false, mode: PlayMode::OneShot, pan: 0.0, attack_ms: 0.0, release_ms: 0.0, sound: SoundKind::Sample }
    }
}

fn db_to_gain(db: f64) -> f64 {
    if db <= -96.0 {
        0.0
    } else {
        10f64.powf(db / 20.0)
    }
}

/* -- Patterns ----------------------------------------------------------------------------------- */

/// One note in a pad's piano roll.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RollNote {
    pub step: usize,
    /// In steps; the pad sounds for exactly this long.
    pub length: usize,
    /// Relative to the pad's own pitch.
    pub semitone: f64,
    /// Relative velocity 0.1 … 1.0 (default 0.9).
    pub velocity: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pattern {
    pub steps: usize,
    pub bpm: f64,
    /// 0 is straight; 0.5 pushes every second sixteenth half a step late.
    pub swing: f64,
    /// Slice id → which steps are on.
    pub cells: std::collections::BTreeMap<String, Vec<bool>>,
    /// Slice id → its piano roll. A pad with an entry here plays its notes and not its steps: a channel is
    /// either stepped or rolled, never both at once.
    pub notes: std::collections::BTreeMap<String, Vec<RollNote>>,
    pub muted: std::collections::BTreeMap<String, bool>,
}

impl Pattern {
    pub fn new(steps: usize, bpm: f64) -> Pattern {
        Pattern { steps, bpm, swing: 0.0, cells: Default::default(), notes: Default::default(), muted: Default::default() }
    }

    pub fn has_roll(&self, id: &str) -> bool {
        self.notes.contains_key(id)
    }
}

/// The steps of a pad, as notes at its own pitch — how a roll starts out.
pub fn cells_to_notes(cells: Option<&[bool]>) -> Vec<RollNote> {
    cells.unwrap_or(&[]).iter().enumerate().filter(|(_, on)| **on).map(|(step, _)| RollNote { step, length: 1, semitone: 0.0, velocity: None }).collect()
}

/// Longer or shorter pattern: a second bar repeats the first, a shorter one keeps the start.
pub fn resize_notes(notes: &[RollNote], from: usize, to: usize) -> Vec<RollNote> {
    let mut kept: Vec<RollNote> = notes.iter().filter(|n| n.step < to).map(|n| RollNote { length: n.length.min(to - n.step), ..*n }).collect();
    if to <= from || from == 0 {
        return kept;
    }
    let mut offset = from;
    while offset < to {
        for note in notes {
            if note.step + offset < to {
                kept.push(RollNote { step: note.step + offset, ..*note });
            }
        }
        offset += from;
    }
    kept
}

pub fn step_seconds(bpm: f64) -> f64 {
    60.0 / bpm / 4.0
}

/// When step `index` falls, relative to the start of the pattern.
pub fn step_time(index: usize, bpm: f64, swing: f64) -> f64 {
    let step = step_seconds(bpm);
    index as f64 * step + if index % 2 == 1 { swing * step } else { 0.0 }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// The pad as this hit plays it: a roll note carries its pitch in here.
    pub slice: Slice,
    pub row: usize,
    pub step: usize,
    pub at: f64,
    pub hold: f64,
    pub velocity: f64,
    /// Which voice this hit replaces when pads choke: the row, or row and note.
    pub voice: String,
}

/// The hits of one pass, in order, with how long each may ring.
pub fn pattern_hits(slices: &[Slice], pattern: &Pattern) -> Vec<Hit> {
    let length = pattern.steps as f64 * step_seconds(pattern.bpm);
    let mut hits: Vec<Hit> = Vec::new();
    for (row, slice) in slices.iter().enumerate() {
        if pattern.muted.get(&slice.id).copied().unwrap_or(false) {
            continue;
        }
        if let Some(roll) = pattern.notes.get(&slice.id) {
            // A roll note sounds as long as it is drawn — a key held on a piano. Loops keep looping for that
            // long; everything else becomes a gate.
            for note in roll {
                if note.step >= pattern.steps {
                    continue;
                }
                let at = step_time(note.step, pattern.bpm, pattern.swing);
                let end = if note.step + note.length >= pattern.steps { length } else { step_time(note.step + note.length, pattern.bpm, pattern.swing) };
                hits.push(Hit {
                    slice: Slice { semitones: slice.semitones + note.semitone, mode: if slice.mode == PlayMode::Loop { PlayMode::Loop } else { PlayMode::Gate }, ..slice.clone() },
                    row,
                    step: note.step,
                    at,
                    hold: (end - at).max(0.01),
                    velocity: note.velocity.unwrap_or(0.9),
                    voice: format!("{row}:{}", note.semitone),
                });
            }
            continue;
        }
        let cells = pattern.cells.get(&slice.id).map(Vec::as_slice).unwrap_or(&[]);
        let on: Vec<usize> = cells.iter().enumerate().filter(|(step, v)| **v && *step < pattern.steps).map(|(step, _)| step).collect();
        for (index, step) in on.iter().enumerate() {
            let at = step_time(*step, pattern.bpm, pattern.swing);
            // A gate lasts one step; a loop until the row's next hit (wrapping).
            let next = if index + 1 < on.len() { step_time(on[index + 1], pattern.bpm, pattern.swing) } else { length + step_time(on[0], pattern.bpm, pattern.swing) };
            let hold = if slice.mode == PlayMode::Gate { step_seconds(pattern.bpm) } else { next - at };
            hits.push(Hit { slice: slice.clone(), row, step: *step, at, hold, velocity: 1.0, voice: row.to_string() });
        }
    }
    // A stable sort by time, as `Array.prototype.sort` is.
    hits.sort_by(|a, b| a.at.total_cmp(&b.at));
    hits
}

/// The pattern as MIDI: one note per stepped row, from C1 up — the layout drum racks and FL Studio's FPC
/// expect — one step long. Rolled pads are melodies and keep their notes, around C4 for the pad's own pitch.
pub fn pattern_to_midi(slices: &[Slice], pattern: &Pattern, loops: usize) -> Vec<u8> {
    let hits = pattern_hits(slices, pattern);
    let pass = pattern.steps as f64 * step_seconds(pattern.bpm);
    let mut notes = Vec::new();
    for p in 0..loops.max(1) {
        for hit in &hits {
            let start = p as f64 * pass + hit.at;
            let rolled = pattern.has_roll(&slices[hit.row].id);
            notes.push(Note {
                midi: if rolled { (60.0 + hit.slice.semitones - slices[hit.row].semitones).round() as i32 } else { 36 + hit.row as i32 },
                start_seconds: start,
                end_seconds: start + if rolled { hit.hold } else { step_seconds(pattern.bpm) * 0.9 },
                velocity: ((hit.velocity * 110.0).round() as i64).clamp(1, 127) as u8,
            });
        }
    }
    write_midi(&notes, &MidiOptions { bpm: pattern.bpm, track_name: Some("Sondra Pattern".into()) })
}

/// A first beat to start from: kick, snare on two and four, eighth hats.
pub fn starter_pattern(slices: &[Slice], steps: usize) -> std::collections::BTreeMap<String, Vec<bool>> {
    let mut cells = std::collections::BTreeMap::new();
    for (row, slice) in slices.iter().take(3).enumerate() {
        let line = (0..steps).map(|step| match row {
            0 => step % 8 == 0 || step % 16 == 10,
            1 => step % 8 == 4,
            _ => step % 2 == 0,
        });
        cells.insert(slice.id.clone(), line.collect());
    }
    cells
}

/* -- Voices ------------------------------------------------------------------------------------- */

/// A stereo bed to mix voices into, at `rate`.
pub struct Bed {
    pub rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl Bed {
    pub fn new(rate: u32, frames: usize) -> Bed {
        Bed { rate, left: vec![0.0; frames], right: vec![0.0; frames] }
    }
}

/// RBJ low-pass state for the voices that carry a filter.
struct LowPass {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl LowPass {
    fn new(rate: f64, hz: f64, q: f64) -> LowPass {
        let mut f = LowPass { b: [0.0; 3], a: [0.0; 2], x: [0.0; 2], y: [0.0; 2] };
        f.set(rate, hz, q);
        f
    }
    /// A new cutoff, the state kept: a filter that closes while the note rings.
    fn set(&mut self, rate: f64, hz: f64, q: f64) {
        let w = 2.0 * std::f64::consts::PI * hz.clamp(10.0, rate / 2.0 - 100.0) / rate;
        let alpha = w.sin() / (2.0 * q);
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        self.b = [(1.0 - cos) / 2.0 / a0, (1.0 - cos) / a0, (1.0 - cos) / 2.0 / a0];
        self.a = [-2.0 * cos / a0, (1.0 - alpha) / a0];
    }
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// The pad's source: the part of the take it plays, forward or reversed, at its own rate, as a pair of
/// channels (a mono take plays on both sides).
pub struct Material<'a> {
    pub audio: &'a AudioData,
}

fn sample_at(channel: &[f32], position: f64) -> f64 {
    let i = position.floor();
    if i < 0.0 || i as usize >= channel.len() {
        return 0.0;
    }
    let i = i as usize;
    let t = position - i as f64;
    let a = f64::from(channel[i]);
    let b = f64::from(*channel.get(i + 1).unwrap_or(&channel[i]));
    a + (b - a) * t
}

/// The equal-power gains of a stereo panner (`pan` −1 … 1) for a mono source.
fn pan_gains(pan: f64) -> (f64, f64) {
    let x = (pan.clamp(-1.0, 1.0) + 1.0) / 2.0;
    ((x * std::f64::consts::FRAC_PI_2).cos(), (x * std::f64::consts::FRAC_PI_2).sin())
}

/// Puts one hit of `slice` into `bed` at `when` seconds. `hold` bounds gate and loop pads. Returns how long
/// the voice lasts, in seconds, so that a choke can cut it.
pub fn render_voice(bed: &mut Bed, material: &Material, slice: &Slice, when: f64, hold: Option<f64>, velocity: f64, cut_at: Option<f64>) {
    let rate = f64::from(bed.rate);
    let vel = velocity.clamp(0.01, 1.0);
    let level = db_to_gain(slice.gain_db) * vel;
    let attack = slice.attack_ms / 1000.0;
    let release = slice.release_ms / 1000.0;
    let (gl, gr) = pan_gains(slice.pan);
    let stereo = material.audio.channels.len() >= 2;
    let start_frame = (when * rate).round() as i64;

    // One voice, as a function of time since its start: its signal and when it is over.
    let (lasts, mut signal): (f64, Box<dyn FnMut(f64) -> (f64, f64)>) = match slice.sound {
        SoundKind::Sample | SoundKind::Warm => {
            let source = material.audio;
            let total = source.frames() as f64 / f64::from(source.sample_rate);
            let length = (slice.end - slice.start).max(0.005);
            let ratio = 2f64.powf(slice.semitones / 12.0);
            let natural = length / ratio;
            let lasts = match slice.mode {
                PlayMode::OneShot => natural,
                PlayMode::Gate => hold.unwrap_or(natural),
                PlayMode::Loop => hold.unwrap_or(f64::INFINITY),
            };
            let (from, to) = if slice.reverse { (total - slice.end, total - slice.start) } else { (slice.start, slice.end) };
            let src_rate = f64::from(source.sample_rate);
            let channels = source.channels.clone();
            let reverse = slice.reverse;
            let looping = slice.mode == PlayMode::Loop;
            let mut filter = (slice.sound == SoundKind::Warm).then(|| [LowPass::new(rate, 1750.0, 0.85), LowPass::new(rate, 1750.0, 0.85)]);
            (
                lasts,
                Box::new(move |t: f64| {
                    let mut at = t * ratio;
                    if looping {
                        at %= to - from;
                    } else if at >= to - from {
                        return (0.0, 0.0);
                    }
                    // Reversed: the take is read backwards from the end of the chosen part.
                    let position = if reverse { (to - at) * src_rate } else { (from + at) * src_rate };
                    let l = sample_at(&channels[0], position);
                    let r = if channels.len() >= 2 { sample_at(&channels[1], position) } else { l };
                    match filter.as_mut() {
                        Some(f) => (f[0].run(l), f[1].run(r)),
                        None => (l, r),
                    }
                }),
            )
        }
        kind => {
            let base = (if kind == SoundKind::Sub808 { 65.41 } else { 261.63 }) * 2f64.powf(slice.semitones / 12.0);
            let lasts = hold.map(|h| h.max(0.08)).unwrap_or(if kind == SoundKind::Sub808 { 0.65 } else { 0.45 });
            let tau = 2.0 * std::f64::consts::PI;
            let mut phase = 0.0f64;
            let mut phase2 = 0.0f64;
            let mut lp = match kind {
                SoundKind::Sub808 => Some(LowPass::new(rate, 240.0, std::f64::consts::FRAC_1_SQRT_2)),
                SoundKind::EPiano => Some(LowPass::new(rate, 2400.0, std::f64::consts::FRAC_1_SQRT_2)),
                SoundKind::Lead => Some(LowPass::new(rate, (base * 5.0).min(9000.0), std::f64::consts::FRAC_1_SQRT_2)),
                _ => None,
            };
            let mut pluck = LowPass::new(rate, (base * 9.0).min(12000.0), 2.2);
            (
                lasts,
                Box::new(move |t: f64| {
                    let dt = 1.0 / rate;
                    let value = match kind {
                        SoundKind::Sub808 => {
                            // From just over an octave above to the note in 45 ms, exponentially.
                            let hz = if t < 0.045 { (base * 2.1) * (base.max(24.0) / (base * 2.1)).powf(t / 0.045) } else { base.max(24.0) };
                            phase += tau * hz * dt;
                            phase.sin()
                        }
                        SoundKind::EPiano => {
                            phase += tau * base * dt;
                            phase2 += tau * base * 4.0 * dt;
                            let cycle = phase / tau;
                            let body = 4.0 * (cycle - (cycle + 0.5).floor()).abs() - 1.0;
                            let tine = 0.22 * vel * phase2.sin() * (0.001f64).powf((t / lasts.min(0.18)).min(1.0));
                            body + tine
                        }
                        SoundKind::Pluck => {
                            phase += tau * base * dt;
                            let saw = 2.0 * (phase / tau - (phase / tau).floor()) - 1.0;
                            let top = (base * 9.0).min(12000.0);
                            let low = (base * 1.4).max(180.0);
                            let fall = (t / lasts.min(0.16)).min(1.0);
                            let hz = top * (low / top).powf(fall);
                            pluck.set(rate, hz, 2.2);
                            pluck.run(saw)
                        }
                        _ => {
                            phase += tau * base * dt;
                            phase2 += tau * base * 1.004 * dt;
                            let saw = 2.0 * (phase / tau - (phase / tau).floor()) - 1.0;
                            let cycle2 = phase2 / tau;
                            let tri = 4.0 * (cycle2 - (cycle2 + 0.5).floor()).abs() - 1.0;
                            saw + 0.55 * tri
                        }
                    };
                    let value = match lp.as_mut() {
                        Some(f) => f.run(value),
                        None => value,
                    };
                    (value, value)
                }),
            )
        }
    };

    let synth = !matches!(slice.sound, SoundKind::Sample | SoundKind::Warm);
    let body_level = if synth { level * 0.7 } else { level };
    // The fade at the end of a hit: at least a few milliseconds, so that nothing clicks.
    let fade = if synth { 0.015f64.max(release.max(if slice.sound == SoundKind::Pluck && release == 0.0 { 0.08 } else { 0.04 }).min(lasts * 0.6)) } else { 0.004f64.max(release.max(0.0).min(lasts)).min(lasts) };
    let end_time = if lasts.is_finite() { lasts } else { f64::INFINITY };
    let frames = bed.left.len() as i64;
    let mut frame = start_frame.max(0);
    while frame < frames {
        let t = (frame - start_frame) as f64 / rate;
        if t >= end_time + 0.01 {
            break;
        }
        if let Some(cut) = cut_at {
            if when + t >= cut + release.max(0.006) {
                break;
            }
        }
        let mut g = body_level;
        if attack > 0.0 && t < attack {
            g *= t / attack;
        }
        if lasts.is_finite() && t > lasts - fade {
            g *= ((lasts - t) / fade).clamp(0.0, 1.0);
        }
        if let Some(cut) = cut_at {
            let into = when + t - cut;
            if into > 0.0 {
                g *= (1.0 - into / release.max(0.006)).clamp(0.0, 1.0);
            }
        }
        let (l, r) = signal(t);
        let (l, r) = if stereo && !synth {
            // A stereo source is panned by moving its sides, as the browser does.
            if slice.pan <= 0.0 {
                let x = slice.pan + 1.0;
                (l + r * (x * std::f64::consts::FRAC_PI_2).cos(), r * (x * std::f64::consts::FRAC_PI_2).sin())
            } else {
                let x = slice.pan;
                (l * (x * std::f64::consts::FRAC_PI_2).cos(), r + l * (x * std::f64::consts::FRAC_PI_2).sin())
            }
        } else {
            (l * gl, r * gr)
        };
        let i = frame as usize;
        bed.left[i] += (l * g) as f32;
        bed.right[i] += (r * g) as f32;
        frame += 1;
    }
}

/// Renders `loops` passes offline. The ring-out past the end is folded back onto the start, so the file loops
/// without a gap and without a cut-off tail.
pub fn bounce_pattern(slices: &[Slice], pattern: &Pattern, material: &Material, loops: usize, choke: bool) -> AudioData {
    let rate = material.audio.sample_rate;
    let pass = pattern.steps as f64 * step_seconds(pattern.bpm);
    let tail = 2.0;
    let frames = ((pass * loops as f64 + tail) * f64::from(rate)).ceil() as usize;
    let hits = pattern_hits(slices, pattern);
    let mut bed = Bed::new(rate, frames);
    // With choke, a hit cuts the one before it on the same voice: the cut comes from the next hit's time.
    let mut order: Vec<(f64, usize)> = Vec::new();
    for p in 0..loops.max(1) {
        for (i, hit) in hits.iter().enumerate() {
            order.push((p as f64 * pass + hit.at, i));
        }
    }
    let cuts: Vec<Option<f64>> = order
        .iter()
        .enumerate()
        .map(|(k, (_, i))| {
            if !choke {
                return None;
            }
            order[k + 1..].iter().find(|(_, j)| hits[*j].voice == hits[*i].voice).map(|(at, _)| *at)
        })
        .collect();
    for (k, (when, i)) in order.iter().enumerate() {
        let hit = &hits[*i];
        let hold = if hit.slice.mode == PlayMode::OneShot { None } else { Some(hit.hold) };
        render_voice(&mut bed, material, &hit.slice, *when, hold, hit.velocity, cuts[k]);
    }
    let length = (pass * loops as f64 * f64::from(rate)).round() as usize;
    let fold = |channel: &[f32]| -> Vec<f32> {
        let mut out = vec![0.0f32; length];
        out[..length.min(channel.len())].copy_from_slice(&channel[..length.min(channel.len())]);
        for i in length..channel.len() {
            if length > 0 {
                out[(i - length) % length] += channel[i];
            }
        }
        out.iter().map(|v| v.clamp(-1.0, 1.0)).collect()
    };
    AudioData { channels: vec![fold(&bed.left), fold(&bed.right)], sample_rate: rate }
}
