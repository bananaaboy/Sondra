//! A Standard MIDI File writer, format 0, and the small helpers around it. A port of the file-writing
//! half of `src/lib/midi.ts`. (Talking to MIDI hardware — keyboards, drum pads — is a matter of the
//! platform and comes with the sampler, not here.)

use crate::key::{ChordSpan, Quality};
use crate::pitch::Note;

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Chord spans as polyphonic MIDI notes, four voices per chord: the root as a bass in octave 3 (48 + root)
/// and a full triad in octave 4 (60 + root, + third, + fifth).
pub fn chords_to_midi_notes(chords: &[ChordSpan]) -> Vec<Note> {
    let mut notes = Vec::new();
    for span in chords {
        let Some(root) = span.root else { continue };
        let third = if span.quality == Some(Quality::Moll) {
            3
        } else {
            4
        };
        let root = root as i32;
        for pitch in [48 + root, 60 + root, 60 + root + third, 60 + root + 7] {
            notes.push(Note {
                midi: pitch,
                start_seconds: span.start_seconds,
                end_seconds: span.end_seconds,
                velocity: 82,
            });
        }
    }
    notes
}

/// Ticks per quarter note. 480 is the common DAW default.
const TICKS_PER_QUARTER: f64 = 480.0;

/// MIDI delta times are variable-length: seven bits per byte, high bit set on every byte but the last.
fn variable_length(value: f64) -> Vec<u8> {
    let clamped = js_round(value).max(0.0) as u64;
    let mut bytes = vec![(clamped & 0x7f) as u8];
    let mut rest = clamped >> 7;
    while rest > 0 {
        bytes.insert(0, ((rest & 0x7f) as u8) | 0x80);
        rest >>= 7;
    }
    bytes
}

fn chunk(id: &str, body: &[u8]) -> Vec<u8> {
    let length = body.len();
    let mut out: Vec<u8> = id.bytes().collect();
    out.extend([
        (length >> 24) as u8,
        (length >> 16) as u8,
        (length >> 8) as u8,
        length as u8,
    ]);
    out.extend_from_slice(body);
    out
}

#[derive(Debug, Clone, Default)]
pub struct MidiOptions {
    pub bpm: f64,
    /// Shown as the track name in most DAWs.
    pub track_name: Option<String>,
}

/// Renders notes as a `.mid` file.
pub fn write_midi(notes: &[Note], options: &MidiOptions) -> Vec<u8> {
    let bpm = if options.bpm > 0.0 {
        options.bpm
    } else {
        120.0
    };
    let ticks_per_second = TICKS_PER_QUARTER * bpm / 60.0;

    // (tick, data)
    let mut events: Vec<(i64, [u8; 3])> = Vec::new();
    for note in notes {
        let midi = js_round(f64::from(note.midi)).clamp(0.0, 127.0) as u8;
        let velocity = js_round(f64::from(note.velocity)).clamp(1.0, 127.0) as u8;
        let on = js_round(note.start_seconds * ticks_per_second) as i64;
        let off = (on + 1).max(js_round(note.end_seconds * ticks_per_second) as i64);
        events.push((on, [0x90, midi, velocity]));
        // The real note-off status keeps the file readable in editors that show raw events.
        events.push((off, [0x80, midi, 0]));
    }
    // Note-off must precede note-on at the same tick, or a repeated pitch is cut short by its own predecessor.
    events.sort_by(|a, b| a.0.cmp(&b.0).then((a.1[0] & 0xf0).cmp(&(b.1[0] & 0xf0))));

    let mut track: Vec<u8> = Vec::new();
    // Tempo, as microseconds per quarter note.
    let microseconds = js_round(60_000_000.0 / bpm) as u32;
    track.extend(variable_length(0.0));
    track.extend([
        0xff,
        0x51,
        0x03,
        (microseconds >> 16) as u8,
        (microseconds >> 8) as u8,
        microseconds as u8,
    ]);
    if let Some(name) = &options.track_name {
        // `charCodeAt(0) & 0x7f` per UTF-16 unit, at most 120.
        let bytes: Vec<u8> = name
            .encode_utf16()
            .map(|c| (c & 0x7f) as u8)
            .take(120)
            .collect();
        track.extend(variable_length(0.0));
        track.extend([0xff, 0x03, bytes.len() as u8]);
        track.extend(bytes);
    }
    let mut previous = 0i64;
    for (tick, data) in events {
        track.extend(variable_length((tick - previous) as f64));
        track.extend(data);
        previous = tick;
    }
    track.extend(variable_length(0.0));
    track.extend([0xff, 0x2f, 0x00]); // end of track

    let ticks = TICKS_PER_QUARTER as u16;
    let mut out = chunk("MThd", &[0, 0, 0, 0, (ticks >> 8) as u8, ticks as u8]);
    out.extend(chunk("MTrk", &track));
    out
}

/// Maps incoming MIDI note numbers to pad indices (0..15): the standard MPC / General MIDI drum notes
/// 36–51 map 1:1, as do 48–63 and 60–75.
pub fn midi_note_to_pad_index(note: i32) -> usize {
    if (36..=51).contains(&note) {
        return (note - 36) as usize;
    }
    if (48..=63).contains(&note) {
        return (note - 48) as usize;
    }
    if (60..=75).contains(&note) {
        return (note - 60) as usize;
    }
    note.rem_euclid(16) as usize
}
