//! Sondra, the native app. A window with the header, the row of tabs and the start page.

use gpui::{prelude::*, px, size, App, Application, Bounds, WindowBounds, WindowOptions};
use sondra_a11y::{attach, set_window_title};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

fn main() {
    Application::new().run(|cx: &mut App| {
        fonts::load(cx);
        bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(1180.), px(860.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                // Hidden until the accessibility bridge is attached: it has to exist before the first
                // show, or a screen reader never learns the window.
                show: false,
                titlebar: Some(gpui::TitlebarOptions {
                    title: Some("Sondra".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| {
                attach(window, cx);
                set_window_title(window, cx, "Sondra");
                window.activate_window();
                cx.new(|cx| Shell::new(window, cx))
            },
        )
        .expect("a window opens");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
