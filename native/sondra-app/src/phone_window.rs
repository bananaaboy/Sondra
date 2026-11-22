//! „In einem eigenen Fenster öffnen“ for „Handy spiegeln“: the phone's screen in a window of the system — anywhere on
//! the screen, on a second one too, of its own size (the picture fills it in its shape). It is the same screen as on
//! the page (`phone_screen`): mouse, wheel and keys go to the phone the same way. The page says meanwhile „Das Handy
//! steht in einem eigenen Fenster“ with „Zurück in die Seite“; closing the window brings it back, „Beenden“ closes it.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{div, prelude::*, px, size, Bounds, Context, Entity, FocusHandle, Pixels, Window, WindowBounds, WindowHandle, WindowOptions};
use sondra_a11y::a11y_root;

use crate::shell::Shell;

pub struct PhoneWindowView {
    shell: Entity<Shell>,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    focus: FocusHandle,
}

/// The picture's size in a room of `room`, in the shape of the phone's screen.
pub fn fitted(room: (f32, f32), screen: (u32, u32)) -> (f32, f32) {
    let aspect = screen.0.max(1) as f32 / screen.1.max(1) as f32;
    let (w, h) = room;
    if w / h.max(1.0) > aspect {
        (h * aspect, h)
    } else {
        (w, w / aspect)
    }
}

impl Render for PhoneWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let room = window.viewport_size();
        let shell = self.shell.clone();
        let screen = shell.read(cx).phone_screen_size();
        let (w, h) = fitted((f32::from(room.width), f32::from(room.height)), screen);
        let picture = shell.read(cx).phone_screen(shell.clone(), w, h, &self.bounds, &self.focus);
        a11y_root(div().size_full().bg(gpui::black()).flex().items_center().justify_center().child(picture))
    }
}

impl Shell {
    /// The size of the phone's screen in pixels (9 × 16 until it is known).
    pub fn phone_screen_size(&self) -> (u32, u32) {
        self.phone_session_size().unwrap_or((9, 16))
    }

    pub fn phone_window_open(&self) -> bool {
        self.phone_window.is_some()
    }

    /// Opens the phone in a window of its own, or brings it back into the page.
    pub fn phone_window_switch(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = self.phone_window.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
            cx.notify();
            return;
        }
        if self.phone_session_size().is_none() || self.phone_window_opening {
            return;
        }
        self.phone_window_opening = true;
        let (sw, sh) = self.phone_screen_size();
        let shell = cx.entity();
        // The window draws itself as it opens, and drawing asks this page: so it opens once this update is over.
        cx.defer(move |app| {
            let (w, h) = fitted((420.0, 760.0), (sw, sh));
            let bounds = Bounds::centered(None, size(px(w), px(h)), app);
            let view_of = shell.clone();
            let opened: Result<WindowHandle<PhoneWindowView>, _> = app.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions { title: Some("Sondra – Handy".into()), ..Default::default() }),
                    ..Default::default()
                },
                move |window, cx| {
                    if crate::system::window_handle(window).is_some() {
                        sondra_a11y::attach(window, cx);
                    }
                    cx.new(|cx| {
                        // A new picture of the phone: drawn again.
                        cx.observe(&view_of, |_, _, cx| cx.notify()).detach();
                        PhoneWindowView { shell: view_of.clone(), bounds: Rc::new(Cell::new(Bounds::default())), focus: cx.focus_handle().tab_stop(true) }
                    })
                },
            );
            shell.update(app, |shell, cx| {
                shell.phone_window_opening = false;
                match opened {
                    Ok(handle) => {
                        // Closed with the system's own button: the phone comes back into the page.
                        let me = cx.entity();
                        let _ = handle.update(cx, |_, window, cx| {
                            window.on_window_should_close(cx, move |_, app| {
                                me.update(app, |shell, cx| {
                                    shell.phone_window = None;
                                    cx.notify();
                                });
                                true
                            });
                        });
                        shell.phone_window = Some(handle);
                    }
                    Err(e) => shell.phone.said = Some(format!("Das eigene Fenster ging nicht auf: {e}")),
                }
                cx.notify();
            });
        });
    }

    /// Ending the mirror, or leaving it, closes the window.
    pub(crate) fn phone_window_close(&mut self, cx: &mut Context<Self>) {
        if let Some(handle) = self.phone_window.take() {
            let _ = handle.update(cx, |_, window, _| window.remove_window());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fitted;

    #[test]
    fn the_picture_fills_the_window_in_the_phones_shape() {
        assert_eq!(fitted((400.0, 800.0), (1080, 2400)), (360.0, 800.0));
        assert_eq!(fitted((400.0, 400.0), (1080, 2400)), (180.0, 400.0));
        let (w, h) = fitted((1000.0, 400.0), (2400, 1080));
        assert!((w - 888.888_9).abs() < 0.01 && (h - 400.0).abs() < 0.01);
    }
}
