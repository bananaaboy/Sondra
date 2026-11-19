//! The Geräte page: the other devices of the Google account, files sent to them and taken from them, a line
//! of text or a link. What does the work is `sondra-devices` (the rounds through Drive, the data channel,
//! the transfer); this page asks it, shows what it says and never decides for the person: nothing is taken
//! without a yes, nothing opens by itself, a device is only connected on the person's own click.
//!
//! How the engine is made (the Drive sign-in, the key, the Google client) is handed in by the program as a
//! [`Setup`], so that a test can bring a stand-in for Drive and the page itself stays free of accounts.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_devices::engine::{now_ms, Engine, Note, State, Status, Transfer, FOLDER_FILES_MAX, TEXT_MAX};
use sondra_devices::files::{files_to_send, folder_sinks, folder_to_send};
use sondra_devices::registry::is_online;
use sondra_devices::short_id;
use sondra_ui::{radius, size, FieldEvent, NoticeKind, TextField, Ui};

use crate::nav::Panel;
use crate::shell::Shell;
use crate::store::FileStore;

/// What the program gives the page to work with.
#[derive(Clone)]
pub struct Setup {
    /// Whether a Google client is set up at all; without one, devices cannot find each other.
    pub configured: bool,
    pub signed_in: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Signs in to Google (opens the browser and waits for the answer).
    pub sign_in: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
    /// Makes the engine: this device's identity and its rounds.
    pub start: Arc<dyn Fn() -> Result<Engine, String> + Send + Sync>,
    /// Forgets this device's identity (the next connection makes a new one).
    pub forget: Arc<dyn Fn() + Send + Sync>,
}

pub struct DevicesState {
    pub setup: Option<Setup>,
    pub engine: Option<Engine>,
    /// Switched on by the person (kept, as the web app keeps `sondra:geraete:an`).
    pub enabled: bool,
    /// What is going on while the engine is made: signing in, connecting.
    pub working: Option<&'static str>,
    pub error: Option<String>,
    pub rename: Entity<TextField>,
    pub renaming: bool,
    pub text: Entity<TextField>,
    /// The device a text is being written to.
    pub text_to: Option<String>,
    pub text_sent: bool,
    /// Where what arrives is put.
    pub receive_dir: PathBuf,
    pub memory: Option<FileStore>,
    pub problem: Option<String>,
}

const KEY_ON: &str = "sondra:geraete:an";

impl DevicesState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> DevicesState {
        let rename = cx.new(|cx| TextField::new(cx, colors, "Name dieses Geräts").max_chars(40));
        cx.subscribe(&rename, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.devices_rename(cx);
            }
        })
        .detach();
        let text = cx.new(|cx| TextField::new(cx, colors, "Text oder Link").placeholder("https://… oder ein paar Zeilen").max_chars(TEXT_MAX));
        cx.subscribe(&text, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.devices_send_text(cx);
            }
        })
        .detach();
        DevicesState {
            setup: None,
            engine: None,
            enabled: false,
            working: None,
            error: None,
            rename,
            renaming: false,
            text,
            text_to: None,
            text_sent: false,
            receive_dir: crate::store::downloads_dir(),
            memory: None,
            problem: None,
        }
    }
}

fn seen_label(seen: f64, now: f64) -> String {
    if now - seen < sondra_devices::registry::ONLINE_WITHIN {
        return "offen".into();
    }
    let minutes = ((now - seen) / 60_000.0).round().max(1.0) as i64;
    if minutes < 60 {
        return format!("zuletzt vor {minutes} Min.");
    }
    let hours = (minutes as f64 / 60.0).round() as i64;
    if hours < 48 {
        return format!("zuletzt vor {hours} Std.");
    }
    format!("zuletzt vor {} Tagen", (hours as f64 / 24.0).round() as i64)
}

fn bytes(n: u64) -> String {
    sondra_merk::format::format_bytes(n as f64, 1)
}

fn files_phrase(files: &[sondra_devices::transfer::FileInfo]) -> String {
    match files {
        [one] => format!("„{}“", one.name),
        [first, rest @ ..] => format!("„{}“ und {} {}", first.name, rest.len(), if rest.len() == 1 { "weitere Datei" } else { "weitere Dateien" }),
        [] => "nichts".into(),
    }
}

/// What a transfer says about itself, in a sentence.
fn say(t: &Transfer) -> String {
    let peer = &t.peer_name;
    match (t.state, t.outgoing) {
        (State::Offering, _) => format!("Fragt bei „{peer}“ an: {}", files_phrase(&t.files)),
        (State::Asking, _) => format!("„{peer}“ möchte {} senden ({}).", files_phrase(&t.files), bytes(t.total)),
        (State::Connecting, _) => format!("Verbindet mit „{peer}“ …"),
        (State::Sending, _) => format!("Sendet {} an „{peer}“", files_phrase(&t.files)),
        (State::Receiving, _) => format!("Empfängt {} von „{peer}“", files_phrase(&t.files)),
        (State::Done, true) => format!("{} ist bei „{peer}“ angekommen.", files_phrase(&t.files)),
        (State::Done, false) => format!("{} von „{peer}“ ist da.", files_phrase(&t.files)),
        (State::Declined, true) => format!("„{peer}“ hat abgelehnt."),
        (State::Declined, false) => format!("Abgelehnt: {}", files_phrase(&t.files)),
        (State::Cancelled, _) => format!("Abgebrochen: {}", files_phrase(&t.files)),
        (State::Expired, _) => format!("Keine Antwort von „{peer}“ — das Angebot ist verfallen."),
        (State::Failed, _) => format!("Nicht geklappt: {}{}", files_phrase(&t.files), t.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default()),
    }
}

impl Shell {
    /// Gives the page what it needs, and goes on with the connection the person switched on before.
    pub fn open_devices(&mut self, setup: Setup, memory: FileStore, cx: &mut Context<Self>) {
        use sondra_merk::folder_memory::Store;
        let was_on = memory.get_item(KEY_ON).as_deref() == Some("1");
        self.devices.memory = Some(memory);
        self.devices.setup = Some(setup.clone());
        if was_on && setup.configured {
            self.devices.enabled = true;
            // Never a sign-in window at start: without a token the page says it waits for one.
            if (setup.signed_in)() {
                self.devices_start(false, cx);
            }
        }
        cx.notify();
    }

    fn devices_remember(&mut self, on: bool) {
        use sondra_merk::folder_memory::Store;
        if let Some(m) = &mut self.devices.memory {
            m.set_item(KEY_ON, if on { "1".into() } else { "0".into() });
        }
    }

    /// „Dieses Gerät verbinden“: the sign-in first if there is none, then the rounds.
    pub fn devices_connect(&mut self, cx: &mut Context<Self>) {
        if self.devices.setup.is_none() || self.devices.working.is_some() || self.devices.engine.is_some() {
            return;
        }
        self.devices.enabled = true;
        self.devices_remember(true);
        self.devices_start(true, cx);
    }

    fn devices_start(&mut self, sign_in: bool, cx: &mut Context<Self>) {
        let Some(setup) = self.devices.setup.clone() else { return };
        self.devices.error = None;
        self.devices.working = Some(if (setup.signed_in)() { "Verbindet …" } else { "Meldet an …" });
        Self::in_background(
            cx,
            move || -> Result<Engine, String> {
                if !(setup.signed_in)() {
                    if !sign_in {
                        return Err(String::new());
                    }
                    (setup.sign_in)()?;
                }
                (setup.start)()
            },
            |shell, answer, cx| {
                shell.devices.working = None;
                match answer {
                    Ok(engine) => shell.devices.engine = Some(engine),
                    Err(e) if e.is_empty() => {}
                    Err(e) => shell.devices.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// „Trennen“: the rounds stop; the identity stays.
    pub fn devices_disconnect(&mut self, cx: &mut Context<Self>) {
        self.devices.enabled = false;
        self.devices_remember(false);
        if let Some(engine) = self.devices.engine.take() {
            Self::in_background(cx, move || drop(engine), |_, _, _| {});
        }
        cx.notify();
    }

    /// „Dieses Gerät ganz vergessen“.
    pub fn devices_forget(&mut self, cx: &mut Context<Self>) {
        self.devices_disconnect(cx);
        if let Some(setup) = &self.devices.setup {
            (setup.forget)();
        }
    }

    pub fn devices_rename(&mut self, cx: &mut Context<Self>) {
        let wanted = self.devices.rename.read(cx).text().trim().to_owned();
        self.devices.renaming = false;
        if !wanted.is_empty() {
            if let Some(e) = &self.devices.engine {
                e.rename(&wanted);
            }
        }
        cx.notify();
    }

    fn devices_pick(&mut self, to: String, folder: bool, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: !folder, directories: folder, multiple: !folder, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.devices_send_paths(&to, paths, folder, cx)).ok();
            }
        })
        .detach();
    }

    /// Offers these files (or this folder, with everything in it) to a device.
    pub fn devices_send_paths(&mut self, to: &str, paths: Vec<PathBuf>, folder: bool, cx: &mut Context<Self>) {
        self.devices.problem = None;
        let Some(engine) = &self.devices.engine else { return };
        let files = if folder {
            paths.first().map(|p| folder_to_send(p, FOLDER_FILES_MAX)).unwrap_or_else(|| Ok(vec![]))
        } else {
            files_to_send(&paths)
        };
        match files {
            Ok(files) if !files.is_empty() => engine.send(to, files),
            Ok(_) => self.devices.problem = Some("Da waren keine Dateien.".into()),
            Err(e) => self.devices.problem = Some(format!("Das liess sich nicht lesen: {e}")),
        }
        cx.notify();
    }

    pub fn devices_send_text(&mut self, cx: &mut Context<Self>) {
        let (Some(to), Some(engine)) = (self.devices.text_to.clone(), &self.devices.engine) else { return };
        let text = self.devices.text.read(cx).text().to_owned();
        if text.trim().is_empty() {
            return;
        }
        engine.send_text(&to, &text);
        self.devices.text.update(cx, |t, cx| t.set_text("", cx));
        self.devices.text_sent = true;
        cx.notify();
    }

    pub fn devices_accept(&mut self, id: &str, cx: &mut Context<Self>) {
        if let Some(e) = &self.devices.engine {
            e.accept(id, folder_sinks(self.devices.receive_dir.clone()));
        }
        cx.notify();
    }

    /// Where what arrives is put (the person's choice later; the folder for Downloads until then).
    pub fn devices_set_receive_dir(&mut self, dir: PathBuf) {
        self.devices.receive_dir = dir;
    }

    /// For tests: what the engine says now.
    pub fn devices_snapshot(&self) -> Option<sondra_devices::engine::Snapshot> {
        self.devices.engine.as_ref().map(Engine::snapshot)
    }

    pub(crate) fn devices_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let d = &self.devices;
        let mut page = div().flex().flex_col().gap(px(24.)).max_w(px(760.)).child(ui.heading("Ihre Geräte"));
        page = page.child(ui.prose("Dateien von hier direkt auf Ihr Handy, Ihren Laptop oder einen anderen Rechner — und zurück. Gefunden werden die Geräte über Ihr Google-Konto; die Dateien gehen von Gerät zu Gerät, verschlüsselt und im selben WLAN, ohne das Netz zu verlassen."));
        let Some(setup) = d.setup.as_ref().filter(|s| s.configured) else {
            return page.child(ui.notice(NoticeKind::Info, "Hier nicht eingerichtet: Geräte finden sich über Google Drive, und in dieser Fassung ist Google Drive nicht eingerichtet.")).into_any_element();
        };
        if let Some(error) = &d.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let block = || div().flex().flex_col().gap(px(12.)).p(px(20.)).rounded(px(radius::CARD)).bg(c.panel_soft);

        let Some(engine) = &d.engine else {
            if let Some(what) = d.working {
                return page.child(ui.prose(what)).into_any_element();
            }
            if d.enabled {
                // Switched on before, but no sign-in is there.
                let signed = (setup.signed_in)();
                let button = {
                    let me = me.clone();
                    ui.button("bei-google-anmelden", "Bei Google anmelden").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.devices_start(true, cx)))
                };
                return page
                    .child(div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.hint(if signed { "Verbindet …" } else { "Wartet auf die Anmeldung bei Google Drive." })).child(if signed { div().into_any_element() } else { button.into_any_element() }))
                    .into_any_element();
            }
            let button = {
                let me = me.clone();
                let label = if (setup.signed_in)() { "Dieses Gerät verbinden" } else { "Mit Google anmelden und verbinden" };
                ui.button("geraet-verbinden", label).primary().on_click(move |_, app| me.update(app, |shell, cx| shell.devices_connect(cx)))
            };
            return page
                .child(
                    block()
                        .child(ui.title("Dieses Gerät verbinden"))
                        .child(ui.prose("In Ihrem Drive liegt dann je Gerät eine kleine Datei: Name, Art und wann es zuletzt offen war. Jede ist mit einem Schlüssel signiert, der dieses Gerät nie verlässt — kein anderes Gerät kann sie ändern oder sich als dieses ausgeben. Machen Sie dasselbe auf Ihren anderen Geräten, mit demselben Google-Konto."))
                        .child(div().flex().child(button)),
                )
                .into_any_element();
        };

        let snap = engine.snapshot();
        let now = now_ms();
        // Offered to this device: first of all, because someone waits for the answer.
        for t in snap.transfers.iter().filter(|t| t.state == State::Asking) {
            let (yes, no) = (me.clone(), me.clone());
            let (id_yes, id_no) = (t.id.clone(), t.id.clone());
            page = page.child(
                block()
                    .child(ui.title(say(t)))
                    .child(ui.hint(format!("Sie landen in {}.", d.receive_dir.display())))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(ui.button(format!("annehmen-{}", t.id), "Annehmen").primary().accessible_name(format!("{} annehmen", files_phrase(&t.files))).on_click(move |_, app| yes.update(app, |shell, cx| shell.devices_accept(&id_yes, cx))))
                            .child(ui.button(format!("ablehnen-{}", t.id), "Ablehnen").accessible_name(format!("{} ablehnen", files_phrase(&t.files))).on_click(move |_, app| {
                                let id = id_no.clone();
                                no.update(app, |shell, cx| {
                                    if let Some(e) = &shell.devices.engine {
                                        e.decline(&id);
                                    }
                                    cx.notify();
                                })
                            })),
                    ),
            );
        }
        for note in &snap.notes {
            page = page.child(note_card(ui, &me, note));
        }

        // This device.
        let mut mine = div().flex().flex_col().gap(px(12.)).child(ui.subheading("Dieses Gerät"));
        match &snap.status {
            Status::Joining => mine = mine.child(ui.hint("Verbindet …")),
            Status::Error(e) => {
                let me2 = me.clone();
                mine = mine.child(div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.hint(format!("! Drive antwortete nicht wie erwartet: {e}."))).child(ui.button("geraete-erneut", "Erneut").small().on_click(move |_, app| me2.update(app, |shell, cx| {
                    if let Some(e) = &shell.devices.engine {
                        e.refresh();
                    }
                    cx.notify();
                }))));
            }
            Status::Ready => {
                let kind = snap.me.as_ref().and_then(|m| m["platform"].as_str()).unwrap_or("").to_owned();
                let id = snap.me.as_ref().and_then(|m| m["id"].as_str()).unwrap_or("").to_owned();
                let mut row = div().flex().flex_wrap().items_center().gap(px(16.));
                if d.renaming {
                    let me2 = me.clone();
                    let me3 = me.clone();
                    row = row.child(div().w(px(280.)).child(d.rename.clone())).child(ui.button("name-speichern", "Speichern").small().on_click(move |_, app| me2.update(app, |shell, cx| shell.devices_rename(cx)))).child(ui.button("name-lassen", "Abbrechen").small().on_click(move |_, app| me3.update(app, |shell, cx| {
                        shell.devices.renaming = false;
                        cx.notify();
                    })));
                } else {
                    let (me2, me3) = (me.clone(), me.clone());
                    let name = snap.name.clone();
                    row = row
                        .child(div().flex().flex_col().gap(px(2.)).child(div().flex().items_baseline().gap(px(8.)).child(ui.title(snap.name.clone())).child(ui.value(short_id(&id).to_owned()))).child(ui.hint(format!("{kind} · dieses Gerät"))))
                        .child(ui.button("umbenennen", "Umbenennen").small().on_click(move |_, app| me2.update(app, |shell, cx| {
                            shell.devices.rename.update(cx, |t, cx| t.set_text(name.clone(), cx));
                            shell.devices.renaming = true;
                            cx.notify();
                        })))
                        .child(ui.button("trennen", "Trennen").small().on_click(move |_, app| me3.update(app, |shell, cx| shell.devices_disconnect(cx))));
                }
                mine = mine.child(row);
                if !snap.former.is_empty() {
                    mine = mine.child(former_hint(ui, &me, &snap.former, now));
                }
            }
        }
        page = page.child(mine);

        // The others.
        let mut others = div().flex().flex_col().gap(px(12.)).child(ui.subheading("Ihre anderen Geräte"));
        if snap.devices.is_empty() {
            others = others.child(ui.prose(if snap.status == Status::Ready {
                "Noch kein anderes. Öffnen Sie Sondra auf dem Handy oder einem anderen Rechner — Website oder App —, melden Sie sich mit demselben Google-Konto an und schalten Sie unter „Geräte“ dasselbe ein. Es erscheint dann hier."
            } else {
                "Sobald dieses Gerät verbunden ist, stehen die anderen hier."
            }));
        } else {
            let mut devices: Vec<_> = snap.devices.iter().collect();
            devices.sort_by_key(|d| !is_online(d, now));
            let mut list = div().flex().flex_col().gap(px(8.));
            for device in devices {
                list = list.child(other_device(ui, &me, d, device, now));
            }
            others = others.child(list);
        }
        page = page.child(others);
        if let Some(problem) = &d.problem {
            page = page.child(ui.notice(NoticeKind::Warning, problem.clone()));
        }

        // Transfers.
        let shown: Vec<&Transfer> = snap.transfers.iter().filter(|t| t.state != State::Asking && !t.dismissed).collect();
        if !shown.is_empty() {
            let mut rows = div().flex().flex_col();
            for t in shown {
                rows = rows.child(transfer_row(ui, &me, t, &d.receive_dir));
            }
            page = page.child(div().flex().flex_col().gap(px(12.)).child(ui.subheading("Übertragungen")).child(rows));
        }

        page = page.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(ui.subheading("So geht es"))
                .child(ui.prose("Das andere Gerät fragt, bevor es etwas annimmt. Hier landen angenommene Dateien im Ordner unten; Ordner behalten ihre Unterordner. Sind die Geräte nicht im selben Netz, findet sich kein direkter Weg."))
                .child(div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.hint("Ordner:")).child(ui.value(d.receive_dir.display().to_string()))),
        );
        let forget = {
            let me = me.clone();
            ui.button("geraet-vergessen", "Dieses Gerät ganz vergessen").small().on_click(move |_, app| me.update(app, |shell, cx| shell.devices_forget(cx)))
        };
        page.child(div().flex().child(forget)).into_any_element()
    }
}

fn note_card(ui: Ui, me: &Entity<Shell>, note: &Note) -> AnyElement {
    let c = ui.c;
    let id = note.id.clone();
    let me = me.clone();
    let mut card = div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(16.))
        .rounded(px(radius::CARD))
        .bg(c.panel_soft)
        .child(ui.title(format!("Text von „{}“", note.peer_name)))
        .child(ui.value(note.text.clone()));
    let mut buttons = div().flex().flex_wrap().gap(px(8.));
    if let Some(link) = note.link.clone() {
        buttons = buttons.child(ui.button(format!("link-{}", note.id), "Link öffnen").small().on_click(move |_, app| app.open_url(&link)));
    }
    let text = note.text.clone();
    buttons = buttons.child(ui.button(format!("kopieren-{}", note.id), "Kopieren").small().on_click(move |_, app| app.write_to_clipboard(gpui::ClipboardItem::new_string(text.clone()))));
    buttons = buttons.child(ui.button(format!("schliessen-{}", note.id), "Schliessen").small().on_click(move |_, app| {
        let id = id.clone();
        me.update(app, |shell, cx| {
            if let Some(e) = &shell.devices.engine {
                e.dismiss_note(&id);
            }
            cx.notify();
        })
    }));
    card = card.child(buttons);
    card.into_any_element()
}

fn former_hint(ui: Ui, me: &Entity<Shell>, former: &[serde_json::Value], now: f64) -> AnyElement {
    let c = ui.c;
    let mut block = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.prose("Neu installiert oder Daten gelöscht? Dann war dieses Gerät vielleicht schon verbunden — es kann seinen alten Eintrag übernehmen."));
    for device in former {
        let id = device["id"].as_str().unwrap_or_default().to_owned();
        let name = device["name"].as_str().unwrap_or_default().to_owned();
        let me = me.clone();
        let id2 = id.clone();
        block = block.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(ui.prose(format!("{name} · {} · {}", device["platform"].as_str().unwrap_or_default(), seen_label(device["seen"].as_f64().unwrap_or(0.0), now))))
                .child(ui.button(format!("war-dieses-{id}"), "Das war dieses Gerät").small().accessible_name(format!("„{name}“ war dieses Gerät")).on_click(move |_, app| {
                    let id = id2.clone();
                    me.update(app, |shell, cx| {
                        if let Some(e) = &shell.devices.engine {
                            e.adopt_former(&id);
                        }
                        cx.notify();
                    })
                })),
        );
    }
    let me = me.clone();
    block = block.child(div().flex().child(ui.button("anderes-geraet", if former.len() == 1 { "Nein, das ist ein anderes Gerät" } else { "Nein, das sind andere Geräte" }).small().on_click(move |_, app| {
        me.update(app, |shell, cx| {
            if let Some(e) = &shell.devices.engine {
                e.dismiss_former();
            }
            cx.notify();
        })
    })));
    block.into_any_element()
}

fn other_device(ui: Ui, me: &Entity<Shell>, state: &DevicesState, device: &serde_json::Value, now: f64) -> AnyElement {
    let c = ui.c;
    let id = device["id"].as_str().unwrap_or_default().to_owned();
    let name = device["name"].as_str().unwrap_or_default().to_owned();
    let online = is_online(device, now);
    let caps: Vec<&str> = device["caps"].as_array().map(|l| l.iter().filter_map(|c| c.as_str()).collect()).unwrap_or_default();
    let can = |cap: &str| caps.contains(&cap);
    let mut buttons = div().flex().flex_wrap().gap(px(8.));
    {
        let (me, to) = (me.clone(), id.clone());
        buttons = buttons.child(ui.button(format!("dateien-{id}"), "Dateien senden").small().accessible_name(format!("Dateien an „{name}“ senden")).on_click(move |_, app| {
            let to = to.clone();
            me.update(app, |shell, cx| shell.devices_pick(to, false, cx))
        }));
    }
    if can("folder") {
        let (me, to) = (me.clone(), id.clone());
        buttons = buttons.child(ui.button(format!("ordner-{id}"), "Ordner senden").small().accessible_name(format!("Ordner an „{name}“ senden")).on_click(move |_, app| {
            let to = to.clone();
            me.update(app, |shell, cx| shell.devices_pick(to, true, cx))
        }));
    }
    if can("text") {
        let (me, to) = (me.clone(), id.clone());
        let writing = state.text_to.as_deref() == Some(id.as_str());
        buttons = buttons.child(ui.button(format!("text-{id}"), "Text senden").small().accessible_name(format!("Text an „{name}“ senden")).on_click(move |_, app| {
            let to = to.clone();
            me.update(app, |shell, cx| {
                shell.devices.text_to = if writing { None } else { Some(to) };
                shell.devices.text_sent = false;
                cx.notify();
            })
        }));
    }
    let mut card = div()
        .flex()
        .flex_col()
        .gap(px(10.))
        .p(px(14.))
        .rounded(px(radius::CARD))
        .bg(c.panel_soft)
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(16.))
                .child(div().flex().flex_col().gap(px(2.)).child(div().flex().items_baseline().gap(px(8.)).child(ui.title(name.clone())).child(ui.value(short_id(&id).to_owned()))).child(ui.hint(format!("{} · {}", device["platform"].as_str().unwrap_or_default(), if online { "● offen".to_string() } else { seen_label(device["seen"].as_f64().unwrap_or(0.0), now) }))))
                .child(buttons),
        );
    if !can("text") {
        card = card.child(ui.hint("Dort läuft eine ältere Version. Text, Links und Ordner gehen nach deren Update."));
    }
    if !online {
        let (me, to) = (me.clone(), id.clone());
        card = card.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .child(ui.hint("Kommt an, wenn Sondra dort innerhalb von 15 Min. offen ist."))
                .child(ui.button(format!("entfernen-{id}"), "Entfernen").small().accessible_name(format!("„{name}“ aus der Liste nehmen")).on_click(move |_, app| {
                    let to = to.clone();
                    me.update(app, |shell, cx| {
                        if let Some(e) = &shell.devices.engine {
                            e.remove_device(&to);
                        }
                        cx.notify();
                    })
                })),
        );
    }
    if state.text_to.as_deref() == Some(id.as_str()) {
        let me2 = me.clone();
        card = card.child(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(ui.hint(format!("Text oder Link an „{name}“")))
                .child(div().max_w(px(520.)).child(state.text.clone()))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .child(ui.button("text-senden", "Senden").small().primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.devices_send_text(cx))))
                        .child(ui.hint(if state.text_sent { "● Gesendet — erscheint dort, sobald Sondra offen ist." } else { "" })),
                ),
        );
    }
    let _ = size::SMALL;
    card.into_any_element()
}

fn transfer_row(ui: Ui, me: &Entity<Shell>, t: &Transfer, dir: &std::path::Path) -> AnyElement {
    let c = ui.c;
    let mut row = div().flex().flex_col().gap(px(8.)).py(px(12.)).border_t_1().border_color(c.line).child(ui.prose(say(t)));
    let fraction = (t.total > 0).then(|| t.done as f32 / t.total as f32);
    if matches!(t.state, State::Sending | State::Receiving) {
        row = row.child(ui.bar(format!("uebertragung-{}", t.id), fraction, format!("{} {}", if t.outgoing { "Senden an" } else { "Empfangen von" }, t.peer_name)));
        row = row.child(ui.hint(format!("{} von {}", bytes(t.done), bytes(t.total))));
    }
    let mut buttons = div().flex().flex_wrap().gap(px(8.));
    let id = t.id.clone();
    if !t.state.over() {
        let me = me.clone();
        buttons = buttons.child(ui.button(format!("abbrechen-{}", t.id), "Abbrechen").small().on_click(move |_, app| {
            let id = id.clone();
            me.update(app, |shell, cx| {
                if let Some(e) = &shell.devices.engine {
                    e.cancel(&id);
                }
                cx.notify();
            })
        }));
    } else {
        if t.state == State::Done && !t.outgoing {
            let folder = dir.to_path_buf();
            let me = me.clone();
            buttons = buttons.child(ui.button(format!("zeigen-{}", t.id), "Im Ordner zeigen").small().on_click(move |_, app| {
                let folder = folder.clone();
                me.update(app, |shell, cx| {
                    shell.go(Panel::Folder, cx);
                    shell.open_folder(folder, cx);
                })
            }));
        }
        let me = me.clone();
        buttons = buttons.child(ui.button(format!("schliessen-{}", t.id), "Schliessen").small().on_click(move |_, app| {
            let id = id.clone();
            me.update(app, |shell, cx| {
                if let Some(e) = &shell.devices.engine {
                    e.dismiss(&id);
                }
                cx.notify();
            })
        }));
    }
    row.child(buttons).into_any_element()
}
