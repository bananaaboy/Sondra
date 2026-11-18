//! Templates for the converter: one click instead of five settings. A port of
//! `src/lib/convertPresets.ts` (the four that come with Sondra; own ones belong to the app's
//! settings, not to this crate).

use serde::Deserialize;

use crate::convert::{Frame, Kind, Pick, Settings};

/// The settings a template sets; trimming belongs to the file, not to it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Partial {
    pub format_id: Option<String>,
    pub audio_bitrate_kbps: Option<u32>,
    pub audio_quality: Option<u32>,
    pub use_variable_bitrate: Option<bool>,
    pub sample_rate: Option<Pick<u32>>,
    pub channels: Option<Pick<u8>>,
    pub wav_bit_depth: Option<u8>,
    pub video_crf: Option<f64>,
    pub video_preset: Option<String>,
    pub video_height: Option<Pick<u32>>,
    pub video_frame: Option<Frame>,
    pub frame_rate: Option<Pick<f64>>,
}

impl Partial {
    /// Puts what this template sets over `settings`.
    pub fn apply(&self, settings: &mut Settings) {
        macro_rules! set {
            ($($field:ident),*) => {$(
                if let Some(v) = &self.$field { settings.$field = v.clone(); }
            )*};
        }
        set!(
            format_id,
            audio_bitrate_kbps,
            audio_quality,
            use_variable_bitrate,
            sample_rate,
            channels,
            wav_bit_depth,
            video_crf,
            video_preset,
            video_height,
            video_frame,
            frame_rate
        );
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// For a video file; also what a sound file gets when `audio` is absent and it is audio itself.
    pub video: Option<Partial>,
    /// For a sound file — or for taking only the sound from a video.
    pub audio: Option<Partial>,
}

fn p(format: &str) -> Partial {
    Partial {
        format_id: Some(format.to_owned()),
        ..Partial::default()
    }
}

/// WhatsApp, Instagram Reel, Hörbuch, Klein für E-Mail.
pub fn built_in() -> Vec<Preset> {
    vec![
        Preset {
            id: "whatsapp",
            label: "Für WhatsApp",
            hint: "MP4 in 720p, kompakt — spielt auf jedem Handy. Ton als M4A.",
            video: Some(Partial {
                video_frame: Some(Frame::Source),
                video_height: Some(Pick::Value(720)),
                video_crf: Some(28.0),
                video_preset: Some("medium".into()),
                frame_rate: Some(Pick::Value(30.0)),
                audio_bitrate_kbps: Some(96),
                channels: Some(Pick::Source),
                sample_rate: Some(Pick::Source),
                ..p("mp4")
            }),
            audio: Some(Partial { audio_bitrate_kbps: Some(128), channels: Some(Pick::Source), sample_rate: Some(Pick::Source), ..p("aac") }),
        },
        Preset {
            id: "reel",
            label: "Instagram Reel",
            hint: "MP4 im Hochformat 1080 × 1920, 30 Bilder/s — das Bild ganz, mit Rändern.",
            video: Some(Partial {
                video_frame: Some(Frame::Vertical),
                video_height: Some(Pick::Source),
                video_crf: Some(21.0),
                video_preset: Some("medium".into()),
                frame_rate: Some(Pick::Value(30.0)),
                audio_bitrate_kbps: Some(128),
                channels: Some(Pick::Source),
                sample_rate: Some(Pick::Source),
                ..p("mp4")
            }),
            audio: None,
        },
        Preset {
            id: "hoerbuch",
            label: "Hörbuch",
            hint: "M4A in Mono mit 64 kbit/s — Sprache klar, die Datei klein. Aus einem Video nur der Ton.",
            video: None,
            audio: Some(Partial { audio_bitrate_kbps: Some(64), channels: Some(Pick::Value(1)), sample_rate: Some(Pick::Value(44100)), ..p("aac") }),
        },
        Preset {
            id: "email",
            label: "Klein für E-Mail",
            hint: "MP4 in 480p, stark verkleinert; Ton als MP3 in Mono.",
            video: Some(Partial {
                video_frame: Some(Frame::Source),
                video_height: Some(Pick::Value(480)),
                video_crf: Some(30.0),
                video_preset: Some("medium".into()),
                frame_rate: Some(Pick::Value(24.0)),
                audio_bitrate_kbps: Some(64),
                channels: Some(Pick::Value(1)),
                sample_rate: Some(Pick::Source),
                ..p("mp4")
            }),
            audio: Some(Partial {
                use_variable_bitrate: Some(false),
                audio_bitrate_kbps: Some(96),
                channels: Some(Pick::Value(1)),
                sample_rate: Some(Pick::Source),
                ..p("mp3")
            }),
        },
    ]
}

/// What a template sets for this file: a video takes the video settings, or the sound ones when the
/// template only has those (Hörbuch); a sound file only ever takes sound settings.
pub fn preset_for(preset: &Preset, source: Kind) -> Option<&Partial> {
    if source == Kind::Audio {
        return preset.audio.as_ref();
    }
    preset.video.as_ref().or(preset.audio.as_ref())
}
