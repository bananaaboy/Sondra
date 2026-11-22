//! „Herunterladen: Adresse und Einstellungen“ of a series (the website's block in the series' window): load it as
//! video with sound or only the sound, at which quality, in which language version, and whether subtitles are made
//! afterwards. The values are the website's (`mode`, `videoPref`, `audioPref`, `language`, `autoTranscribe`) and
//! travel with the list. „Folge n laden“ hands them to „Herunterladen“; „Merken“ there puts its own on the entry.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::Item;
use sondra_ui::Ui;

use crate::download_options::{DownloadOptions, What};
use crate::shell::Shell;

pub const MODES: [(&str, &str); 2] = [("video", "Video mit Ton"), ("audio", "Nur Ton")];
pub const VIDEO: [(&str, &str); 6] = [("untouched", "Wie die Quelle"), ("best", "Beste (bis 4K)"), ("1080p", "1080p"), ("720p", "720p"), ("480p", "480p"), ("360p", "360p")];
pub const AUDIO: [(&str, &str); 5] = [("untouched", "Wie die Quelle"), ("high", "Hoch (320 kbps)"), ("medium", "Mittel (192 kbps)"), ("low", "Klein (128 kbps)"), ("lossless", "Verlustfrei")];
pub const LANGUAGES: [(&str, &str); 4] = [("auto", "Automatisch"), ("ger_sub", "Deutsch untertitelt"), ("ger_dub", "Deutsch"), ("eng_sub", "Englisch untertitelt")];

/// The language as the page's own code (`parse_language`): Dub 1, English subtitles 2, OmU 3, automatic empty.
pub fn language_code(language: &str) -> String {
    match language {
        "ger_dub" => "1",
        "eng_sub" => "2",
        "ger_sub" => "3",
        _ => "",
    }
    .to_string()
}

/// The other way round, for „Merken“.
pub fn language_pref(code: &str) -> &'static str {
    match code {
        "1" => "ger_dub",
        "2" => "eng_sub",
        "3" => "ger_sub",
        _ => "auto",
    }
}

/// What „Herunterladen“ is to do for this series: its settings over those of the page.
pub fn options_for(item: &Item, base: &DownloadOptions) -> (DownloadOptions, String) {
    let mut o = base.clone();
    o.what = if item.mode == "audio" { What::Audio } else { What::Video };
    o.height = match item.video_pref.as_str() {
        "1080p" => Some(1080),
        "720p" => Some(720),
        "480p" => Some(480),
        "360p" => Some(360),
        "best" | "untouched" => None,
        _ => base.height,
    };
    o.audio_kbps = match item.audio_pref.as_str() {
        "high" => Some(320),
        "medium" => Some(192),
        "low" => Some(128),
        "lossless" => None,
        _ => base.audio_kbps,
    };
    o.after_subtitles = item.auto_transcribe;
    (o, language_code(&item.language))
}

/// The page's settings as a series keeps them (for „Merken“).
pub fn prefs_of(o: &DownloadOptions, language: &str) -> serde_json::Value {
    let video = match o.height {
        Some(1080) => "1080p",
        Some(720) => "720p",
        Some(480) => "480p",
        Some(360) => "360p",
        _ => "best",
    };
    let audio = match o.audio_kbps {
        Some(320) => "high",
        Some(192) => "medium",
        Some(128) => "low",
        None => "lossless",
        _ => "untouched",
    };
    serde_json::json!({
        "mode": if o.what == What::Audio { "audio" } else { "video" },
        "videoPref": video,
        "audioPref": audio,
        "language": language_pref(language),
        "autoTranscribe": o.after_subtitles,
    })
}

impl Shell {
    /// For tests: what „Herunterladen“ is set to: what to load, the height, kbit/s, subtitles after, the language.
    pub fn download_settings_now(&self) -> (bool, Option<u32>, Option<u32>, bool, String) {
        let o = &self.download.options;
        (o.what == What::Audio, o.height, o.audio_kbps, o.after_subtitles, self.download.language.clone())
    }

    /// The block in the form „Bearbeiten“: each choice counts at once, as on the website.
    pub(crate) fn load_prefs_section(&self, ui: &Ui, id: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let item = self.merk.items.iter().find(|i| i.id == id)?;
        let me = cx.entity();
        let pills = |prefix: &str, list: &[(&'static str, &'static str)], now: &str, name: &str, set: fn(&mut Item, &str)| {
            let mut row = div().flex().flex_wrap().gap(px(6.));
            for (value, label) in list.iter().copied() {
                let (me, id) = (me.clone(), id.to_string());
                row = row.child(ui.chip(format!("{prefix}-{value}"), label, now == value).accessible_name(format!("{name}: {label}")).on_click(move |_, app| {
                    let id = id.clone();
                    Shell::merk_do(&me, app, move |m| m.change(&id, |item| set(item, value)))
                }));
            }
            row
        };
        let audio = item.mode == "audio";
        let quality = if audio { pills("serie-ton", &AUDIO, &item.audio_pref, "Qualität", |i, v| i.audio_pref = v.into()) } else { pills("serie-bild", &VIDEO, &item.video_pref, "Qualität", |i, v| i.video_pref = v.into()) };
        let subtitles = {
            let (me, id, on) = (me.clone(), id.to_string(), item.auto_transcribe);
            ui.chip("serie-untertitel", "Untertitel dazu erstellen", on).on_click(move |_, app| {
                let id = id.clone();
                Shell::merk_do(&me, app, move |m| m.change(&id, |item| item.auto_transcribe = !on))
            })
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Laden als")).child(pills("serie-laden", &MODES, &item.mode, "Laden als", |i, v| i.mode = v.into())))
                .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Qualität")).child(quality))
                .child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Sprachfassung")).child(pills("serie-sprache", &LANGUAGES, &item.language, "Sprachfassung", |i, v| i.language = v.into())))
                .child(div().flex().flex_col().gap(px(6.)).child(subtitles).child(ui.hint("Whisper schreibt nach dem Laden auf diesem Gerät mit. „Folge n laden“ nimmt diese Einstellungen mit.")))
                .into_any_element(),
        )
    }

    /// „Folge n laden“: the series' settings go to „Herunterladen“ for this load (and stay there as its settings,
    /// visible, until changed).
    pub(crate) fn take_series_prefs(&mut self, id: &str) {
        let Some(item) = self.merk.items.iter().find(|i| i.id == id) else { return };
        let (options, language) = options_for(item, &self.download.options);
        self.download.options = options;
        self.download.language = language;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(extra: serde_json::Value) -> Item {
        let mut raw = serde_json::json!({ "id": "fr", "title": "Frieren" });
        for (k, v) in extra.as_object().unwrap() {
            raw[k] = v.clone();
        }
        sondra_merk::normalize::normalize(&raw, &mut sondra_merk::normalize::Context::system())
    }

    #[test]
    fn a_series_settings_become_the_page_settings_and_back() {
        let base = DownloadOptions::default();
        let (o, lang) = options_for(&item(serde_json::json!({ "mode": "audio", "audioPref": "medium", "language": "ger_sub", "autoTranscribe": true })), &base);
        assert_eq!((o.what, o.audio_kbps, o.after_subtitles, lang.as_str()), (What::Audio, Some(192), true, "3"));
        let (o, lang) = options_for(&item(serde_json::json!({ "mode": "video", "videoPref": "720p", "language": "ger_dub" })), &base);
        assert_eq!((o.what, o.height, lang.as_str()), (What::Video, Some(720), "1"));
        let back = prefs_of(&o, &lang);
        assert_eq!((back["mode"].as_str(), back["videoPref"].as_str(), back["language"].as_str()), (Some("video"), Some("720p"), Some("ger_dub")));
    }
}
