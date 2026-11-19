//! Hits, times and MIDI of a pattern against the web app's own `pattern.ts` (`npm run native:golden`), and
//! the voices, which are rendered here, by what they must do: be silent where nothing plays, last as long as
//! asked, sit where the pan puts them, and fold the tail back to the start.

use std::collections::BTreeMap;

use serde::Deserialize;
use sondra_media::audio::AudioData;
use sondra_media::pattern::*;

const GOLDEN: &str = include_str!("golden/pattern.json");

#[derive(Deserialize)]
struct HitJs {
    id: String,
    semitones: f64,
    mode: String,
    row: usize,
    step: usize,
    at: f64,
    hold: f64,
    velocity: f64,
    voice: String,
}
#[derive(Deserialize)]
struct PatternJs {
    steps: usize,
    bpm: f64,
    swing: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    pattern: PatternJs,
    hits: Vec<HitJs>,
    midi: Vec<u8>,
    midi_loops: Vec<u8>,
}
#[derive(Deserialize, Debug, PartialEq)]
struct NoteJs {
    step: usize,
    length: usize,
    semitone: f64,
    velocity: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    starter: BTreeMap<String, Vec<bool>>,
    roll: Vec<NoteJs>,
    resized: Vec<NoteJs>,
    resized_short: Vec<NoteJs>,
    times: Vec<f64>,
    out: Vec<Out>,
}

fn slices() -> Vec<Slice> {
    let mk = |id: &str, a: f64, b: f64| Slice::new(id, a, b);
    vec![
        mk("a", 0.0, 0.4),
        Slice { mode: PlayMode::Gate, semitones: 2.0, ..mk("b", 0.4, 0.9) },
        Slice { mode: PlayMode::Loop, ..mk("c", 0.9, 1.5) },
        Slice { semitones: -3.0, sound: SoundKind::Sub808, ..mk("d", 1.5, 2.2) },
        mk("e", 2.2, 2.6),
    ]
}

fn notes_of(js: &[NoteJs]) -> Vec<RollNote> {
    js.iter().map(|n| RollNote { step: n.step, length: n.length, semitone: n.semitone, velocity: n.velocity }).collect()
}

fn same_notes(got: &[RollNote], want: &[NoteJs]) {
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(want) {
        assert_eq!((g.step, g.length, g.semitone, g.velocity), (w.step, w.length, w.semitone, w.velocity));
    }
}

#[test]
fn hits_times_and_midi_are_the_ones_of_the_web_app() {
    let g: File = serde_json::from_str(GOLDEN).unwrap();
    let slices = slices();
    let mut cells = starter_pattern(&slices, 16);
    assert_eq!(cells, g.starter);
    cells.insert("d".into(), (0..16).map(|i| i % 5 == 0).collect());
    let roll = cells_to_notes(Some(&[true, false, true, false, false, true, false, false, false, false, true, true, false, false, false, true]));
    same_notes(&roll, &g.roll);
    let notes_c = vec![
        RollNote { step: 0, length: 3, semitone: 0.0, velocity: None },
        RollNote { step: 4, length: 2, semitone: 7.0, velocity: Some(0.5) },
        RollNote { step: 14, length: 4, semitone: -5.0, velocity: None },
        RollNote { step: 20, length: 1, semitone: 0.0, velocity: None },
    ];
    same_notes(&resize_notes(&notes_c, 16, 40), &g.resized);
    same_notes(&resize_notes(&notes_c, 16, 8), &g.resized_short);
    for (i, t) in [0usize, 1, 2, 3, 7].iter().zip(&g.times) {
        assert!((step_time(*i, 100.0, 0.3) - t).abs() < 1e-12);
    }

    let mut patterns = Vec::new();
    patterns.push(Pattern { steps: 16, bpm: 120.0, swing: 0.0, cells: cells.clone(), notes: BTreeMap::new(), muted: BTreeMap::new() });
    patterns.push(Pattern {
        steps: 16,
        bpm: 93.5,
        swing: 0.4,
        cells: cells.clone(),
        notes: BTreeMap::from([("c".to_string(), notes_c.clone()), ("e".to_string(), roll.clone())]),
        muted: BTreeMap::from([("b".to_string(), true)]),
    });
    let mut long = cells.clone();
    long.insert("a".into(), (0..32).map(|i| i % 3 == 0).collect());
    patterns.push(Pattern {
        steps: 32,
        bpm: 140.0,
        swing: 0.2,
        cells: long,
        notes: BTreeMap::from([("d".to_string(), resize_notes(&[RollNote { step: 0, length: 2, semitone: 0.0, velocity: None }, RollNote { step: 8, length: 4, semitone: 3.0, velocity: None }], 16, 32))]),
        muted: BTreeMap::new(),
    });
    assert_eq!(patterns.len(), g.out.len());
    for (n, (pattern, want)) in patterns.iter().zip(&g.out).enumerate() {
        assert_eq!((pattern.steps, pattern.bpm, pattern.swing), (want.pattern.steps, want.pattern.bpm, want.pattern.swing));
        let hits = pattern_hits(&slices, pattern);
        assert_eq!(hits.len(), want.hits.len(), "pattern {n}");
        for (h, w) in hits.iter().zip(&want.hits) {
            let mode = match h.slice.mode {
                PlayMode::OneShot => "oneshot",
                PlayMode::Gate => "gate",
                PlayMode::Loop => "loop",
            };
            assert_eq!((h.slice.id.as_str(), h.slice.semitones, mode, h.row, h.step, h.velocity, h.voice.as_str()), (w.id.as_str(), w.semitones, w.mode.as_str(), w.row, w.step, w.velocity, w.voice.as_str()), "pattern {n}");
            assert!((h.at - w.at).abs() < 1e-9 && (h.hold - w.hold).abs() < 1e-9, "pattern {n}: {h:?} vs {} {}", w.at, w.hold);
        }
        assert_eq!(pattern_to_midi(&slices, pattern, 1), want.midi, "pattern {n}: MIDI");
        assert_eq!(pattern_to_midi(&slices, pattern, 2), want.midi_loops, "pattern {n}: MIDI, two passes");
    }
}

fn take() -> AudioData {
    // A second of a steady tone on the left, nothing on the right.
    let rate = 8000u32;
    let left: Vec<f32> = (0..rate as usize * 2).map(|i| (0.6 * (i as f64 * 0.31).sin()) as f32).collect();
    AudioData { channels: vec![left.clone(), left], sample_rate: rate }
}

#[test]
fn a_bounce_is_silent_where_nothing_plays_loops_whole_and_follows_pan_and_gain() {
    let audio = take();
    let material = Material { audio: &audio };
    let mut pattern = Pattern::new(16, 120.0);
    pattern.cells.insert("a".into(), (0..16).map(|i| i == 0).collect());
    let pass = 16.0 * step_seconds(120.0);
    let one = Slice { gain_db: -6.0, ..Slice::new("a", 0.0, 0.25) };
    let out = bounce_pattern(&[one], &pattern, &material, 2, true);
    assert_eq!(out.sample_rate, 8000);
    assert_eq!(out.frames(), (pass * 2.0 * 8000.0).round() as usize, "two passes, the tail folded in");
    // The hit is there at the start of each pass and silent between.
    let peak = |from: f64, to: f64| out.channels[0][(from * 8000.0) as usize..(to * 8000.0) as usize].iter().fold(0f32, |p, v| p.max(v.abs()));
    assert!((peak(0.0, 0.2) - 0.3).abs() < 0.02, "−6 dB of 0.6 is about 0.3: {}", peak(0.0, 0.2));
    assert!(peak(0.5, 1.9) < 1e-6, "silence between the hits");
    assert!(peak(pass, pass + 0.2) > 0.25, "the second pass hits again");

    // Pan: hard left leaves the right side empty.
    let left = Slice { pan: -1.0, ..Slice::new("a", 0.0, 0.25) };
    let l = bounce_pattern(&[left], &pattern, &material, 1, false);
    let side = |c: usize| l.channels[c].iter().fold(0f32, |p, v| p.max(v.abs()));
    assert!(side(0) > 0.2 && side(1) < 1e-4, "{} {}", side(0), side(1));

    // Pitch up an octave: the hit lasts half as long.
    let high = Slice { semitones: 12.0, ..Slice::new("a", 0.0, 0.4) };
    let h = bounce_pattern(&[high], &pattern, &material, 1, false);
    let last = h.channels[0].iter().rposition(|v| v.abs() > 0.01).unwrap() as f64 / 8000.0;
    assert!((last - 0.2).abs() < 0.03, "{last}");

    // Reversed: the part is read from its end.
    let rev = Slice { reverse: true, ..Slice::new("a", 0.0, 0.25) };
    let r = bounce_pattern(&[rev], &pattern, &material, 1, false);
    assert!(r.channels[0][100] != 0.0 || r.channels[0][101] != 0.0);

    // A synth pad: a note rolled from the pad, as long as drawn, with no sample in it.
    let mut rolled = Pattern::new(16, 120.0);
    rolled.notes.insert("s".into(), vec![RollNote { step: 0, length: 4, semitone: 0.0, velocity: None }]);
    for kind in [SoundKind::Sub808, SoundKind::EPiano, SoundKind::Pluck, SoundKind::Lead, SoundKind::Warm] {
        let synth = Slice { sound: kind, ..Slice::new("s", 0.0, 0.3) };
        let o = bounce_pattern(&[synth], &rolled, &material, 1, true);
        let energy: f64 = o.channels[0][..4000].iter().map(|v| f64::from(*v).powi(2)).sum();
        assert!(energy > 0.01, "{kind:?} sounds");
        assert!(o.channels.iter().flatten().all(|v| v.is_finite() && v.abs() <= 1.0), "{kind:?}");
    }
    // A muted pad is silent.
    let mut muted = pattern.clone();
    muted.muted.insert("a".into(), true);
    let m = bounce_pattern(&[Slice::new("a", 0.0, 0.25)], &muted, &material, 1, false);
    assert!(m.channels[0].iter().all(|v| *v == 0.0));
}
