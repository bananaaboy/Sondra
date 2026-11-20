//! „AniList“ in the Merkliste (the dialog „AniList / MyAnimeList Synchronisation“ of the web app's Merkliste,
//! `src/lib/anilist.ts`): a token from the person's own AniList account, then
//!
//! * the progress is sent while watching — whenever an episode is marked seen, the series is told how far it is;
//! * the anime list of the account can be read in, merged into the Merkliste (and taken back).
//!
//! Nothing is asked of AniList unless the person connected it. The token rests like Drive's (encrypted where
//! Windows can), is never shown again and never part of a message.

use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_drive::keystore::{FileKeyStore, KeyStore};
use sondra_merk::folder_memory::Store;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::Item;
use sondra_ui::{FieldEvent, NoticeKind, TextField, Ui};

use crate::anilist::Entry;
use crate::merkliste::TrackerEntry;
use crate::shell::Shell;
use crate::store::FileStore;

pub struct AniState {
    pub open: bool,
    /// The progress is sent by itself while watching.
    pub enabled: bool,
    pub user: Option<String>,
    pub token: Entity<TextField>,
    pub busy: Option<&'static str>,
    pub said: Option<(NoticeKind, String)>,
    /// Why the last progress could not be sent, until one goes through.
    pub problem: Option<String>,
    sending: bool,
    keys: Option<Arc<FileKeyStore>>,
    memory: Option<FileStore>,
}

impl AniState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> AniState {
        let token = cx.new(|cx| TextField::new(cx, colors, "AniList-Token").placeholder("Personal Access Token einfügen …").max_chars(4000).secret());
        cx.subscribe(&token, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.anilist_connect(cx);
            }
        })
        .detach();
        let dir = crate::store::data_dir();
        let keys = dir.as_ref().map(|d| Arc::new(FileKeyStore::new(d.join("anilist-schluessel.bin"))));
        let memory = dir.map(|d| FileStore::open(d.join("AniList.json")));
        let connected = keys.as_ref().is_some_and(|k| k.load().is_some());
        let enabled = connected && memory.as_ref().and_then(|m| m.get_item("an")).as_deref() == Some("ja");
        let user = if connected { memory.as_ref().and_then(|m| m.get_item("nutzer")).filter(|u| !u.is_empty()) } else { None };
        AniState { open: false, enabled, user, token, busy: None, said: None, problem: None, sending: false, keys, memory }
    }

    pub fn connected(&self) -> bool {
        self.keys.as_ref().is_some_and(|k| k.load().is_some())
    }

    fn remember(&mut self, key: &str, value: String) {
        if let Some(memory) = self.memory.as_mut() {
            memory.set_item(key, value);
        }
    }
}

/// The Merkliste entries an AniList list becomes: the season is the one season AniList knows, everything up to
/// the progress is seen (`handleImportAniList`; AniList's „dropped“ is a pause here).
pub fn items_of(entries: &[Entry], ids: &mut Ids) -> Vec<Item> {
    entries
        .iter()
        .map(|e| {
            let total = e.total.unwrap_or_else(|| 12.max(e.progress));
            let watched: Vec<i64> = (1..=e.progress.min(total)).collect();
            let status = match e.status {
                "later" => "later",
                "paused" | "dropped" => "paused",
                "done" => "done",
                _ => "watching",
            };
            normalize(
                &serde_json::json!({
                    "title": e.title, "url": "", "season": 1, "episode": total.min((e.progress + 1).max(1)),
                    "seasons": [{ "number": 1, "episodes": e.total, "watched": watched }],
                    "status": status, "cover": e.cover_url, "tags": ["AniList"],
                }),
                ids,
            )
        })
        .collect()
}

impl Shell {
    /// While connected, the progress made is sent a moment after it was made.
    pub(crate) fn start_anilist_rounds(window: &mut gpui::Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(1250)).await;
            if this.update(cx, |shell, cx| shell.anilist_tick(cx)).is_err() {
                break;
            }
        })
        .detach();
    }

    fn anilist_tick(&mut self, cx: &mut Context<Self>) {
        if self.merk.tracker.is_empty() || self.anilist.sending {
            return;
        }
        let token = if self.anilist.enabled { self.anilist.keys.as_ref().and_then(|k| k.load()) } else { None };
        let Some(token) = token else {
            // Not asked for: the progress is not kept for later.
            self.merk.tracker.clear();
            return;
        };
        let batch: Vec<TrackerEntry> = std::mem::take(&mut self.merk.tracker);
        self.anilist.sending = true;
        Self::in_background(
            cx,
            move || batch.iter().filter_map(|t| crate::anilist::save_progress(&token, &t.title, t.season, t.watched, t.total, t.status).err()).last(),
            |shell, failed, cx| {
                shell.anilist.sending = false;
                shell.anilist.problem = failed;
                cx.notify();
            },
        );
    }

    pub fn anilist_open(&mut self, cx: &mut Context<Self>) {
        self.anilist.open = true;
        self.anilist.said = None;
        self.anilist.token.update(cx, |f, cx| f.set_text("", cx));
        cx.notify();
    }

    pub fn anilist_close(&mut self, cx: &mut Context<Self>) {
        self.anilist.open = false;
        self.anilist.token.update(cx, |f, cx| f.set_text("", cx));
        cx.notify();
    }

    /// Checks the token typed with AniList, and keeps it when it is a person's.
    pub fn anilist_connect(&mut self, cx: &mut Context<Self>) {
        let token = self.anilist.token.read(cx).text().trim().to_string();
        if token.is_empty() {
            self.anilist.said = Some((NoticeKind::Warning, "Fügen Sie zuerst ein Token ein: auf anilist.co unter Settings → Developer erstellen.".into()));
            cx.notify();
            return;
        }
        self.anilist.busy = Some("AniList prüft das Token …");
        self.anilist.said = None;
        let kept = token.clone();
        Self::in_background(cx, move || crate::anilist::verify(&token), move |shell, result, cx| {
            shell.anilist.busy = None;
            shell.anilist.said = Some(match result {
                Ok(Some((_, name))) => match shell.anilist.keys.as_ref().map(|k| k.save(&kept)) {
                    Some(Ok(())) => {
                        shell.anilist.user = Some(name.clone());
                        shell.anilist.enabled = true;
                        shell.anilist.remember("an", "ja".into());
                        shell.anilist.remember("nutzer", name.clone());
                        shell.anilist.token.update(cx, |f, cx| f.set_text("", cx));
                        (NoticeKind::Info, format!("Verbunden als „{name}“. Der Fortschritt wird beim Schauen automatisch gesendet."))
                    }
                    _ => (NoticeKind::Warning, "Das Token ließ sich auf diesem Rechner nicht ablegen; es wurde nicht gespeichert.".into()),
                },
                Ok(None) => (NoticeKind::Warning, "Ungültiges AniList-Token. Bitte ein gültiges Personal Access Token einfügen.".into()),
                Err(problem) => (NoticeKind::Warning, problem),
            });
            cx.notify();
        });
        cx.notify();
    }

    pub fn anilist_disconnect(&mut self, cx: &mut Context<Self>) {
        if let Some(keys) = &self.anilist.keys {
            keys.clear();
        }
        self.anilist.user = None;
        self.anilist.enabled = false;
        self.anilist.problem = None;
        self.anilist.remember("an", "nein".into());
        self.anilist.remember("nutzer", String::new());
        self.merk.tracker.clear();
        self.anilist.said = Some((NoticeKind::Info, "AniList-Verbindung getrennt.".into()));
        cx.notify();
    }

    pub fn anilist_set_enabled(&mut self, on: bool, cx: &mut Context<Self>) {
        self.anilist.enabled = on && self.anilist.connected();
        self.anilist.remember("an", if self.anilist.enabled { "ja" } else { "nein" }.into());
        cx.notify();
    }

    /// Reads the account's anime list in: merged into the Merkliste, and taken back with „Rückgängig“.
    pub fn anilist_import(&mut self, cx: &mut Context<Self>) {
        let Some(token) = self.anilist.keys.as_ref().and_then(|k| k.load()) else { return };
        self.anilist.busy = Some("Die Liste wird von AniList geholt …");
        self.anilist.said = None;
        Self::in_background(cx, move || crate::anilist::collection(&token), |shell, result, cx| {
            shell.anilist.busy = None;
            shell.anilist.said = Some(match result {
                Ok(entries) if entries.is_empty() => (NoticeKind::Info, "Keine Anime-Einträge auf diesem AniList-Konto gefunden.".into()),
                Ok(entries) => {
                    let items = items_of(&entries, &mut Ids::system());
                    let (added, updated) = shell.merk.bring_in(items);
                    shell.merk.note = Some(format!("Von AniList importiert: {added} neu · {updated} aktualisiert."));
                    (NoticeKind::Info, format!("{} Serien von AniList abgeglichen ({added} neu, {updated} aktualisiert). In der Merkliste lässt sich das zurücknehmen.", entries.len()))
                }
                Err(problem) => (NoticeKind::Warning, problem),
            });
            cx.notify();
        });
        cx.notify();
    }

    pub(crate) fn anilist_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let a = &self.anilist;
        if !a.open {
            return None;
        }
        let me = cx.entity();
        let busy = a.busy.is_some();
        let mut body = div().flex().flex_col().gap(px(14.));
        body = body.child(ui.prose("Ist AniList verbunden, sagt Sondra Ihrem Konto beim Abhaken einer Folge (auch wenn sie im Player zu Ende läuft), wie weit Sie sind. Ihre Anime-Liste von AniList lässt sich außerdem in die Merkliste einlesen. Gefragt wird AniList nur, wenn Sie es hier verbunden haben."));
        if a.keys.is_none() {
            body = body.child(ui.notice(NoticeKind::Warning, "Sondra hat auf diesem Rechner keinen Ordner für seine Daten gefunden; so lässt sich AniList nicht verbinden."));
        }
        if let Some(label) = a.busy {
            body = body.child(ui.hint(label));
        }
        if let Some((kind, said)) = &a.said {
            body = body.child(ui.notice(*kind, said.clone()));
        }
        if let Some(problem) = a.problem.as_ref().filter(|_| a.connected()) {
            body = body.child(ui.notice(NoticeKind::Warning, format!("Der letzte Fortschritt kam bei AniList nicht an: {problem}")));
        }
        let mut actions: Vec<AnyElement> = Vec::new();
        if let Some(user) = a.user.as_ref().filter(|_| a.connected()) {
            body = body.child(ui.subheading(format!("Verbunden als „{user}“")));
            let m = me.clone();
            body = body.child(
                ui.chip("anilist-automatisch", "Fortschritt beim Schauen automatisch senden", a.enabled)
                    .accessible_name("Fortschritt beim Schauen automatisch an AniList senden")
                    .on_click(move |_, app| m.update(app, |sh, cx| {
                        let on = !sh.anilist.enabled;
                        sh.anilist_set_enabled(on, cx)
                    })),
            );
            let (m, d) = (me.clone(), me.clone());
            actions.push(ui.button("anilist-importieren", "Anime-Liste von AniList einlesen").disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| sh.anilist_import(cx))).into_any_element());
            actions.push(ui.button("anilist-trennen", "Verbindung trennen").disabled(busy).on_click(move |_, app| d.update(app, |sh, cx| sh.anilist_disconnect(cx))).into_any_element());
        } else {
            let m = me.clone();
            body = body.child(ui.subheading("AniList-Token"))
                .child(div().child(a.token.clone()))
                .child(ui.hint("Ein Token erstellen Sie auf anilist.co unter Settings → Developer. Es bleibt auf diesem Rechner und liegt, wo Windows es kann, verschlüsselt."));
            actions.push(ui.button("anilist-verbinden", "Verbinden").primary().disabled(busy || a.keys.is_none()).on_click(move |_, app| m.update(app, |sh, cx| sh.anilist_connect(cx))).into_any_element());
        }
        let (close, away) = (me.clone(), me);
        let mut dialog = ui.dialog("anilist-fenster", "AniList").width(560.).child(body);
        for action in actions {
            dialog = dialog.action(action);
        }
        Some(
            dialog
                .action(ui.button("anilist-schliessen", "Schließen").on_click(move |_, app| close.update(app, |sh, cx| sh.anilist_close(cx))))
                .on_close(move |_, app| away.update(app, |sh, cx| sh.anilist_close(cx)))
                .into_any_element(),
        )
    }
}
