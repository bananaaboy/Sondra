//! Pictures: turn, mirror, crop, scale, colour, blur, sharpen, and write as WebP, JPEG or PNG. The
//! operations, their order and the arithmetic of the crop rectangle are `src/lib/image.ts` and
//! `CropOverlay.tsx`; where the browser has a canvas, this has FFmpeg's filters.
//!
//! The order is fixed, as there: orient (turn, then mirror what ends up on screen), crop (a rectangle in
//! fractions of the turned frame), scale, colour, blur, sharpen. The preview and the file are made by one
//! function ([`chain`]) — a preview from a second, similar-looking path is one that will eventually lie.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::ffmpeg::{Ffmpeg, MediaError};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    /// Fractions of the frame, 0 to 1, so a crop survives a resize.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub const FULL_RECT: Rect = Rect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };

/// The ratios both editors offer, in the order people reach for them (`ASPECTS`).
pub const ASPECTS: [(&str, &str, Option<f64>); 6] = [
    ("free", "Frei", None),
    ("square", "1:1", Some(1.0)),
    ("classic", "4:3", Some(4.0 / 3.0)),
    ("photo", "3:2", Some(3.0 / 2.0)),
    ("wide", "16:9", Some(16.0 / 9.0)),
    ("tall", "9:16", Some(9.0 / 16.0)),
];

/// The largest rectangle of this ratio (width over height in pixels) inside the frame, centred.
pub fn rect_for_aspect(ratio: Option<f64>, source_aspect: f64, previous: Option<Rect>) -> Rect {
    let Some(ratio) = ratio else { return previous.unwrap_or(FULL_RECT) };
    let wanted = ratio / source_aspect;
    let mut width = 1.0;
    let mut height = width / wanted;
    if height > 1.0 {
        height = 1.0;
        width = height * wanted;
    }
    Rect { x: (1.0 - width) / 2.0, y: (1.0 - height) / 2.0, width, height }
}

/// The same selection after the picture under it has turned clockwise.
pub fn rotate_rect(rect: Rect, degrees: u16) -> Rect {
    match degrees {
        180 => Rect { x: 1.0 - rect.x - rect.width, y: 1.0 - rect.y - rect.height, ..rect },
        90 => Rect { x: 1.0 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width },
        270 => Rect { x: rect.y, y: 1.0 - rect.x - rect.width, width: rect.height, height: rect.width },
        _ => rect,
    }
}

/// The same selection after the picture has been mirrored (`'h'` left to right, `'v'` top to bottom).
pub fn mirror_rect(rect: Rect, axis: char) -> Rect {
    if axis == 'h' {
        Rect { x: 1.0 - rect.x - rect.width, ..rect }
    } else {
        Rect { y: 1.0 - rect.y - rect.height, ..rect }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    /// (label, extension, hint, lossy) in the order the web app lists them.
    pub const ALL: [(Format, &'static str, &'static str, &'static str, bool); 3] = [
        (Format::Webp, "WebP", "webp", "Kleinste Dateien, überall modern unterstützt", true),
        (Format::Jpeg, "JPEG", "jpg", "Fotos, von wirklich allem lesbar", true),
        (Format::Png, "PNG", "png", "Verlustfrei, kann Transparenz", false),
    ];

    pub fn extension(self) -> &'static str {
        Format::ALL.iter().find(|f| f.0 == self).map_or("png", |f| f.2)
    }
    pub fn label(self) -> &'static str {
        Format::ALL.iter().find(|f| f.0 == self).map_or("PNG", |f| f.1)
    }
    pub fn hint(self) -> &'static str {
        Format::ALL.iter().find(|f| f.0 == self).map_or("", |f| f.3)
    }
    pub fn lossy(self) -> bool {
        self != Format::Png
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageOps {
    /// Target width in pixels; 0 keeps the original.
    pub width: u32,
    pub crop: Option<Rect>,
    pub rotate: u16,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 1 is unchanged for all three.
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// Pixels of gaussian blur.
    pub blur: f64,
    /// 0 to 1.
    pub sharpen: f64,
    pub format: Format,
    /// 0 to 1, ignored by PNG.
    pub quality: f64,
    /// „Pixelgenau“: scaled by the nearest pixel (pixel art, screenshots), not smoothed.
    pub pixelated: bool,
}

impl Default for ImageOps {
    fn default() -> Self {
        ImageOps { width: 0, crop: None, rotate: 0, flip_h: false, flip_v: false, brightness: 1.0, contrast: 1.0, saturation: 1.0, blur: 0.0, sharpen: 0.0, format: Format::Webp, quality: 0.85, pixelated: false }
    }
}

/// The frame the crop rectangle lives in: turned a quarter, it is the other way round.
pub fn rotated_size(width: u32, height: u32, rotate: u16) -> (u32, u32) {
    if rotate == 90 || rotate == 270 {
        (height, width)
    } else {
        (width, height)
    }
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The size the result will have, without doing the work.
pub fn output_size(width: u32, height: u32, ops: &ImageOps) -> (u32, u32) {
    let (fw, fh) = rotated_size(width, height, ops.rotate);
    let (mut w, mut h) = match ops.crop {
        Some(c) => ((js_round(f64::from(fw) * c.width).max(1.0)) as u32, (js_round(f64::from(fh) * c.height).max(1.0)) as u32),
        None => (fw, fh),
    };
    if ops.width > 0 && ops.width != w {
        h = (js_round(f64::from(h) * f64::from(ops.width) / f64::from(w)).max(1.0)) as u32;
        w = ops.width;
    }
    (w, h)
}

/// FFmpeg's filter chain for these operations on a picture of this size, made `scale` times as large as the
/// result (1 for the file, less for a preview). Ends in `format=…`; a JPEG is laid on white first.
pub fn chain(width: u32, height: u32, ops: &ImageOps, scale: f64, end_format: &str) -> String {
    let mut f: Vec<String> = Vec::new();
    // Orient: turn clockwise, then mirror what ends up on screen.
    match ops.rotate {
        90 => f.push("transpose=1".into()),
        180 => f.push("hflip,vflip".into()),
        270 => f.push("transpose=2".into()),
        _ => {}
    }
    if ops.flip_h {
        f.push("hflip".into());
    }
    if ops.flip_v {
        f.push("vflip".into());
    }
    // Crop, in pixels of the turned frame.
    let (fw, fh) = rotated_size(width, height, ops.rotate);
    if let Some(c) = ops.crop {
        let (cw, ch) = (js_round(f64::from(fw) * c.width).max(1.0), js_round(f64::from(fh) * c.height).max(1.0));
        let (cx, cy) = (js_round(f64::from(fw) * c.x).max(0.0), js_round(f64::from(fh) * c.y).max(0.0));
        f.push(format!("crop={}:{}:{}:{}", cw as u32, ch as u32, cx as u32, cy as u32));
    }
    // Scale to the result (or the preview of it).
    let (ow, oh) = output_size(width, height, ops);
    let (sw, sh) = (((f64::from(ow) * scale).round().max(1.0)) as u32, ((f64::from(oh) * scale).round().max(1.0)) as u32);
    if (sw, sh) != (output_size(width, height, &ImageOps { width: 0, ..ops.clone() })) {
        f.push(format!("scale={sw}:{sh}:flags={}", if ops.pixelated { "neighbor" } else { "lanczos" }));
    }
    // Colour: brightness multiplies, contrast turns around mid grey, saturation multiplies.
    f.push("format=rgba".into());
    if (ops.brightness - 1.0).abs() > 1e-9 {
        let b = ops.brightness;
        f.push(format!("lutrgb=r=val*{b}:g=val*{b}:b=val*{b}"));
    }
    if (ops.contrast - 1.0).abs() > 1e-9 || (ops.saturation - 1.0).abs() > 1e-9 {
        f.push(format!("eq=contrast={}:saturation={}", ops.contrast, ops.saturation));
    }
    if ops.blur > 0.0 {
        f.push(format!("gblur=sigma={:.2}", ops.blur * scale));
    }
    if ops.sharpen > 0.0 {
        // The 3 × 3 pass of the web app: the middle 1 + 4a, the four neighbours −a.
        let a = ops.sharpen;
        let side = -a;
        let centre = 1.0 + 4.0 * a;
        let m = format!("0 {side} 0 {side} {centre} {side} 0 {side} 0");
        f.push(format!("convolution=0m={m}:1m={m}:2m={m}:3m=0 0 0 0 1 0 0 0 0:0rdiv=1:1rdiv=1:2rdiv=1:3rdiv=1"));
    }
    let tail = if end_format == "yuvj420p" {
        // A JPEG has no see-through: lay the picture on white.
        format!("[fg];color=c=white:s={sw}x{sh}:d=1,format=rgba[bg];[bg][fg]overlay=shortest=1,format=yuvj420p")
    } else {
        format!(",format={end_format}")
    };
    format!("{}{tail}", f.join(","))
}

/// The arguments for FFmpeg to write the picture.
pub fn write_args(input: &str, output: &str, width: u32, height: u32, ops: &ImageOps) -> Vec<String> {
    let jpeg = ops.format == Format::Jpeg;
    let graph = chain(width, height, ops, 1.0, if jpeg { "yuvj420p" } else { "rgba" });
    let mut args: Vec<String> = ["-v", "error", "-y", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(input.into());
    args.push("-filter_complex".into());
    args.push(format!("[0:v]{graph}"));
    for s in ["-frames:v", "1", "-update", "1"] {
        args.push(s.into());
    }
    match ops.format {
        Format::Webp => {
            args.extend(["-c:v", "libwebp", "-quality"].iter().map(|s| s.to_string()));
            args.push(format!("{}", (ops.quality * 100.0).round() as i64));
        }
        Format::Jpeg => {
            // mjpeg's scale runs 2 (best) to 31; quality 1 is 2, 0.3 about 24.
            let q = (31.0 - ops.quality.clamp(0.0, 1.0) * 29.0).round() as i64;
            args.extend(["-c:v", "mjpeg", "-q:v"].iter().map(|s| s.to_string()));
            args.push(q.to_string());
        }
        Format::Png => args.extend(["-c:v", "png"].iter().map(|s| s.to_string())),
    }
    args.push(output.into());
    args
}

/// The pixel size of a picture, by FFmpeg.
pub fn size_of(ffmpeg: &Ffmpeg, path: &Path) -> Result<(u32, u32), MediaError> {
    let probe = ffmpeg.probe(path)?;
    probe
        .streams
        .iter()
        .find(|s| s.kind == "video" && s.width.is_some())
        .and_then(|s| Some((s.width? as u32, s.height? as u32)))
        .ok_or_else(|| MediaError::Failed { code: None, tail: "Dieses Bild lässt sich nicht öffnen.".into() })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Made {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// Runs the chain and writes the picture into `dir` as `stem.ext` (or `stem (2).ext` — nothing is replaced).
pub fn process_file(ffmpeg: &Ffmpeg, input: &Path, dir: &Path, stem: &str, ops: &ImageOps) -> Result<Made, String> {
    let (w, h) = size_of(ffmpeg, input).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = crate::run::unique_path(dir, stem, ops.format.extension());
    let temp = dir.join(format!(".sondra-bild-{}.{}", std::process::id(), ops.format.extension()));
    let args = write_args(&input.to_string_lossy(), &temp.to_string_lossy(), w, h, ops);
    let out = Command::new(ffmpeg.program()).args(&args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&temp);
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Das Bild liess sich nicht schreiben. {}", said.lines().last().unwrap_or("")));
    }
    let bytes = std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    if bytes == 0 {
        let _ = std::fs::remove_file(&temp);
        return Err("FFmpeg hat eine leere Datei geschrieben.".into());
    }
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
    let (width, height) = output_size(w, h, ops);
    Ok(Made { path: target, width, height, bytes })
}

/// The picture for the stage: the chain at a size that fits `max_side`, as BGRA, with its size.
pub fn render_bgra(ffmpeg: &Ffmpeg, input: &Path, width: u32, height: u32, ops: &ImageOps, max_side: u32) -> Result<(u32, u32, Vec<u8>), String> {
    let (ow, oh) = output_size(width, height, ops);
    let scale = if max_side > 0 && ow.max(oh) > max_side { f64::from(max_side) / f64::from(ow.max(oh)) } else { 1.0 };
    let graph = chain(width, height, &ImageOps { format: Format::Png, ..ops.clone() }, scale, "bgra");
    let (pw, ph) = (((f64::from(ow) * scale).round().max(1.0)) as u32, ((f64::from(oh) * scale).round().max(1.0)) as u32);
    let out = Command::new(ffmpeg.program())
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(input)
        .args(["-filter_complex", &format!("[0:v]{graph}"), "-frames:v", "1", "-f", "rawvideo", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() || out.stdout.len() != (pw * ph * 4) as usize {
        return Err(format!("Die Vorschau liess sich nicht rechnen. {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
    }
    Ok((pw, ph, out.stdout))
}
