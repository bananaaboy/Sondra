//! Playing real files with the real FFmpeg: the clock, the pictures that wait for it, pause, a jump, a speed,
//! the end. Skipped where there is no FFmpeg.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use sondra_media::Ffmpeg;
use sondra_playback::{Playback, State};

fn ffmpeg() -> Option<Ffmpeg> {
    Ffmpeg::locate()
}

/// A 4-second test film with sound, 320 × 180 at 15 frames a second, and a 2-second tone.
fn media(dir: &Path, ff: &Ffmpeg) -> (PathBuf, PathBuf, PathBuf) {
    let film = dir.join("film.mp4");
    let tone = dir.join("ton.wav");
    let silent = dir.join("stumm.mp4");
    let run = |args: &[&str]| {
        let out = Command::new(ff.program()).args(["-v", "error", "-y"]).args(args).output().expect("FFmpeg runs");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    run(&["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", film.to_str().unwrap()]);
    run(&["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100", "-t", "2", tone.to_str().unwrap()]);
    run(&["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent.to_str().unwrap()]);
    (film, tone, silent)
}

/// Draws as a window would: asks for the next picture every few milliseconds for `seconds`.
fn watch(p: &mut Playback, seconds: f64) -> Vec<f64> {
    let until = Instant::now() + Duration::from_secs_f64(seconds);
    let mut seen = Vec::new();
    while Instant::now() < until {
        if let Some(frame) = p.next_frame() {
            seen.push(frame.pts);
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    seen
}

#[test]
fn a_film_plays_in_time_with_its_sound_and_the_pictures_follow_the_clock() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (film, _, _) = media(tmp.path(), &ff);
    let mut p = Playback::open(ff, &film, 0.0).unwrap();
    assert_eq!(p.picture_size(), Some((320, 180)));
    assert_eq!(p.audio_tracks().len(), 1);
    assert!((3.5..=4.5).contains(&p.duration().unwrap()));
    let seen = watch(&mut p, 1.5);
    let position = p.position();
    assert!((1.0..=1.9).contains(&position), "after one and a half seconds the film is about there: {position}");
    // At 15 a second, about twenty pictures in that time; none out of order, none from the future.
    assert!((12..=24).contains(&seen.len()), "{} pictures: {seen:?}", seen.len());
    assert!(seen.windows(2).all(|w| w[0] < w[1]), "in order: {seen:?}");
    assert!(*seen.last().unwrap() <= position + 0.01, "a picture is never shown before its moment");
    assert!(p.current_frame().is_some());
    assert_eq!(p.state(), State::Playing);
}

#[test]
fn pause_stops_the_clock_and_play_goes_on_from_there() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (film, _, _) = media(tmp.path(), &ff);
    let mut p = Playback::open(ff, &film, 0.0).unwrap();
    watch(&mut p, 0.8);
    p.pause();
    let held = p.position();
    watch(&mut p, 0.5);
    assert!((p.position() - held).abs() < 0.05, "the clock stood still: {held} → {}", p.position());
    assert_eq!(p.state(), State::Paused);
    p.play();
    watch(&mut p, 0.5);
    assert!(p.position() > held + 0.3, "and goes on: {held} → {}", p.position());
}

#[test]
fn a_jump_lands_at_the_new_place_with_its_picture_and_the_clock_follows() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (film, _, _) = media(tmp.path(), &ff);
    let mut p = Playback::open(ff, &film, 0.0).unwrap();
    watch(&mut p, 0.3);
    p.seek(2.5).unwrap();
    let seen = watch(&mut p, 0.6);
    assert!(!seen.is_empty(), "a picture of the new place comes");
    assert!(seen.iter().all(|pts| *pts >= 2.49), "nothing of the old place is shown after the jump: {seen:?}");
    assert!((2.5..=3.3).contains(&p.position()), "{}", p.position());
}

#[test]
fn a_speed_runs_the_clock_faster_and_the_film_ends() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (film, _, _) = media(tmp.path(), &ff);
    let mut p = Playback::open(ff, &film, 0.0).unwrap();
    p.set_rate(2.0).unwrap();
    assert_eq!(p.rate(), 2.0);
    watch(&mut p, 1.0);
    let position = p.position();
    assert!((1.4..=2.8).contains(&position), "twice as fast: {position}");
    // Nearly at the end: it ends, and says so.
    p.seek(3.4).unwrap();
    let until = Instant::now() + Duration::from_secs(4);
    while Instant::now() < until && p.state() != State::Ended {
        p.next_frame();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(p.state(), State::Ended);
    assert!(p.position() >= 3.3);
    // Play at the end starts again from the beginning.
    p.play();
    watch(&mut p, 0.4);
    assert!(p.position() < 1.0 && p.state() == State::Playing, "{}", p.position());
}

#[test]
fn a_song_has_no_picture_a_silent_film_keeps_its_own_time() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (_, tone, silent) = media(tmp.path(), &ff);
    let mut song = Playback::open(Ffmpeg::locate().unwrap(), &tone, 0.0).unwrap();
    assert_eq!(song.picture_size(), None);
    watch(&mut song, 0.6);
    assert!((0.3..=1.0).contains(&song.position()), "{}", song.position());

    let mut film = Playback::open(ff, &silent, 0.0).unwrap();
    assert!(film.audio_tracks().is_empty());
    let seen = watch(&mut film, 1.0);
    assert!((0.7..=1.4).contains(&film.position()), "with no sound the time that passed is the clock: {}", film.position());
    assert!((6..=12).contains(&seen.len()), "10 a second: {}", seen.len());
}

#[test]
fn a_file_with_nothing_to_play_says_so() {
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let text = tmp.path().join("kein-film.txt");
    std::fs::write(&text, "nur Text").unwrap();
    assert!(Playback::open(ff, &text, 0.0).is_err());
}

/// The mean of the colour channels of a picture, 0 to 255.
fn mean(frame: &sondra_playback::Frame) -> f64 {
    let sum: u64 = frame.bgra.chunks(4).map(|p| p[0] as u64 + p[1] as u64 + p[2] as u64).sum();
    sum as f64 / (frame.bgra.len() / 4 * 3) as f64
}

fn first_frame(p: &mut Playback) -> sondra_playback::Frame {
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if let Some(f) = p.next_frame() {
            return f;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("no picture came");
}

#[test]
fn the_picture_can_be_brightened_greyed_and_mirrored_and_the_sound_made_for_the_night() {
    use sondra_playback::Picture;
    let Some(ff) = ffmpeg() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let (film, _, _) = media(tmp.path(), &ff);
    let mut p = Playback::open(ff, &film, 0.5).unwrap();
    let plain = first_frame(&mut p);

    p.set_picture(Picture { brightness: 0.5, ..Picture::default() }).unwrap();
    let dark = first_frame(&mut p);
    assert!(mean(&dark) < mean(&plain) * 0.75, "darker: {} against {}", mean(&dark), mean(&plain));

    p.set_picture(Picture { saturation: 0.0, ..Picture::default() }).unwrap();
    let grey = first_frame(&mut p);
    let spread = |f: &sondra_playback::Frame| f.bgra.chunks(4).map(|p| (p[0] as i32 - p[2] as i32).abs() as u64).sum::<u64>() as f64 / (f.bgra.len() / 4) as f64;
    assert!(spread(&grey) < spread(&plain) * 0.2, "no colour left: {} against {}", spread(&grey), spread(&plain));

    p.set_picture(Picture { mirror: true, ..Picture::default() }).unwrap();
    let mirrored = first_frame(&mut p);
    let w = plain.width as usize;
    let row = |f: &sondra_playback::Frame, y: usize, x: usize| f.bgra[(y * w + x) * 4..(y * w + x) * 4 + 3].to_vec();
    let distance = |a: Vec<u8>, b: Vec<u8>| a.iter().zip(&b).map(|(a, b)| (*a as i32 - *b as i32).abs()).sum::<i32>();
    // Compare a column on one side with the column opposite in the other picture; the unmirrored
    // opposite is a different spot of the test pattern.
    let (y, x) = (90usize, 20usize);
    let near = distance(row(&mirrored, y, x), row(&plain, y, w - 1 - x));
    let far = distance(row(&mirrored, y, x), row(&plain, y, x));
    assert!(near < far.max(30), "mirrored: {near} against {far}");

    // The boost is on top of the volume, night mode restarts the sound and the film goes on.
    p.set_boost(2.0);
    p.set_night(true).unwrap();
    let seen = watch(&mut p, 1.0);
    assert!(!seen.is_empty(), "the pictures go on after the sound is made again");
    assert!(p.position() > 0.9);
    p.set_night(false).unwrap();
}
