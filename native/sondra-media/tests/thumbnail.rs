//! The picture and length of a file for a folder's tile, with the real FFmpeg.

use std::process::Command;

use sondra_media::thumbnail::{of_audio, of_image, of_video};
use sondra_media::Ffmpeg;

fn make(ff: &Ffmpeg, args: &[&str], out: &std::path::Path) {
    let status = Command::new(ff.program()).args(["-v", "error", "-y"]).args(args).arg(out).status().unwrap();
    assert!(status.success());
}

#[test]
fn a_film_gives_a_frame_and_its_length_and_a_sound_only_its_length() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let dir = tempfile::tempdir().unwrap();
    let film = dir.path().join("film.mp4");
    make(&ff, &["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=10", "-pix_fmt", "yuv420p"], &film);
    let thumb = of_video(&ff, &film, 80);
    let picture = image::load_from_memory(&thumb.picture.expect("a frame")).unwrap();
    assert_eq!(picture.width(), 80);
    assert!((picture.height() as i32 - 60).abs() <= 2);
    assert!((thumb.seconds.unwrap() - 10.0).abs() < 0.3);

    let song = dir.path().join("lied.wav");
    make(&ff, &["-f", "lavfi", "-i", "sine=frequency=440:duration=3"], &song);
    let thumb = of_audio(&ff, &song);
    assert!(thumb.picture.is_none());
    assert!((thumb.seconds.unwrap() - 3.0).abs() < 0.2);
    // A sound given to the film's way has no picture either, and says how long it is.
    let again = of_video(&ff, &song, 80);
    assert!(again.picture.is_none());
    assert!((again.seconds.unwrap() - 3.0).abs() < 0.2);
}

#[test]
fn an_image_is_its_own_picture() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bild.png");
    let mut bytes = Vec::new();
    image::DynamicImage::new_rgb8(4, 3).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(of_image(&path).picture, Some(bytes));
    assert_eq!(of_image(&dir.path().join("fehlt.png")).picture, None);
}
