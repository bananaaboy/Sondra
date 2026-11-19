//! Key, chords, pitch, notes and the MIDI file: the cases of `scripts/verify-harmony.mts`, and the web
//! app's own numbers for the same synthesised material (`npm run native:golden`).

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::chroma::{chromagram, estimate_tuning};
use sondra_media::key::*;
use sondra_media::midi::*;
use sondra_media::pitch::*;

const GOLDEN: &str = include_str!("golden/harmony.json");
const SR: u32 = 44100;

fn midi_to_hz(midi: f64) -> f64 {
    440.0 * 2f64.powf((midi - 69.0) / 12.0)
}

/// A tone with a few harmonics, so the chroma sees something instrument-like.
fn tone(target: &mut [f32], midi: f64, from: usize, to: usize, level: f64) {
    let hz = midi_to_hz(midi);
    let pi = std::f64::consts::PI;
    for i in from..to.min(target.len()) {
        let t = i as f64 / f64::from(SR);
        let fade = ((i - from).min(to - i) as f64 / (0.01 * f64::from(SR))).min(1.0);
        target[i] += (level
            * fade
            * ((2.0 * pi * hz * t).sin()
                + 0.4 * (4.0 * pi * hz * t).sin()
                + 0.2 * (6.0 * pi * hz * t).sin())) as f32;
    }
}

fn progression(tonic: usize, major: bool, seconds: usize) -> AudioData {
    let frames = SR as usize * seconds;
    let mut channel = vec![0.0f32; frames];
    let degrees: [usize; 4] = if major { [0, 7, 9, 5] } else { [0, 8, 3, 10] };
    let per_chord = frames / degrees.len();
    for (index, degree) in degrees.iter().enumerate() {
        let (from, to) = (index * per_chord, index * per_chord + per_chord);
        let root = 48 + ((tonic + degree) % 12);
        let quality = if major {
            if index == 2 {
                3
            } else {
                4
            }
        } else if index == 0 {
            3
        } else {
            4
        };
        tone(&mut channel, root as f64, from, to, 0.25);
        tone(&mut channel, (root + quality) as f64, from, to, 0.2);
        tone(&mut channel, (root + 7) as f64, from, to, 0.2);
        tone(&mut channel, (root + 12) as f64, from, to, 0.15);
    }
    AudioData {
        channels: vec![channel],
        sample_rate: SR,
    }
}

fn notes_on(target: &mut [f32], notes: &[u32], step: f64, length: f64, level: f64) {
    for (index, midi) in notes.iter().enumerate() {
        let from = (index as f64 * step * f64::from(SR)).round() as usize;
        tone(
            target,
            f64::from(*midi),
            from,
            from + (length * f64::from(SR)).round() as usize,
            level,
        );
    }
}

/* verify-harmony ------------------------------------------------------------------------------ */

#[test]
fn keys_are_named_and_mapped_to_the_camelot_wheel() {
    for (tonic, major, expected, camelot) in [
        (0, true, "C-Dur", "8B"),
        (7, true, "G-Dur", "9B"),
        (9, false, "A-Moll", "8A"),
        (2, false, "D-Moll", "7A"),
    ] {
        let k = estimate_key(&chromagram(&progression(tonic, major, 8), 0.0));
        assert_eq!(k.label, expected);
        assert_eq!(k.camelot, camelot, "{expected}");
    }
    assert_eq!(key_label(8, Mode::Dur), "A♭-Dur");
    assert_eq!(camelot_of(0, Mode::Moll), "5A");
}

#[test]
fn chords_are_named_and_a_solo_line_has_none() {
    let chords = estimate_chords(&chromagram(&progression(0, true, 8), 0.0), 0.5, 0.55);
    let labels: Vec<&str> = chords
        .iter()
        .map(|c| c.label.as_str())
        .filter(|l| *l != "—")
        .collect();
    assert!(
        labels.contains(&"C") && labels.contains(&"Am"),
        "{labels:?}"
    );

    let mut solo = vec![0.0f32; SR as usize * 4];
    notes_on(&mut solo, &[60, 62, 64, 65, 67, 69, 71, 72], 0.5, 0.45, 0.4);
    let solo_chords = estimate_chords(
        &chromagram(
            &AudioData {
                channels: vec![solo],
                sample_rate: SR,
            },
            0.0,
        ),
        0.5,
        0.55,
    );
    assert_eq!(
        solo_chords.iter().filter(|c| c.root.is_some()).count(),
        0,
        "a single line is not harmony"
    );
}

#[test]
fn chords_survive_a_melody_on_top() {
    let mut mixed = progression(0, true, 8);
    notes_on(
        &mut mixed.channels[0],
        &[
            72, 76, 74, 72, 71, 67, 69, 72, 74, 72, 71, 69, 67, 65, 64, 60,
        ],
        0.5,
        0.45,
        0.34,
    );
    let named: Vec<String> = estimate_chords(&chromagram(&mixed, 0.0), 0.5, 0.55)
        .into_iter()
        .filter(|c| c.root.is_some())
        .map(|c| c.label)
        .collect();
    assert!(named.len() >= 3, "{named:?}");
}

fn scale_melody() -> AudioData {
    let mut melody = vec![0.0f32; SR as usize * 4];
    notes_on(
        &mut melody,
        &[60, 62, 64, 65, 67, 69, 71, 72],
        0.4,
        0.35,
        0.4,
    );
    AudioData {
        channels: vec![melody],
        sample_rate: SR,
    }
}

#[test]
fn a_scale_comes_back_as_eight_notes_at_the_right_pitch_and_time() {
    let audio = scale_melody();
    let frames = track_pitch(&audio, &TrackOptions::default(), &mut |_| {});
    let notes = segment_notes(
        &audio,
        &frames,
        &SegmentOptions {
            minimum_seconds: 0.12,
            ..SegmentOptions::default()
        },
    );
    assert_eq!(
        notes.iter().map(|n| n.midi).collect::<Vec<_>>(),
        [60, 62, 64, 65, 67, 69, 71, 72]
    );
    for (index, n) in notes.iter().enumerate() {
        assert!(
            (n.start_seconds - index as f64 * 0.4).abs() < 0.05,
            "{index}: {}",
            n.start_seconds
        );
    }
    assert_eq!(midi_name(60), "C4");
    assert_eq!(midi_name(70), "A♯4");
    assert_eq!(midi_name(-1), "B-2");
}

#[test]
fn low_notes_with_loud_harmonics_stay_in_their_octave() {
    for midi in [40, 45, 52] {
        let n = (f64::from(SR) * 1.5) as usize;
        let hz = midi_to_hz(f64::from(midi));
        let pi = std::f64::consts::PI;
        let channel: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / f64::from(SR);
                let fade = (i.min(n - i) as f64 / (0.02 * f64::from(SR))).min(1.0);
                (0.3 * fade
                    * ((2.0 * pi * hz * t).sin()
                        + (4.0 * pi * hz * t).sin()
                        + 0.6 * (6.0 * pi * hz * t).sin()
                        + 0.4 * (8.0 * pi * hz * t).sin())) as f32
            })
            .collect();
        let clip = AudioData {
            channels: vec![channel],
            sample_rate: SR,
        };
        let found = segment_notes(
            &clip,
            &track_pitch(&clip, &TrackOptions::default(), &mut |_| {}),
            &SegmentOptions {
                minimum_seconds: 0.2,
                ..SegmentOptions::default()
            },
        );
        assert_eq!(
            found.first().map(|n| n.midi),
            Some(midi),
            "{}",
            midi_name(midi)
        );
    }
}

#[test]
fn the_midi_file_is_a_midi_file() {
    let audio = scale_melody();
    let notes = segment_notes(
        &audio,
        &track_pitch(&audio, &TrackOptions::default(), &mut |_| {}),
        &SegmentOptions {
            minimum_seconds: 0.12,
            ..SegmentOptions::default()
        },
    );
    let midi = write_midi(
        &notes,
        &MidiOptions {
            bpm: 120.0,
            track_name: Some("test".into()),
        },
    );
    assert_eq!(&midi[..4], b"MThd");
    assert_eq!(&midi[14..18], b"MTrk");
    assert_eq!(&midi[midi.len() - 3..], &[255, 47, 0]);
    assert!(
        midi.iter()
            .enumerate()
            .filter(|(i, b)| **b == 0x90 && *i > 20)
            .count()
            >= notes.len()
    );
    assert_eq!(midi_note_to_pad_index(36), 0);
    assert_eq!(midi_note_to_pad_index(51), 15);
    assert_eq!(midi_note_to_pad_index(70), 10);
    assert_eq!(midi_note_to_pad_index(20), 4);
    assert_eq!(midi_note_to_pad_index(100), 4);
}

/* The web app's numbers --------------------------------------------------------------------- */

#[derive(Deserialize)]
struct GAlt {
    label: String,
    camelot: String,
}
#[derive(Deserialize)]
struct GScore {
    label: String,
    camelot: String,
    score: f64,
}
#[derive(Deserialize)]
struct GKey {
    tonic: usize,
    label: String,
    camelot: String,
    confidence: f64,
    alternative: GAlt,
    scores: Vec<GScore>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GChord {
    start_seconds: f64,
    end_seconds: f64,
    label: String,
    root: Option<usize>,
}
#[derive(Deserialize)]
struct GCase {
    name: String,
    tuning: Option<f64>,
    average: Vec<f64>,
    bass: Vec<f64>,
    head: Vec<f64>,
    tail: Vec<f64>,
    key: GKey,
    chords: Vec<GChord>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GNote {
    midi: i32,
    start_seconds: f64,
    end_seconds: f64,
    velocity: u8,
}
#[derive(Deserialize)]
struct GPitch {
    i: usize,
    hz: f64,
    clarity: f64,
    #[serde(rename = "timeSeconds")]
    time_seconds: f64,
}
#[derive(Deserialize)]
struct GOctave {
    midi: i32,
    got: i32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    keys: Vec<GCase>,
    solo_chords: usize,
    mixed_labels: Vec<String>,
    frame_count: usize,
    pitch_sample: Vec<GPitch>,
    notes: Vec<GNote>,
    quantized: Vec<GNote>,
    octaves: Vec<GOctave>,
    midi: Vec<u8>,
    midi_no_name: Vec<u8>,
    chord_notes: Vec<GNote>,
}

fn golden() -> Golden {
    serde_json::from_str(GOLDEN).unwrap()
}

fn close(label: &str, a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() <= tolerance, "{label}: {a} vs {b}");
}

fn vector(label: &str, mine: &[f32; 12], theirs: &[f64]) {
    for (i, (a, b)) in mine.iter().zip(theirs).enumerate() {
        close(&format!("{label}[{i}]"), f64::from(*a), *b, 2e-3);
    }
}

#[test]
fn chroma_key_and_chords_are_the_web_apps() {
    let g = golden();
    let materials = [(0, true), (7, true), (9, false), (2, false)];
    assert_eq!(g.keys.len(), 4);
    for (case, (tonic, major)) in g.keys.iter().zip(materials) {
        let audio = progression(tonic, major, 8);
        let chroma = chromagram(&audio, 0.0);
        let n = &case.name;
        vector(&format!("{n} average"), &chroma.average, &case.average);
        vector(&format!("{n} bass"), &chroma.bass, &case.bass);
        vector(&format!("{n} head"), &chroma.head, &case.head);
        vector(&format!("{n} tail"), &chroma.tail, &case.tail);
        if let Some(tuning) = case.tuning {
            close(
                &format!("{n} tuning"),
                estimate_tuning(&audio),
                tuning,
                1e-12,
            );
        }
        let k = estimate_key(&chroma);
        assert_eq!(
            (k.tonic, k.label.as_str(), k.camelot.as_str()),
            (
                case.key.tonic,
                case.key.label.as_str(),
                case.key.camelot.as_str()
            ),
            "{n}"
        );
        close(
            &format!("{n} confidence"),
            k.confidence,
            case.key.confidence,
            2e-3,
        );
        assert_eq!(
            (k.alternative.0.as_str(), k.alternative.1.as_str()),
            (
                case.key.alternative.label.as_str(),
                case.key.alternative.camelot.as_str()
            ),
            "{n} runner-up"
        );
        assert_eq!(k.scores.len(), case.key.scores.len());
        for (a, b) in k.scores.iter().zip(&case.key.scores) {
            assert_eq!(
                (a.label.as_str(), a.camelot.as_str()),
                (b.label.as_str(), b.camelot.as_str()),
                "{n} order of candidates"
            );
            close(&format!("{n} score"), a.score, b.score, 2e-3);
        }
        let chords = estimate_chords(&chroma, 0.5, 0.55);
        assert_eq!(
            chords.len(),
            case.chords.len(),
            "{n}: {:?}",
            chords.iter().map(|c| &c.label).collect::<Vec<_>>()
        );
        for (a, b) in chords.iter().zip(&case.chords) {
            assert_eq!(
                (a.label.as_str(), a.root),
                (b.label.as_str(), b.root),
                "{n}"
            );
            close(
                &format!("{n} chord start"),
                a.start_seconds,
                b.start_seconds,
                1e-5,
            );
            close(
                &format!("{n} chord end"),
                a.end_seconds,
                b.end_seconds,
                1e-5,
            );
        }
    }
}

#[test]
fn solo_and_melody_cases_are_the_web_apps() {
    let g = golden();
    assert_eq!(g.solo_chords, 0);
    let mut mixed = progression(0, true, 8);
    notes_on(
        &mut mixed.channels[0],
        &[
            72, 76, 74, 72, 71, 67, 69, 72, 74, 72, 71, 69, 67, 65, 64, 60,
        ],
        0.5,
        0.45,
        0.34,
    );
    let labels: Vec<String> = estimate_chords(&chromagram(&mixed, 0.0), 0.5, 0.55)
        .into_iter()
        .filter(|c| c.root.is_some())
        .map(|c| c.label)
        .collect();
    assert_eq!(labels, g.mixed_labels);
}

#[test]
fn pitch_frames_notes_and_midi_bytes_are_the_web_apps() {
    let g = golden();
    let audio = scale_melody();
    let frames = track_pitch(&audio, &TrackOptions::default(), &mut |_| {});
    assert_eq!(frames.len(), g.frame_count);
    for p in &g.pitch_sample {
        let f = frames[p.i];
        close(
            &format!("frame {} time", p.i),
            f.time_seconds,
            p.time_seconds,
            1e-5,
        );
        // Unvoiced frames are 0 on both sides; voiced ones agree to a hundredth of a hertz.
        close(&format!("frame {} hz", p.i), f.hz, p.hz, 0.01);
        close(
            &format!("frame {} clarity", p.i),
            f.clarity,
            p.clarity,
            2e-3,
        );
    }
    let options = SegmentOptions {
        minimum_seconds: 0.12,
        ..SegmentOptions::default()
    };
    let notes = segment_notes(&audio, &frames, &options);
    assert_eq!(notes.len(), g.notes.len());
    for (a, b) in notes.iter().zip(&g.notes) {
        assert_eq!((a.midi, a.velocity), (b.midi, b.velocity));
        close("note start", a.start_seconds, b.start_seconds, 1e-5);
        close("note end", a.end_seconds, b.end_seconds, 1e-5);
    }
    let quantized = segment_notes(
        &audio,
        &frames,
        &SegmentOptions {
            quantize_seconds: 0.125,
            ..options
        },
    );
    assert_eq!(quantized.len(), g.quantized.len());
    for (a, b) in quantized.iter().zip(&g.quantized) {
        close("quantized start", a.start_seconds, b.start_seconds, 1e-5);
        close("quantized end", a.end_seconds, b.end_seconds, 1e-5);
    }
    // The file the web app writes for these notes, byte for byte — with and without a track name.
    assert_eq!(
        write_midi(
            &notes,
            &MidiOptions {
                bpm: 120.0,
                track_name: Some("test".into())
            }
        ),
        g.midi
    );
    assert_eq!(write_midi(&notes, &MidiOptions::default()), g.midi_no_name);
    for o in &g.octaves {
        assert_eq!(o.got, o.midi, "the web app keeps the octave");
    }
}

#[test]
fn chords_become_four_voices_each() {
    let g = golden();
    let audio = progression(0, true, 8);
    let chords = estimate_chords(&chromagram(&audio, 0.0), 0.5, 0.55);
    let notes = chords_to_midi_notes(&chords);
    assert_eq!(notes.len(), g.chord_notes.len());
    for (a, b) in notes.iter().zip(&g.chord_notes) {
        assert_eq!((a.midi, a.velocity), (b.midi, b.velocity));
        close("chord note start", a.start_seconds, b.start_seconds, 1e-5);
        close("chord note end", a.end_seconds, b.end_seconds, 1e-5);
    }
}
