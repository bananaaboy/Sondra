//! Sondra, the native app. A window with the header, the row of tabs and the start page.

use gpui::{prelude::*, px, size, App, Application, Bounds, WindowBounds, WindowOptions};
use sondra_a11y::{attach, set_window_title};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts, Assets};

fn main() {
    // One Sondra at a time: a second start hands over what it was given and ends.
    let given: Vec<std::path::PathBuf> = std::env::args_os().skip(1).map(Into::into).collect();
    let instance = match sondra_app::store::data_dir() {
        Some(dir) => match sondra_app::instance::claim(&dir, &given) {
            sondra_app::instance::Claim::Handed => return,
            sondra_app::instance::Claim::First(instance) => Some(instance),
        },
        None => None,
    };
    let mut instance = instance;
    Application::new().with_assets(Assets).run(move |cx: &mut App| {
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
                    if let Some(store) = sondra_app::store::FileStore::at_default("Einstellungen.json") {
                        shell.open_whats_new_memory(store, cx);
                    }
                    if let (Some(setup), Some(store)) = (sondra_app::devices_setup::production(), sondra_app::store::FileStore::at_default("Geraete.json")) {
                        shell.open_devices(setup, store, cx);
                    }
                    if let Some(store) = sondra_app::store::FileStore::at_default("Thema.json") {
                        shell.open_theme_memory(store, cx);
                    }
                    shell.look_for_old_app(cx);
                    // Files and folders on the command line: „Öffnen mit Sondra“ and a drop on the program.
                    if !given.is_empty() {
                        shell.open_paths(given.clone(), cx);
                    }
                    // And what a second start hands over later.
                    if let Some(instance) = instance.take() {
                        shell.listen_for_instances(instance.paths, cx);
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
