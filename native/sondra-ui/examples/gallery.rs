//! The components in light and dark, side by side — what the CI photographs, and what a person looks at
//! to judge the look before a screen is built from it. Closes itself after 40 seconds.
//!
//!   cargo run --release --example gallery -p sondra-ui

use std::time::Duration;

use gpui::{
    div, prelude::*, px, size, App, Application, Bounds, Context, Render, Window, WindowBounds,
    WindowOptions,
};
use sondra_a11y::{a11y_root, attach, set_window_title};
use sondra_ui::{fonts, Assets, Mode, NoticeKind, Ui};

struct Gallery {
    chosen_tab: usize,
    chosen_chip: usize,
    clicks: u32,
}

fn panel(ui: Ui, name: &'static str, state: &Gallery) -> gpui::AnyElement {
    let c = ui.c;
    let tabs = [
        "Start",
        "Merkliste",
        "Ordner",
        "Abspielen",
        "Herunterladen",
        "Geräte",
        "Bearbeiten ▾",
        "Ton ▾",
        "Mehr",
    ];
    let chips = ["Alle", "Bearbeiten", "Ton", "Aufnehmen"];
    let tools = [
        (
            "umwandeln",
            "Umwandeln",
            "Dateien in ein anderes Format bringen — Ton, Video, Bild.",
            "U",
        ),
        (
            "video",
            "Video",
            "Schneiden, drehen, Blenden, Farbe; auch lange Filme.",
            "V",
        ),
        (
            "untertitel",
            "Untertitel",
            "Aus Sprache Text machen und auf dem Gerät behalten.",
            "T",
        ),
        (
            "tonart",
            "Tonart",
            "Tonart, Tempo und Akkorde eines Stücks bestimmen.",
            "A",
        ),
    ];

    ui.sheet()
        .id(name)
        .w(px(540.))
        .h_full()
        .flex()
        .flex_col()
        .gap(px(20.))
        .p(px(24.))
        .child(
            // The header: the wordmark, then the row of tabs on the section line.
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(div().flex().items_center().justify_between().child(ui.wordmark()).child(ui.button(format!("{name}-app"), "App").small()))
                .child(
                    div().flex().flex_wrap().gap(px(2.)).children(tabs.iter().enumerate().map(|(i, label)| {
                        ui.tab(format!("{name}-reiter-{i}"), *label, i == state.chosen_tab)
                    })),
                )
                .child(ui.rule()),
        )
        .child(ui.heading("Werkzeuge"))
        .child(ui.prose("Wählen Sie eine Datei aus oder ziehen Sie sie hierher. Alles wird auf diesem Gerät gerechnet; nichts wird hochgeladen."))
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .child(ui.button(format!("{name}-datei"), "Datei auswählen").primary())
                .child(ui.button(format!("{name}-adresse"), "Von Adresse laden"))
                .child(ui.button(format!("{name}-klein"), "Klein").small())
                .child(ui.button(format!("{name}-aus"), "Nicht möglich").disabled(true))
                .child(ui.button(format!("{name}-mehr"), "Mehr dazu").ghost()),
        )
        .child(
            div().flex().flex_wrap().gap(px(8.)).children(
                chips.iter().enumerate().map(|(i, label)| ui.chip(format!("{name}-filter-{i}"), *label, i == state.chosen_chip)),
            ),
        )
        .child(
            div().grid().grid_cols(2).gap(px(12.)).children(
                tools.iter().map(|(id, title, hint, symbol)| ui.tile(format!("{name}-{id}"), *title, *hint).symbol(*symbol)),
            ),
        )
        .child(ui.notice(NoticeKind::Info, "Die Merkliste ist mit Google Drive abgeglichen."))
        .child(ui.notice(NoticeKind::NotLocal, "Achtung: Herunterladen läuft nicht lokal. Die Adresse geht an einen Dienst."))
        .child(
            div()
                .flex()
                .gap(px(12.))
                .child(ui.value("Folge 12 · S01E12.mkv"))
                .child(ui.value("00:23:41 / 00:24:10"))
                .child(ui.hint(format!("{} Klicks", state.clicks))),
        )
        .child(div().h(px(1.)).w_full().bg(c.line))
        .into_any_element()
}

impl Render for Gallery {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let light = Ui::new(Mode::Light.colors());
        let dark = Ui::new(Mode::Dark.colors());
        a11y_root(
            div()
                .size_full()
                .flex()
                .child(panel(light, "hell", self))
                .child(panel(dark, "dunkel", self)),
        )
    }
}

fn main() {
    Application::new().with_assets(Assets).run(|cx: &mut App| {
        fonts::load(cx);
        let bounds = Bounds::centered(None, size(px(1120.), px(900.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                show: false,
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("Sondra Bausteine".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| {
                attach(window, cx);
                set_window_title(window, cx, "Sondra Bausteine");
                window.activate_window();
                cx.new(|_| Gallery {
                    chosen_tab: 0,
                    chosen_chip: 2,
                    clicks: 0,
                })
            },
        )
        .expect("a window opens");
        cx.activate(true);
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_secs(40))
                .await;
            cx.update(|cx| cx.quit()).ok();
        })
        .detach();
    });
}
