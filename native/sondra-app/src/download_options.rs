//! What „Herunterladen“ loads and what happens with it, as on the website (`DownloaderPanel.tsx`): video
//! with sound or only the sound, the quality, the language on AniWorld, how the file is named
//! (`stealthName` in `studio.ts`), and whether it plays at once. Kept in `Herunterladen.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sondra_download::ytdlp::Want;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum What {
    #[default]
    Video,
    Audio,
}

/// How a loaded file is named: its title, or one that does not say what it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Naming {
    #[default]
    Original,
    /// „media_1a2b3c4d.mp4“
    Neutral,
    /// Twelve characters, nothing else.
    Hash,
    /// „Teams_Meeting_Aufzeichnung_2026-11-22_1A2B.mp4“
    Office,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadOptions {
    pub what: What,
    /// The highest picture, `None` for the best there is.
    pub height: Option<u32>,
    /// kbit/s of MP3 for „Nur Ton“; `None` keeps the sound as it comes.
    pub audio_kbps: Option<u32>,
    pub naming: Naming,
    /// „Nach Download sofort im Player abspielen“.
    pub play_after: bool,
    /// „In die Sitzung legen“.
    pub after_session: bool,
    /// „Direkt in Google Drive speichern“.
    pub after_drive: bool,
    /// „Untertitel erstellen“ after the file is here.
    pub after_subtitles: bool,
    /// „Direkte Datei-Links“: `false` takes them 1:1 (the website's „untouched“), `true` applies the quality above.
    pub direct_adjust: bool,
    /// How many addresses of a list are looked up at once (1–5).
    pub at_once: u8,
    /// „Netzwerk“: the address of the adapter connections leave from; `None` is the system's choice.
    pub network: Option<String>,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        DownloadOptions { what: What::Video, height: None, audio_kbps: Some(320), naming: Naming::Original, play_after: false, after_session: false, after_drive: false, after_subtitles: false, direct_adjust: false, at_once: 3, network: None }
    }
}

pub const HEIGHTS: [(Option<u32>, &str); 6] = [(None, "Beste"), (Some(2160), "4K"), (Some(1080), "1080p"), (Some(720), "720p"), (Some(480), "480p"), (Some(360), "360p")];
pub const AUDIO: [(Option<u32>, &str); 4] = [(Some(320), "Hoch (320 kbps)"), (Some(192), "Mittel (192 kbps)"), (Some(128), "Klein (128 kbps)"), (None, "Verlustfrei")];
pub const NAMINGS: [(Naming, &str); 4] = [(Naming::Original, "Originaltitel"), (Naming::Neutral, "Neutral (media_…)"), (Naming::Hash, "Nur Zeichen"), (Naming::Office, "Wie eine Office-Datei")];
/// AniWorld's languages: the code `parse_language` understands, and the word.
pub const LANGUAGES: [(&str, &str); 4] = [("", "Sprache automatisch"), ("1", "Deutsch (Dub)"), ("3", "Deutsch untertitelt (OmU)"), ("2", "Englisch untertitelt")];

const KEY: &str = "optionen";

impl DownloadOptions {
    pub fn load() -> DownloadOptions {
        use sondra_merk::folder_memory::Store;
        crate::store::FileStore::at_default("Herunterladen.json").and_then(|s| s.get_item(KEY)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn keep(&self) {
        use sondra_merk::folder_memory::Store;
        if let Some(mut store) = crate::store::FileStore::at_default("Herunterladen.json") {
            store.set_item(KEY, serde_json::to_string(self).unwrap_or_default());
        }
    }

    /// Makes the chosen adapter the one connections leave from (an address no longer there counts as automatic).
    pub fn apply_network(&self) {
        let chosen = self.network.as_deref().and_then(|a| a.parse::<std::net::IpAddr>().ok());
        let there = chosen.filter(|ip| sondra_extract::net::adapters().iter().any(|a| a.address == *ip));
        sondra_extract::net::set_bind_address(there);
    }

    /// What yt-dlp is to fetch.
    pub fn want(&self) -> Want {
        match self.what {
            What::Video => Want::Video(self.height),
            What::Audio => Want::Audio(self.audio_kbps),
        }
    }
}

/// JavaScript's `hash = ((hash << 5) - hash + code) | 0` over the UTF-16 units, as `stealthName` does.
fn js_hash(text: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(i32::from(unit));
    }
    hash
}

/// The name a loaded file gets, as `stealthName` on the website; `None` keeps the name it has.
pub fn stealth_name(title: &str, id: &str, ext: &str, naming: Naming, today: &str) -> Option<String> {
    let ext = if ext.is_empty() { "mp4".to_string() } else { ext.to_lowercase() };
    let pos = js_hash(&format!("{title}:{id}")).unsigned_abs();
    let hex8 = format!("{pos:08x}");
    match naming {
        Naming::Original => None,
        Naming::Neutral => Some(format!("media_{hex8}.{ext}")),
        Naming::Hash => {
            let second = (pos as i64 * 1_664_525 + 1_013_904_223) as i32;
            let full = format!("{hex8}{:08x}", second.unsigned_abs());
            Some(format!("{}.{ext}", &full[..12]))
        }
        Naming::Office => {
            let code = hex8[..4].to_uppercase();
            let audio = matches!(ext.as_str(), "mp3" | "wav" | "m4a" | "flac" | "aac" | "ogg");
            let video = ["Teams_Meeting_Aufzeichnung", "Meeting_Recording", "Teams_Projektbesprechung", "Schulung_Aufzeichnung", "Teams_Review_Meeting", "Besprechung_Q4_Aufzeichnung"];
            let sound = ["Teams_Meeting_Audio", "Besprechungsnotiz_Audio", "Teams_Call_Aufzeichnung", "Diktat_Audioexport", "Teams_Voice_Recording"];
            let list: &[&str] = if audio { &sound } else { &video };
            Some(format!("{}_{today}_{code}.{ext}", list[pos as usize % list.len()]))
        }
    }
}

/// After loading: the sound alone when only the sound was wanted (for sources that are not yt-dlp's, which
/// does it itself), then the name. Returns where the file is now.
pub fn finish(path: &Path, title: &str, options: &DownloadOptions, ytdlp_did_audio: bool, direct: bool) -> Result<PathBuf, String> {
    let mut path = path.to_path_buf();
    // A direct file is taken 1:1 unless the quality above is to count for it too.
    if direct && options.direct_adjust && options.what == What::Video {
        if let Some(limit) = options.height {
            path = scaled_down(&path, limit)?;
        }
    }
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let is_audio = matches!(ext.as_str(), "mp3" | "m4a" | "opus" | "ogg" | "flac" | "wav" | "aac");
    if options.what == What::Audio && !is_audio && !ytdlp_did_audio {
        let ffmpeg = sondra_media::ffmpeg::Ffmpeg::locate().ok_or("FFmpeg ist nicht da; der Ton liess sich nicht herauslösen.")?;
        let (target_ext, codec): (&str, Vec<String>) = match options.audio_kbps {
            Some(k) => ("mp3", vec!["-c:a".into(), "libmp3lame".into(), "-b:a".into(), format!("{k}k")]),
            None => ("flac", vec!["-c:a".into(), "flac".into()]),
        };
        let target = sondra_media::run::unique_path(path.parent().unwrap_or(Path::new(".")), &path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Ton".into()), target_ext);
        let status = std::process::Command::new(ffmpeg.program())
            .args(["-v", "error", "-nostdin", "-y", "-i"])
            .arg(&path)
            .args(["-vn"])
            .args(&codec)
            .arg(&target)
            .stdin(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = std::fs::remove_file(&target);
            return Err("Der Ton liess sich nicht aus dem Video lösen.".into());
        }
        let _ = std::fs::remove_file(&path);
        path = target;
    }
    let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Some(name) = stealth_name(title, &path.to_string_lossy(), &ext, options.naming, &today) {
        let dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();
        let stem = name.rsplit_once('.').map_or(name.clone(), |(s, _)| s.to_string());
        let target = sondra_media::run::unique_path(&dir, &stem, &ext);
        std::fs::rename(&path, &target).map_err(|e| format!("Die Datei liess sich nicht umbenennen: {e}"))?;
        path = target;
    }
    Ok(path)
}

/// A video taller than `limit` made `limit` high (H.264, the sound copied); anything else stays as it is.
fn scaled_down(path: &Path, limit: u32) -> Result<PathBuf, String> {
    let Some(ffmpeg) = sondra_media::ffmpeg::Ffmpeg::locate() else { return Ok(path.to_path_buf()) };
    let Ok(probe) = ffmpeg.probe(path) else { return Ok(path.to_path_buf()) };
    let tall = probe.streams.iter().filter(|s| s.kind == "video").filter_map(|s| s.height).max().unwrap_or(0);
    if tall <= limit {
        return Ok(path.to_path_buf());
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Video".into());
    let target = sondra_media::run::unique_path(path.parent().unwrap_or(Path::new(".")), &format!("{stem} {limit}p"), "mp4");
    let status = std::process::Command::new(ffmpeg.program())
        .args(["-v", "error", "-nostdin", "-y", "-i"])
        .arg(path)
        .args(["-vf", &format!("scale=-2:{limit}"), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k"])
        .arg(&target)
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_file(&target);
        return Err(format!("Das Video liess sich nicht auf {limit}p verkleinern."));
    }
    let _ = std::fs::remove_file(path);
    Ok(target)
}

impl crate::shell::Shell {
    /// „Direkte Datei-Links“ and „gleichzeitig“: how direct files are taken and how many addresses are looked up at once.
    pub(crate) fn download_direct_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let o = &self.download.options;
        let mut ways = div().flex().flex_wrap().gap(px(6.));
        for (adjust, label) in [(false, "1:1 übernehmen"), (true, "Anpassen")] {
            let me = cx.entity();
            ways = ways.child(ui.chip(format!("direkt-{adjust}"), label, o.direct_adjust == adjust).accessible_name(format!("Direkte Datei-Links: {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.direct_adjust = adjust, cx))));
        }
        let mut many = div().flex().flex_wrap().gap(px(6.));
        for n in 1..=5u8 {
            let me = cx.entity();
            many = many.child(ui.chip(format!("gleichzeitig-{n}"), format!("{n} gleichzeitig"), o.at_once.clamp(1, 5) == n).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.at_once = n, cx))));
        }
        let said = if o.direct_adjust { "Auch direkte Datei-Links bekommen die Qualität von oben (ein höheres Video wird verkleinert)." } else { "Direkte Links auf .mp4, .mp3 und andere Dateien kommen ohne jede Anpassung." };
        ui.setting(
            "Direkte Datei-Links",
            div().flex().flex_col().gap(px(8.)).child(ways).child(ui.hint(said)).child(ui.hint("Eine Liste von Adressen wird so viele auf einmal nachgeschlagen:")).child(many),
            None,
        )
    }

    /// „Netzwerk“: automatic, or one of the adapters of this computer.
    pub(crate) fn download_network_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let now = self.download.options.network.clone();
        let mut row = div().flex().flex_wrap().gap(px(6.));
        {
            let me = cx.entity();
            row = row.child(ui.chip("netz-auto", "Automatisch (System)", now.is_none()).accessible_name("Netzwerk: Automatisch").on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.network = None, cx))));
        }
        for adapter in sondra_extract::net::adapters() {
            let me = cx.entity();
            let address = adapter.address.to_string();
            let on = now.as_deref() == Some(address.as_str());
            row = row.child(ui.chip(format!("netz-{address}"), format!("{} · {address}", adapter.name), on).accessible_name(format!("Netzwerk: {} ({address})", adapter.name)).on_click(move |_, app| {
                let address = address.clone();
                me.update(app, |shell, cx| shell.set_download_options(|o| o.network = Some(address), cx))
            }));
        }
        ui.setting("Netzwerk", div().flex().flex_col().gap(px(8.)).child(row).child(ui.hint("Lädt über den gewählten Adapter, etwa ein Kabel neben dem WLAN. Automatisch nimmt, was das System wählt.")), None)
    }

    pub(crate) fn set_download_options(&mut self, change: impl FnOnce(&mut DownloadOptions), cx: &mut gpui::Context<Self>) {
        change(&mut self.download.options);
        self.download.options.apply_network();
        if self.download.options_kept {
            self.download.options.keep();
        }
        cx.notify();
    }

    /// „Was laden“: video with sound, or only the sound.
    pub(crate) fn download_what_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let now = self.download.options.what;
        let mut row = div().flex().flex_wrap().gap(px(6.));
        for (what, id, label) in [(What::Video, "laden-video", "Video mit Ton"), (What::Audio, "laden-ton", "Nur Ton")] {
            let me = cx.entity();
            row = row.child(ui.chip(id, label, now == what).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.what = what, cx))));
        }
        ui.setting("Was laden", row, None)
    }

    /// „Qualität“: the highest picture, or for the sound the bitrate.
    pub(crate) fn download_quality_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let o = &self.download.options;
        let mut row = div().flex().flex_wrap().gap(px(6.));
        if o.what == What::Video {
            for (height, label) in HEIGHTS {
                let me = cx.entity();
                row = row.child(ui.chip(format!("hoehe-{label}"), label, o.height == height).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.height = height, cx))));
            }
            ui.setting("Qualität", row, Some("Gibt es das Video nur grösser, kommt das Nächstkleinere. Gilt für Seiten, die yt-dlp lädt; eine Folge kommt so, wie der Hoster sie anbietet."))
        } else {
            for (kbps, label) in AUDIO {
                let me = cx.entity();
                row = row.child(ui.chip(format!("ton-{label}"), label, o.audio_kbps == kbps).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.audio_kbps = kbps, cx))));
            }
            ui.setting("Qualität", row, Some("Die Tonspur wird herausgelöst und in der gewählten Qualität gespeichert; „Verlustfrei“ behält sie, wie sie kommt (sonst FLAC)."))
        }
    }

    /// The language AniWorld is asked for first.
    pub(crate) fn download_language_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let now = self.download.language.clone();
        let mut row = div().flex().flex_wrap().gap(px(6.));
        for (code, label) in LANGUAGES {
            let me = cx.entity();
            row = row.child(ui.chip(format!("aniworld-{label}"), label, now == code).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.download.language = code.to_string();
                cx.notify();
            })));
        }
        ui.setting("Sprache auf AniWorld", row, None)
    }

    /// How the file is named.
    pub(crate) fn download_naming_setting(&self, ui: &sondra_ui::Ui, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let now = self.download.options.naming;
        let mut row = div().flex().flex_wrap().gap(px(6.));
        for (naming, label) in NAMINGS {
            let me = cx.entity();
            row = row.child(ui.chip(format!("name-{label}"), label, now == naming).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(|o| o.naming = naming, cx))));
        }
        ui.setting("Dateiname", row, None)
    }

    /// „Merken“: the address goes onto the Merkliste, with the title the page gave.
    pub(crate) fn remember_address(&mut self, address: &str, title: &str, season: i64, episode: Option<i64>, cx: &mut gpui::Context<Self>) {
        let title = if title.trim().is_empty() { sondra_merk::urlinfo::derive_link_title(address) } else { title.trim().to_string() };
        let known = self.merk.items.iter().any(|i| i.url == address || i.title.eq_ignore_ascii_case(&title));
        if known {
            self.download.error = Some(format!("„{title}“ steht schon auf der Merkliste."));
        } else {
            let mut ids = sondra_merk::normalize::Context::system();
            let mut raw = serde_json::json!({ "title": title, "url": address, "status": "watching", "season": season.max(0), "episode": episode.unwrap_or(1), "updatedAt": ids.now });
            // The settings it is loaded with now go with it, for „Folge n laden“ later.
            if let (Some(raw), serde_json::Value::Object(prefs)) = (raw.as_object_mut(), crate::merk_load_prefs::prefs_of(&self.download.options, &self.download.language)) {
                raw.extend(prefs);
            }
            let item = sondra_merk::normalize::normalize(&raw, &mut ids);
            self.merk.items.insert(0, item);
            self.merk.save();
            self.note("Gemerkt", format!("„{title}“ steht jetzt auf der Merkliste."), Some(crate::nav::Panel::Merkliste));
        }
        cx.notify();
    }
}

impl crate::shell::Shell {
    /// When „Herunterladen“ opens with an empty field and an address in the clipboard, it is offered — never
    /// typed in by itself, and not again once turned down.
    pub(crate) fn offer_clipboard(&mut self, cx: &mut gpui::Context<Self>) {
        if !self.download.input.read(cx).text().trim().is_empty() || self.download.job.is_some() {
            return;
        }
        let Some(text) = cx.read_from_clipboard().and_then(|c| c.text()) else { return };
        let Some(address) = sondra_download::addresses::extract_addresses(&text).into_iter().next() else { return };
        if self.download.clip_declined.as_deref() == Some(address.as_str()) {
            return;
        }
        self.download.clip_offer = Some(address);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_as_on_the_website() {
        // The same 32-bit hash as JavaScript's `| 0` arithmetic.
        assert_eq!(js_hash("a"), 97);
        assert_eq!(js_hash("ab"), 97 * 31 + 98);
        let n = stealth_name("Frieren", "x", "mp4", Naming::Neutral, "2026-11-22").unwrap();
        assert!(n.starts_with("media_") && n.ends_with(".mp4") && n.len() == "media_12345678.mp4".len());
        let h = stealth_name("Frieren", "x", "MP4", Naming::Hash, "2026-11-22").unwrap();
        assert_eq!(h.len(), "123456789abc.mp4".len());
        let o = stealth_name("Frieren", "x", "mp3", Naming::Office, "2026-11-22").unwrap();
        assert!(o.contains("_2026-11-22_") && o.ends_with(".mp3"));
        assert_eq!(stealth_name("Frieren", "x", "mp4", Naming::Original, "2026-11-22"), None);
    }

    #[test]
    fn the_options_say_what_yt_dlp_fetches() {
        let mut o = DownloadOptions::default();
        assert_eq!(o.want(), Want::Video(None));
        o.what = What::Audio;
        o.audio_kbps = Some(192);
        assert_eq!(o.want(), Want::Audio(Some(192)));
    }
}
