use sondra_audio::chime::chime_samples;

#[test]
fn the_chime_is_two_soft_notes_that_die_away() {
    let rate = 48_000;
    let s = chime_samples(rate);
    assert_eq!(s.len(), (0.6 * f64::from(rate)).ceil() as usize);
    let peak = s.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.1 && peak < 0.25, "quiet: {peak}");
    // Silent at the very start (the rise begins at zero) and at the very end.
    assert!(s[0].abs() < 1e-6);
    let tail: f32 = s[s.len() - 100..].iter().fold(0.0, |m, v| m.max(v.abs()));
    assert!(tail < 0.001, "{tail}");
    // The second note comes in 0.12 s after the first: the early stretch is the first note alone, so
    // the window around 0.13 s is louder than a window at the same distance into the first one.
    let window = |from: f64| s[(from * f64::from(rate)) as usize..((from + 0.02) * f64::from(rate)) as usize].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(window(0.13) > window(0.03) * 0.7);
    // And it fades: the end of the second note is far below its start.
    assert!(window(0.5) < window(0.13) * 0.2);
}
