//! The small picture of a file in a folder (`src/lib/thumbnails.ts`): a video shows a frame from about 15 % of
//! its length — past the black of an opening — an image is the image itself; a sound has none. FFmpeg makes the
//! video's frame, handed back as JPEG bytes; the picture is made from those (and from an image's own bytes) by
//! whoever draws it. The length comes along: a tile says how long a film or a song is.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::ffmpeg::Ffmpeg;

/// Where in a film the frame is taken: past the opening, before the end.
pub const FRACTION: f64 = 0.15;
/// A picture bigger than this is not read whole: it is not what a folder's tile is for.
const IMAGE_LIMIT: u64 = 64 * 1024 * 1024;

/// What a file gives a tile: the bytes of a picture, if it has one, and its length in seconds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Thumb {
    pub picture: Option<Vec<u8>>,
    pub seconds: Option<f64>,
}

/// The second to look at: 15 % of the length, and the start of a very short one.
pub fn frame_time(duration: Option<f64>) -> f64 {
    duration.filter(|d| d.is_finite() && *d > 0.0).map_or(0.0, |d| (d * FRACTION * 10.0).round() / 10.0)
}

/// The picture of a video and its length. `None` picture where FFmpeg found nothing to show (a sound, a
/// damaged file).
pub fn of_video(ff: &Ffmpeg, path: &Path, width: u32) -> Thumb {
    let probe = ff.probe(path).ok();
    let seconds = probe.as_ref().and_then(|p| p.duration);
    let has_picture = probe.as_ref().is_none_or(|p| p.streams.iter().any(|s| s.kind == "video" && !s.attached_picture) || p.streams.iter().any(|s| s.attached_picture));
    if !has_picture {
        return Thumb { picture: None, seconds };
    }
    let at = frame_time(seconds);
    // A second try from the very start: a file shorter than its header says has nothing at 15 %.
    let picture = frame(ff, path, at, width).or_else(|| if at > 0.0 { frame(ff, path, 0.0, width) } else { None });
    Thumb { picture, seconds }
}

fn frame(ff: &Ffmpeg, path: &Path, at: f64, width: u32) -> Option<Vec<u8>> {
    let mut command = Command::new(ff.program());
    command
        .args(["-v", "error", "-nostdin", "-ss", &format!("{at:.1}"), "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-an", "-sn", "-vf", &format!("scale={width}:-2"), "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let out = command.output().ok()?;
    (out.status.success() && out.stdout.len() > 100).then_some(out.stdout)
}

/// The bytes of an image file, if it is of a size a tile can take.
pub fn of_image(path: &Path) -> Thumb {
    let small = std::fs::metadata(path).is_ok_and(|m| m.len() <= IMAGE_LIMIT);
    Thumb { picture: if small { std::fs::read(path).ok() } else { None }, seconds: None }
}

/// The length of a sound (no picture).
pub fn of_audio(ff: &Ffmpeg, path: &Path) -> Thumb {
    Thumb { picture: None, seconds: ff.probe(path).ok().and_then(|p| p.duration) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_frame_is_taken_past_the_opening() {
        assert_eq!(frame_time(Some(1400.0)), 210.0);
        assert_eq!(frame_time(Some(10.0)), 1.5);
        assert_eq!(frame_time(Some(0.0)), 0.0);
        assert_eq!(frame_time(None), 0.0);
        assert_eq!(frame_time(Some(f64::NAN)), 0.0);
    }
}
