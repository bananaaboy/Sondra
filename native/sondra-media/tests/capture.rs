//! A recording from start to file, with a test pattern in place of the screen: the picture is made while it
//! runs, the sound tracks are joined at the end, and what comes out is a whole MP4.

use sondra_media::capture::{input_args, Recorder, Source};
use sondra_media::Ffmpeg;

fn test_input() -> Vec<String> {
    ["-f", "lavfi", "-i", "testsrc=size=161x121:rate=15"].iter().map(|s| (*s).to_owned()).collect()
}

fn tone(rate: u32, seconds: f32, hz: f32) -> Vec<f32> {
    (0..(rate as f32 * seconds) as usize).map(|i| 0.3 * (i as f32 * hz * std::f32::consts::TAU / rate as f32).sin()).collect()
}

#[test]
fn a_recording_becomes_one_mp4_with_the_picture_and_the_sound_that_was_taken() {
    let Some(ffmpeg) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    for (name, tracks) in [("ohne", vec![]), ("eins", vec![(tone(44_100, 1.2, 440.0), 44_100)]), ("zwei", vec![(tone(44_100, 1.2, 440.0), 44_100), (tone(48_000, 1.2, 660.0), 48_000)])] {
        let recorder = Recorder::start(&ffmpeg, &test_input(), 15, &tmp.path().join(format!("tmp-{name}"))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(recorder.seconds() >= 1.4);
        let out = tmp.path().join(format!("{name}.mp4"));
        recorder.finish(&ffmpeg, &tracks, &out).unwrap_or_else(|e| panic!("{name}: {e}"));
        let probe = ffmpeg.probe(&out).unwrap();
        assert!(probe.has("video"), "{name}");
        assert_eq!(probe.has("audio"), !tracks.is_empty(), "{name}");
        // Even sides, though the source is 161 × 121.
        let video = probe.streams.iter().find(|s| s.kind == "video").unwrap();
        assert_eq!((video.width, video.height), (Some(162), Some(122)), "{name}");
        assert!(probe.duration.unwrap_or(0.0) > 0.8, "{name}: {:?}", probe.duration);
        assert!(!tmp.path().join(format!("tmp-{name}")).exists(), "the temporary files are gone");
    }
}

#[test]
fn a_source_that_gives_nothing_is_said_so_and_a_discarded_recording_leaves_nothing() {
    let Some(ffmpeg) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    // A source that does not exist: FFmpeg ends at once.
    let bad: Vec<String> = ["-f", "lavfi", "-i", "nosuchsource=size=10x10"].iter().map(|s| (*s).to_owned()).collect();
    let mut recorder = Recorder::start(&ffmpeg, &bad, 15, &tmp.path().join("a")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(recorder.ended());
    let error = recorder.finish(&ffmpeg, &[], &tmp.path().join("a.mp4")).err().expect("nothing recorded");
    assert!(error.to_string().contains("nichts aufgezeichnet"), "{error}");

    let recorder = Recorder::start(&ffmpeg, &test_input(), 15, &tmp.path().join("b")).unwrap();
    recorder.discard();
    assert!(!tmp.path().join("b").exists());
}

#[test]
fn the_grabber_is_the_one_of_this_computer() {
    let screen = input_args(&Source::Screen, 30);
    let window = input_args(&Source::Window("Notizen".into()), 60);
    if cfg!(windows) {
        assert_eq!(screen, ["-f", "gdigrab", "-framerate", "30", "-draw_mouse", "1", "-i", "desktop"]);
        assert_eq!(window.last().map(String::as_str), Some("title=Notizen"));
        assert!(window.contains(&"60".to_string()));
    } else {
        assert_eq!(screen[..2], ["-f", "x11grab"]);
    }
}
