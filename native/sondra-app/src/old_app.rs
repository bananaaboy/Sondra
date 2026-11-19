//! „Daten der bisherigen App übernehmen“: the Windows app (Electron) left its Merkliste and settings in its
//! Chromium's localStorage (`sondra-electron` reads them). The start page says so, once, and the window shows what
//! would be taken before anything is:
//!
//! * the Merkliste is **merged** (the series changed last wins, nothing doubles) the way a file read in is, and can
//!   be taken back on the Merkliste page;
//! * the settings of the Ordner and Player pages and the person's own conversion templates only **add** what is not
//!   set here (`merge_value`): what a person did in this program is never undone by what the old one remembered;
//! * nothing in the old app's folder is ever changed.
//!
//! „Nicht fragen“ and a take-over both end the offer for good (`Einstellungen.json`, `uebernahme`).

use std::path::PathBuf;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_electron::{merge_value, Found, ORDNER_KEYS, PLAYER_KEYS};
use sondra_merk::folder_memory::Store;
use sondra_merk::merge::merge_merkliste;
use sondra_merk::normalize::Context as Ids;
use sondra_ui::{NoticeKind, Ui};

use crate::shell::Shell;
use crate::store::FileStore;

const SETTING: &str = "uebernahme";

#[derive(Default)]
pub struct OldApp {
    pub found: Option<Found>,
    pub open: bool,
    pub said: Option<String>,
    /// Folders to look in instead of the Windows app's own (tests).
    pub dirs: Option<Vec<PathBuf>>,
}

fn decided() -> bool {
    FileStore::at_default("Einstellungen.json").is_some_and(|s| s.get_item(SETTING).is_some())
}

fn decide(word: &str) {
    if let Some(mut store) = FileStore::at_default("Einstellungen.json") {
        store.set_item(SETTING, word.to_string());
    }
}

impl Shell {
    /// Looks, away from the window, for what the old app left; says so on the start page when there is something.
    pub fn look_for_old_app(&mut self, cx: &mut Context<Self>) {
        if decided() {
            return;
        }
        let dirs = self.old_app.dirs.clone().unwrap_or_else(sondra_electron::default_dirs);
        if dirs.is_empty() {
            return;
        }
        Self::in_background(
            cx,
            move || {
                let mut best: Option<Found> = None;
                for dir in dirs {
                    if let Ok(found) = sondra_electron::find(&dir) {
                        let weight = |f: &Found| f.merkliste.as_ref().map_or(0, Vec::len) + f.ordner.len() + f.player.len();
                        if !found.is_empty() && best.as_ref().is_none_or(|b| weight(&found) > weight(b)) {
                            best = Some(found);
                        }
                    }
                }
                best
            },
            |shell, found, cx| {
                shell.old_app.found = found;
                cx.notify();
            },
        );
    }

    /// For tests: where to look instead.
    pub fn old_app_dirs_for_test(&mut self, dirs: Vec<PathBuf>) {
        self.old_app.dirs = Some(dirs);
    }

    pub fn old_app_found(&self) -> Option<Found> {
        self.old_app.found.clone()
    }

    /// The line on the start page.
    pub(crate) fn old_app_offer(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.old_app.found.is_none() {
            // Taken over: said once, where the person is.
            let said = self.old_app.said.clone()?;
            let close = cx.entity();
            return Some(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .child(ui.prose(said))
                    .child(ui.button("alte-app-hinweis-schliessen", "Schliessen").small().on_click(move |_, app| close.update(app, |sh, cx| {
                        sh.old_app.said = None;
                        cx.notify();
                    })))
                    .into_any_element(),
            );
        }
        let (look, never) = (cx.entity(), cx.entity());
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(ui.prose("Die bisherige Sondra-App hat auf diesem Rechner Ihre Merkliste und Einstellungen hinterlassen."))
                .child(ui.button("alte-app-ansehen", "Ansehen und übernehmen").small().on_click(move |_, app| look.update(app, |sh, cx| {
                    sh.old_app.open = true;
                    sh.old_app.said = None;
                    cx.notify();
                })))
                .child(ui.button("alte-app-nicht-fragen", "Nicht fragen").small().on_click(move |_, app| never.update(app, |sh, cx| {
                    decide("nein");
                    sh.old_app.found = None;
                    sh.old_app.open = false;
                    cx.notify();
                })))
                .into_any_element(),
        )
    }

    /// What taking the Merkliste over would do to the list that is here: (new, updated, same).
    fn old_app_preview(&self) -> Option<(usize, usize, usize, usize)> {
        let bytes = self.old_app.found.as_ref()?.merkliste.as_ref()?;
        let incoming = sondra_merk::importer::read_merkliste_file(bytes, &mut Ids::system()).ok()?;
        let merged = merge_merkliste(&self.merk.items, &incoming);
        Some((incoming.len(), merged.added, merged.updated, merged.kept))
    }

    pub(crate) fn old_app_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.old_app.open {
            return None;
        }
        let found = self.old_app.found.as_ref()?;
        let me = cx.entity();
        let mut body = div().flex().flex_col().gap(px(12.));
        body = body.child(ui.prose("Das hat die bisherige App auf diesem Rechner gespeichert. Gezeigt wird, was übernommen würde — erst „Übernehmen“ ändert etwas."));
        let mut lines: Vec<String> = Vec::new();
        match self.old_app_preview() {
            Some((all, added, updated, kept)) => {
                let mut parts = vec![format!("{added} neu")];
                if updated > 0 {
                    parts.push(format!("{updated} aktualisiert"));
                }
                if kept > 0 {
                    parts.push(format!("{kept} hier neuer, so belassen"));
                }
                lines.push(format!("Merkliste: {all} {} ({})", if all == 1 { "Serie" } else { "Serien" }, parts.join(", ")));
            }
            None if found.merkliste.is_some() => lines.push("Merkliste: gefunden, aber nicht lesbar — sie bleibt, wo sie ist.".into()),
            None => {}
        }
        if !found.ordner.is_empty() {
            lines.push("Ordner: Ansichten, Sortierung und zuletzt geöffnete Ordner".into());
        }
        if !found.player.is_empty() {
            lines.push("Abspielen: Einstellungen, Stellen in Filmen und Lesezeichen".into());
        }
        if found.templates.is_some() {
            lines.push("Umwandeln: eigene Vorlagen".into());
        }
        for line in lines {
            body = body.child(ui.prose(line));
        }
        body = body.child(ui.hint("Die Merkliste wird zusammengeführt: je Serie gilt der zuletzt geänderte Stand, nichts wird doppelt. Einstellungen kommen nur dazu, wo hier noch nichts steht. Es lässt sich auf der Merkliste zurücknehmen; in der alten App wird nichts geändert."));
        if let Some(said) = &self.old_app.said {
            body = body.child(ui.notice(NoticeKind::Info, said.clone()));
        }
        let (take, never, close, away) = (me.clone(), me.clone(), me.clone(), me.clone());
        Some(
            ui.dialog("alte-app-fenster", "Daten der bisherigen App übernehmen")
                .width(600.)
                .child(body)
                .action(ui.button("alte-app-uebernehmen", "Übernehmen").primary().on_click(move |_, app| take.update(app, |sh, cx| sh.take_old_app(cx))))
                .action(ui.button("alte-app-fenster-nicht-fragen", "Nicht fragen").on_click(move |_, app| never.update(app, |sh, cx| {
                    decide("nein");
                    sh.old_app.found = None;
                    sh.old_app.open = false;
                    cx.notify();
                })))
                .action(ui.button("alte-app-schliessen", "Schliessen").on_click(move |_, app| close.update(app, |sh, cx| {
                    sh.old_app.open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |sh, cx| {
                    sh.old_app.open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    /// Takes over what the window showed.
    pub fn take_old_app(&mut self, cx: &mut Context<Self>) {
        let Some(found) = self.old_app.found.take() else { return };
        let mut done: Vec<&str> = Vec::new();
        if let Some(bytes) = &found.merkliste {
            // As a file read in: merged, noted on the page, and taken back from there.
            let staged = crate::store::data_dir().unwrap_or_else(std::env::temp_dir).join("Uebernahme.tmp");
            if std::fs::create_dir_all(staged.parent().unwrap_or(&staged)).is_ok() && std::fs::write(&staged, bytes).is_ok() {
                self.merk.import_file(&staged);
                let _ = std::fs::remove_file(&staged);
                done.push("Merkliste");
            }
        }
        let add = |file: &str, entries: Vec<(&str, &str)>| -> bool {
            let Some(mut store) = FileStore::at_default(file) else { return false };
            for (key, value) in entries {
                let merged = merge_value(store.get_item(key).as_deref(), value);
                store.set_item(key, merged);
            }
            true
        };
        if !found.ordner.is_empty() {
            let rows: Vec<(&str, &str)> = ORDNER_KEYS.iter().filter_map(|k| found.ordner.get(*k).map(|v| (*k, v.as_str()))).collect();
            if add("Ordner.json", rows) {
                if let Some(store) = FileStore::default_location() {
                    self.open_ordner_memory(store, cx);
                }
                done.push("Ordner");
            }
        }
        if !found.player.is_empty() {
            let rows: Vec<(&str, &str)> = PLAYER_KEYS.iter().filter_map(|k| found.player.get(*k).map(|v| (*k, v.as_str()))).collect();
            if add("Abspielen.json", rows) {
                if let Some(store) = FileStore::at_default("Abspielen.json") {
                    self.open_player_memory(store, cx);
                }
                done.push("Abspielen");
            }
        }
        if let Some(templates) = &found.templates {
            if add("Umwandeln.json", vec![("vorlagen", templates.as_str())]) {
                self.convert.reload_own();
                done.push("Umwandeln");
            }
        }
        decide("ja");
        self.old_app.open = false;
        self.old_app.said = Some(format!("Übernommen: {}.", done.join(", ")));
        // The sentence is read on the Merkliste, where the take-back is; the start page has no place for it.
        if done.contains(&"Merkliste") {
            self.go(crate::nav::Panel::Merkliste, cx);
        }
        cx.notify();
    }
}
