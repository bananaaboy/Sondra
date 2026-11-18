//! Output formats and the FFmpeg argument lists behind them. A port of `src/lib/convert.ts`.

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

/// A choice that is either "as the source" or a value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pick<T> {
    Source,
    Value(T),
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Pick<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw<T> {
            Word(String),
            Number(T),
        }
        match Raw::<T>::deserialize(deserializer)? {
            Raw::Word(word) if word == "source" => Ok(Pick::Source),
            Raw::Word(other) => Err(de::Error::custom(format!(
                "expected a number or \"source\", got {other:?}"
            ))),
            Raw::Number(value) => Ok(Pick::Value(value)),
        }
    }
}

impl<T: Serialize> Serialize for Pick<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Pick::Source => serializer.serialize_str("source"),
            Pick::Value(v) => v.serialize(serializer),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Frame {
    #[default]
    Source,
    /// 1080 × 1920, the picture fitted in with black bars — what Reels, Stories and Shorts take.
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub format_id: String,
    /// Constant bitrate in kbit/s, for the lossy codecs.
    pub audio_bitrate_kbps: u32,
    /// 0 (best) to 9 (smallest) for the VBR codecs.
    pub audio_quality: u32,
    pub use_variable_bitrate: bool,
    pub sample_rate: Pick<u32>,
    pub channels: Pick<u8>,
    pub wav_bit_depth: u8,
    /// Constant Rate Factor — lower is better quality, larger file.
    pub video_crf: f64,
    pub video_preset: String,
    /// Target height in pixels; width follows the source aspect ratio.
    pub video_height: Pick<u32>,
    #[serde(default)]
    pub video_frame: Frame,
    pub frame_rate: Pick<f64>,
    pub trim_start_seconds: Option<f64>,
    pub trim_end_seconds: Option<f64>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            format_id: "mp3".into(),
            audio_bitrate_kbps: 192,
            audio_quality: 2,
            use_variable_bitrate: true,
            sample_rate: Pick::Source,
            channels: Pick::Source,
            wav_bit_depth: 24,
            video_crf: 23.0,
            video_preset: "medium".into(),
            video_height: Pick::Source,
            video_frame: Frame::Source,
            frame_rate: Pick::Source,
            trim_start_seconds: None,
            trim_end_seconds: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Audio,
    Video,
    Image,
}

#[derive(Debug, Clone, Copy)]
pub struct Format {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub extension: &'static str,
    pub kind: Kind,
    pub mime: &'static str,
    pub lossless: bool,
    /// The sample rates the encoder accepts, where it does not accept all of them. MP3 stops at 48
    /// kHz and Opus only knows 48 kHz.
    pub sample_rates: Option<&'static [u32]>,
}

pub const FORMATS: [Format; 10] = [
    Format {
        id: "mp3",
        label: "MP3",
        hint: "Überall abspielbar",
        extension: "mp3",
        kind: Kind::Audio,
        mime: "audio/mpeg",
        lossless: false,
        sample_rates: Some(&[22050, 32000, 44100, 48000]),
    },
    Format {
        id: "aac",
        label: "AAC (M4A)",
        hint: "Apple-Ökosystem",
        extension: "m4a",
        kind: Kind::Audio,
        mime: "audio/mp4",
        lossless: false,
        sample_rates: None,
    },
    Format {
        id: "opus",
        label: "Opus",
        hint: "Beste Qualität pro Bit",
        extension: "opus",
        kind: Kind::Audio,
        mime: "audio/ogg",
        lossless: false,
        sample_rates: Some(&[48000]),
    },
    Format {
        id: "vorbis",
        label: "Ogg Vorbis",
        hint: "Offenes Format",
        extension: "ogg",
        kind: Kind::Audio,
        mime: "audio/ogg",
        lossless: false,
        sample_rates: None,
    },
    Format {
        id: "flac",
        label: "FLAC",
        hint: "Verlustfrei komprimiert",
        extension: "flac",
        kind: Kind::Audio,
        mime: "audio/flac",
        lossless: true,
        sample_rates: None,
    },
    Format {
        id: "alac",
        label: "ALAC (M4A)",
        hint: "Verlustfrei, Apple",
        extension: "m4a",
        kind: Kind::Audio,
        mime: "audio/mp4",
        lossless: true,
        sample_rates: None,
    },
    Format {
        id: "wav",
        label: "WAV",
        hint: "Unkomprimiert, für Schnitt",
        extension: "wav",
        kind: Kind::Audio,
        mime: "audio/wav",
        lossless: true,
        sample_rates: None,
    },
    Format {
        id: "mp4",
        label: "MP4 (H.264)",
        hint: "Standard für Video",
        extension: "mp4",
        kind: Kind::Video,
        mime: "video/mp4",
        lossless: false,
        sample_rates: None,
    },
    Format {
        id: "webm",
        label: "WebM (VP8)",
        hint: "Offen, fürs Web",
        extension: "webm",
        kind: Kind::Video,
        mime: "video/webm",
        lossless: false,
        sample_rates: Some(&[48000]),
    },
    Format {
        id: "gif",
        label: "GIF",
        hint: "Kurze Schleifen",
        extension: "gif",
        kind: Kind::Image,
        mime: "image/gif",
        lossless: false,
        sample_rates: None,
    },
];

pub const VIDEO_PRESETS: [&str; 7] = [
    "ultrafast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "veryslow",
];
pub const SAMPLE_RATES: [u32; 5] = [22050, 32000, 44100, 48000, 96000];
pub const BITRATES: [u32; 7] = [64, 96, 128, 160, 192, 256, 320];

pub fn find_format(id: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|f| f.id == id)
}

/// A number as JavaScript prints it: `30` for 30.0, `29.97` for 29.97.
pub fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

fn s(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

/// Opus through libopus, held at complexity 4. The WebAssembly build crashed from 5 up; the files
/// this makes are the ones the web app makes, so the limit stays.
pub fn opus_args(rate: &str) -> Vec<String> {
    s(&[
        "-c:a",
        "libopus",
        "-b:a",
        rate,
        "-vbr",
        "on",
        "-compression_level",
        "4",
    ])
}

/// WebM pictures as VP8, the x264 quality scale mapped onto VP8's so that 23 stays "a good compromise".
pub fn vp8_args(x264_crf: f64) -> Vec<String> {
    // `Math.round`: halves go up.
    let crf = (x264_crf * 0.9 - 10.0 + 0.5).floor().clamp(4.0, 50.0) as i64;
    let mut args = s(&["-c:v", "libvpx", "-crf"]);
    args.push(crf.to_string());
    args.extend(s(&["-b:v", "8M", "-deadline", "good", "-cpu-used", "4"]));
    args
}

fn codec_args(format: &Format, st: &Settings) -> Vec<String> {
    let bitrate = format!("{}k", st.audio_bitrate_kbps);
    match format.id {
        "mp3" => {
            let mut a = s(&["-c:a", "libmp3lame"]);
            if st.use_variable_bitrate {
                a.extend(s(&["-q:a"]));
                a.push(st.audio_quality.to_string());
            } else {
                a.extend(s(&["-b:a"]));
                a.push(bitrate);
            }
            a
        }
        "aac" => {
            let mut a = s(&["-c:a", "aac", "-b:a"]);
            a.push(bitrate);
            a.extend(s(&["-movflags", "+faststart"]));
            a
        }
        "opus" => opus_args(&bitrate),
        "vorbis" => {
            let mut a = s(&["-c:a", "libvorbis", "-q:a"]);
            a.push(10u32.saturating_sub(st.audio_quality).to_string());
            a
        }
        "flac" => s(&["-c:a", "flac", "-compression_level", "8"]),
        "alac" => s(&["-c:a", "alac"]),
        "wav" => {
            let codec = match st.wav_bit_depth {
                16 => "pcm_s16le",
                24 => "pcm_s24le",
                _ => "pcm_f32le",
            };
            s(&["-c:a", codec])
        }
        "mp4" => {
            let mut a = s(&["-c:v", "libx264", "-crf"]);
            a.push(js_number(st.video_crf));
            a.push("-preset".into());
            a.push(st.video_preset.clone());
            // 4:2:0 is the only chroma layout every hardware decoder accepts.
            a.extend(s(&["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a"]));
            a.push(bitrate);
            a.extend(s(&["-movflags", "+faststart"]));
            a
        }
        "webm" => {
            let mut a = vp8_args(st.video_crf);
            a.extend(opus_args(&bitrate));
            a
        }
        _ => Vec::new(),
    }
}

/// GIF replaces the whole tail of the command: one pass builds a palette from the clip, then applies it.
fn filter_complex(format: &Format, st: &Settings) -> Option<Vec<String>> {
    if format.id != "gif" {
        return None;
    }
    let fps = match st.frame_rate {
        Pick::Source => 12.0,
        Pick::Value(v) => v,
    };
    let scale = match st.video_height {
        Pick::Source => 480,
        Pick::Value(v) => v,
    };
    Some(vec![
        "-filter_complex".into(),
        format!(
            "fps={},scale=-1:{scale}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
            js_number(fps)
        ),
        "-loop".into(),
        "0".into(),
    ])
}

/// The rate actually passed to FFmpeg: the chosen one if the encoder takes it, otherwise the nearest
/// one it does ("as the source" stays as it is).
pub fn rate_for(format: &Format, wanted: Pick<u32>) -> Pick<u32> {
    let Pick::Value(want) = wanted else {
        return Pick::Source;
    };
    match format.sample_rates {
        None => Pick::Value(want),
        Some(rates) if rates.contains(&want) => Pick::Value(want),
        Some(rates) => {
            let mut best = rates[0];
            for &rate in rates {
                if rate.abs_diff(want) < best.abs_diff(want) {
                    best = rate;
                }
            }
            Pick::Value(best)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Unbekanntes Format: {0}")]
pub struct UnknownFormat(pub String);

/// The complete argument list for one conversion (without the options that only make FFmpeg quiet
/// and machine-readable; see [`crate::ffmpeg`]).
pub fn build_args(input: &str, output: &str, st: &Settings) -> Result<Vec<String>, UnknownFormat> {
    let format = find_format(&st.format_id).ok_or_else(|| UnknownFormat(st.format_id.clone()))?;
    let mut args = vec!["-i".to_owned(), input.to_owned()];

    // Output-side seeking: slower than seeking the input, but frame accurate.
    if let Some(start) = st.trim_start_seconds {
        args.push("-ss".into());
        args.push(format!("{start:.3}"));
    }
    if let Some(end) = st.trim_end_seconds {
        args.push("-to".into());
        args.push(format!("{end:.3}"));
    }

    if let Some(complex) = filter_complex(format, st) {
        args.extend(complex);
        args.push("-an".into());
    } else {
        if format.kind == Kind::Audio {
            args.push("-vn".into());
        }
        if format.kind == Kind::Video {
            let mut filters: Vec<String> = Vec::new();
            if st.video_frame == Frame::Vertical {
                // Fitted, not cropped: a landscape film keeps its whole picture.
                filters.push("scale=1080:1920:force_original_aspect_ratio=decrease".into());
                filters.push("pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black".into());
                filters.push("setsar=1".into());
            } else if let Pick::Value(height) = st.video_height {
                // -2 keeps the aspect ratio and rounds to an even width, which both H.264 and VP8 require.
                filters.push(format!("scale=-2:{height}"));
            }
            if let Pick::Value(fps) = st.frame_rate {
                filters.push(format!("fps={}", js_number(fps)));
            }
            if !filters.is_empty() {
                args.push("-vf".into());
                args.push(filters.join(","));
            }
        }
        args.extend(codec_args(format, st));
        if let Pick::Value(rate) = rate_for(format, st.sample_rate) {
            args.push("-ar".into());
            args.push(rate.to_string());
        }
        if let Pick::Value(channels) = st.channels {
            args.push("-ac".into());
            args.push(channels.to_string());
        }
    }
    args.push(output.to_owned());
    Ok(args)
}

/// The same command, rendered the way you would type it into a shell.
pub fn preview_command(args: &[String]) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            if a.chars()
                .any(|c| c.is_whitespace() || c == '"' || c == '\'')
            {
                format!("{a:?}")
            } else {
                a.clone()
            }
        })
        .collect();
    format!("ffmpeg {}", quoted.join(" "))
}
