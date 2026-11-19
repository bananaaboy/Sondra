//! A film can be watched smaller than its own: the pictures that come are of the chosen height, the film goes
//! on from where it is, and a film that is not taller than the step offers none. Skipped where there is no FFmpeg.

use std::time::{Duration, Instant};

use sondra_media::Ffmpeg;
use sondra_playback::Playback;

#[test]
fn a_smaller_picture_comes_from_where_the_film_was_and_original_brings_the_own_back() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let dir = tempfile::tempdir().unwrap();
    let film = dir.path().join("gross.mp4");
    let out = std::process::Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "5"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&film)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    let mut p = Playback::open(ff, &film, 0.0).unwrap();
    assert_eq!(p.picture_size(), Some((1280, 720)));
    // Steps below the film's own (and 40 px of leeway): not 720 itself.
    assert_eq!(p.quality_steps(), [480, 360]);
    assert_eq!(p.quality(), None);

    let draw = |p: &mut Playback, seconds: f64| {
        let until = Instant::now() + Duration::from_secs_f64(seconds);
        let mut last = None;
        while Instant::now() < until {
            if let Some(frame) = p.next_frame() {
                last = Some((frame.width, frame.height, frame.pts));
            }
            std::thread::sleep(Duration::from_millis(4));
        }
        last
    };
    assert!(draw(&mut p, 1.0).is_some());
    let before = p.position();
    p.set_quality(Some(480)).unwrap();
    assert_eq!(p.quality(), Some(480));
    assert_eq!(p.picture_size(), Some((852, 480)));
    let (w, h, pts) = draw(&mut p, 1.5).expect("a picture after the change");
    assert_eq!((w, h), (852, 480), "the pictures are of the height asked");
    assert!(pts >= before - 0.3, "the film goes on from where it was: {pts} after {before}");
    // A step the film does not offer is no change, and Original brings the own size back.
    p.set_quality(Some(2160)).unwrap();
    assert_eq!(p.quality(), None);
    assert_eq!(p.picture_size(), Some((1280, 720)));
}
