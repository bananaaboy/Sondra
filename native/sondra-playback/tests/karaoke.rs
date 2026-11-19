//! The voice remover: FFmpeg takes its chain, and it does what it is for — a tone in the middle of the picture
//! of the sound goes, one at the side stays, a bass tone stays wherever it is.

use std::process::Command;

use sondra_playback::karaoke_filter;

/// The mean volume of the left channel of a source made by `source` (a lavfi graph), after the voice remover
/// or, with `removed` false, as it is.
fn left_volume(program: &std::path::Path, source: &str, removed: bool) -> f64 {
    let chain = if removed { format!("{},pan=mono|c0=c0,volumedetect", karaoke_filter(2).unwrap()) } else { "pan=mono|c0=c0,volumedetect".to_string() };
    let out = Command::new(program).args(["-hide_banner", "-f", "lavfi", "-i", source, "-af", &chain, "-f", "null", "-"]).output().unwrap();
    let text = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{text}");
    text.lines().find_map(|l| l.split("mean_volume: ").nth(1)).and_then(|v| v.trim().trim_end_matches(" dB").parse().ok()).unwrap_or(-91.0)
}

#[test]
fn one_channel_has_no_middle_and_is_left_alone() {
    assert!(karaoke_filter(1).is_none());
    assert!(karaoke_filter(2).is_some());
}

#[test]
fn a_voice_in_the_middle_goes_one_at_the_side_and_the_bass_stay() {
    let Some(ff) = sondra_media::Ffmpeg::locate() else { return };
    let program = ff.program();
    let tones = [
        // 1 kHz in both channels: the middle.
        ("centre", "sine=frequency=1000:duration=1,volume=0.3,pan=stereo|c0=c0|c1=c0"),
        // 1 kHz in the left channel only: the side.
        ("side", "sine=frequency=1000:duration=1,volume=0.3,pan=stereo|c0=c0|c1=0*c0"),
        // 60 Hz in both channels: the bass, kept wherever it lies.
        ("bass", "sine=frequency=60:duration=1,volume=0.3,pan=stereo|c0=c0|c1=c0"),
    ];
    let change = |name: &str| {
        let source = tones.iter().find(|(n, _)| *n == name).unwrap().1;
        left_volume(program, source, true) - left_volume(program, source, false)
    };
    assert!(change("centre") < -25.0, "the middle is taken out: {}", change("centre"));
    assert!(change("side").abs() < 4.0, "the side stays: {}", change("side"));
    assert!(change("bass").abs() < 4.0, "the bass stays: {}", change("bass"));
}
