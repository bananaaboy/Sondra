//! Video operations as one FFmpeg invocation — a port of `src/lib/video.ts`, argument for argument.
//!
//! Every edit is a filter, and filters compose: cutting, cropping, straightening, scaling and changing the
//! speed happen in one pass rather than five. The order of the chain is fixed and not arbitrary: crop first
//! so everything downstream has fewer pixels, scale before the speed change, `setpts` last because it rewrites
//! the timestamps the earlier filters rely on. What the browser needed workarounds for stays as it is where
//! the files must be the same ones the web app makes (VP8 for WebM, libopus at complexity 4).

use crate::convert::{opus_args, vp8_args};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mp4,
    Webm,
    Gif,
    Webp,
}

impl Container {
    pub fn id(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Webm => "webm",
            Container::Gif => "gif",
            Container::Webp => "webp",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// 0 keeps the source height.
    pub height: u32,
    /// Constant Rate Factor: lower is better and bigger.
    pub crf: f64,
}

pub const VIDEO_PRESETS: [VideoPreset; 5] = [
    VideoPreset { id: "original", label: "Original", hint: "Auflösung unverändert, sichtbar verlustfrei", height: 0, crf: 18.0 },
    VideoPreset { id: "high", label: "Hohe Qualität", hint: "Auflösung unverändert, deutlich kleiner", height: 0, crf: 22.0 },
    VideoPreset { id: "1080p", label: "1080p", hint: "Full HD — der übliche Kompromiss", height: 1080, crf: 23.0 },
    VideoPreset { id: "720p", label: "720p", hint: "Schnell und klein, gut für Messenger", height: 720, crf: 25.0 },
    VideoPreset { id: "480p", label: "480p", hint: "Sehr klein, für Vorschau und E-Mail", height: 480, crf: 28.0 },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    None,
    Mono,
    Sepia,
    Vivid,
    Warm,
    Cool,
}

pub const VIDEO_LOOKS: [(Look, &str, &str); 6] = [
    (Look::None, "none", "Ohne"),
    (Look::Mono, "mono", "Schwarzweiss"),
    (Look::Sepia, "sepia", "Sepia"),
    (Look::Vivid, "vivid", "Lebendig"),
    (Look::Warm, "warm", "Warm"),
    (Look::Cool, "cool", "Kühl"),
];

fn look_filter(look: Look) -> Option<&'static str> {
    match look {
        Look::None => None,
        Look::Mono => Some("hue=s=0"),
        Look::Sepia => Some("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"),
        Look::Vivid => Some("eq=saturation=1.35:contrast=1.08"),
        Look::Warm => Some("colorbalance=rs=.08:gs=.02:bs=-.08:rm=.06:bm=-.06"),
        Look::Cool => Some("colorbalance=rs=-.06:bs=.08:rm=-.04:bm=.06"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CropBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoOps {
    /// Seconds. An `end` of 0 means to the end of the file.
    pub start: f64,
    pub end: f64,
    pub crop: Option<CropBox>,
    pub rotate: u16,
    pub flip_h: bool,
    pub flip_v: bool,
    /// 1 is unchanged; 0.5 is half speed, 2 double.
    pub speed: f64,
    pub mute: bool,
    pub container: Container,
    pub preset: String,
    /// Added (−0.3 to 0.3); contrast and saturation multiply.
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub look: Look,
    pub sharpen: bool,
    pub denoise: bool,
    pub stabilize: bool,
    /// Seconds of the finished clip, picture and sound together.
    pub fade_in: f64,
    pub fade_out: f64,
    /// Sound level change in dB.
    pub volume_db: f64,
    /// Bring the sound to −16 LUFS, the level most platforms play at.
    pub loudnorm: bool,
    pub reverse: bool,
    pub fps: f64,
    pub width: f64,
}

impl Default for VideoOps {
    fn default() -> Self {
        VideoOps {
            start: 0.0,
            end: 0.0,
            crop: None,
            rotate: 0,
            flip_h: false,
            flip_v: false,
            speed: 1.0,
            mute: false,
            container: Container::Mp4,
            preset: "1080p".into(),
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            look: Look::None,
            sharpen: false,
            denoise: false,
            stabilize: false,
            fade_in: 0.0,
            fade_out: 0.0,
            volume_db: 0.0,
            loudnorm: false,
            reverse: false,
            fps: 15.0,
            width: 480.0,
        }
    }
}

/// `Number.prototype.toFixed`: the decimal text of the exact value, rounded half up at `digits`.
pub fn to_fixed(value: f64, digits: usize) -> String {
    let negative = value < 0.0;
    let exact = format!("{:.60}", value.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut all: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).map(|b| b - b'0').collect();
    if fraction.as_bytes().get(digits).is_some_and(|b| *b >= b'5') {
        let mut i = all.len();
        loop {
            if i == 0 {
                all.insert(0, 1);
                break;
            }
            i -= 1;
            if all[i] == 9 {
                all[i] = 0;
            } else {
                all[i] += 1;
                break;
            }
        }
    }
    let int_len = all.len() - digits;
    let int_part: String = all[..int_len].iter().map(|d| (b'0' + d) as char).collect();
    let text = if digits == 0 { int_part } else { format!("{int_part}.{}", all[int_len..].iter().map(|d| (b'0' + d) as char).collect::<String>()) };
    // JavaScript: a negative number keeps its sign even when the digits come out as zeros; minus zero is not negative.
    if negative {
        format!("-{text}")
    } else {
        text
    }
}

fn find_preset(id: &str) -> &'static VideoPreset {
    VIDEO_PRESETS.iter().find(|p| p.id == id).unwrap_or(&VIDEO_PRESETS[2])
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `atempo` only accepts 0.5 to 2.0, so anything beyond is reached by chaining.
fn tempo_chain(speed: f64) -> Vec<String> {
    let mut stages = Vec::new();
    let mut remaining = speed;
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining *= 2.0;
    }
    if (remaining - 1.0).abs() > 0.001 {
        stages.push(remaining);
    }
    stages.into_iter().map(|s| format!("atempo={}", to_fixed(s, 4))).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct BuiltJob {
    pub args: Vec<String>,
    /// What the result should be called, extension included.
    pub extension: &'static str,
    pub mime: &'static str,
    /// True when nothing was asked for that requires re-encoding.
    pub copy_only: bool,
}

fn touches_content(o: &VideoOps) -> bool {
    o.brightness != 0.0 || o.contrast != 1.0 || o.saturation != 1.0 || o.look != Look::None || o.sharpen || o.denoise || o.stabilize || o.fade_in > 0.0 || o.fade_out > 0.0 || o.volume_db != 0.0 || o.loudnorm || o.reverse
}

fn s(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

/// Turns the settings into an argument list. `source` is the picture's size, when it is known.
pub fn build_video_job(ops: &VideoOps, input: &str, duration: f64, source: Option<(u32, u32)>) -> BuiltJob {
    let preset = find_preset(&ops.preset);
    let mut args: Vec<String> = vec!["-i".into(), input.into()];

    let end = if ops.end > 0.0 { ops.end } else { duration };
    let trimmed = ops.start > 0.0 || (ops.end > 0.0 && ops.end < duration - 0.001);
    // Length of the kept part in the source's own time, before any speed change.
    let span = (end - ops.start).max(0.01);

    let mut filters: Vec<String> = Vec::new();
    if ops.reverse {
        filters.push("reverse".into());
    }
    if ops.stabilize {
        filters.push("deshake".into());
    }
    // Straighten first, crop second.
    match ops.rotate {
        90 => filters.push("transpose=1".into()),
        180 => filters.push("transpose=1,transpose=1".into()),
        270 => filters.push("transpose=2".into()),
        _ => {}
    }
    if ops.flip_h {
        filters.push("hflip".into());
    }
    if ops.flip_v {
        filters.push("vflip".into());
    }
    if let Some(c) = ops.crop {
        let even = |value: String| format!("trunc({value}/2)*2");
        filters.push(format!(
            "crop={}:{}:{}:{}",
            even(format!("iw*{}", to_fixed(c.width, 4))),
            even(format!("ih*{}", to_fixed(c.height, 4))),
            even(format!("iw*{}", to_fixed(c.x, 4))),
            even(format!("ih*{}", to_fixed(c.y, 4)))
        ));
    }
    if preset.height > 0 {
        let height = source.map_or(f64::from(preset.height), |(_, h)| f64::from(preset.height.min(h)));
        // Odd heights have no valid 4:2:0 chroma plane.
        filters.push(format!("scale=-2:{}", 2f64.max(js_round(height / 2.0) * 2.0) as i64));
    }
    if ops.denoise {
        filters.push("hqdn3d=3:2:4:3".into());
    }
    if ops.brightness != 0.0 || ops.contrast != 1.0 || ops.saturation != 1.0 {
        filters.push(format!("eq=brightness={}:contrast={}:saturation={}", to_fixed(ops.brightness, 3), to_fixed(ops.contrast, 3), to_fixed(ops.saturation, 3)));
    }
    if let Some(look) = look_filter(ops.look) {
        filters.push(look.into());
    }
    if ops.sharpen {
        filters.push("unsharp=5:5:0.8:3:3:0".into());
    }
    // Fades are timed on the kept part, which the trim below has already moved to start at zero, and before
    // the speed change — hence the multiplication.
    if ops.fade_in > 0.0 {
        filters.push(format!("fade=t=in:st=0:d={}", to_fixed(ops.fade_in * ops.speed, 3)));
    }
    if ops.fade_out > 0.0 {
        let length = span.min(ops.fade_out * ops.speed);
        filters.push(format!("fade=t=out:st={}:d={}", to_fixed((span - length).max(0.0), 3), to_fixed(length, 3)));
    }
    if ops.speed != 1.0 {
        filters.push(format!("setpts={}*PTS", to_fixed(1.0 / ops.speed, 5)));
    }

    let untouched = filters.is_empty() && ops.speed == 1.0 && !touches_content(ops);

    // A plain cut can copy the streams; the moment anything is re-encoded, the cut becomes a trim filter at
    // the head of the graph instead.
    let mut cut_args: Vec<String> = Vec::new();
    if trimmed {
        cut_args = vec!["-ss".into(), to_fixed(ops.start, 3)];
        if end < duration - 0.001 {
            cut_args.push("-to".into());
            cut_args.push(to_fixed(end, 3));
        }
        filters.insert(0, "setpts=PTS-STARTPTS".into());
        filters.insert(0, format!("trim=start={}:end={}", to_fixed(ops.start, 3), to_fixed(end, 3)));
    }

    let mut audio_filters: Vec<String> = Vec::new();
    if trimmed {
        audio_filters.push(format!("atrim=start={}:end={}", to_fixed(ops.start, 3), to_fixed(end, 3)));
        audio_filters.push("asetpts=PTS-STARTPTS".into());
    }
    if ops.reverse {
        audio_filters.push("areverse".into());
    }
    if ops.fade_in > 0.0 {
        audio_filters.push(format!("afade=t=in:st=0:d={}", to_fixed(ops.fade_in * ops.speed, 3)));
    }
    if ops.fade_out > 0.0 {
        let length = span.min(ops.fade_out * ops.speed);
        audio_filters.push(format!("afade=t=out:st={}:d={}", to_fixed((span - length).max(0.0), 3), to_fixed(length, 3)));
    }
    if ops.volume_db != 0.0 {
        audio_filters.push(format!("volume={}dB", to_fixed(ops.volume_db, 1)));
    }
    if ops.speed != 1.0 {
        audio_filters.extend(tempo_chain(ops.speed));
    }
    if ops.loudnorm {
        audio_filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".into());
    }

    let fps = ops.fps;
    let width = ops.width;
    match ops.container {
        Container::Gif => {
            if trimmed {
                args.extend(cut_args);
            }
            args.push("-vf".into());
            args.push(format!("fps={},scale={}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer", crate::convert::js_number(fps), crate::convert::js_number(width)));
            args.extend(s(&["-loop", "0"]));
            return BuiltJob { args, extension: "gif", mime: "image/gif", copy_only: false };
        }
        Container::Webp => {
            if trimmed {
                args.extend(cut_args);
            }
            args.extend(s(&["-vcodec", "libwebp", "-filter:v"]));
            args.push(format!("fps={},scale={}:-1", crate::convert::js_number(fps), crate::convert::js_number(width)));
            args.extend(s(&["-lossless", "0", "-compression_level", "4", "-q:v", "70", "-loop", "0"]));
            return BuiltJob { args, extension: "webp", mime: "image/webp", copy_only: false };
        }
        _ => {}
    }

    // Nothing but a cut: copy the streams instead of re-encoding them.
    if ops.container == Container::Mp4 && untouched && trimmed && !ops.mute {
        args.extend(cut_args);
        args.extend(s(&["-c", "copy", "-avoid_negative_ts", "make_zero"]));
        return BuiltJob { args, extension: "mp4", mime: "video/mp4", copy_only: true };
    }

    if !filters.is_empty() {
        args.push("-vf".into());
        args.push(filters.join(","));
    }
    if ops.mute {
        args.push("-an".into());
    } else if !audio_filters.is_empty() {
        args.push("-filter:a".into());
        args.push(audio_filters.join(","));
    }

    if ops.container == Container::Webm {
        // VP8 and Opus at complexity 4.
        args.extend(vp8_args(preset.crf));
        if !ops.mute {
            args.extend(opus_args("128k"));
        }
        return BuiltJob { args, extension: "webm", mime: "video/webm", copy_only: false };
    }

    args.extend(s(&["-c:v", "libx264", "-crf"]));
    args.push(crate::convert::js_number(preset.crf));
    args.extend(s(&["-preset", "medium", "-pix_fmt", "yuv420p"]));
    if !ops.mute {
        args.extend(s(&["-c:a", "aac", "-b:a", "192k"]));
    }
    args.extend(s(&["-movflags", "+faststart"]));
    BuiltJob { args, extension: "mp4", mime: "video/mp4", copy_only: false }
}

/// Pulls the audio out untouched where possible, re-encoded where not.
pub fn build_audio_extraction(input: &str, format: &str) -> BuiltJob {
    let mut args = s(&["-i", input, "-vn"]);
    match format {
        "wav" => {
            args.extend(s(&["-c:a", "pcm_s16le"]));
            BuiltJob { args, extension: "wav", mime: "audio/wav", copy_only: false }
        }
        "mp3" => {
            args.extend(s(&["-c:a", "libmp3lame", "-q:a", "2"]));
            BuiltJob { args, extension: "mp3", mime: "audio/mpeg", copy_only: false }
        }
        "flac" => {
            args.extend(s(&["-c:a", "flac"]));
            BuiltJob { args, extension: "flac", mime: "audio/flac", copy_only: false }
        }
        _ => {
            // Copy keeps whatever the video carried: usually AAC in an .m4a shell.
            args.extend(s(&["-c:a", "copy"]));
            BuiltJob { args, extension: "m4a", mime: "audio/mp4", copy_only: true }
        }
    }
}

/// A single frame as a PNG.
pub fn build_frame_grab(input: &str, at_seconds: f64) -> BuiltJob {
    BuiltJob { args: vec!["-ss".into(), to_fixed(at_seconds, 3), "-i".into(), input.into(), "-frames:v".into(), "1".into()], extension: "png", mime: "image/png", copy_only: false }
}

/// Replaces the soundtrack, keeping the picture untouched.
pub fn build_audio_replacement(video: &str, audio: &str) -> BuiltJob {
    BuiltJob {
        args: s(&["-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart"]),
        extension: "mp4",
        mime: "video/mp4",
        copy_only: false,
    }
}


/// The size of the picture after turning and cropping, as the crop filter works it out (even numbers only,
/// which 4:2:0 chroma needs): what `build_video_job`'s `crop=` makes of a source of this size.
pub fn cropped_size(width: u32, height: u32, ops: &VideoOps) -> (u32, u32) {
    let (w, h) = if ops.rotate == 90 || ops.rotate == 270 { (height, width) } else { (width, height) };
    match ops.crop {
        Some(c) => {
            let even = |v: f64| ((v / 2.0).trunc() * 2.0).max(2.0) as u32;
            // The filter reads the fractions at four digits, as written.
            let at4 = |v: f64| to_fixed(v, 4).parse::<f64>().unwrap_or(v);
            (even(f64::from(w) * at4(c.width)), even(f64::from(h) * at4(c.height)))
        }
        None => (w, h),
    }
}

/// The picture part of the chain, for a still of what will be written: turned, mirrored, cropped, softened,
/// coloured, sharpened. Not the cut, the speed, the fades, the reversal or the stabilising — those are about
/// time, and a still has none.
pub fn preview_filters(ops: &VideoOps) -> Vec<String> {
    let mut filters: Vec<String> = Vec::new();
    match ops.rotate {
        90 => filters.push("transpose=1".into()),
        180 => filters.push("transpose=1,transpose=1".into()),
        270 => filters.push("transpose=2".into()),
        _ => {}
    }
    if ops.flip_h {
        filters.push("hflip".into());
    }
    if ops.flip_v {
        filters.push("vflip".into());
    }
    if let Some(c) = ops.crop {
        let even = |value: String| format!("trunc({value}/2)*2");
        filters.push(format!(
            "crop={}:{}:{}:{}",
            even(format!("iw*{}", to_fixed(c.width, 4))),
            even(format!("ih*{}", to_fixed(c.height, 4))),
            even(format!("iw*{}", to_fixed(c.x, 4))),
            even(format!("ih*{}", to_fixed(c.y, 4)))
        ));
    }
    if ops.denoise {
        filters.push("hqdn3d=3:2:4:3".into());
    }
    if ops.brightness != 0.0 || ops.contrast != 1.0 || ops.saturation != 1.0 {
        filters.push(format!("eq=brightness={}:contrast={}:saturation={}", to_fixed(ops.brightness, 3), to_fixed(ops.contrast, 3), to_fixed(ops.saturation, 3)));
    }
    if let Some(look) = look_filter(ops.look) {
        filters.push(look.into());
    }
    if ops.sharpen {
        filters.push("unsharp=5:5:0.8:3:3:0".into());
    }
    filters
}
