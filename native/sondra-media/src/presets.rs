//! Templates for the converter: one click instead of five settings. A port of
//! `src/lib/convertPresets.ts` (the four that come with Sondra; own ones belong to the app's
//! settings, not to this crate).

use serde::{Deserialize, Serialize};

use crate::convert::{Frame, Kind, Pick, Settings};

/// The settings a template sets; trimming belongs to the file, not to it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Partial {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_bitrate_kbps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_variable_bitrate: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<Pick<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<Pick<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wav_bit_depth: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_crf: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_height: Option<Pick<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_frame: Option<Frame>,
    #[serde(skip_serializing_if = "Option::is_none")]
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


/* -------------------------------------------------------------------------- */
/* Own templates: the settings kept under a name                               */
/* -------------------------------------------------------------------------- */

/// A template of one's own: the settings under a name. The JSON is the one the website keeps in
/// `sondra:umwandeln:vorlagen`, so a list written by one can be read by the other.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Own {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<Partial>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<Partial>,
}

impl Own {
    /// What this template sets for this file — the rule of `preset_for`.
    pub fn partial_for(&self, source: Kind) -> Option<&Partial> {
        if source == Kind::Audio {
            return self.audio.as_ref();
        }
        self.video.as_ref().or(self.audio.as_ref())
    }
}

/// The own templates out of what was kept: an entry that is no template (no id, no name) is passed over, and a list
/// that is not a list is empty — a convenience never worth a failure.
pub fn parse_own(json: &str) -> Vec<Own> {
    let Ok(serde_json::Value::Array(entries)) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    entries.into_iter().filter_map(|entry| serde_json::from_value::<Own>(entry).ok()).filter(|o| !o.id.is_empty() && !o.label.is_empty()).collect()
}

/// The list as it is kept.
pub fn own_json(list: &[Own]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".into())
}

/// The settings that make up a template — everything but the trim.
pub fn template_of(settings: &Settings) -> Partial {
    Partial {
        format_id: Some(settings.format_id.clone()),
        audio_bitrate_kbps: Some(settings.audio_bitrate_kbps),
        audio_quality: Some(settings.audio_quality),
        use_variable_bitrate: Some(settings.use_variable_bitrate),
        sample_rate: Some(settings.sample_rate),
        channels: Some(settings.channels),
        wav_bit_depth: Some(settings.wav_bit_depth),
        video_crf: Some(settings.video_crf),
        video_preset: Some(settings.video_preset.clone()),
        video_height: Some(settings.video_height),
        video_frame: Some(settings.video_frame),
        frame_rate: Some(settings.frame_rate),
    }
}

/// The settings kept under a name (at most 40 letters); `None` when the name is empty. A sound format makes a template
/// for sound files, anything else one for films — as the website does.
pub fn new_own(label: &str, settings: &Settings, stamp: u64) -> Option<Own> {
    let label: String = label.trim().chars().take(40).collect();
    if label.is_empty() {
        return None;
    }
    let template = template_of(settings);
    let audio = crate::convert::find_format(&settings.format_id).is_some_and(|f| f.kind == Kind::Audio);
    Some(Own {
        id: format!("eigene-{}", base36(stamp)),
        label,
        hint: "Eigene Vorlage.".into(),
        video: (!audio).then(|| template.clone()),
        audio: audio.then_some(template),
    })
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

#[cfg(test)]
mod own_tests {
    use super::*;

    #[test]
    fn the_website_s_list_is_read_and_ours_reads_back() {
        // As `saveOwnPreset` of the website writes it.
        let web = r#"[{"id":"eigene-lq1x2","label":"Für Oma","hint":"Eigene Vorlage.","video":{"formatId":"mp4","videoFrame":"source","videoHeight":480,"videoCrf":30,"videoPreset":"medium","frameRate":24,"audioBitrateKbps":64,"channels":1,"sampleRate":"source"}},{"nonsense":true},{"id":"","label":"leer"}]"#;
        let list = parse_own(web);
        assert_eq!(list.len(), 1, "what is no template is passed over");
        assert_eq!(list[0].label, "Für Oma");
        let mut settings = Settings::default();
        list[0].partial_for(Kind::Video).unwrap().apply(&mut settings);
        assert_eq!((settings.format_id.as_str(), settings.video_crf), ("mp4", 30.0));
        assert_eq!(settings.video_height, crate::convert::Pick::Value(480));
        assert_eq!(settings.sample_rate, crate::convert::Pick::Source);
        assert_eq!(parse_own(&own_json(&list)), list);
        assert!(parse_own("kein json").is_empty() && parse_own("{}").is_empty());
    }

    #[test]
    fn a_name_keeps_the_settings_but_not_the_trim_and_a_sound_format_makes_a_sound_template() {
        let mut s = Settings { format_id: "mp3".into(), audio_bitrate_kbps: 96, trim_start_seconds: Some(5.0), ..Settings::default() };
        let own = new_own("  Hörbuch klein  ", &s, 123456).unwrap();
        assert_eq!((own.label.as_str(), own.hint.as_str()), ("Hörbuch klein", "Eigene Vorlage."));
        assert!(own.video.is_none() && own.audio.is_some());
        assert!(own.id.starts_with("eigene-") && own.id.len() > 7);
        let json = own_json(&[own.clone()]);
        assert!(!json.contains("trim"), "{json}");
        assert!(json.contains("\"audioBitrateKbps\":96"));
        s.format_id = "mp4".into();
        let film = new_own("Film", &s, 1).unwrap();
        assert!(film.video.is_some() && film.audio.is_none());
        assert!(new_own("   ", &s, 1).is_none(), "no name, no template");
        assert_eq!(new_own(&"x".repeat(60), &s, 1).unwrap().label.chars().count(), 40);
    }
}
