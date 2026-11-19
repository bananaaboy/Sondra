//! What hangs below a control: the menu of a group of tabs, the list behind „Mehr“. The one shadow of the
//! design belongs to what really floats above the sheet — this is it. Every part names itself: the
//! popover is a menu with a label, its entries are menu items, the row of tabs is navigation.

use std::rc::Rc;

use gpui::{
    div, point, prelude::*, px, AnyElement, App, BoxShadow, Div, FocusHandle, FontWeight,
    IntoElement, SharedString, Window,
};
use sondra_a11y::{accessible, Role};

use crate::theme::{family, radius, size};
use crate::ui::{focus_ring, key_id, press, Handler, Ui};

/// One entry of a menu: the tool's name, and under it what it does, in one line.
#[derive(IntoElement)]
pub struct MenuItem {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    hint: Option<SharedString>,
    selected: bool,
    on_click: Option<Handler>,
    /// A handle the screen owns, so it can move the focus here when the menu opens.
    focus: Option<FocusHandle>,
}

impl MenuItem {
    pub fn focus_handle(mut self, handle: FocusHandle) -> Self {
        self.focus = Some(handle);
        self
    }
    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for MenuItem {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let focus = match &self.focus {
            Some(handle) => handle.clone(),
            None => window
                .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| {
                    cx.focus_handle().tab_stop(true)
                })
                .read(cx)
                .clone(),
        };
        let mut text = div().flex().flex_col().gap(px(1.)).child(
            div()
                .text_size(px(size::BODY))
                .text_color(c.ink)
                .font_weight(if self.selected {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::NORMAL
                })
                .child(self.label.clone()),
        );
        if let Some(hint) = &self.hint {
            text = text.child(
                div()
                    .text_size(px(size::SMALL))
                    .text_color(c.muted)
                    .line_clamp(1)
                    .child(hint.clone()),
            );
        }
        let visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .flex()
            .items_center()
            .gap(px(10.))
            .px(px(12.))
            .py(px(8.))
            .rounded(px(radius::NAV))
            .font_family(family::SANS)
            .hover(move |s| s.bg(c.panel_soft))
            .focus(move |s| s.shadow(focus_ring(&c)))
            // The chosen entry carries a short bar of ink in the margin, as the chosen tab carries its line.
            .child(
                div()
                    .w(px(3.))
                    .h(px(18.))
                    .rounded(px(radius::PILL))
                    .bg(if self.selected {
                        c.ink
                    } else {
                        gpui::transparent_black().into()
                    }),
            )
            .child(text);
        // Up and Down walk the list, as in every menu.
        let visual = press(visual, self.on_click.clone()).on_key_down(|event, window, cx| {
            match event.keystroke.key.as_str() {
                "down" => {
                    window.focus_next();
                    cx.stop_propagation();
                }
                "up" => {
                    window.focus_prev();
                    cx.stop_propagation();
                }
                _ => {}
            }
        });
        let mut node = accessible(self.id.clone(), Role::MenuItem, visual)
            .label(self.label.clone())
            .selected(self.selected)
            .focus(&focus);
        if let Some(hint) = self.hint {
            node = node.description(hint);
        }
        if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

impl Ui {
    pub fn menu_item(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> MenuItem {
        MenuItem {
            ui: *self,
            id: id.into(),
            label: label.into(),
            hint: None,
            selected,
            on_click: None,
            focus: None,
        }
    }

    /// A card that floats above the sheet and holds menu items; `title` is how a screen reader names it.
    pub fn popover(
        &self,
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        items: impl IntoIterator<Item = AnyElement>,
    ) -> AnyElement {
        let c = self.c;
        let id: SharedString = id.into();
        let card = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(px(8.))
            .min_w(px(260.))
            .rounded(px(radius::CARD))
            .bg(c.raised)
            .border_1()
            .border_color(c.line)
            .shadow(vec![BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.16),
                offset: point(px(0.), px(8.)),
                blur_radius: px(24.),
                spread_radius: px(0.),
            }])
            .children(items);
        accessible(id, Role::Menu, card)
            .label(title)
            .into_any_element()
    }

    /// A named region the screen reader can jump to: the row of tabs is `Navigation`.
    pub fn landmark(
        &self,
        role: Role,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        content: impl IntoElement,
    ) -> AnyElement {
        let id: SharedString = id.into();
        accessible(gpui::ElementId::Name(id.to_string().into()), role, content)
            .label(label)
            .into_any_element()
    }
}
