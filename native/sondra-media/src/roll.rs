//! A pad's piano roll — the gestures of `PianoRoll.tsx`, as rules: two octaves either side of the pad's own pitch (the
//! C in the middle), one column a step. A press on empty ground sets a note (as long as the last one drawn, with a chord
//! when a stamp is chosen) and a drag lengthens it; a press on a note takes hold of it — its right edge changes its length,
//! the rest moves it — and a click without a drag takes it away; two notes on one key and step are one note.
//!
//! The pointer is given as a position in the grid (`x`, `y` from its top left, in pixels) with the grid's `width` and
//! the height of a row, so the rules do not know about windows.

use crate::pattern::RollNote;

/// The highest and lowest key, in semitones from the pad's pitch.
pub const TOP: i32 = 16;
pub const BOTTOM: i32 = -16;
pub const ROWS: usize = (TOP - BOTTOM + 1) as usize;
/// Pitch class names, German: H for B.
pub const NAMES: [&str; 12] = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "H"];
const BLACK: [i32; 5] = [1, 3, 6, 8, 10];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scale {
    Chromatic,
    Minor,
    Major,
    Pentatonic,
    Blues,
}

impl Scale {
    pub const ALL: [Scale; 5] = [Scale::Chromatic, Scale::Minor, Scale::Major, Scale::Pentatonic, Scale::Blues];

    pub fn label(self) -> &'static str {
        match self {
            Scale::Chromatic => "Alle Töne",
            Scale::Minor => "Moll",
            Scale::Major => "Dur",
            Scale::Pentatonic => "Pentatonik",
            Scale::Blues => "Blues",
        }
    }

    fn classes(self) -> &'static [i32] {
        match self {
            Scale::Chromatic => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            Scale::Minor => &[0, 2, 3, 5, 7, 8, 10],
            Scale::Major => &[0, 2, 4, 5, 7, 9, 11],
            Scale::Pentatonic => &[0, 3, 5, 7, 10],
            Scale::Blues => &[0, 3, 5, 6, 7, 10],
        }
    }

    pub fn allows(self, semitone: i32) -> bool {
        self.classes().contains(&pitch_class(semitone))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stamp {
    Single,
    Minor,
    Major,
    Octave,
}

impl Stamp {
    pub const ALL: [Stamp; 4] = [Stamp::Single, Stamp::Minor, Stamp::Major, Stamp::Octave];

    pub fn label(self) -> &'static str {
        match self {
            Stamp::Single => "Einzelton",
            Stamp::Minor => "Moll-Akkord",
            Stamp::Major => "Dur-Akkord",
            Stamp::Octave => "Oktave",
        }
    }

    fn intervals(self) -> &'static [i32] {
        match self {
            Stamp::Single => &[0],
            Stamp::Minor => &[0, 3, 7],
            Stamp::Major => &[0, 4, 7],
            Stamp::Octave => &[0, 12],
        }
    }
}

pub fn pitch_class(semitone: i32) -> i32 {
    semitone.rem_euclid(12)
}

pub fn is_black(semitone: i32) -> bool {
    BLACK.contains(&pitch_class(semitone))
}

/// „C4“, „H3“ … the pad's own pitch is C4.
pub fn note_name(semitone: i32) -> String {
    format!("{}{}", NAMES[pitch_class(semitone) as usize], 4 + semitone.div_euclid(12))
}

/// The nearest key the scale allows, looking up first and then down, up to six semitones.
pub fn snap_to_scale(semitone: i32, scale: Scale) -> i32 {
    if scale.allows(semitone) {
        return semitone;
    }
    for delta in 1..=6 {
        if semitone + delta <= TOP && scale.allows(semitone + delta) {
            return semitone + delta;
        }
        if semitone - delta >= BOTTOM && scale.allows(semitone - delta) {
            return semitone - delta;
        }
    }
    semitone
}

/// Where the pointer is in the grid.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cell {
    pub step: usize,
    /// Snapped to the scale.
    pub semitone: i32,
    /// What the row under the pointer says, before snapping.
    pub raw_semitone: i32,
    pub x: f32,
}

pub fn cell_at(x: f32, y: f32, width: f32, row_height: f32, steps: usize, scale: Scale) -> Cell {
    let steps_f = steps.max(1) as f32;
    let step = ((x / width.max(1.0)) * steps_f).floor().clamp(0.0, steps_f - 1.0) as usize;
    let raw = (TOP - (y / row_height.max(1.0)).floor() as i32).clamp(BOTTOM, TOP);
    let semitone = if scale == Scale::Chromatic { raw } else { snap_to_scale(raw, scale) };
    Cell { step, semitone, raw_semitone: raw, x }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Move,
    Resize,
    New,
}

/// What the pointer holds while it is down.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Gesture {
    pub index: usize,
    pub kind: Kind,
    pub down_step: usize,
    pub down_semitone: i32,
    pub origin: RollNote,
    pub moved: bool,
}

/// What a press or move did that the caller should act on.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Outcome {
    /// The pad is to be heard at this pitch.
    pub audition: Option<i32>,
}

fn same_key(note: &RollNote, semitone: i32) -> bool {
    note.semitone == f64::from(semitone)
}

/// A press at `cell`. On a note it takes hold (near its right edge: of its length); on empty ground it sets a note —
/// and a chord when a stamp is chosen — as long as `last_length`.
pub fn press(notes: &mut Vec<RollNote>, cell: Cell, width: f32, steps: usize, scale: Scale, stamp: Stamp, last_length: usize) -> (Option<Gesture>, Outcome) {
    let column = width / steps.max(1) as f32;
    let found = notes.iter().position(|n| (same_key(n, cell.raw_semitone) || same_key(n, cell.semitone)) && cell.step >= n.step && cell.step < n.step + n.length);
    if let Some(index) = found {
        let note = notes[index];
        let right_edge = (note.step + note.length) as f32 / steps.max(1) as f32 * width;
        let kind = if right_edge - cell.x <= (8.0f32).max(column * 0.32) { Kind::Resize } else { Kind::Move };
        return (Some(Gesture { index, kind, down_step: cell.step, down_semitone: note.semitone as i32, origin: note, moved: false }), Outcome::default());
    }
    let length = last_length.max(1).min(steps - cell.step);
    let added: Vec<RollNote> = stamp
        .intervals()
        .iter()
        .map(|offset| cell.semitone + offset)
        .filter(|pitch| (BOTTOM..=TOP).contains(pitch))
        .map(|pitch| RollNote { step: cell.step, length, semitone: f64::from(if scale == Scale::Chromatic { pitch } else { snap_to_scale(pitch, scale) }), velocity: Some(0.9) })
        .collect();
    let index = notes.len();
    let origin = added.first().copied().unwrap_or(RollNote { step: cell.step, length, semitone: f64::from(cell.semitone), velocity: Some(0.9) });
    notes.extend(added);
    (Some(Gesture { index, kind: Kind::New, down_step: cell.step, down_semitone: cell.semitone, origin, moved: false }), Outcome { audition: Some(cell.semitone) })
}

/// The pointer moves with something held: a note moves (to the cell it was dragged by), or its length follows.
pub fn drag(notes: &mut [RollNote], gesture: &mut Gesture, cell: Cell, steps: usize, scale: Scale) -> Outcome {
    let Some(note) = notes.get(gesture.index).copied() else { return Outcome::default() };
    let mut outcome = Outcome::default();
    let next = if gesture.kind == Kind::Move {
        let start = (gesture.origin.step as i64 + cell.step as i64 - gesture.down_step as i64).clamp(0, (steps - gesture.origin.length) as i64) as usize;
        let raw = (gesture.origin.semitone as i32 + cell.semitone - gesture.down_semitone).clamp(BOTTOM, TOP);
        let pitch = if scale == Scale::Chromatic { raw } else { snap_to_scale(raw, scale) };
        if !same_key(&note, pitch) {
            outcome.audition = Some(pitch);
        }
        RollNote { step: start, semitone: f64::from(pitch), ..gesture.origin }
    } else {
        let length = (cell.step as i64 - note.step as i64 + 1).clamp(1, (steps - note.step) as i64) as usize;
        RollNote { length, ..note }
    };
    if next == note {
        return Outcome { audition: None };
    }
    gesture.moved = true;
    notes[gesture.index] = next;
    outcome
}

/// The pointer is up. A click on a note without a drag takes it away; a note that was drawn or lengthened gives its length to
/// the next one; two notes on one key and step become one. Returns the length to remember, when there is one.
pub fn release(notes: &mut Vec<RollNote>, gesture: Gesture) -> Option<usize> {
    if gesture.kind == Kind::Move && !gesture.moved {
        if gesture.index < notes.len() {
            notes.remove(gesture.index);
        }
        return None;
    }
    let note = *notes.get(gesture.index)?;
    let mut at = 0;
    notes.retain(|other| {
        let keep = at == gesture.index || other.semitone != note.semitone || other.step != note.step;
        at += 1;
        keep
    });
    (gesture.kind != Kind::Move).then_some(note.length)
}

/// The dynamics lane: every note that sounds in `step` gets this velocity (0.15 … 1, two decimals).
pub fn set_velocity(notes: &mut [RollNote], step: usize, velocity: f64) -> bool {
    let velocity = (velocity.clamp(0.15, 1.0) * 100.0).round() / 100.0;
    let mut changed = false;
    for note in notes.iter_mut().filter(|n| step >= n.step && step < n.step + n.length) {
        note.velocity = Some(velocity);
        changed = true;
    }
    changed
}

/// The whole roll an octave up or down, never past one octave either side (as the web app's button does).
pub fn shift_octave(notes: &[RollNote], delta: i32) -> Vec<RollNote> {
    notes.iter().map(|n| RollNote { semitone: (n.semitone + f64::from(delta)).clamp(-12.0, 12.0), ..*n }).collect()
}

/// Back to steps: every note's start becomes a step at the pad's pitch.
pub fn notes_to_cells(notes: &[RollNote], steps: usize) -> Vec<bool> {
    let mut cells = vec![false; steps];
    for note in notes {
        if let Some(cell) = cells.get_mut(note.step) {
            *cell = true;
        }
    }
    cells
}
