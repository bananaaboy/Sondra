//! Every format and every template through the real FFmpeg: `verify:convert` for the native side.
//! Skipped, and says so, where there is no FFmpeg.

use std::path::{Path, PathBuf};

use sondra_media::convert::*;
use sondra_media::presets::{built_in, preset_for};
use sondra_media::run::{convert_file, explain, unique_path};
use sondra_media::{Cancel, Ffmpeg};

fn ffmpeg() -> Option<Ffmpeg> {
    let found = Ffmpeg::locate();
    if found.is_none() {
        eprintln!("skipped: no ffmpeg here");
    }
    found
}

/// A few seconds of test picture and a tone, in Matroska.
fn sample(dir: &Path, name: &str, video: bool, audio: bool, seconds: u32) -> PathBuf {
    let path = dir.join(name);
    let mut c = std::process::Command::new("ffmpeg");
    c.args(["-hide_banner", "-loglevel", "error", "-y"]);
    if video {
        c.args([
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size=320x180:rate=25:duration={seconds}"),
        ]);
    }
    if audio {
        c.args([
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:sample_rate=44100:duration={seconds}"),
        ]);
    }
    if video {
        c.args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ]);
    }
    if audio {
        c.args(["-c:a", "aac", "-ac", "2"]);
    }
    c.arg(&path);
    assert!(c.status().expect("ffmpeg runs").success());
    path
}

fn expected_codec(format: &str) -> &'static str {
    match format {
        "mp3" => "mp3",
        "aac" | "mp4" => "aac",
        "opus" => "opus",
        "vorbis" => "vorbis",
        "flac" => "flac",
        "alac" => "alac",
        "wav" => "pcm_s24le",
        "webm" => "opus",
        _ => "",
    }
}

#[test]
fn every_format_gives_a_file_that_is_what_it_says() {
    let Some(ff) = ffmpeg() else { return };
    let work = tempfile::tempdir().unwrap();
    let input = sample(work.path(), "film.mkv", true, true, 4);
    for format in FORMATS {
        let out = work.path().join(format.id);
        let settings = Settings {
            format_id: format.id.into(),
            ..Settings::default()
        };
        let mut last = None;
        let got = convert_file(
            &ff,
            &input,
            &out,
            "Ergebnis",
            &settings,
            &Cancel::new(),
            &mut |p| last = Some(p),
        )
        .unwrap_or_else(|e| panic!("{}: {} — {}", format.id, e.message, e.detail));
        assert_eq!(
            got.path.extension().unwrap(),
            format.extension,
            "{}",
            format.id
        );
        assert!(got.size > 500, "{} is a real file", format.id);
        let probe = ff.probe(&got.path).unwrap();
        match format.kind {
            Kind::Audio => {
                assert!(
                    probe.has("audio") && !probe.has("video"),
                    "{}: {:?}",
                    format.id,
                    probe.streams
                );
                assert_eq!(
                    probe.streams[0].codec,
                    expected_codec(format.id),
                    "{}",
                    format.id
                );
            }
            Kind::Video => {
                assert!(probe.has("video") && probe.has("audio"), "{}", format.id);
                let v = probe.streams.iter().find(|s| s.kind == "video").unwrap();
                assert_eq!(v.codec, if format.id == "mp4" { "h264" } else { "vp8" });
                assert_eq!(
                    probe
                        .streams
                        .iter()
                        .find(|s| s.kind == "audio")
                        .unwrap()
                        .codec,
                    expected_codec(format.id)
                );
            }
            Kind::Image => {
                assert_eq!(probe.streams[0].codec, "gif");
                assert!(!probe.has("audio"));
            }
        }
        // The length survives (a conversion that drops half the file is a failure too).
        let seconds = probe.duration.unwrap_or(0.0);
        assert!(
            (seconds - 4.0).abs() < 0.6,
            "{} is {seconds} s long",
            format.id
        );
        // Progress reached the end.
        assert_eq!(last.and_then(|p| p.fraction), Some(1.0), "{}", format.id);
        // The command is the one that ran, and it is the web app's.
        assert!(got.command.starts_with("ffmpeg -i "), "{}", got.command);
    }
}

#[test]
fn every_template_runs_on_a_video_and_on_a_sound_file() {
    let Some(ff) = ffmpeg() else { return };
    let work = tempfile::tempdir().unwrap();
    let film = sample(work.path(), "film.mkv", true, true, 3);
    let sound = sample(work.path(), "ton.mkv", false, true, 3);
    for preset in built_in() {
        for (kind, input) in [(Kind::Video, &film), (Kind::Audio, &sound)] {
            let Some(set) = preset_for(&preset, kind) else {
                continue;
            };
            let mut settings = Settings::default();
            set.apply(&mut settings);
            let out = work.path().join(format!("{}-{:?}", preset.id, kind));
            let got = convert_file(
                &ff,
                input,
                &out,
                "x",
                &settings,
                &Cancel::new(),
                &mut |_| {},
            )
            .unwrap_or_else(|e| panic!("{} ({kind:?}): {} — {}", preset.id, e.message, e.detail));
            let probe = ff.probe(&got.path).unwrap();
            match preset.id {
                "reel" => {
                    let v = probe.streams.iter().find(|s| s.kind == "video").unwrap();
                    assert_eq!(
                        (v.width, v.height),
                        (Some(1080), Some(1920)),
                        "the reel is portrait and whole"
                    );
                }
                "whatsapp" if kind == Kind::Video => {
                    assert_eq!(
                        probe
                            .streams
                            .iter()
                            .find(|s| s.kind == "video")
                            .unwrap()
                            .height,
                        Some(720)
                    );
                }
                "hoerbuch" => {
                    let a = probe.streams.iter().find(|s| s.kind == "audio").unwrap();
                    assert_eq!(
                        (a.channels, a.sample_rate),
                        (Some(1), Some(44100)),
                        "mono, 44.1 kHz"
                    );
                    assert!(!probe.has("video"), "from a video only the sound");
                }
                "email" if kind == Kind::Video => {
                    assert_eq!(
                        probe
                            .streams
                            .iter()
                            .find(|s| s.kind == "video")
                            .unwrap()
                            .height,
                        Some(480)
                    );
                }
                _ => {}
            }
        }
    }
}

#[test]
fn a_chosen_part_is_cut_out_and_a_rate_the_encoder_lacks_is_moved() {
    let Some(ff) = ffmpeg() else { return };
    let work = tempfile::tempdir().unwrap();
    let input = sample(work.path(), "ton.mkv", false, true, 6);
    // Opus knows only 48 kHz: 96 kHz is asked for and 48 is what comes out, without an error.
    let settings = Settings {
        format_id: "opus".into(),
        sample_rate: Pick::Value(96000),
        trim_start_seconds: Some(1.0),
        trim_end_seconds: Some(3.5),
        ..Settings::default()
    };
    let got = convert_file(
        &ff,
        &input,
        work.path(),
        "Ausschnitt",
        &settings,
        &Cancel::new(),
        &mut |_| {},
    )
    .expect("a file");
    let probe = ff.probe(&got.path).unwrap();
    assert!(
        (probe.duration.unwrap() - 2.5).abs() < 0.3,
        "{:?}",
        probe.duration
    );
    assert_eq!(probe.streams[0].sample_rate, Some(48000));
}

#[test]
fn an_existing_file_is_never_replaced_and_nothing_is_left_after_a_failure() {
    let Some(ff) = ffmpeg() else { return };
    let work = tempfile::tempdir().unwrap();
    let input = sample(work.path(), "ton.mkv", false, true, 2);
    std::fs::write(work.path().join("Datei.mp3"), b"mine").unwrap();
    let st = Settings::default();
    let got = convert_file(
        &ff,
        &input,
        work.path(),
        "Datei",
        &st,
        &Cancel::new(),
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(got.path.file_name().unwrap(), "Datei (2).mp3");
    assert_eq!(
        std::fs::read(work.path().join("Datei.mp3")).unwrap(),
        b"mine"
    );
    assert_eq!(
        unique_path(work.path(), "Datei", "mp3")
            .file_name()
            .unwrap(),
        "Datei (3).mp3"
    );

    // A video file with no picture, asked for GIF; and a file that is not media at all.
    let out = work.path().join("fehler");
    let gif = Settings {
        format_id: "gif".into(),
        ..Settings::default()
    };
    let err = convert_file(&ff, &input, &out, "x", &gif, &Cancel::new(), &mut |_| {}).unwrap_err();
    assert!(!err.cancelled);
    assert!(err.message.contains("GIF"), "{}", err.message);
    let junk = work.path().join("kaputt.mp3");
    std::fs::write(&junk, b"this is not audio at all, not even close").unwrap();
    let err = convert_file(&ff, &junk, &out, "y", &st, &Cancel::new(), &mut |_| {}).unwrap_err();
    assert!(
        err.message.contains("beschädigt"),
        "{} / {}",
        err.message,
        err.detail
    );
    assert!(!err.detail.is_empty(), "FFmpeg's own words are kept");
    let left: Vec<_> = std::fs::read_dir(&out)
        .map(|d| d.map(|e| e.unwrap().file_name()).collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "nothing is left behind: {left:?}");
}

#[test]
fn a_conversion_can_be_cancelled() {
    let Some(ff) = ffmpeg() else { return };
    let work = tempfile::tempdir().unwrap();
    // Long enough that it is still running when the cancel comes.
    let input = sample(work.path(), "lang.mkv", true, true, 60);
    let settings = Settings {
        format_id: "mp4".into(),
        video_preset: "veryslow".into(),
        video_crf: 12.0,
        ..Settings::default()
    };
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    let mut seen = 0;
    let err = convert_file(
        &ff,
        &input,
        work.path(),
        "weg",
        &settings,
        &cancel,
        &mut |_| {
            seen += 1;
            if seen == 1 {
                c2.cancel();
            }
        },
    )
    .unwrap_err();
    assert!(err.cancelled);
    assert!(!work.path().join("weg.mp4").exists());
    let hidden: Vec<_> = std::fs::read_dir(work.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(".sondra"))
        .collect();
    assert!(hidden.is_empty(), "{hidden:?}");
}

#[test]
fn failures_are_said_in_a_sentence() {
    let e = |t: &str| explain(t, "MP3").message;
    assert!(
        e("Output file #0 does not contain any stream").contains("nichts, woraus MP3 werden kann")
    );
    assert!(e("moov atom not found").contains("beschädigt"));
    assert!(e("Specified sample rate 96000 is not supported").contains("Abtastrate"));
    assert!(e("Decoder (codec xyz) not found").contains("Codec"));
    assert!(e("Cannot allocate memory").contains("Arbeitsspeicher"));
    assert_eq!(
        e("something else"),
        "Die Umwandlung nach MP3 hat nicht geklappt."
    );
    assert_eq!(explain("  raw words \n", "MP3").detail, "raw words");
}

#[test]
fn a_missing_ffmpeg_is_told() {
    let ff = Ffmpeg::at("/nonexistent/ffmpeg", "/nonexistent/ffprobe");
    assert_eq!(
        ff.version().unwrap_err(),
        sondra_media::MediaError::NotFound
    );
    let work = tempfile::tempdir().unwrap();
    let err = convert_file(
        &ff,
        Path::new("x.mkv"),
        work.path(),
        "y",
        &Settings::default(),
        &Cancel::new(),
        &mut |_| {},
    )
    .unwrap_err();
    assert!(err.message.contains("nicht gefunden"), "{}", err.message);
}
