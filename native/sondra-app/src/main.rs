//! Sondra, the native app. A window with the header, the row of tabs and the start page.

use gpui::{prelude::*, px, size, App, Application, Bounds, WindowBounds, WindowOptions};
use sondra_a11y::{attach, set_window_title};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts, Assets};

fn main() {
    Application::new().with_assets(Assets).run(|cx: &mut App| {
        fonts::load(cx);
        sondra_ui::motion::set_reduced(sondra_app::system::prefers_reduced_motion());
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
                cx.new(|cx| {
                    let mut shell = Shell::new(window, cx);
                    if let Some(store) = sondra_app::store::MerkStore::default_location() {
                        shell.open_merkliste(store, cx);
                    }
                    if let Some(store) = sondra_app::store::FileStore::default_location() {
                        shell.open_ordner_memory(store, cx);
                    }
                    if let Some(store) = sondra_app::store::FileStore::at_default("Abspielen.json") {
                        shell.open_player_memory(store, cx);
                    }
                    // Files and folders on the command line: „Öffnen mit Sondra“ and a drop on the program.
                    let given: Vec<std::path::PathBuf> = std::env::args_os().skip(1).map(Into::into).collect();
                    if !given.is_empty() {
                        shell.open_paths(given, cx);
                    }
                    shell
                })
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
