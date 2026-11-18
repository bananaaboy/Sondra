//! A window with a few controls, to be asked about by a screen reader's API.
//!
//! The CI starts it on Windows and queries it through UI Automation, the way a
//! screen reader does (`uia-check.ps1`). Closes itself after 40 seconds.
//!
//!   cargo run --release --example demo -p sondra-a11y

use std::time::Duration;

use gpui::{
    div, prelude::*, px, rgb, size, App, Application, Bounds, Context, FocusHandle, Render, Window,
    WindowBounds, WindowOptions,
};
use sondra_a11y::{a11y_root, accessible, attach, Role};

struct Demo {
    play: FocusHandle,
    search: FocusHandle,
    plays: u32,
    muted: bool,
}

impl Demo {
    fn activate_play(&mut self, cx: &mut Context<Self>) {
        self.plays += 1;
        // The check reads this file to know that activation really reached the app.
        let _ = std::fs::write("activated.txt", format!("{}", self.plays));
        cx.notify();
    }
}

fn button(label: &'static str) -> gpui::Div {
    div()
        .px_4()
        .py_2()
        .rounded_lg()
        .bg(rgb(0x2b4a3a))
        .text_color(rgb(0xf2efe6))
        .child(label)
}

impl Render for Demo {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let toggle_view = cx.entity();
        a11y_root(
            div()
                .size_full()
                .bg(rgb(0x14201a))
                .text_color(rgb(0xf2efe6))
                .flex()
                .flex_col()
                .gap_3()
                .p_6()
                .child(
                    accessible(
                        "title",
                        Role::Label,
                        div().text_size(px(24.)).child("Frieren – Folge 12 von 28"),
                    )
                    .label("Frieren – Folge 12 von 28"),
                )
                .child(
                    accessible(
                        "play",
                        Role::Button,
                        button("Abspielen")
                            .id("play-visual")
                            .track_focus(&self.play)
                            .on_click(cx.listener(|this, _, _, cx| this.activate_play(cx))),
                    )
                    .label("Abspielen")
                    .description("Startet die Folge")
                    .focus(&self.play)
                    .on_activate(move |_, cx| view.update(cx, |this, cx| this.activate_play(cx))),
                )
                .child(
                    accessible(
                        "mute",
                        Role::Switch,
                        button(if self.muted {
                            "Stumm: an"
                        } else {
                            "Stumm: aus"
                        })
                        .id("mute-visual")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.muted = !this.muted;
                            cx.notify();
                        })),
                    )
                    .label("Stumm")
                    .toggled(self.muted)
                    .on_activate(move |_, cx| {
                        toggle_view.update(cx, |this, cx| {
                            this.muted = !this.muted;
                            cx.notify();
                        })
                    }),
                )
                .child(
                    accessible(
                        "search",
                        Role::TextInput,
                        div()
                            .id("search-visual")
                            .track_focus(&self.search)
                            .px_4()
                            .py_2()
                            .rounded_lg()
                            .bg(rgb(0x1f2f27))
                            .child("Serie suchen …"),
                    )
                    .label("Suche")
                    .focus(&self.search),
                )
                .child(
                    accessible(
                        "status",
                        Role::Status,
                        div().child(format!("{} Mal gestartet", self.plays)),
                    )
                    .label("Status")
                    .value(format!("{} Mal gestartet", self.plays))
                    .live(),
                ),
        )
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(720.), px(480.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("Sondra Bedienungshilfen".into()),
                    ..Default::default()
                }),
                // Hidden until the accessibility bridge is on the window (see `attach`).
                show: false,
                ..Default::default()
            },
            |window, cx| {
                let attached = attach(window, cx);
                eprintln!("accessibility bridge attached: {attached}");
                window.activate_window();
                cx.new(|cx| Demo {
                    play: cx.focus_handle(),
                    search: cx.focus_handle(),
                    plays: 0,
                    muted: false,
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
