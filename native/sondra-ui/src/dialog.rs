//! A dialog: a card in the middle of a dimmed window, for the one thing that has to be answered before
//! anything else. It names itself (a dialog with a title), takes the focus when it opens, keeps Tab inside
//! it between its first and its last control, shuts with Escape and with a click on the dim, and comes in
//! from a little below (`DESIGN.md`, „Motion“). The one shadow of the design belongs to it, as to a popover.

use std::rc::Rc;

use gpui::{
    deferred, div, prelude::*, px, AnyElement, App, FocusHandle, MouseButton,
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
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let close_dim = self.on_close.clone();
        let close_key = self.on_close.clone();
        let close_head = self.on_close.clone();
        let (first, last) = (self.first.clone(), self.last.clone());

        // Sized by the window, not by a wrapper: on a small window the card keeps 16 px to each edge and
        // its body scrolls between a head and a foot that stay.
        let viewport = window.viewport_size();
        let (vw, vh): (f32, f32) = (viewport.width.into(), viewport.height.into());
        let width = self.width.min(vw - 32.0).max(280.0);
        let max_height = (vh - 48.0).max(240.0);

        let mut head = div()
            .flex_none()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(16.))
            .px(px(24.))
            .pt(px(22.))
            .pb(px(14.))
            .child(div().flex_1().min_w_0().child(self.ui.heading_at(self.title.clone(), 22.0, gpui::FontWeight::SEMIBOLD, 1.25)));
        if let Some(close) = close_head {
            let close_button = div()
                .id(gpui::ElementId::Name(format!("{}-zu", self.id).into()))
                .flex_none()
                .size(px(34.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(radius::PILL))
                .text_color(c.muted)
                .cursor_pointer()
                .hover(move |s| s.bg(c.panel_mid).text_color(c.prose))
                .child(gpui::svg().path(crate::icons::ui_icon("schliessen")).size(px(16.)).text_color(c.muted))
                .on_click({
                    let close = close.clone();
                    move |_, window, cx| close(window, cx)
                });
            head = head.child(
                accessible(gpui::ElementId::Name(format!("{}-schliessen", self.id).into()), Role::Button, close_button)
                    .label("Fenster schliessen")
                    .on_activate(move |window, cx| close(window, cx)),
            );
        }
        let body = div()
            .id(gpui::ElementId::Name(format!("{}-inhalt", self.id).into()))
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(16.))
            .px(px(24.))
            .pb(px(if self.actions.is_empty() { 24. } else { 18. }))
            .children(self.body);

        let mut card = div()
            .id(gpui::ElementId::Name(format!("{}-karte", self.id).into()))
            .w(px(width))
            .max_h(px(max_height))
            .flex()
            .flex_col()
            .rounded(px(radius::DIALOG))
            .bg(c.canvas)
            .border_1()
            .border_color(c.plate_edge)
            .font_family(family::SANS)
            .text_size(px(size::BODY))
            .text_color(c.prose)
            .shadow(crate::ui::float_shadow())
            .overflow_hidden()
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
            .child(head)
            .child(body);
        if !self.actions.is_empty() {
            // The foot stays while the body scrolls: a hairline over it, the answers at its right.
            card = card.child(
                div()
                    .flex_none()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_end()
                    .gap(px(10.))
                    .px(px(24.))
                    .py(px(16.))
                    .border_t_1()
                    .border_color(c.line)
                    .bg(c.raised)
                    .children(self.actions),
            );
        }
        let card = accessible(gpui::ElementId::Name(self.id.clone()), Role::Dialog, card).label(self.title.clone());

        deferred(
            motion::fade(
                div()
                    .id(gpui::ElementId::Name(format!("{}-dunkel", self.id).into()))
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::hsla(0., 0., 0., 0.55))
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
                        (0.0, 16.0),
                        std::time::Duration::ZERO,
                        motion::BASE,
                    )),
                gpui::ElementId::Name(format!("{}-dunkel-ein", self.id).into()),
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
            width: 560.0,
            body: Vec::new(),
            actions: Vec::new(),
            on_close: None,
            first: None,
            last: None,
        }
    }
}
