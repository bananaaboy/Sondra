//! The command palette (Ctrl/⌘ + K) and the overview of keys („?“) — `CommandPalette.tsx` and `ShortcutHelp.tsx`. The
//! palette searches what Sondra can do with the same search as the start page (`actions::search`: „mp3 aus video“,
//! „extract audio“ and „tonspur“ find the same thing); Enter opens the first hit, a click any. The overview lists the keys
//! that this program has, by where they work.

use gpui::{div, prelude::*, px, AnyElement, Context, Entity};
use sondra_ui::{family, size, FieldEvent, TextField, Ui};

use crate::actions;
use crate::shell::Shell;

/// How many hits the palette shows; the rest is said, not scrolled.
const SHOWN: usize = 8;

pub struct Palette {
    pub open: bool,
    pub field: Entity<TextField>,
    pub help: bool,
    /// The overview of keys: the group shown (`None`: all) and the search in it.
    pub help_group: Option<&'static str>,
    pub help_field: Entity<TextField>,
}

impl Palette {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> Palette {
        let field = cx.new(|cx| TextField::new(cx, colors, "Befehl suchen").placeholder("Was möchten Sie tun? z. B. „mp3 aus video“").max_chars(80));
        let help_field = cx.new(|cx| TextField::new(cx, colors, "Kürzel suchen").placeholder("z. B. „zoom“ oder „Strg“").max_chars(40));
        cx.subscribe(&help_field, |_, _, event: &sondra_ui::FieldEvent, cx| {
            if *event == sondra_ui::FieldEvent::Changed {
                cx.notify();
            }
        })
        .detach();
        Palette { open: false, field, help: false, help_group: None, help_field }
    }
}

/// The keys of this program, by where they work: (category, [(keys, what)]).
pub fn shortcuts() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    vec![
        (
            "Allgemein",
            vec![
                ("Strg K", "Befehlspalette öffnen"),
                ("?", "Diese Übersicht ein- und ausblenden"),
                ("↑ ↓", "Im Rack von Ort zu Ort gehen"),
                ("Tab · Umschalt Tab", "Zum nächsten und vorigen Bedienelement"),
                ("Esc", "Menü oder Fenster schliessen"),
                ("Ziehen und Loslassen", "Dateien öffnen — überall im Fenster"),
            ],
        ),
        (
            "Ton & Schnitt",
            vec![
                ("Leertaste", "Abspielen und Anhalten"),
                ("Strg Z", "Rückgängig"),
                ("Strg Umschalt Z · Strg Y", "Wiederholen"),
                ("Strg X · Entf", "Auswahl ausschneiden"),
                ("Strg C", "Auswahl kopieren"),
                ("Strg V", "Einfügen"),
                ("T", "Tempo klopfen"),
                ("+ −", "Hinein- und herauszoomen"),
                ("Mausrad", "Zoomen"),
            ],
        ),
        (
            "Sampler & Beat",
            vec![
                ("1 2 3 4 · Q W E R · A S D F · Y X C V", "Das Pad auf dieser Taste spielen"),
                ("Leertaste", "Den Beat abspielen und anhalten"),
                ("Entf", "Gewähltes Pad löschen"),
                ("USB-MIDI", "Ein Controller spielt die Pads"),
            ],
        ),
        (
            "Player & Bühne",
            vec![
                ("Leertaste · K", "Pause und Weiter"),
                ("← →", "Zurück und vor um die eingestellte Sprungweite"),
                ("J L", "10 Sekunden zurück und vor"),
                ("0 … 9", "An den Anfang, zu 10 % … 90 % springen"),
                (", .", "Bei angehaltenem Video ein Bild zurück und vor"),
                ("< >", "Langsamer und schneller"),
                ("N P", "Nächste und vorige Datei der Liste"),
                ("S", "Vorspann überspringen"),
                ("C", "Untertitel an und aus"),
                ("↑ ↓", "Lauter und leiser"),
                ("M", "Ton aus und an"),
                ("B", "Lesezeichen setzen"),
                ("Umschalt ← →", "Zum vorigen und nächsten Lesezeichen"),
                ("T", "Kinomodus"),
                ("W", "Fenster füllen"),
                ("F", "Vollbild"),
                ("Esc", "Vollbild und Kino verlassen"),
            ],
        ),
        (
            "Video & Bild",
            vec![
                ("Strg Z", "Einstellung zurücknehmen (Video, Bilder)"),
                ("Strg Umschalt Z · Strg Y", "Wieder anwenden"),
                ("Ziehen auf der Zeitleiste", "Anfang und Ende des Schnitts setzen"),
                ("Ziehen auf dem Bild", "Einen Ausschnitt aufziehen, verschieben oder an den Griffen ändern"),
            ],
        ),
        (
            "Ordner",
            vec![
                ("Klick", "Eine Datei wählen"),
                ("Strg + Klick", "Eine Datei dazunehmen oder abwählen"),
                ("Umschalt + Klick", "Von der zuletzt gewählten bis hierher wählen"),
                ("← → ↑ ↓", "Durch die Liste gehen (mit Umschalt als Bereich)"),
                ("Leertaste", "Datei dazunehmen oder abwählen"),
                ("Strg A", "Alles in der Ansicht wählen"),
                ("Esc", "Nichts mehr wählen"),
                ("Enter", "Die Auswahl abspielen"),
            ],
        ),
        (
            "Maus & Gesten",
            vec![
                ("Ziehen auf der Welle", "Einen Bereich wählen; im Zerschneiden einen Schnitt verschieben"),
                ("Umschalt + Mausrad", "Seitlich scrollen"),
                ("Linksklick aufs Handy", "Tippen; Rechtsklick Zurück, Mittelklick Start"),
                ("Strg Alt Esc", "Die Tastatur vom Handy an Sondra zurückgeben"),
            ],
        ),
    ]
}

/// The lines of the overview that fit the group chosen (`None`: all) and the words typed (in the keys or the text,
/// case ignored).
pub fn shortcut_hits(group: Option<&str>, query: &str) -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    let q = query.trim().to_lowercase();
    shortcuts()
        .into_iter()
        .filter(|(g, _)| group.is_none_or(|want| want == *g))
        .map(|(g, items)| (g, items.into_iter().filter(|(k, t)| q.is_empty() || k.to_lowercase().contains(&q) || t.to_lowercase().contains(&q)).collect::<Vec<_>>()))
        .filter(|(_, items)| !items.is_empty())
        .collect()
}

impl Shell {
    pub fn open_palette(&mut self, cx: &mut Context<Self>) {
        self.palette.open = true;
        self.palette.help = false;
        self.palette.field.update(cx, |f, cx| f.set_text("", cx));
        self.pending_focus = Some(gpui::Focusable::focus_handle(self.palette.field.read(cx), cx));
        cx.notify();
    }

    pub fn close_palette(&mut self, cx: &mut Context<Self>) {
        self.palette.open = false;
        self.palette.help = false;
        self.pending_focus = Some(self.focus.clone());
        cx.notify();
    }

    /// For tests: the search field of the overview of keys.
    pub fn palette_help_field(&self) -> Entity<TextField> {
        self.palette.help_field.clone()
    }

    pub fn toggle_help(&mut self, cx: &mut Context<Self>) {
        self.palette.help = !self.palette.help;
        self.palette.open = false;
        cx.notify();
    }

    /// The hits for what is typed.
    pub fn palette_hits(&self, cx: &gpui::App) -> Vec<&'static actions::Action> {
        actions::search(self.palette.field.read(cx).text())
    }

    /// Opens the tool of a hit and closes the palette.
    pub fn palette_choose(&mut self, action: &'static actions::Action, cx: &mut Context<Self>) {
        self.palette.open = false;
        self.go(action.panel, cx);
    }

    /// Enter in the field: the first hit.
    pub fn palette_submit(&mut self, cx: &mut Context<Self>) {
        if let Some(first) = self.palette_hits(cx).first().copied() {
            self.palette_choose(first, cx);
        }
    }

    pub(crate) fn palette_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let me = cx.entity();
        let c = ui.c;
        if self.palette.help {
            let away = me.clone();
            let close = me.clone();
            let mut body = div().flex().flex_col().gap(px(14.));
            let mut groups = div().flex().flex_wrap().gap(px(6.));
            {
                let me = me.clone();
                groups = groups.child(ui.chip("kuerzel-alle", "Alle", self.palette.help_group.is_none()).accessible_name("Alle Kürzel").on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.palette.help_group = None;
                    cx.notify();
                })));
            }
            for (group, _) in shortcuts() {
                let me = me.clone();
                groups = groups.child(ui.chip(format!("kuerzel-{group}"), group, self.palette.help_group == Some(group)).accessible_name(format!("Kürzel: {group}")).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.palette.help_group = Some(group);
                    cx.notify();
                })));
            }
            body = body.child(groups).child(div().w(px(320.)).child(self.palette.help_field.clone()));
            let query = self.palette.help_field.read(cx).text().to_string();
            let hits = shortcut_hits(self.palette.help_group, &query);
            if hits.is_empty() {
                body = body.child(ui.hint(format!("Kein Kürzel passt zu „{}“.", query.trim())));
            }
            for (category, items) in hits {
                let mut block = div().flex().flex_col().child(div().pb(px(6.)).border_b_1().border_color(c.line).child(ui.subheading(category)));
                for (keys, what) in items {
                    block = block.child(div().flex().flex_wrap().items_baseline().justify_between().gap(px(12.)).py(px(5.)).border_b_1().border_color(c.line).child(ui.prose(what)).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.ink).child(keys)));
                }
                body = body.child(block);
            }
            return Some(
                ui.dialog("tastenkuerzel", "Tastenkürzel")
                    .width(640.)
                    .child(body)
                    .action(ui.button("kuerzel-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| shell.close_palette(cx))))
                    .on_close(move |_, app| away.update(app, |shell, cx| shell.close_palette(cx)))
                    .into_any_element(),
            );
        }
        if !self.palette.open {
            return None;
        }
        let hits = self.palette_hits(cx);
        let mut list = div().flex().flex_col();
        if hits.is_empty() {
            list = list.child(ui.prose("Dazu fällt Sondra nichts ein. Versuchen Sie ein anderes Wort, etwa „mp3“, „zuschneiden“ oder „untertitel“."));
        }
        for (n, action) in hits.iter().take(SHOWN).enumerate() {
            let (go, action) = (me.clone(), *action);
            list = list.child(
                div().border_t_1().border_color(c.line).when(n == 0, |d| d.border_t_0()).child(
                    ui.button(format!("befehl-{}", action.id), action.label.clone()).ghost().accessible_name(format!("{} — {}", action.label, action.hint)).on_click(move |_, app| go.update(app, |shell, cx| shell.palette_choose(action, cx))),
                ),
            );
        }
        if hits.len() > SHOWN {
            list = list.child(ui.hint(format!("und {} weitere — tippen Sie mehr, um einzugrenzen", hits.len() - SHOWN)));
        }
        let (away, close) = (me.clone(), me);
        Some(
            ui.dialog("befehlspalette", "Befehlspalette")
                .width(560.)
                .child(self.palette.field.clone())
                .child(list)
                .action(ui.button("palette-schliessen", "Schliessen").on_click(move |_, app| close.update(app, |shell, cx| shell.close_palette(cx))))
                .on_close(move |_, app| away.update(app, |shell, cx| shell.close_palette(cx)))
                .into_any_element(),
        )
    }
}

/// Wires the field of the palette to the shell: typing refreshes the hits, Enter takes the first.
pub fn subscribe(shell_field: &Entity<TextField>, cx: &mut Context<Shell>) {
    cx.subscribe(shell_field, |shell, _, event: &FieldEvent, cx| match event {
        FieldEvent::Changed => cx.notify(),
        FieldEvent::Submitted => shell.palette_submit(cx),
        _ => {}
    })
    .detach();
}

impl Shell {
    /// For tests: types into the field of the palette.
    pub fn palette_type_for_test(&mut self, text: &str, cx: &mut Context<Self>) {
        self.palette.field.update(cx, |f, cx| f.set_text(text.to_string(), cx));
    }

    /// For tests: the focus of the window's root.
    pub fn focus_for_test(&self) -> gpui::FocusHandle {
        self.focus.clone()
    }
}
