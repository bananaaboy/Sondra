//! The size of the picture from the stream's own parameter set — checked against streams FFmpeg makes at
//! sizes that do and do not divide by 16 (the encoder then crops).

use std::process::{Command, Stdio};

use sondra_mirror::h264::{announced_size, nal_units, sps_size};

fn ffmpeg() -> Option<std::path::PathBuf> {
    let program = std::env::var_os("SONDRA_FFMPEG").map(|d| std::path::PathBuf::from(d).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })).unwrap_or_else(|| "ffmpeg".into());
    Command::new(&program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| program)
}

fn stream(program: &std::path::Path, size: &str, extra: &[&str]) -> Vec<u8> {
    let out = Command::new(program)
        .args(["-v", "error", "-f", "lavfi", "-i"])
        .arg(format!("testsrc=size={size}:rate=10"))
        .args(["-frames:v", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"])
        .args(extra)
        .args(["-f", "h264", "-"])
        .stderr(Stdio::inherit())
        .output()
        .expect("ffmpeg runs");
    assert!(out.status.success());
    out.stdout
}

#[test]
fn the_picture_size_comes_out_of_the_parameter_set_cropping_included() {
    let Some(program) = ffmpeg() else { return };
    for (size, want) in [("320x240", (320, 240)), ("100x180", (100, 180)), ("90x160", (90, 160)), ("1080x2400", (1080, 2400)), ("720x1280", (720, 1280)), ("1280x720", (1280, 720)), ("66x34", (66, 34))] {
        let data = stream(&program, size, &[]);
        assert_eq!(announced_size(&data), Some(want), "{size}");
    }
    // Other profiles carry more in the set (chroma format, scaling lists).
    let high = stream(&program, "200x120", &["-profile:v", "high"]);
    assert_eq!(announced_size(&high), Some((200, 120)));
    let high444 = stream(&program, "200x120", &["-pix_fmt", "yuv444p", "-profile:v", "high444"]);
    assert_eq!(announced_size(&high444), Some((200, 120)));
}

#[test]
fn units_are_found_between_start_codes_of_three_or_four_bytes() {
    let data = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6];
    let units = nal_units(&data);
    assert_eq!(units, vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4, 5, 6][..]]);
    // Something that is no parameter set has no size, and a cut-off one none either.
    assert_eq!(sps_size(&[0x68, 1, 2]), None);
    assert_eq!(sps_size(&[0x67, 0x42]), None);
}
