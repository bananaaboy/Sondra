//! A dialog: a card in the middle of a dimmed window, for the one thing that has to be answered before
//! anything else. It names itself (a dialog with a title), takes the focus when it opens, keeps Tab inside
//! it between its first and its last control, shuts with Escape and with a click on the dim, and comes in
//! from a little below (`DESIGN.md`, „Motion“). The one shadow of the design belongs to it, as to a popover.

use std::rc::Rc;

use gpui::{
    deferred, div, point, prelude::*, px, AnyElement, App, BoxShadow, FocusHandle, MouseButton,
    SharedString, Window,
};
use sondra_a11y::{accessible, Role};

use crate::motion;
use crate::theme::{family, radius, size};
use crate::ui::{Handler, Ui};

#[derive(IntoElement)]
pub struct Dialog {
    ui: Ui,
    id: SharedString,
    title: SharedString,
    width: f32,
    body: Vec<AnyElement>,
    actions: Vec<AnyElement>,
    on_close: Option<Handler>,
    first: Option<FocusHandle>,
    last: Option<FocusHandle>,
}

impl Dialog {
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }
    pub fn child(mut self, element: impl IntoElement) -> Self {
        self.body.push(element.into_any_element());
        self
    }
    /// The row of buttons at the foot, the one that answers first.
    pub fn action(mut self, element: impl IntoElement) -> Self {
        self.actions.push(element.into_any_element());
        self
    }
    /// What Escape and a click on the dim do.
    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(handler));
        self
    }
    /// The first and the last control inside it: Tab past the last goes to the first, Shift+Tab before the
    /// first goes to the last — the focus does not leave for the page behind.
    pub fn keeps_focus_between(mut self, first: FocusHandle, last: FocusHandle) -> Self {
        self.first = Some(first);
        self.last = Some(last);
        self
    }
}

impl RenderOnce for Dialog {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let close_dim = self.on_close.clone();
        let close_key = self.on_close.clone();
        let (first, last) = (self.first.clone(), self.last.clone());

        let mut card = div()
            .id(gpui::ElementId::Name(format!("{}-karte", self.id).into()))
            .w(px(self.width))
            .max_w(gpui::relative(0.92))
            .max_h(gpui::relative(0.9))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(16.))
            .p(px(24.))
            .rounded(px(radius::DIALOG))
            .bg(c.raised)
            .border_1()
            .border_color(c.line)
            .font_family(family::SANS)
            .text_size(px(size::BODY))
            .text_color(c.prose)
            .shadow(vec![BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.2),
                offset: point(px(0.), px(12.)),
                blur_radius: px(32.),
                spread_radius: px(0.),
            }])
            // A click on the card is not a click on the dim.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_key_down(move |event, window, cx| match event.keystroke.key.as_str() {
                "escape" => {
                    if let Some(close) = &close_key {
                        close(window, cx);
                    }
                    cx.stop_propagation();
                }
                "tab" => {
                    let shift = event.keystroke.modifiers.shift;
                    if let (Some(first), Some(last)) = (&first, &last) {
                        if !shift && last.is_focused(window) {
                            window.focus(first);
                            cx.stop_propagation();
                        } else if shift && first.is_focused(window) {
                            window.focus(last);
                            cx.stop_propagation();
                        }
                    }
                }
                _ => {}
            })
            .child(self.ui.heading(self.title.clone()))
            .children(self.body);
        if !self.actions.is_empty() {
            card = card.child(div().flex().flex_wrap().items_center().gap(px(10.)).children(self.actions));
        }
        let card = accessible(gpui::ElementId::Name(self.id.clone()), Role::Dialog, card).label(self.title.clone());

        deferred(
            motion::enter(
                div()
                    .id(gpui::ElementId::Name(format!("{}-dunkel", self.id).into()))
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::hsla(0., 0., 0., 0.45))
                    // Nothing behind it is clicked while it is open.
                    .occlude()
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        if let Some(close) = &close_dim {
                            close(window, cx);
                        }
                    })
                    .child(motion::enter(
                        div().child(card),
                        gpui::ElementId::Name(format!("{}-auf", self.id).into()),
                        (0.0, 12.0),
                        std::time::Duration::ZERO,
                        motion::BASE,
                    )),
                gpui::ElementId::Name(format!("{}-dunkel-ein", self.id).into()),
                (0.0, 0.0),
                std::time::Duration::ZERO,
                motion::FAST,
            ),
        )
        .with_priority(30)
    }
}

impl Ui {
    /// A dialog with this title; build it with `child`, `action`, `on_close` and `keeps_focus_between`.
    pub fn dialog(&self, id: impl Into<SharedString>, title: impl Into<SharedString>) -> Dialog {
        Dialog {
            ui: *self,
            id: id.into(),
            title: title.into(),
            width: 520.0,
            body: Vec::new(),
            actions: Vec::new(),
            on_close: None,
            first: None,
            last: None,
        }
    }
}
