//! A film in Drive played where it lies: FFmpeg reads it from the program's own small server, which asks Drive
//! for ranges — the index at the end of the file first, then what is played. Real FFmpeg; skipped without one.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use sondra_drive::fake::FakeDrive;
use sondra_drive::DriveStream;
use sondra_media::Ffmpeg;
use sondra_playback::{register_source, Playback, State};

#[test]
fn a_film_in_drive_plays_and_jumps_by_asking_for_ranges() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let film = tmp.path().join("film.mp4");
    // An ordinary MP4: its index lies at the end, so a player must ask for the end first.
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&film)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let data = std::fs::read(&film).unwrap();

    let fake = FakeDrive::start();
    let client = fake.client();
    let folder = client.ensure_path(&["Sondra", "Filme"]).unwrap();
    let file = client.create(&folder, "Film Eins.mp4", &data, "video/mp4", &Default::default()).unwrap();
    let stream = DriveStream::start(fake.client()).unwrap();
    // The list holds a name that is no file; FFmpeg is given the address.
    let shown: PathBuf = tmp.path().join("Drive-Ablage").join("f1-Film Eins.mp4");
    assert!(!shown.exists());
    register_source(&shown, &stream.url(&file.id, "Film Eins.mp4", data.len() as u64, "video/mp4"));

    let mut p = Playback::open(ff, &shown, 0.0).expect("the film opens from Drive");
    assert_eq!(p.picture_size(), Some((320, 180)));
    assert!((5.5..=6.5).contains(&p.duration().unwrap()));
    let until = Instant::now() + Duration::from_millis(1200);
    let mut pictures = 0;
    while Instant::now() < until {
        if p.next_frame().is_some() {
            pictures += 1;
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    assert!(pictures > 5, "{pictures} pictures came");
    assert_eq!(p.state(), State::Playing);

    // A jump asks Drive for the bytes at that place.
    p.seek(4.0).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert!(p.position() >= 3.9, "after the jump: {}", p.position());
    let asked = fake.state.lock().unwrap().range_requests.clone();
    assert!(asked.len() >= 2, "ranges were asked for: {asked:?}");
    assert!(asked.iter().any(|(from, _)| *from > 0), "something other than the start was asked for: {asked:?}");
    let _: &Path = &shown;
}
