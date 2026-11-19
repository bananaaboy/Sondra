//! Subtitles, character for character, as the web app's own `transcribe.ts` shapes them
//! (`npm run native:golden`), and the windows a long recording is cut into.

use serde::Deserialize;
use sondra_speech::cues::*;
use sondra_speech::windows::{quietest_point, windows, RATE, SEEK, WINDOW};
use sondra_speech::Segment;

#[derive(Deserialize, Clone)]
struct Seg {
    start: f64,
    end: f64,
    text: String,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    segments: Vec<Seg>,
    cues: Vec<Seg>,
    srt: String,
    vtt: String,
    text: String,
}

fn segs(v: &[Seg]) -> Vec<Segment> {
    v.iter().map(|s| Segment { start: s.start, end: s.end, text: s.text.clone() }).collect()
}

#[test]
fn cues_srt_vtt_and_text_are_the_ones_of_the_web_app() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("golden/cues.json")).unwrap();
    assert_eq!(cases.len(), 5);
    for case in &cases {
        let input = segs(&case.segments);
        let cues = to_cues(&input);
        assert_eq!(cues.len(), case.cues.len(), "{}", case.name);
        for (got, want) in cues.iter().zip(&case.cues) {
            assert!((got.start - want.start).abs() < 1e-9 && (got.end - want.end).abs() < 1e-9, "{}: {got:?}", case.name);
            assert_eq!(got.text, want.text, "{}", case.name);
        }
        assert_eq!(to_srt(&input), case.srt, "{}: SRT", case.name);
        assert_eq!(to_vtt(&input), case.vtt, "{}: VTT", case.name);
        assert_eq!(to_text(&input), case.text, "{}: Text", case.name);
    }
}

#[test]
fn a_long_recording_is_cut_where_it_is_quietest_and_every_sample_is_in_a_window() {
    // 75 seconds of a steady tone with a dip at 25.5 s and at 52 s.
    let mut samples: Vec<f32> = (0..75 * RATE).map(|i| (0.4 * (i as f64 * 0.05).sin()) as f32).collect();
    for dip in [25.5f64, 52.0] {
        let at = (dip * RATE as f64) as usize;
        for s in &mut samples[at - 400..at + 400] {
            *s = 0.0;
        }
    }
    let parts = windows(&samples);
    assert_eq!(parts[0].0, 0);
    assert_eq!(parts.last().unwrap().1, samples.len());
    assert!(parts.windows(2).all(|w| w[0].1 == w[1].0), "no gaps and no overlaps");
    assert!(parts.iter().all(|(a, b)| b - a <= WINDOW), "no window longer than the limit");
    // The first cut is in the dip (within 20 ms of 25.5 s): inside the last three seconds before 28 s.
    assert!((parts[0].1 as f64 / RATE as f64 - 25.5).abs() < 0.03, "{}", parts[0].1 as f64 / RATE as f64);
    // A short recording is one window; silence has none.
    assert_eq!(windows(&samples[..RATE * 5]).len(), 1);
    assert!(windows(&[]).is_empty());
    assert_eq!(quietest_point(&samples, 28 * RATE - SEEK, 28 * RATE), parts[0].1);
}
