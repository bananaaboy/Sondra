//! „Eigener Server für andere Netze“ on the Geräte page (`OwnServer` in `DevicesPanel.tsx`). Between two networks
//! devices find each other only with the help of a server (STUN) or one that carries the traffic (TURN). Sondra
//! brings none and puts none in — that server would see the address of every device — so there are fields, empty,
//! for one the person trusts. The addresses are kept on this computer; the TURN password is not: it stays in
//! memory until Sondra closes. A change counts for the next connection.

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_devices::servers::{server_problem, Kind, ServerSettings};
use sondra_ui::{radius, FieldEvent, TextField, Ui};

use crate::shell::Shell;

pub struct ServersUi {
    pub open: bool,
    pub stun: Entity<TextField>,
    pub turn: Entity<TextField>,
    pub user: Entity<TextField>,
    pub password: Entity<TextField>,
    /// The fields were taken over (shown until something is typed again).
    pub applied: bool,
}

impl ServersUi {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> ServersUi {
        let watch = |cx: &mut Context<Shell>, entity: Entity<TextField>| {
            cx.subscribe(&entity, |shell: &mut Shell, _, event: &FieldEvent, cx| {
                if *event == FieldEvent::Changed {
                    shell.devices.servers.applied = false;
                    cx.notify();
                }
            })
            .detach();
            entity
        };
        let e = cx.new(|cx| TextField::new(cx, colors, "STUN-Server").placeholder("stun:beispiel.de:3478").max_chars(200));
        let stun = watch(cx, e);
        let e = cx.new(|cx| TextField::new(cx, colors, "TURN-Server (Relay)").placeholder("turn:beispiel.de:3478").max_chars(200));
        let turn = watch(cx, e);
        let e = cx.new(|cx| TextField::new(cx, colors, "Benutzername").max_chars(100));
        let user = watch(cx, e);
        let e = cx.new(|cx| TextField::new(cx, colors, "Passwort").max_chars(200).secret());
        let password = watch(cx, e);
        ServersUi { open: false, stun, turn, user, password, applied: false }
    }
}

impl Shell {
    fn servers_draft(&self, cx: &Context<Self>) -> ServerSettings {
        let s = &self.devices.servers;
        ServerSettings { stun: s.stun.read(cx).text().trim().to_owned(), turn: s.turn.read(cx).text().trim().to_owned(), user: s.user.read(cx).text().trim().to_owned(), password: s.password.read(cx).text().to_owned() }
    }

    /// Opens or shuts the block; opening shows what is set.
    pub(crate) fn servers_toggle(&mut self, cx: &mut Context<Self>) {
        let open = !self.devices.servers.open;
        self.devices.servers.open = open;
        if open {
            if let Some(setup) = &self.devices.setup {
                let now = setup.servers.lock().expect("lock").clone();
                let s = &self.devices.servers;
                s.stun.update(cx, |f, cx| f.set_text(now.stun.clone(), cx));
                s.turn.update(cx, |f, cx| f.set_text(now.turn.clone(), cx));
                s.user.update(cx, |f, cx| f.set_text(now.user.clone(), cx));
                s.password.update(cx, |f, cx| f.set_text(now.password.clone(), cx));
            }
            self.devices.servers.applied = false;
        }
        cx.notify();
    }

    /// Takes the fields over: the next connection uses them.
    pub(crate) fn servers_apply(&mut self, cx: &mut Context<Self>) {
        let draft = self.servers_draft(cx);
        if server_problem(&draft.stun, Kind::Stun).is_some() || server_problem(&draft.turn, Kind::Turn).is_some() {
            return;
        }
        if let Some(setup) = &self.devices.setup {
            *setup.servers.lock().expect("lock") = draft.clone();
            (setup.keep_servers)(&draft);
        }
        self.devices.servers.applied = true;
        cx.notify();
    }

    /// For tests: puts text in the fields as if it were typed.
    pub fn devices_servers_fill(&mut self, stun: &str, cx: &mut Context<Self>) {
        self.devices.servers.stun.update(cx, |f, cx| f.set_text(stun.to_owned(), cx));
    }

    /// Empties the fields and the servers.
    pub(crate) fn servers_clear(&mut self, cx: &mut Context<Self>) {
        let s = &self.devices.servers;
        for field in [&s.stun, &s.turn, &s.user, &s.password] {
            field.update(cx, |f, cx| f.set_text("", cx));
        }
        self.servers_apply(cx);
    }

    pub(crate) fn own_server_block(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let Some(setup) = &self.devices.setup else { return div().into_any_element() };
        let set = setup.servers.lock().expect("lock").clone();
        let active = !set.stun.trim().is_empty() || !set.turn.trim().is_empty();
        let s = &self.devices.servers;
        let toggle = {
            let me = me.clone();
            ui.button("eigener-server", if active { "Eigener Server für andere Netze (gesetzt)" } else { "Eigener Server für andere Netze" }).small().on_click(move |_, app| me.update(app, |shell, cx| shell.servers_toggle(cx)))
        };
        let mut block = div().flex().flex_col().gap(px(12.)).child(div().flex().child(toggle));
        if !s.open {
            return block.into_any_element();
        }
        let draft = self.servers_draft(cx);
        let (stun_problem, turn_problem) = (server_problem(&draft.stun, Kind::Stun), server_problem(&draft.turn, Kind::Turn));
        let field = |label: &str, entity: &Entity<TextField>, hint: String| div().flex().flex_col().gap(px(4.)).child(ui.hint(label.to_string())).child(div().max_w(px(480.)).child(entity.clone())).child(ui.hint(hint));
        let dirty = draft.stun != set.stun || draft.turn != set.turn || draft.user != set.user || draft.password != set.password;
        let mut card = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(16.))
            .rounded(px(radius::CARD))
            .bg(c.panel_cool)
            .child(ui.prose("Geräte in verschiedenen Netzen finden sich nur mit Hilfe eines Servers. Sondra bringt keinen mit und trägt keinen ein: dieser Server sähe die Netzadresse jedes Ihrer Geräte. Wenn Sie einen eigenen oder einen vertrauten haben, tragen Sie ihn hier ein; die Dateien bleiben auch über einen Relay-Server (TURN) verschlüsselt. Der Server und seine Adressen reisen in der Nachricht an das andere Gerät mit."))
            .child(field("STUN-Server", &s.stun, stun_problem.map_or_else(|| "Sagt jedem Gerät, wie es von aussen erreichbar ist. Genügt oft schon.".to_owned(), str::to_owned)))
            .child(field("TURN-Server (Relay)", &s.turn, turn_problem.map_or_else(|| "Für Netze, in denen STUN allein nicht reicht: der Server leitet den Verkehr weiter.".to_owned(), str::to_owned)));
        if !draft.turn.is_empty() {
            card = card.child(field("Benutzername", &s.user, String::new())).child(field("Passwort", &s.password, "Wird nicht gespeichert: nach dem Schliessen von Sondra fragt es neu.".to_owned()));
        }
        let (apply, clear) = (me.clone(), me.clone());
        let mut buttons = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.button("server-uebernehmen", "Übernehmen").small().primary().disabled(!dirty || stun_problem.is_some() || turn_problem.is_some()).on_click(move |_, app| apply.update(app, |shell, cx| shell.servers_apply(cx))));
        if active || !draft.stun.is_empty() || !draft.turn.is_empty() {
            buttons = buttons.child(ui.button("server-leeren", "Leeren").small().on_click(move |_, app| clear.update(app, |shell, cx| shell.servers_clear(cx))));
        }
        if s.applied {
            buttons = buttons.child(ui.hint("Übernommen: gilt für die nächste Verbindung."));
        }
        block = block.child(card.child(buttons));
        block.into_any_element()
    }
}
