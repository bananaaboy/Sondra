//! The rest of the website's Herunterladen: what happens once a file is here („In die Sitzung“, „Direkt in Google
//! Drive“, „Untertitel erstellen“, beside „Nach dem Laden abspielen“); „Zuletzt geladen“ (the last thirty, kept on
//! this device, to play, show or load again); a text file with links (.txt, .m3u, .csv) dropped or chosen; which
//! portals go („alle zeigen“); and the line that asks to load only what is allowed.

use std::path::{Path, PathBuf};

use gpui::{div, prelude::*, px, AnyElement, Context, PathPromptOptions};
use serde::{Deserialize, Serialize};
use sondra_merk::folder_memory::Store;
use sondra_ui::Ui;

use crate::shell::Shell;

const HISTORY_KEY: &str = "zuletzt";
const HISTORY_KEPT: usize = 30;

/// What the website names under the field, the first four in the sentence, the rest behind „alle zeigen“.
pub const SERVICES: [&str; 20] = [
    "YouTube",
    "Spotify",
    "Apple Podcasts",
    "Mediatheken (ARD, ZDF, Arte, SRF, ORF, 3sat)",
    "TikTok",
    "Instagram",
    "AniWorld / SerienStream",
    "Threads",
    "Twitch",
    "SoundCloud",
    "Bandcamp",
    "Vimeo",
    "Reddit",
    "Snapchat",
    "Patreon",
    "Rumble",
    "Kick",
    "Archive.org",
    "Podcast-RSS",
    "direkte Dateiadressen",
];

/// The endings of files whose lines are links.
pub fn is_link_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "txt" | "m3u" | "m3u8" | "csv" | "json"))
}

/// One file that was loaded, as „Zuletzt geladen“ keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Recent {
    pub title: String,
    pub path: PathBuf,
    /// Where it came from, to load it again.
    #[serde(default)]
    pub address: Option<String>,
    /// Milliseconds since 1970.
    pub at: i64,
}

/// The list with `entry` first; the same file twice is once, thirty at most.
pub fn with_recent(list: &[Recent], entry: Recent) -> Vec<Recent> {
    let mut next = vec![entry.clone()];
    next.extend(list.iter().filter(|r| r.path != entry.path).cloned());
    next.truncate(HISTORY_KEPT);
    next
}

fn store() -> Option<crate::store::FileStore> {
    crate::store::FileStore::at_default("Herunterladen.json")
}

pub fn load_recent() -> Vec<Recent> {
    store().and_then(|s| s.get_item(HISTORY_KEY)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn keep_recent(list: &[Recent]) {
    if let Some(mut s) = store() {
        s.set_item(HISTORY_KEY, serde_json::to_string(list).unwrap_or_default());
    }
}

impl Shell {
    /// After a file is here: noted in „Zuletzt geladen“, and what the person chose to happen with it.
    pub(crate) fn download_after(&mut self, title: &str, path: &Path, address: Option<String>, cx: &mut Context<Self>) {
        let entry = Recent { title: title.to_owned(), path: path.to_path_buf(), address, at: chrono::Utc::now().timestamp_millis() };
        self.download.recent = with_recent(&self.download.recent, entry);
        if self.download.options_kept {
            keep_recent(&self.download.recent);
        }
        let o = self.download.options.clone();
        if o.after_session {
            self.session_add(vec![path.to_path_buf()], cx);
        }
        if o.after_drive && self.drive.as_ref().is_some_and(|d| d.configured) {
            self.save_to_drive(path.to_path_buf(), cx);
        }
        if o.after_subtitles && matches!(crate::session::kind_of(path), sondra_merk::folder::AssetKind::Video | sondra_merk::folder::AssetKind::Audio) {
            self.subtitles_take(path.to_path_buf(), cx);
            self.subtitles_start(cx);
        }
    }

    pub fn download_recent(&self) -> &[Recent] {
        &self.download.recent
    }

    /// The addresses in a text file with links go into the field, each once.
    pub fn download_take_link_file(&mut self, path: &Path, cx: &mut Context<Self>) {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let found = sondra_download::addresses::extract_addresses(&text);
        if found.is_empty() {
            self.download.error = Some(format!("In „{}“ steht keine Adresse.", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
            cx.notify();
            return;
        }
        let typed = self.download.input.read(cx).text().to_string();
        let mut all = sondra_download::addresses::extract_addresses(&typed);
        for a in found {
            if !all.contains(&a) {
                all.push(a);
            }
        }
        crate::protocol::note("herunterladen", format!("{} Adressen aus {}", all.len(), path.display()));
        self.download_set_input(&all.join(", "), cx);
        self.download.error = None;
        cx.notify();
    }

    pub(crate) fn download_choose_link_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| {
                    for path in paths {
                        shell.download_take_link_file(&path, cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    /// Under the field: what it takes, how to give it more, the portals, and what is allowed.
    pub(crate) fn download_field_hint(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let open = self.download.services_open;
        let (toggle, choose) = (me.clone(), me.clone());
        let mut hint = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.))
                    .child(ui.hint(format!("YouTube, Spotify, Apple Podcasts, Mediatheken und {} weitere", SERVICES.len() - 4)))
                    .child(ui.button("portale-zeigen", if open { "weniger" } else { "alle zeigen" }).small().ghost().accessible_name(if open { "Weniger Portale zeigen" } else { "Alle Portale zeigen" }).on_click(move |_, app| toggle.update(app, |shell, cx| {
                        shell.download.services_open = !open;
                        cx.notify();
                    })))
                    .child(ui.hint("· Mehrere Adressen mit Komma trennen, oder eine Textdatei mit Links (.txt, .m3u) aufs Fenster ziehen bzw."))
                    .child(ui.button("linkdatei-waehlen", "auswählen").small().ghost().accessible_name("Textdatei mit Links auswählen").on_click(move |_, app| choose.update(app, |shell, cx| shell.download_choose_link_file(cx)))),
            );
        if open {
            hint = hint.child(div().w(px(640.)).child(ui.prose(SERVICES.join(" · "))));
        }
        hint.child(div().w(px(640.)).child(ui.hint("Bitte nur laden, was erlaubt ist: was Ihnen gehört, was frei ist oder wofür Sie die Erlaubnis haben. Die Regeln der Seite gelten auch hier.")))
            .into_any_element()
    }

    /// „Was danach geschieht“.
    pub(crate) fn download_after_setting(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let o = &self.download.options;
        let mut row = div().flex().flex_wrap().gap(px(6.));
        let chip = |id: &'static str, label: &'static str, on: bool, change: fn(&mut crate::download_options::DownloadOptions)| {
            let me = cx.entity();
            ui.chip(id, label, on).on_click(move |_, app| me.update(app, |shell, cx| shell.set_download_options(change, cx)))
        };
        row = row
            .child(chip("danach-sitzung", "In die Sitzung legen", o.after_session, |o| o.after_session = !o.after_session))
            .child(chip("danach-abspielen", "Sofort abspielen", o.play_after, |o| o.play_after = !o.play_after))
            .child(chip("danach-untertitel", "Untertitel erstellen", o.after_subtitles, |o| o.after_subtitles = !o.after_subtitles));
        if self.drive.as_ref().is_some_and(|d| d.configured) {
            row = row.child(chip("danach-drive", "Direkt in Google Drive", o.after_drive, |o| o.after_drive = !o.after_drive));
        }
        ui.setting("Was danach geschieht", row, Some("Die Datei liegt immer im Download-Ordner. „Untertitel erstellen“ öffnet sie im Werkzeug „Untertitel“ und hört sie dort ab (mit dem Sprachmodell, das dort geladen ist)."))
    }

    /// „Zuletzt geladen“: the last files, each to play, to show in its folder, or to load again.
    pub(crate) fn download_recent_section(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.download.recent.is_empty() {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut list = div().flex().flex_col();
        for (n, r) in self.download.recent.iter().enumerate().take(10) {
            let there = r.path.exists();
            let when = chrono::DateTime::from_timestamp_millis(r.at).map(|t| t.with_timezone(&chrono::Local).format("%d.%m.%Y %H:%M").to_string()).unwrap_or_default();
            let mut row = div().flex().flex_wrap().items_center().gap(px(10.)).py(px(6.)).border_t_1().border_color(c.line).child(div().flex_1().min_w(px(200.)).child(ui.value(r.title.clone()))).child(ui.hint(if there { when } else { format!("{when} · nicht mehr da") }));
            if there {
                let (play, show, path) = (me.clone(), me.clone(), r.path.clone());
                let p2 = path.clone();
                row = row
                    .child(ui.button(format!("zuletzt-abspielen-{n}"), "Abspielen").small().ghost().accessible_name(format!("{} abspielen", r.title)).on_click(move |_, app| {
                        let p = path.clone();
                        play.update(app, |shell, cx| {
                            shell.go(crate::nav::Panel::Player, cx);
                            shell.play_files(vec![p], cx);
                        })
                    }))
                    .child(ui.button(format!("zuletzt-zeigen-{n}"), "Im Ordner zeigen").small().ghost().accessible_name(format!("{} im Ordner zeigen", r.title)).on_click(move |_, app| {
                        let dir = p2.parent().map(PathBuf::from);
                        show.update(app, |shell, cx| {
                            if let Some(dir) = dir {
                                shell.go(crate::nav::Panel::Folder, cx);
                                shell.open_folder(dir, cx);
                            }
                        })
                    }));
            }
            if let Some(address) = r.address.clone() {
                let again = me.clone();
                row = row.child(ui.button(format!("zuletzt-wieder-{n}"), "Wieder laden").small().ghost().accessible_name(format!("{} wieder laden", r.title)).on_click(move |_, app| {
                    let a = address.clone();
                    again.update(app, |shell, cx| {
                        shell.download_set_input(&a, cx);
                        shell.find_address(cx);
                    })
                }));
            }
            list = list.child(row);
        }
        let clear = me.clone();
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(div().flex().items_center().justify_between().child(ui.subheading("Zuletzt geladen")).child(ui.button("zuletzt-leeren", "Liste leeren").small().ghost().accessible_name("Zuletzt geladen leeren").on_click(move |_, app| clear.update(app, |shell, cx| {
                    shell.download.recent.clear();
                    if shell.download.options_kept {
                        keep_recent(&[]);
                    }
                    cx.notify();
                }))))
                .child(list)
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_comes_first_the_same_file_once_thirty_at_most() {
        let r = |n: i64| Recent { title: format!("T{n}"), path: PathBuf::from(format!("/d/{n}.mp4")), address: None, at: n };
        let mut list = Vec::new();
        for n in 0..35 {
            list = with_recent(&list, r(n));
        }
        assert_eq!(list.len(), 30);
        assert_eq!(list[0].title, "T34");
        list = with_recent(&list, r(20));
        assert_eq!(list[0].title, "T20");
        assert_eq!(list.iter().filter(|x| x.title == "T20").count(), 1);
        assert!(is_link_file(Path::new("links.M3U")) && !is_link_file(Path::new("film.mp4")));
    }
}
