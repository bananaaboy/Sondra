//! „Anytype“ in the Merkliste (`AnytypeDialog` of the web app's Merkliste, `desktop/anytype.mjs`): the list as
//! one page in a space of the person's Anytype, kept in step from here. Only this computer's Anytype is
//! asked (127.0.0.1); the key it hands out rests like Drive's token.
//!
//! * connecting is Anytype's own four-digit code — nothing is typed but that;
//! * choosing the page: a found „Sondra …“ page, or a new one; a page that already holds a list asks once —
//!   „Aus Anytype laden“ (the default: it replaces this device's list, which can be taken back in) or „Beide
//!   Listen zusammenführen“;
//! * once connected a round runs a few seconds after each change, and every three minutes to receive what
//!   another computer wrote; a round never overlaps another, and a failed one is tried again a minute later;
//! * nothing is written over a page whose data block cannot be read.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_anytype::{load_from_anytype, sync_merkliste, Anytype, Kind, Note, Space, Status, PAGE_NAME};
use sondra_merk::merge::{merge_merkliste, merge_shared, revived, shared_key, Removed};
use sondra_merk::model::Item;
use sondra_ui::{FieldEvent, NoticeKind, TextField, Ui};

use crate::shell::Shell;

/// A quiet list is looked at this often; a change is sent once it has stood still for one tick.
const TICK: Duration = Duration::from_millis(1250);
/// Receiving what another computer wrote.
const EVERY: Duration = Duration::from_secs(3 * 60);
/// After a failed round.
const RETRY: Duration = Duration::from_secs(60);

pub struct AnytypeState {
    pub open: bool,
    pub link: Option<Arc<Anytype>>,
    pub status: Option<Status>,
    /// What is going on, in a sentence; buttons wait while it is set.
    pub busy: Option<&'static str>,
    pub said: Option<(NoticeKind, String)>,
    /// The code asked for; its four digits are typed into `code`.
    pub challenge: Option<String>,
    pub code: Entity<TextField>,
    pub name: Entity<TextField>,
    pub spaces: Option<Vec<Space>>,
    /// The space chosen and the pages found in it.
    pub notes: Option<(Space, Vec<Note>)>,
    /// A page with a list on it was picked: load it, or merge?
    pub picked: Option<Note>,
    /// The list this device had before „Aus Anytype laden“ replaced it.
    pub replaced: Option<(Vec<Item>, Removed)>,
    pub running: bool,
    /// What the page holds after the last round.
    pub synced: Option<serde_json::Value>,
    pub pending: Option<serde_json::Value>,
    pub last: Option<Instant>,
    pub last_at: Option<String>,
    pub retry_after: Option<Instant>,
}

impl AnytypeState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> AnytypeState {
        let code = cx.new(|cx| TextField::new(cx, colors, "Code aus Anytype").placeholder("4 Ziffern").max_chars(4));
        cx.subscribe(&code, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.anytype_pair(cx);
            }
        })
        .detach();
        let name = cx.new(|cx| TextField::new(cx, colors, "Name der neuen Seite").placeholder(PAGE_NAME).max_chars(120));
        cx.subscribe(&name, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.anytype_new_note(cx);
            }
        })
        .detach();
        let link = crate::store::data_dir().map(|dir| Arc::new(Anytype::in_dir(dir)));
        AnytypeState {
            open: false,
            link,
            status: None,
            busy: None,
            said: None,
            challenge: None,
            code,
            name,
            spaces: None,
            notes: None,
            picked: None,
            replaced: None,
            running: false,
            synced: None,
            pending: None,
            last: None,
            last_at: None,
            retry_after: None,
        }
    }
}

fn problem(error: &sondra_anytype::Error) -> (NoticeKind, String) {
    let mut text = error.kind.problem().to_string();
    if matches!(error.kind, Kind::Failed | Kind::Rejected | Kind::Forbidden | Kind::NotGranted) && !error.detail.is_empty() {
        text.push_str(&format!(" ({})", error.detail));
    }
    (if error.kind == Kind::Unreachable { NoticeKind::Info } else { NoticeKind::Warning }, text)
}

fn clock() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

impl Shell {
    /// Starts the rounds: while connected, a change goes to Anytype after a moment, and now and then the page is read.
    pub(crate) fn start_anytype_rounds(window: &mut gpui::Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(TICK).await;
            if this.update(cx, |shell, cx| shell.anytype_tick(cx)).is_err() {
                break;
            }
        })
        .detach();
    }

    fn anytype_tick(&mut self, cx: &mut Context<Self>) {
        let a = &self.anytype;
        let Some(link) = a.link.clone() else { return };
        if a.running || !link.connected() || a.busy.is_some() || a.picked.is_some() || link.settings().object_id.is_none() && a.notes.is_some() {
            return;
        }
        if a.retry_after.is_some_and(|t| Instant::now() < t) {
            return;
        }
        let key = shared_key(&self.merk.items, &self.merk.removed);
        let changed = self.anytype.synced.as_ref() != Some(&key);
        let due = self.anytype.last.is_none_or(|t| t.elapsed() >= EVERY);
        if changed {
            // Sent once the list has stood still for a tick.
            if self.anytype.pending.as_ref() == Some(&key) || self.anytype.last.is_none() {
                self.anytype_sync(cx);
            } else {
                self.anytype.pending = Some(key);
            }
        } else if due {
            self.anytype_sync(cx);
        }
    }

    /// The window opens and looks at Anytype.
    pub fn anytype_open(&mut self, cx: &mut Context<Self>) {
        let a = &mut self.anytype;
        a.open = true;
        a.said = None;
        a.challenge = None;
        a.picked = None;
        a.notes = None;
        a.spaces = None;
        self.anytype_refresh(cx);
        cx.notify();
    }

    pub fn anytype_close(&mut self, cx: &mut Context<Self>) {
        self.anytype.open = false;
        cx.notify();
    }

    fn anytype_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        self.anytype.busy = Some("Anytype wird gefragt …");
        Self::in_background(cx, move || link.status(), |shell, status, cx| {
            shell.anytype.busy = None;
            let paired = status.paired;
            let (space, note) = (status.space.is_some(), status.note.is_some());
            shell.anytype.status = Some(status);
            if paired && !space {
                shell.anytype_load_spaces(cx);
            } else if paired && space && !note {
                shell.anytype_load_notes(cx);
            }
            cx.notify();
        });
    }

    pub fn anytype_connect(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        self.anytype.busy = Some("Anytype wird um einen Code gebeten …");
        self.anytype.said = None;
        Self::in_background(cx, move || link.challenge(), |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(id) => shell.anytype.challenge = Some(id),
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    pub fn anytype_pair(&mut self, cx: &mut Context<Self>) {
        let (Some(link), Some(challenge)) = (self.anytype.link.clone(), self.anytype.challenge.clone()) else { return };
        let code = self.anytype.code.read(cx).text().trim().to_string();
        self.anytype.busy = Some("Der Code wird geprüft …");
        self.anytype.said = None;
        Self::in_background(cx, move || link.pair(&challenge, &code), |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(()) => {
                    shell.anytype.challenge = None;
                    shell.anytype.code.update(cx, |f, cx| f.set_text("", cx));
                    shell.anytype_refresh(cx);
                }
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    fn anytype_load_spaces(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        self.anytype.busy = Some("Die Spaces werden geholt …");
        Self::in_background(cx, move || link.spaces(), |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(spaces) => shell.anytype.spaces = Some(spaces),
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    pub fn anytype_choose_space(&mut self, space: Space, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        if let Err(error) = link.use_space(&space.id, &space.name, None, None) {
            self.anytype.said = Some(problem(&error));
            return;
        }
        self.anytype.spaces = None;
        self.anytype_refresh(cx);
    }

    fn anytype_load_notes(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        let space = link.settings();
        let space = Space { id: space.space_id.unwrap_or_default(), name: space.space_name.unwrap_or_default() };
        self.anytype.busy = Some("Die Seiten im Space werden gesucht …");
        let found = space.clone();
        Self::in_background(cx, move || link.list_notes(Some(&found.id)), move |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(notes) => shell.anytype.notes = Some((space, notes)),
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    /// A page found in the space: a list on it asks first; an empty one just gets this list.
    pub fn anytype_choose_note(&mut self, note: Note, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        let Some((space, _)) = self.anytype.notes.clone() else { return };
        if let Err(error) = link.use_space(&space.id, &space.name, Some(&note.id), Some(&note.name)) {
            self.anytype.said = Some(problem(&error));
            return;
        }
        self.anytype.synced = None;
        if note.item_count > 0 {
            self.anytype.picked = Some(note);
            cx.notify();
        } else {
            self.anytype.notes = None;
            self.anytype_refresh(cx);
            self.anytype_sync(cx);
        }
    }

    pub fn anytype_new_note(&mut self, cx: &mut Context<Self>) {
        let (Some(link), Some((space, _))) = (self.anytype.link.clone(), self.anytype.notes.clone()) else { return };
        let typed = self.anytype.name.read(cx).text().trim().to_string();
        let name = if typed.is_empty() { PAGE_NAME.to_string() } else { typed };
        self.anytype.busy = Some("Die Seite wird angelegt …");
        Self::in_background(cx, move || link.create_note(Some(&space.id), &name, &space.name, ""), |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(_) => {
                    shell.anytype.notes = None;
                    shell.anytype.synced = None;
                    shell.anytype_refresh(cx);
                    shell.anytype_sync(cx);
                }
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    /// „Aus Anytype laden“: the page's list becomes this device's; the replaced one can be taken back in.
    pub fn anytype_load(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        let (items, removed) = (self.merk.items.clone(), self.merk.removed.clone());
        self.anytype.busy = Some("Die Liste wird aus Anytype geladen …");
        self.anytype.picked = None;
        Self::in_background(cx, move || load_from_anytype(&link, &items, &removed), |shell, answer, cx| {
            shell.anytype.busy = None;
            match answer {
                Ok(loaded) if !loaded.empty => {
                    shell.anytype.replaced = Some((shell.merk.items.clone(), shell.merk.removed.clone()));
                    shell.merk.items = loaded.items.clone();
                    shell.merk.removed = loaded.removed.clone();
                    shell.merk.save();
                    shell.anytype.synced = Some(shared_key(&loaded.items, &loaded.removed));
                    shell.anytype.last = Some(Instant::now());
                    shell.anytype.last_at = Some(clock());
                    shell.anytype.notes = None;
                    shell.anytype.said = Some((NoticeKind::Info, format!("{} Serien aus Anytype geladen.", loaded.loaded)));
                    shell.anytype_refresh(cx);
                }
                Ok(_) => {
                    shell.anytype.notes = None;
                    shell.anytype_refresh(cx);
                    shell.anytype_sync(cx);
                }
                Err(error) => shell.anytype.said = Some(problem(&error)),
            }
            cx.notify();
        });
    }

    /// „Beide Listen zusammenführen“: the first round merges instead of replacing.
    pub fn anytype_merge_both(&mut self, cx: &mut Context<Self>) {
        self.anytype.picked = None;
        self.anytype.notes = None;
        self.anytype_refresh(cx);
        self.anytype_sync(cx);
    }

    /// What „Aus Anytype laden“ replaced, taken back in: nothing is lost by having loaded.
    pub fn anytype_take_back(&mut self, cx: &mut Context<Self>) {
        let Some((before, _)) = self.anytype.replaced.take() else { return };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let removed = self.merk.removed.clone();
        let revived: Vec<Item> = before.iter().map(|i| revived(i, &removed, now)).collect();
        let merged = merge_merkliste(&self.merk.items, &revived);
        let added = merged.added;
        self.merk.items = merged.items;
        self.merk.save();
        self.anytype.said = Some((NoticeKind::Info, format!("Ihre bisherige Liste ist dazugenommen ({added} neu).")));
        self.anytype_sync(cx);
        cx.notify();
    }

    /// One round with the page.
    pub fn anytype_sync(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        if self.anytype.running || !link.connected() {
            return;
        }
        self.anytype.running = true;
        let (items, removed) = (self.merk.items.clone(), self.merk.removed.clone());
        Self::in_background(cx, move || sync_merkliste(&link, &items, &removed), |shell, answer, cx| {
            shell.anytype.running = false;
            shell.anytype.last = Some(Instant::now());
            match answer {
                Ok(sync) => {
                    shell.anytype.retry_after = None;
                    // What changed here meanwhile is merged, not replaced.
                    let (merged, removed) = merge_shared(&shell.merk.items, &shell.merk.removed, &sync.items, &sync.removed);
                    let changed = shared_key(&merged, &removed) != shared_key(&shell.merk.items, &shell.merk.removed);
                    shell.merk.items = merged;
                    shell.merk.removed = removed;
                    if changed {
                        shell.merk.save();
                    }
                    shell.anytype.synced = Some(shared_key(&sync.items, &sync.removed));
                    shell.anytype.pending = None;
                    shell.anytype.last_at = Some(clock());
                    if shell.anytype.said.as_ref().is_some_and(|(k, _)| *k == NoticeKind::Warning) {
                        shell.anytype.said = None;
                    }
                }
                Err(error) => {
                    shell.anytype.retry_after = Some(Instant::now() + RETRY);
                    if error.kind == Kind::Unauthorized {
                        shell.anytype_refresh(cx);
                    }
                    shell.anytype.said = Some(problem(&error));
                }
            }
            cx.notify();
        });
        cx.notify();
    }

    /// „Seite wechseln“: the space stays, the page is chosen again.
    pub fn anytype_change_page(&mut self, cx: &mut Context<Self>) {
        let Some(link) = self.anytype.link.clone() else { return };
        let config = link.settings();
        if let Some(id) = config.space_id {
            let _ = link.use_space(&id, &config.space_name.unwrap_or_default(), None, None);
        }
        self.anytype.synced = None;
        self.anytype.notes = None;
        self.anytype_refresh(cx);
    }

    /// „Trennen“: the key is gone; Anytype's own page stays as it is.
    pub fn anytype_disconnect(&mut self, cx: &mut Context<Self>) {
        if let Some(link) = &self.anytype.link {
            link.forget();
        }
        let a = &mut self.anytype;
        a.synced = None;
        a.notes = None;
        a.spaces = None;
        a.picked = None;
        a.last = None;
        a.last_at = None;
        a.said = Some((NoticeKind::Info, "Getrennt. Die Seite in Anytype bleibt, wie sie ist.".into()));
        self.anytype_refresh(cx);
    }

    /// For tests: a link to a stand-in, and no waiting before a retry.
    pub fn anytype_for_test(&mut self, link: Anytype) {
        self.anytype.link = Some(Arc::new(link));
    }

    /// For tests: the four digits typed.
    pub fn anytype_code_for_test(&mut self, text: &str, cx: &mut Context<Self>) {
        self.anytype.code.update(cx, |f, cx| f.set_text(text.to_string(), cx));
    }

    /// For tests: whether a round is under way.
    pub fn anytype_running(&self) -> bool {
        self.anytype.running || self.anytype.busy.is_some()
    }

    pub(crate) fn anytype_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let a = &self.anytype;
        if !a.open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let busy = a.busy.is_some() || a.running;
        let mut body = div().flex().flex_col().gap(px(14.));
        body = body.child(ui.prose("Sondra hält Ihre Merkliste als eine Seite in einem Space Ihres Anytype: dort lesbar, und auf einem anderen Rechner nimmt Sondra sie von dort zurück. Gefragt wird nur das Anytype auf diesem Rechner — es muss offen sein."));
        if a.link.is_none() {
            body = body.child(ui.notice(NoticeKind::Warning, "Sondra hat auf diesem Rechner keinen Ordner für seine Daten gefunden; so lässt sich Anytype nicht verbinden."));
        }
        if let Some(label) = a.busy {
            body = body.child(ui.hint(label));
        }
        if let Some((kind, said)) = &a.said {
            body = body.child(ui.notice(*kind, said.clone()));
        }
        let status = a.status.as_ref();
        let paired = status.is_some_and(|s| s.paired);
        if let Some(status) = status {
            if !status.reachable {
                body = body.child(ui.notice(NoticeKind::Info, "Anytype antwortet auf diesem Rechner nicht. Öffnen Sie Anytype und fragen Sie dann noch einmal."));
            }
        }
        let mut actions: Vec<AnyElement> = Vec::new();
        if !paired {
            if a.challenge.is_none() {
                let m = me.clone();
                body = body.child(ui.hint("Anytype zeigt beim Verbinden einen vierstelligen Code. Sondra bekommt nur den Schlüssel, den Anytype daraufhin ausgibt — er bleibt auf diesem Rechner und liegt, wo Windows es kann, verschlüsselt."));
                actions.push(ui.button("anytype-verbinden", "Mit Anytype verbinden").primary().disabled(busy || a.link.is_none()).on_click(move |_, app| m.update(app, |sh, cx| sh.anytype_connect(cx))).into_any_element());
            } else {
                let m = me.clone();
                body = body.child(ui.subheading("Code aus Anytype"))
                    .child(ui.prose("Anytype zeigt jetzt vier Ziffern. Tippen Sie sie hier ein."))
                    .child(div().w(px(160.)).child(a.code.clone()));
                actions.push(ui.button("anytype-bestaetigen", "Bestätigen").primary().disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| sh.anytype_pair(cx))).into_any_element());
            }
            let m = me.clone();
            actions.push(ui.button("anytype-pruefen", "Noch einmal prüfen").disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| sh.anytype_refresh(cx))).into_any_element());
        } else if status.is_some_and(|s| s.space.is_none()) {
            body = body.child(ui.subheading("In welchem Space soll die Seite liegen?"));
            match &a.spaces {
                Some(spaces) if spaces.is_empty() => body = body.child(ui.hint("Anytype nennt keinen Space, den Sondra sehen darf. Verbinden Sie neu und geben Sie beim Bestätigen in Anytype einen frei.")),
                Some(spaces) => {
                    let mut row = div().flex().flex_wrap().gap(px(8.));
                    for (n, space) in spaces.iter().enumerate() {
                        let (m, space) = (me.clone(), space.clone());
                        row = row.child(ui.button(format!("anytype-space-{n}"), space.name.clone()).accessible_name(format!("Space {}", space.name)).disabled(busy).on_click(move |_, app| {
                            let space = space.clone();
                            m.update(app, |sh, cx| sh.anytype_choose_space(space, cx))
                        }));
                    }
                    body = body.child(row);
                }
                None => {}
            }
        } else if let Some(note) = &a.picked {
            body = body.child(ui.subheading(format!("Auf „{}“ steht schon eine Liste", note.name)))
                .child(ui.prose(format!("{} Serien. Sondra kann sie als Ihre Liste laden — Ihre bisherige bleibt zum Dazunehmen bereit — oder beide zusammenführen.", note.item_count)));
            let (load, both) = (me.clone(), me.clone());
            actions.push(ui.button("anytype-laden", "Aus Anytype laden").primary().disabled(busy).on_click(move |_, app| load.update(app, |sh, cx| sh.anytype_load(cx))).into_any_element());
            actions.push(ui.button("anytype-zusammenfuehren", "Beide Listen zusammenführen").disabled(busy).on_click(move |_, app| both.update(app, |sh, cx| sh.anytype_merge_both(cx))).into_any_element());
        } else if status.is_some_and(|s| s.note.is_none()) {
            body = body.child(ui.subheading("Welche Seite?"));
            if let Some((space, notes)) = &a.notes {
                body = body.child(ui.hint(format!("Im Space „{}“", space.name)));
                for (n, note) in notes.iter().enumerate() {
                    let (m, note) = (me.clone(), note.clone());
                    let label = format!("{} · {}", note.name, if note.item_count == 1 { "1 Serie".to_string() } else { format!("{} Serien", note.item_count) });
                    body = body.child(div().child(ui.button(format!("anytype-seite-{n}"), label.clone()).accessible_name(format!("Seite {label}")).disabled(busy).on_click(move |_, app| {
                        let note = note.clone();
                        m.update(app, |sh, cx| sh.anytype_choose_note(note, cx))
                    })));
                }
                let m = me.clone();
                body = body.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(10.))
                        .pt(px(6.))
                        .child(div().w(px(320.)).child(a.name.clone()))
                        .child(ui.button("anytype-neue-seite", "Neue Seite anlegen").disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| sh.anytype_new_note(cx)))),
                );
            }
            let m = me.clone();
            actions.push(ui.button("anytype-anderer-space", "Anderen Space wählen").disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| {
                if let Some(link) = &sh.anytype.link {
                    link.forget_space();
                }
                sh.anytype.notes = None;
                sh.anytype_refresh(cx);
            })).into_any_element());
        } else if let Some(status) = status {
            let space = status.space.as_ref().map(|s| s.name.clone()).unwrap_or_default();
            let note = status.note.as_ref().map(|n| n.name.clone()).unwrap_or_default();
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .pt(px(4.))
                    .border_t_1()
                    .border_color(c.line)
                    .child(ui.subheading("Verbunden"))
                    .child(ui.prose(format!("Space „{space}“ · Seite „{note}“")))
                    .child(ui.hint(match (&a.last_at, a.running) {
                        (_, true) => "Es wird gerade abgeglichen …".to_string(),
                        (Some(at), _) => format!("Zuletzt abgeglichen um {at}. Jede Änderung geht nach einem Moment dorthin, und alle drei Minuten wird gelesen, was ein anderer Rechner schrieb."),
                        (None, _) => "Noch nicht abgeglichen.".to_string(),
                    })),
            );
            let (now, page, off) = (me.clone(), me.clone(), me.clone());
            actions.push(ui.button("anytype-abgleichen", "Jetzt abgleichen").primary().disabled(busy).on_click(move |_, app| now.update(app, |sh, cx| sh.anytype_sync(cx))).into_any_element());
            actions.push(ui.button("anytype-seite-wechseln", "Seite wechseln").disabled(busy).on_click(move |_, app| page.update(app, |sh, cx| sh.anytype_change_page(cx))).into_any_element());
            actions.push(ui.button("anytype-trennen", "Trennen").disabled(busy).on_click(move |_, app| off.update(app, |sh, cx| sh.anytype_disconnect(cx))).into_any_element());
        }
        if a.replaced.is_some() {
            let m = me.clone();
            actions.push(ui.button("anytype-bisherige", "Bisherige Liste dazunehmen").disabled(busy).on_click(move |_, app| m.update(app, |sh, cx| sh.anytype_take_back(cx))).into_any_element());
        }
        let (close, away) = (me.clone(), me.clone());
        let mut dialog = ui.dialog("anytype-fenster", "Anytype").width(620.).child(body);
        for action in actions {
            dialog = dialog.action(action);
        }
        Some(
            dialog
                .action(ui.button("anytype-schliessen", "Schliessen").on_click(move |_, app| close.update(app, |sh, cx| sh.anytype_close(cx))))
                .on_close(move |_, app| away.update(app, |sh, cx| sh.anytype_close(cx)))
                .into_any_element(),
        )
    }
}
