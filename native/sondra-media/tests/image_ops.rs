//! Pictures with the real FFmpeg: sizes, turning, mirroring, formats, the preview, and the crop arithmetic.

use std::path::{Path, PathBuf};
use std::process::Command;

use sondra_media::image_ops::*;
use sondra_media::Ffmpeg;

fn picture(ff: &Ffmpeg, dir: &Path, name: &str, size: &str, pattern: &str) -> PathBuf {
    let path = dir.join(name);
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("{pattern}=size={size}"), "-frames:v", "1"]).arg(&path).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    path
}

#[test]
fn the_crop_rectangle_follows_the_picture_as_the_web_app_does() {
    // A square on a 16:9 photo is a narrow rectangle in fractions of it, centred.
    let r = rect_for_aspect(Some(1.0), 16.0 / 9.0, None);
    assert!((r.width - 0.5625).abs() < 1e-12 && r.height == 1.0 && (r.x - 0.21875).abs() < 1e-12 && r.y == 0.0);
    // 16:9 on a portrait photo: the full width, a low band.
    let r = rect_for_aspect(Some(16.0 / 9.0), 3.0 / 4.0, None);
    assert!(r.width == 1.0 && (r.height - (3.0 / 4.0) / (16.0 / 9.0)).abs() < 1e-12);
    assert_eq!(rect_for_aspect(None, 1.5, None), FULL_RECT);
    // Turned clockwise, the top-left corner goes to the top-right one.
    let corner = Rect { x: 0.0, y: 0.0, width: 0.2, height: 0.1 };
    let turned = rotate_rect(corner, 90);
    assert!((turned.x - 0.9).abs() < 1e-12 && turned.y == 0.0 && turned.width == 0.1 && turned.height == 0.2);
    // Four quarter turns come back.
    let mut r = Rect { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    for _ in 0..4 {
        r = rotate_rect(r, 90);
    }
    assert!((r.x - 0.1).abs() < 1e-12 && (r.y - 0.2).abs() < 1e-12 && (r.width - 0.3).abs() < 1e-12);
    assert_eq!(mirror_rect(Rect { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 'h').x, 1.0 - 0.1 - 0.3);
}

#[test]
fn the_size_of_the_result_is_known_before_the_work() {
    assert_eq!(output_size(400, 200, &ImageOps::default()), (400, 200));
    assert_eq!(output_size(400, 200, &ImageOps { rotate: 90, ..ImageOps::default() }), (200, 400));
    assert_eq!(output_size(400, 200, &ImageOps { width: 100, ..ImageOps::default() }), (100, 50));
    let crop = Some(Rect { x: 0.0, y: 0.0, width: 0.5, height: 1.0 });
    assert_eq!(output_size(400, 200, &ImageOps { crop, ..ImageOps::default() }), (200, 200));
    assert_eq!(output_size(400, 200, &ImageOps { crop, width: 50, ..ImageOps::default() }), (50, 50));
}

#[test]
fn a_picture_is_written_in_each_format_in_the_size_that_was_promised_and_never_over_another() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let src = picture(&ff, tmp.path(), "quelle.png", "400x200", "testsrc2");
    let out = tmp.path().join("aus");
    for format in [Format::Webp, Format::Jpeg, Format::Png] {
        let ops = ImageOps { format, rotate: 90, crop: Some(Rect { x: 0.0, y: 0.0, width: 1.0, height: 0.5 }), width: 60, sharpen: 0.4, blur: 0.5, brightness: 1.2, contrast: 1.1, saturation: 0.8, ..ImageOps::default() };
        let made = process_file(&ff, &src, &out, "bild", &ops).unwrap_or_else(|e| panic!("{format:?}: {e}"));
        assert!(made.bytes > 100, "{format:?}");
        let (w, h) = size_of(&ff, &made.path).unwrap();
        assert_eq!((w, h), (made.width, made.height), "{format:?}: the size that was promised");
        assert_eq!((w, h), (60, 60), "{format:?}: turned 200 × 400, the upper half is 200 × 200, then 60 wide");
        assert_eq!(made.path.extension().unwrap(), format.extension());
    }
    // The same name again is a second file.
    let again = process_file(&ff, &src, &out, "bild", &ImageOps::default()).unwrap();
    assert!(again.path.file_name().unwrap().to_string_lossy().starts_with("bild (2)"), "{:?}", again.path);
    assert!(src.exists());
}

fn corner(frame: &(u32, u32, Vec<u8>), x: u32, y: u32) -> [u8; 3] {
    let at = ((y * frame.0 + x) * 4) as usize;
    [frame.2[at + 2], frame.2[at + 1], frame.2[at]]
}

#[test]
fn turning_and_mirroring_move_the_pictures_corners_where_a_person_expects() {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    // smptebars has differently coloured bars from the left to the right.
    let src = picture(&ff, tmp.path(), "balken.png", "320x180", "smptebars");
    let (w, h) = size_of(&ff, &src).unwrap();
    let plain = render_bgra(&ff, &src, w, h, &ImageOps::default(), 0).unwrap();
    assert_eq!((plain.0, plain.1), (320, 180));
    let left = corner(&plain, 5, 5);
    let right = corner(&plain, 314, 5);
    assert_ne!(left, right, "the bars differ");
    let mirrored = render_bgra(&ff, &src, w, h, &ImageOps { flip_h: true, ..ImageOps::default() }, 0).unwrap();
    assert_eq!(corner(&mirrored, 314, 5), left, "left to right");
    assert_eq!(corner(&mirrored, 5, 5), right);
    // A quarter turn clockwise: the old top-left is the new top-right; the picture is upright-sided.
    let turned = render_bgra(&ff, &src, w, h, &ImageOps { rotate: 90, ..ImageOps::default() }, 0).unwrap();
    assert_eq!((turned.0, turned.1), (180, 320));
    assert_eq!(corner(&turned, 174, 5), left);
    // The preview is smaller and of the same shape.
    let small = render_bgra(&ff, &src, w, h, &ImageOps::default(), 160).unwrap();
    assert_eq!((small.0, small.1), (160, 90));
    // Brighter and greyer.
    let bright = render_bgra(&ff, &src, w, h, &ImageOps { brightness: 1.5, ..ImageOps::default() }, 0).unwrap();
    let sum = |f: &(u32, u32, Vec<u8>)| f.2.chunks(4).map(|p| p[0] as u64 + p[1] as u64 + p[2] as u64).sum::<u64>();
    assert!(sum(&bright) > sum(&plain) * 11 / 10);
    let grey = render_bgra(&ff, &src, w, h, &ImageOps { saturation: 0.0, ..ImageOps::default() }, 0).unwrap();
    let spread = |f: &(u32, u32, Vec<u8>)| f.2.chunks(4).map(|p| (p[0] as i64 - p[2] as i64).unsigned_abs()).sum::<u64>();
    assert!(spread(&grey) < spread(&plain) / 5, "{} against {}", spread(&grey), spread(&plain));
}
