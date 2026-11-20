//! „Bild im Bild“: the film in a small window of its own that stays above the others, so the rest of the screen
//! can be worked on. A click on the picture pauses or goes on; closing the window brings nothing else with it. The
//! picture is the one the player already has, drawn a second time — nothing is decoded twice.

use std::sync::Arc;

use gpui::{div, img, prelude::*, px, size, Bounds, Context, Entity, ImageSource, ObjectFit, RenderImage, Window, WindowBounds, WindowHandle, WindowOptions};
use sondra_a11y::{accessible, a11y_root, Role};

use crate::shell::Shell;

pub struct PipView {
    shell: Entity<Shell>,
    /// The picture this window drew last, to let go of it here when a newer one comes.
    last: Option<Arc<RenderImage>>,
}

impl Render for PipView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // This window keeps the player's clock while it is open, and asks for the next frame while something plays
        // (for this window and for the page, which shows how far it is). Not at once: at the next frame.
        let more = self.shell.update(cx, |shell, _| shell.pip_drive(window));
        if more {
            let (me, shell) = (cx.entity_id(), self.shell.clone());
            window.on_next_frame(move |_, app| {
                shell.update(app, |_, cx| cx.notify());
                app.notify(me);
            });
        }
        let (picture, playing, name) = self.shell.read(cx).pip_picture();
        if let (Some(old), Some(new)) = (&self.last, &picture) {
            if !Arc::ptr_eq(old, new) {
                let _ = window.drop_image(old.clone());
            }
        }
        self.last = picture.clone();
        let shell = self.shell.clone();
        let stage = div().id("bild-im-bild").size_full().bg(gpui::black()).flex().items_center().justify_center().cursor_pointer().on_click(move |_, _, app| shell.update(app, |shell, cx| shell.pip_toggle(cx)));
        let stage = match picture {
            Some(image) => stage.child(img(ImageSource::Render(image)).object_fit(ObjectFit::Contain).size_full()),
            None => stage.child(div().text_color(gpui::white()).text_size(px(13.)).child("Kein Bild")),
        };
        let shell = self.shell.clone();
        a11y_root(
            accessible("bild-im-bild-flaeche", Role::Button, stage)
                .label(format!("{name}: {}", if playing { "anhalten" } else { "abspielen" }))
                .on_activate(move |_, app| shell.update(app, |shell, cx| shell.pip_toggle(cx))),
        )
    }
}

impl Shell {
    /// The picture of the film now, whether it plays, and its name.
    pub fn pip_picture(&self) -> (Option<Arc<RenderImage>>, bool, String) {
        let p = &self.player;
        let name = p.queue.get(p.index).and_then(|f| f.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        (p.image.clone(), p.playback.as_ref().is_some_and(|b| b.state() == sondra_playback::State::Playing), name)
    }

    /// One step of the clock, taken from the little window: the picture that is due, the end of the film. Whether
    /// something plays still (and a next frame is due).
    pub fn pip_drive(&mut self, window: &mut Window) -> bool {
        self.player.elsewhere = true;
        let more = self.player.tick(window, true);
        self.player.elsewhere = false;
        more
    }

    pub fn pip_toggle(&mut self, cx: &mut Context<Self>) {
        self.player.toggle();
        cx.notify();
    }

    pub fn pip_open(&self) -> bool {
        self.pip.is_some()
    }

    /// Opens the little window, or closes it when it is open.
    pub fn pip_switch(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = self.pip.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
            cx.notify();
            return;
        }
        if self.player.playback.is_none() || self.pip_opening {
            return;
        }
        self.pip_opening = true;
        // The window draws itself as it opens, and drawing it asks this page; so it is opened once this update is over.
        let shell = cx.entity();
        cx.defer(move |app| {
            let bounds = Bounds::centered(None, size(px(480.), px(270.)), app);
            let view_of = shell.clone();
            let opened: Result<WindowHandle<PipView>, _> = app.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions { title: Some("Sondra – Bild im Bild".into()), ..Default::default() }),
                    ..Default::default()
                },
                move |window, cx| {
                    // A window of the test platform is no real window (the system's handle is asked for and it panics):
                    // only a real one gets the accessibility bridge and the place above the others.
                    if let Some(handle) = crate::system::window_handle(window) {
                        sondra_a11y::attach(window, cx);
                        sondra_tray::set_always_on_top(handle, true);
                    }
                    // The window follows the player: a new picture, a pause.
                    cx.new(|cx| {
                        // A pause or a new film from the page: drawn again at once.
                        cx.observe(&view_of, |_, _, cx| cx.notify()).detach();
                        PipView { shell: view_of.clone(), last: None }
                    })
                },
            );
            shell.update(app, |shell, cx| {
                shell.pip_opening = false;
                match opened {
                    Ok(handle) => {
                        // Closed with the system's own button: the player knows it is gone.
                        let me = cx.entity();
                        let _ = handle.update(cx, |_, window, cx| {
                            window.on_window_should_close(cx, move |_, app| {
                                me.update(app, |shell, cx| {
                                    shell.pip = None;
                                    cx.notify();
                                });
                                true
                            });
                        });
                        shell.pip = Some(handle);
                    }
                    Err(e) => shell.player.error = Some(format!("Das Fenster für Bild im Bild ging nicht auf: {e}")),
                }
                cx.notify();
            });
        });
    }
}
