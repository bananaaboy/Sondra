//! Finding the opening by ear on episodes made up here (`scripts/verify-intro.mts`): an opening melody
//! behind cold opens of different lengths, at another loudness, with noise over it; episodes that only
//! share their silence; and a piece of background music that comes back under other dialogue and must
//! not win over the opening. The same episodes, by the same formulas, as the web app's script — and
//! its numbers for them.

use serde::Deserialize;
use sondra_media::intro::*;

const GOLDEN: &str = include_str!("golden/intro.json");
const RATE: usize = PRINT_RATE;

/// A seeded generator, so every run hears the same episodes (xorshift32, as in the script).
struct Random(u32);
impl Random {
    fn new(seed: u32) -> Self {
        Random(if seed == 0 { 1 } else { seed })
    }
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        f64::from(self.0) / 4294967296.0
    }
}

fn seconds(n: f64) -> usize {
    (n * RATE as f64).round() as usize
}

/// Chords that change every quarter to half second, with a beat.
fn music(length: f64, seed: u32, gain: f64) -> Vec<f32> {
    let mut rand = Random::new(seed);
    let mut out = vec![0.0f32; seconds(length)];
    let mut at = 0;
    let pi = std::f64::consts::PI;
    while at < out.len() {
        let span = seconds(0.25 + rand.next() * 0.25);
        let root = 110.0 * 2f64.powf((rand.next() * 24.0).floor() / 12.0);
        let notes = [root, root * 1.26, root * 1.5, root * 2.0];
        let mut i = 0;
        while i < span && at + i < out.len() {
            let t = i as f64 / RATE as f64;
            let mut v = 0.0;
            for f in notes {
                v += (2.0 * pi * f * t).sin() + 0.3 * (4.0 * pi * f * t).sin();
            }
            let beat = if i < seconds(0.03) {
                (rand.next() * 2.0 - 1.0) * 1.5
            } else {
                0.0
            };
            out[at + i] = (gain * (v / 6.0 + beat) * (-t * 2.0).exp()) as f32;
            i += 1;
        }
        at += span;
    }
    out
}

/// Dialogue-like sound: noise in bursts, shaped like syllables.
fn talk(length: f64, seed: u32, gain: f64) -> Vec<f32> {
    let mut rand = Random::new(seed);
    let mut out = vec![0.0f32; seconds(length)];
    let mut last = 0.0f64;
    let pi = std::f64::consts::PI;
    for (i, o) in out.iter_mut().enumerate() {
        let wave = ((i as f64 / seconds(1.3) as f64) % 1.0) * 0.1;
        let syllable = (2.0 * pi * i as f64 / seconds(0.21 + wave) as f64)
            .sin()
            .max(0.0);
        last = 0.85 * last + 0.15 * (rand.next() * 2.0 - 1.0);
        *o = (gain * last * syllable * 3.0) as f32;
    }
    out
}

fn join(parts: &[&[f32]]) -> Vec<f32> {
    parts.iter().flat_map(|p| p.iter().copied()).collect()
}
fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    let mut out = a.to_vec();
    for i in 0..a.len().min(b.len()) {
        out[i] += b[i];
    }
    out
}
fn noisy(signal: &[f32], level: f64, seed: u32, gain: f64) -> Vec<f32> {
    let mut rand = Random::new(seed);
    signal
        .iter()
        .map(|v| (f64::from(*v) * gain + (rand.next() * 2.0 - 1.0) * level) as f32)
        .collect()
}
fn silence(length: f64) -> Vec<f32> {
    vec![0.0; seconds(length)]
}
/// The first eight minutes, as the player decodes them.
fn head(signal: &[f32]) -> &[f32] {
    &signal[..signal.len().min(seconds(480.0))]
}

struct Episodes {
    a: Vec<f32>,
    b: Vec<f32>,
    c: Vec<f32>,
    d: Vec<f32>,
}

fn episodes() -> Episodes {
    let opening = music(89.0, 7, 0.3);
    let bgm = music(60.0, 99, 0.12);
    Episodes {
        // Cold open of 37.37 s, then the opening.
        a: join(&[
            &talk(37.37, 2, 0.25),
            &opening,
            &mix(&talk(400.0, 3, 0.25), &bgm),
        ]),
        // The opening almost at once, quieter, with noise.
        b: noisy(
            &join(&[&silence(0.4), &opening, &mix(&talk(400.0, 4, 0.25), &bgm)]),
            0.01,
            5,
            0.6,
        ),
        // A long cold open; the opening a little dull and with more noise.
        c: noisy(
            &join(&[&talk(123.45, 6, 0.25), &opening, &talk(300.0, 8, 0.25)]),
            0.02,
            9,
            0.8,
        ),
        // No opening at all.
        d: join(&[&talk(200.0, 10, 0.25), &music(200.0, 11, 0.3)]),
    }
}

/* verify-intro ------------------------------------------------------------------------------- */

#[test]
fn the_opening_is_found_where_it_is_and_not_the_background_music() {
    let e = episodes();
    let a = fingerprint(head(&e.a));
    let b = fingerprint(head(&e.b));
    assert!(
        (a.bits.len() as isize - 480 * PRINT_FPS as isize).abs() < 15,
        "ten frames a second: {}",
        a.bits.len()
    );
    let shared = longest_shared_default(&a, &b).expect("a shared opening");
    let fps = PRINT_FPS as f64;
    assert!(
        (shared.a as f64 / fps - 37.37).abs() <= 1.0,
        "in A: {}",
        shared.a as f64 / fps
    );
    assert!(
        (shared.b as f64 / fps - 0.4).abs() <= 1.0,
        "in B: {}",
        shared.b as f64 / fps
    );
    assert!(
        (shared.frames as f64 / fps - 89.0).abs() <= 1.0,
        "89 s long, not the background music: {}",
        shared.frames as f64 / fps
    );

    // Kept as text with the series, and found again in other episodes.
    let kept = slice(&a, shared.a, shared.frames);
    let text = encode_print(&kept);
    let back = decode_print(&text).expect("text and back");
    assert_eq!(back, kept);
    let c = fingerprint(head(&e.c));
    let found = locate_print(&back, &c).expect("found again in C");
    assert!(
        (found.at as f64 / fps - 123.45).abs() <= 1.0,
        "at {}",
        found.at as f64 / fps
    );
    let d = fingerprint(head(&e.d));
    assert!(
        locate_print(&back, &d).is_none(),
        "an episode without an opening finds none"
    );
}

#[test]
fn episodes_that_share_only_silence_share_no_opening() {
    let e = fingerprint(head(&join(&[&silence(30.0), &talk(300.0, 20, 0.25)])));
    let f = fingerprint(head(&join(&[&silence(30.0), &talk(300.0, 21, 0.25)])));
    assert!(longest_shared_default(&e, &f).is_none());
    assert!(
        e.quiet[5..290].iter().all(|q| *q == 1),
        "digital silence counts as quiet"
    );
}

#[test]
fn broken_text_is_nothing_not_an_error() {
    assert!(decode_print("nicht-base64!").is_none());
    assert!(decode_print("").is_none());
    assert!(
        decode_print("AAAA").is_none(),
        "not a multiple of five bytes"
    );
}

#[test]
fn learning_and_finding_as_the_player_does() {
    let e = episodes();
    let pcm = |s: &[f32]| -> Vec<i16> {
        head(s)
            .iter()
            .map(|v| (f64::from(*v) * 32767.0).round().clamp(-32767.0, 32767.0) as i16)
            .collect()
    };
    let learned =
        learn_intro(&pcm(&e.a), &pcm(&e.b)).expect("two episodes of a series share their opening");
    // As the player hears it — 16-bit — the web app's own engine takes the stretch a few seconds into the
    // background music that follows (94.9 s instead of 89 s: quantised noise matches a little more);
    // the numbers are its numbers.
    let g: Golden = serde_json::from_str(GOLDEN).unwrap();
    let theirs = g.learned_shared;
    assert_eq!((learned.a * 10.0).round() as usize, theirs.a);
    assert_eq!((learned.b * 10.0).round() as usize, theirs.b);
    assert_eq!((learned.seconds * 10.0).round() as usize, theirs.frames);
    let found = find_intro(&[learned.print.clone()], &pcm(&e.c)).expect("found in a third");
    assert!((found.start - 123.45).abs() <= 1.0, "{}", found.start);
    assert!((found.end - found.start - learned.seconds).abs() < 0.2);
    // Several openings: the one that fits best wins; a broken one is skipped.
    let both = [String::from("%%%"), learned.print];
    assert!(find_intro(&both, &pcm(&e.c)).is_some());
    assert!(find_intro(&both, &pcm(&e.d)).is_none());
}

/* The web app's numbers --------------------------------------------------------------------- */

#[derive(Deserialize)]
struct GWord {
    i: usize,
    bits: u32,
    quiet: u8,
}
#[derive(Deserialize)]
struct GShared {
    a: usize,
    b: usize,
    frames: usize,
    score: f64,
    matched: usize,
}
#[derive(Deserialize)]
struct GFound {
    at: usize,
    score: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Golden {
    frames: usize,
    words: Vec<GWord>,
    quiet_count: usize,
    shared: GShared,
    text: String,
    found: GFound,
    found_in_d: Option<GFound>,
    silent_shared: Option<GShared>,
    learned_shared: GShared,
}

#[test]
fn the_fingerprint_and_what_it_finds_are_the_web_apps() {
    let g: Golden = serde_json::from_str(GOLDEN).unwrap();
    let e = episodes();
    let a = fingerprint(head(&e.a));
    assert_eq!(a.bits.len(), g.frames);
    for w in &g.words {
        assert_eq!(
            (a.bits[w.i], a.quiet[w.i]),
            (w.bits, w.quiet),
            "frame {}",
            w.i
        );
    }
    assert_eq!(
        a.quiet.iter().map(|q| usize::from(*q)).sum::<usize>(),
        g.quiet_count
    );

    let shared = longest_shared_default(&a, &fingerprint(head(&e.b))).unwrap();
    assert_eq!(
        (shared.a, shared.b, shared.frames, shared.matched),
        (g.shared.a, g.shared.b, g.shared.frames, g.shared.matched)
    );
    assert!((shared.score - g.shared.score).abs() < 1e-9);

    // The text the web app keeps in the Merkliste, byte for byte — and it reads back.
    assert_eq!(encode_print(&slice(&a, shared.a, shared.frames)), g.text);
    let back = decode_print(&g.text).unwrap();
    let located = locate_print(&back, &fingerprint(head(&e.c))).unwrap();
    assert_eq!(located.at, g.found.at);
    assert!((located.score - g.found.score).abs() < 1e-9);
    assert_eq!(
        locate_print(&back, &fingerprint(head(&e.d))).map(|l| l.at),
        g.found_in_d.map(|l| l.at)
    );
    assert_eq!(g.silent_shared.map(|s| s.frames), None);
}
