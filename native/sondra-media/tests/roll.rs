//! The piano roll's gestures: the rules of `PianoRoll.tsx` — set, lengthen, move, resize, take away, snap, stamp.

use sondra_media::pattern::RollNote;
use sondra_media::roll::*;

const W: f32 = 1600.0; // 16 steps of 100 px
const ROW: f32 = 24.0;
const STEPS: usize = 16;

fn at(step: usize, semitone: i32, scale: Scale) -> Cell {
    // The middle of the cell.
    cell_at(step as f32 * 100.0 + 50.0, (TOP - semitone) as f32 * ROW + 12.0, W, ROW, STEPS, scale)
}

fn note(step: usize, length: usize, semitone: i32) -> RollNote {
    RollNote { step, length, semitone: f64::from(semitone), velocity: Some(0.9) }
}

#[test]
fn the_pointer_is_a_step_and_a_key_and_the_key_may_snap_to_a_scale() {
    let c = cell_at(250.0, 0.0, W, ROW, STEPS, Scale::Chromatic);
    assert_eq!((c.step, c.semitone), (2, TOP));
    // Past the edges stays inside.
    let c = cell_at(9999.0, 9999.0, W, ROW, STEPS, Scale::Chromatic);
    assert_eq!((c.step, c.semitone), (15, BOTTOM));
    let c = cell_at(-5.0, -5.0, W, ROW, STEPS, Scale::Chromatic);
    assert_eq!((c.step, c.semitone), (0, TOP));
    // C sharp is not in C major: the next key up is taken (up first, then down).
    assert_eq!(snap_to_scale(1, Scale::Major), 2);
    assert_eq!(snap_to_scale(-1, Scale::Major), -1, "H is in C major, it stays");
    assert_eq!(snap_to_scale(-2, Scale::Major), -1, "B flat is no key of C major: the next one up, H, is taken");
    assert_eq!(snap_to_scale(1, Scale::Pentatonic), 0, "at each distance up is tried before down: 2 is no key, 0 is");
    let c = at(3, 1, Scale::Major);
    assert_eq!((c.semitone, c.raw_semitone), (2, 1));
    // Names: the pad's own pitch is C4.
    assert_eq!(note_name(0), "C4");
    assert_eq!(note_name(11), "H4");
    assert_eq!(note_name(-1), "H3");
    assert_eq!(note_name(12), "C5");
    assert!(is_black(1) && !is_black(0));
}

#[test]
fn a_press_on_empty_ground_sets_a_note_as_long_as_the_last_and_a_drag_lengthens_it() {
    let mut notes = Vec::new();
    let (gesture, outcome) = press(&mut notes, at(4, 3, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Single, 2);
    assert_eq!(notes, [note(4, 2, 3)]);
    assert_eq!(outcome.audition, Some(3), "the key is heard as it is set");
    let mut g = gesture.unwrap();
    assert_eq!(g.kind, Kind::New);
    // Dragging right lengthens it, never past the end.
    drag(&mut notes, &mut g, at(8, 3, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!(notes[0].length, 5);
    drag(&mut notes, &mut g, at(15, 3, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!(notes[0].length, 12);
    // Never shorter than one.
    drag(&mut notes, &mut g, at(0, 3, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!(notes[0].length, 1);
    drag(&mut notes, &mut g, at(6, 3, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!(release(&mut notes, g), Some(3), "the length the next note starts with");
    assert_eq!(notes, [note(4, 3, 3)]);
    // A new note near the end is cut short.
    let (_, _) = press(&mut notes, at(15, -2, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Single, 4);
    assert_eq!(notes[1], note(15, 1, -2));
}

#[test]
fn a_stamp_sets_a_chord_within_the_keys_and_the_scale() {
    let mut notes = Vec::new();
    press(&mut notes, at(0, 0, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Minor, 1);
    let keys: Vec<f64> = notes.iter().map(|n| n.semitone).collect();
    assert_eq!(keys, [0.0, 3.0, 7.0]);
    // An octave stamp near the top leaves out what is past it.
    let mut high = Vec::new();
    press(&mut high, at(0, 10, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Octave, 1);
    assert_eq!(high.iter().map(|n| n.semitone).collect::<Vec<_>>(), [10.0], "22 is past the top");
    // In a scale each key snaps.
    let mut major = Vec::new();
    press(&mut major, at(0, 0, Scale::Major), W, STEPS, Scale::Major, Stamp::Minor, 1);
    assert_eq!(major.iter().map(|n| n.semitone).collect::<Vec<_>>(), [0.0, 4.0, 7.0], "E flat becomes E");
}

#[test]
fn a_note_is_taken_by_its_edge_to_lengthen_or_elsewhere_to_move_and_a_click_takes_it_away() {
    let start = vec![note(4, 4, 0), note(10, 2, 5)];
    // Near the right edge (step 4..8 ends at x = 800): resize.
    let mut notes = start.clone();
    let c = cell_at(795.0, (TOP) as f32 * ROW + 12.0, W, ROW, STEPS, Scale::Chromatic);
    let (g, _) = press(&mut notes, c, W, STEPS, Scale::Chromatic, Stamp::Single, 2);
    let mut g = g.unwrap();
    assert_eq!(g.kind, Kind::Resize);
    drag(&mut notes, &mut g, at(11, 0, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!(notes[0].length, 8);
    release(&mut notes, g);
    assert_eq!(notes.len(), 2);

    // In the body: move, by the cell it was taken at.
    let mut notes = start.clone();
    let (g, _) = press(&mut notes, at(5, 0, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Single, 2);
    let mut g = g.unwrap();
    assert_eq!(g.kind, Kind::Move);
    let out = drag(&mut notes, &mut g, at(7, 3, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!((notes[0].step, notes[0].semitone), (6, 3.0));
    assert_eq!(out.audition, Some(3), "a new key is heard");
    // Never out of the grid.
    drag(&mut notes, &mut g, at(15, -40, Scale::Chromatic), STEPS, Scale::Chromatic);
    assert_eq!((notes[0].step, notes[0].length), (12, 4));
    assert_eq!(notes[0].semitone, f64::from(BOTTOM));
    release(&mut notes, g);

    // A click without a drag takes the note away.
    let mut notes = start.clone();
    let (g, _) = press(&mut notes, at(11, 5, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Single, 2);
    let g = g.unwrap();
    assert_eq!(g.kind, Kind::Move);
    assert_eq!(release(&mut notes, g), None);
    assert_eq!(notes, [note(4, 4, 0)]);
}

#[test]
fn two_notes_on_one_key_and_step_are_one() {
    let mut notes = vec![note(4, 2, 0), note(8, 2, 0)];
    let (g, _) = press(&mut notes, at(8, 0, Scale::Chromatic), W, STEPS, Scale::Chromatic, Stamp::Single, 2);
    let mut g = g.unwrap();
    // Move the second onto the first.
    drag(&mut notes, &mut g, at(4, 0, Scale::Chromatic), STEPS, Scale::Chromatic);
    release(&mut notes, g);
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].step, 4);
}

#[test]
fn the_dynamics_lane_sets_what_sounds_in_a_step_and_the_octave_buttons_stay_in_range() {
    let mut notes = vec![note(0, 4, 0), note(2, 1, 7), note(8, 1, 0)];
    assert!(set_velocity(&mut notes, 2, 0.5037));
    assert_eq!(notes[0].velocity, Some(0.5));
    assert_eq!(notes[1].velocity, Some(0.5));
    assert_eq!(notes[2].velocity, Some(0.9), "a note that does not sound there is left");
    assert!(set_velocity(&mut notes, 8, 0.0));
    assert_eq!(notes[2].velocity, Some(0.15), "never silent");
    assert!(!set_velocity(&mut notes, 12, 0.7));
    let up = shift_octave(&[note(0, 1, 7), note(1, 1, -9)], 12);
    assert_eq!(up.iter().map(|n| n.semitone).collect::<Vec<_>>(), [12.0, 3.0]);
    let down = shift_octave(&[note(0, 1, -7)], -12);
    assert_eq!(down[0].semitone, -12.0);
    // Back to steps.
    assert_eq!(notes_to_cells(&[note(0, 3, 0), note(2, 1, 7), note(15, 1, 0)], 16).iter().filter(|c| **c).count(), 3);
    assert!(notes_to_cells(&[note(40, 1, 0)], 16).iter().all(|c| !c), "a note past the end is no step");
}

#[test]
fn the_spice_buttons_draw_what_the_website_draws() {
    use sondra_media::roll::{generate, Spice};
    let arp = generate(Spice::Arpeggio, 16);
    assert_eq!(arp.len(), 8);
    assert_eq!(arp.iter().map(|n| n.step).collect::<Vec<_>>(), [0, 2, 4, 6, 8, 10, 12, 14]);
    assert_eq!(arp.iter().map(|n| n.semitone as i32).collect::<Vec<_>>(), [0, 3, 7, 12, 7, 3, 0, -5]);
    assert!(arp.iter().all(|n| n.length == 2));
    assert_eq!(arp[0].velocity, Some(0.95));
    assert_eq!(arp[1].velocity, Some(0.72));
    // Fewer steps, fewer notes.
    assert_eq!(generate(Spice::Arpeggio, 8).len(), 4);
    let chords = generate(Spice::Chords, 16);
    assert_eq!(chords.len(), 12);
    assert_eq!(chords.iter().filter(|n| n.step == 4).map(|n| n.semitone as i32).collect::<Vec<_>>(), [-2, 2, 5]);
    // A chord that would run over the end is cut to it; one that begins after it is left out.
    let short = generate(Spice::Chords, 6);
    assert_eq!(short.len(), 6);
    assert!(short.iter().filter(|n| n.step == 4).all(|n| n.length == 2));
    let bass = generate(Spice::Bass, 16);
    assert_eq!(bass.len(), 6);
    assert_eq!(generate(Spice::Bass, 7).len(), 3, "steps 0, 3 and 6 only");
    assert_eq!(bass[0].semitone, -12.0);
}
