//! A slider: a bar to press or drag, for a place in a film or a volume. It names itself (a slider with a
//! label and its value in words), takes the keyboard (Left and Right step, Home and End go to the ends)
//! and draws the way the rest does — a hairline ground, ink for what is behind, a round handle that grows
//! a ring when it has the focus.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    canvas, div, prelude::*, px, App, Bounds, MouseButton, Pixels, SharedString, Window,
};
use sondra_a11y::{accessible, Role};

use crate::theme::radius;
use crate::ui::{focus_ring, key_id, Ui};

type Change = Rc<dyn Fn(f32, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Slider {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    /// 0 to 1.
    value: f32,
    /// What a screen reader reads as the value („0:12 von 4:00“).
    says: SharedString,
    /// How far an arrow key moves it, as a fraction.
    step: f32,
    width: Option<f32>,
    on_change: Option<Change>,
}

impl Slider {
    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }
    pub fn step(mut self, step: f32) -> Self {
        self.step = step;
        self
    }
    pub fn says(mut self, text: impl Into<SharedString>) -> Self {
        self.says = text.into();
        self
    }
    /// Called with the new value (0 to 1) when the bar is pressed, dragged or stepped.
    pub fn on_change(mut self, handler: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

fn fraction_at(bounds: Bounds<Pixels>, x: Pixels) -> f32 {
    let width: f32 = bounds.size.width.into();
    if width <= 0.0 {
        return 0.0;
    }
    let left: f32 = bounds.origin.x.into();
    let x: f32 = x.into();
    ((x - left) / width).clamp(0.0, 1.0)
}

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let focus = window
            .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| cx.focus_handle().tab_stop(true))
            .read(cx)
            .clone();
        // Where the bar was drawn last, so a press can be turned into a place on it.
        let bounds: Rc<Cell<Bounds<Pixels>>> = window
            .use_keyed_state(key_id(&self.id, "lage"), cx, |_, _| Rc::new(Cell::new(Bounds::default())))
            .read(cx)
            .clone();
        let value = self.value.clamp(0.0, 1.0);
        let (down, drag, key) = (self.on_change.clone(), self.on_change.clone(), self.on_change.clone());
        let (b_down, b_drag) = (bounds.clone(), bounds.clone());
        let (current, step) = (value, self.step);
        let measure = bounds.clone();

        let bar = div()
            .relative()
            .h(px(4.))
            .w_full()
            .rounded(px(radius::PILL))
            .bg(c.line)
            .child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full())
            .child(div().absolute().left_0().top_0().h_full().w(gpui::relative(value)).rounded(px(radius::PILL)).bg(c.ink))
            .child(
                // The handle sits on the end of what is behind.
                div()
                    .absolute()
                    .top(px(-5.))
                    .left(gpui::relative(value))
                    .ml(px(-7.))
                    .size(px(14.))
                    .rounded(px(radius::PILL))
                    .bg(c.ink)
                    .border_2()
                    .border_color(c.canvas),
            );
        let mut track = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .h(px(24.))
            .flex()
            .items_center()
            .cursor_pointer()
            .rounded(px(radius::PILL))
            .focus(move |s| s.shadow(focus_ring(&c)))
            .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                if let Some(change) = &down {
                    change(fraction_at(b_down.get(), event.position.x), window, cx);
                }
            })
            .on_mouse_move(move |event, window, cx| {
                if event.pressed_button == Some(MouseButton::Left) {
                    if let Some(change) = &drag {
                        change(fraction_at(b_drag.get(), event.position.x), window, cx);
                    }
                }
            })
            .on_key_down(move |event, window, cx| {
                let Some(change) = &key else { return };
                // A key with Shift, Ctrl or Alt belongs to whoever asked for it further out (Shift+arrows).
                let m = &event.keystroke.modifiers;
                if m.shift || m.control || m.alt || m.platform {
                    return;
                }
                let to = match event.keystroke.key.as_str() {
                    "left" | "down" => Some((current - step).max(0.0)),
                    "right" | "up" => Some((current + step).min(1.0)),
                    "home" => Some(0.0),
                    "end" => Some(1.0),
                    _ => None,
                };
                if let Some(to) = to {
                    change(to, window, cx);
                    cx.stop_propagation();
                }
            })
            .child(bar);
        track = match self.width {
            Some(w) => track.w(px(w)),
            None => track.w_full(),
        };
        accessible(self.id.clone(), Role::Slider, track).label(self.label).value(self.says).focus(&focus)
    }
}

impl Ui {
    /// A slider at `value` (0 to 1).
    pub fn slider(&self, id: impl Into<SharedString>, label: impl Into<SharedString>, value: f32) -> Slider {
        Slider {
            ui: *self,
            id: id.into(),
            label: label.into(),
            value,
            says: SharedString::default(),
            step: 0.05,
            width: None,
            on_change: None,
        }
    }
}
