//! The editor's own bookkeeping: history, undo and redo, the clipboard, what an edit says about itself, and
//! the refusals that tell the person what to do first.

use sondra_media::audio::AudioData;
use sondra_media::editor::*;

fn tone(seconds: f64) -> AudioData {
    let rate = 8000u32;
    let n = (f64::from(rate) * seconds) as usize;
    AudioData { channels: vec![(0..n).map(|i| (0.5 * (i as f64 * 0.1).sin()) as f32).collect(); 2], sample_rate: rate }
}

#[test]
fn edits_make_a_history_that_undo_and_redo_walk_and_a_new_edit_cuts_off() {
    let mut e = Editor::new(tone(4.0));
    let first = e.audio().clone();
    assert!(!e.can_undo() && !e.can_redo());
    let said = e.apply(Op::Gain(-6.0), None).unwrap();
    assert_eq!(said, "Pegel −6,0 dB · ganze Datei");
    e.apply(Op::Cut, Some((1.0, 2.5))).unwrap();
    assert_eq!(e.audio().frames(), 4 * 8000 - 12000);
    assert_eq!(e.history().iter().map(|h| h.label.as_str()).collect::<Vec<_>>(), ["Pegel −6,0 dB · ganze Datei", "1,50 s herausgeschnitten (1,00 bis 2,50 s)"]);
    assert_eq!(e.undo().unwrap(), "1,50 s herausgeschnitten (1,00 bis 2,50 s)");
    assert_eq!(e.audio().frames(), 4 * 8000);
    assert!(e.can_redo());
    e.redo();
    assert_eq!(e.audio().frames(), 4 * 8000 - 12000);
    e.undo();
    e.undo();
    assert_eq!(e.audio(), &first, "back at the start, sample for sample");
    // A new edit after going back drops what could have been redone.
    e.apply(Op::Mute, Some((0.0, 0.5))).unwrap();
    assert!(!e.can_redo());
}

#[test]
fn a_cut_can_be_pasted_and_the_refusals_say_what_to_do() {
    let mut e = Editor::new(tone(2.0));
    assert!(e.apply(Op::Paste, None).unwrap_err().contains("leer"));
    assert!(e.apply(Op::Cut, None).unwrap_err().contains("Stelle"));
    assert!(e.apply(Op::RemoveNoise { max_cut_db: 12.0 }, None).unwrap_err().contains("Rauschprofil"));
    assert!(e.learn_noise(Some((0.0, 0.05))).unwrap_err().contains("zu kurz"));
    e.apply(Op::Cut, Some((0.5, 1.0))).unwrap();
    assert!(e.has_clipboard());
    let before = e.audio().frames();
    e.apply(Op::Paste, Some((0.0, 0.0001))).unwrap();
    assert_eq!(e.audio().frames(), before + 4000);
    assert!(e.apply(Op::RemoveSilence { threshold_db: -50.0 }, None).unwrap_err().contains("Keine Stille"));
}

#[test]
fn a_range_edit_leaves_the_rest_alone_and_the_peaks_follow_the_sound() {
    let mut e = Editor::new(tone(2.0));
    let before = e.audio().clone();
    e.apply(Op::Mute, Some((0.5, 1.0))).unwrap();
    assert_eq!(e.audio().channels[0][..3000], before.channels[0][..3000]);
    assert!(e.audio().channels[0][4200..7800].iter().all(|v| *v == 0.0));
    assert_eq!(e.audio().channels[0][12500..], before.channels[0][12500..]);
    let peaks = e.peaks(10);
    assert_eq!(peaks.len(), 10);
    assert!(peaks[0].1 > 0.4 && peaks[0].0 < -0.4);
    assert_eq!(peaks[3], (0.0, 0.0), "the muted stretch is flat");
    // A compressor says how far it went.
    let said = e.apply(Op::Compress { threshold_db: -20.0, ratio: 4.0 }, None).unwrap();
    assert!(said.starts_with("Kompressor 4:1 ab −20,0 dB, bis zu "), "{said}");
    // The noise is learned from a quiet part, then taken out.
    let mut quiet = Editor::new(tone(3.0));
    quiet.apply(Op::Mute, Some((0.0, 1.0))).unwrap();
    quiet.learn_noise(Some((0.1, 0.9))).unwrap();
    assert!(quiet.has_noise_profile());
    assert!(quiet.apply(Op::RemoveNoise { max_cut_db: 12.0 }, None).unwrap().starts_with("Rauschen um bis zu 12,0 dB gesenkt"));
}
