//! The components. Each one is built from the palette of the [`Ui`] it comes from (so a light and a
//! dark window can stand side by side), follows the rules of `DESIGN.md` — flat, no shadow on the sheet,
//! rounded only through the radius tokens — and wraps itself in [`sondra_a11y::accessible`]: a control
//! without a name and a role is not finished.

use std::rc::Rc;

use gpui::{
    div, point, prelude::*, px, AnyElement, App, BoxShadow, Div, ElementId, FocusHandle,
    FontWeight, IntoElement, ParentElement, SharedString, Stateful, Styled, Window,
};
use sondra_a11y::{accessible, Role};

use crate::theme::{family, radius, size, Colors};

/// The palette a part of the interface is drawn in.
#[derive(Clone, Copy)]
pub struct Ui {
    pub c: Colors,
}

pub(crate) type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

pub(crate) fn eid(text: String) -> ElementId {
    ElementId::Name(text.into())
}

pub(crate) fn key_id(id: &SharedString, part: &str) -> ElementId {
    ElementId::Name(format!("{id}-{part}").into())
}

/// A 2 px ring in ink with a 2 px gap to the control — never the system's blue.
pub(crate) fn focus_ring(c: &Colors) -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: c.ink.into(),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(4.),
        },
        BoxShadow {
            color: c.canvas.into(),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: px(2.),
        },
    ]
}

/// Click, and Enter or Space on the focused control, as in every other program.
pub(crate) fn press(visual: Stateful<Div>, handler: Option<Handler>) -> Stateful<Div> {
    let Some(handler) = handler else {
        return visual;
    };
    let on_mouse = handler.clone();
    visual
        .cursor_pointer()
        .on_click(move |_, window, cx| on_mouse(window, cx))
        .on_key_down(move |event, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                handler(window, cx);
                cx.stop_propagation();
            }
        })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ButtonKind {
    /// Filled ink: the one action a section asks for.
    Primary,
    /// Field white with a rule ring.
    Quiet,
    /// A word in running text, underlined.
    Ghost,
}

#[derive(IntoElement)]
pub struct Button {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    kind: ButtonKind,
    small: bool,
    disabled: bool,
    on_click: Option<Handler>,
}

impl Button {
    pub fn primary(mut self) -> Self {
        self.kind = ButtonKind::Primary;
        self
    }
    pub fn ghost(mut self) -> Self {
        self.kind = ButtonKind::Ghost;
        self
    }
    pub fn small(mut self) -> Self {
        self.small = true;
        self
    }
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let focus = window
            .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            })
            .read(cx)
            .clone();
        let (text_size, pad_x, pad_y) = if self.small {
            (size::SMALL, 12.0, 8.0)
        } else {
            (size::BODY, 16.0, 12.0)
        };

        let mut visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .text_size(px(text_size))
            .font_family(family::SANS)
            .font_weight(if self.kind == ButtonKind::Primary {
                FontWeight::SEMIBOLD
            } else {
                FontWeight::NORMAL
            })
            .child(self.label.clone());
        visual = match self.kind {
            ButtonKind::Primary => visual
                .px(px(pad_x))
                .py(px(pad_y))
                .rounded(px(radius::NAV))
                .bg(c.ink)
                .text_color(c.on_ink)
                .hover(move |s| s.bg(c.ink_hover)),
            ButtonKind::Quiet => visual
                .px(px(pad_x))
                .py(px(pad_y))
                .rounded(px(radius::NAV))
                .bg(c.raised)
                .text_color(c.ink)
                .border_1()
                .border_color(c.rule)
                .hover(move |s| s.bg(c.panel_soft)),
            ButtonKind::Ghost => visual
                .text_color(c.ink)
                .border_b_1()
                .border_color(c.rule)
                .hover(move |s| s.border_color(c.ink)),
        };
        visual = visual.focus(move |s| s.shadow(focus_ring(&c)));
        visual = if self.disabled {
            visual.opacity(0.4).cursor_not_allowed()
        } else {
            press(visual, self.on_click.clone())
        };

        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.label.clone())
            .focus(&focus);
        if self.disabled {
            node = node.disabled(true);
        } else if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

/// A filter that is on or off: a kind of file, one of four ratios. On is filled ink, without a ring.
#[derive(IntoElement)]
pub struct Chip {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    selected: bool,
    on_click: Option<Handler>,
}

impl Chip {
    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Chip {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let focus = window
            .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            })
            .read(cx)
            .clone();
        let mut visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .px(px(12.))
            .py(px(6.))
            .rounded(px(radius::PILL))
            .text_size(px(size::SMALL))
            .font_family(family::SANS)
            .child(self.label.clone());
        visual = if self.selected {
            visual
                .bg(c.ink)
                .text_color(c.on_ink)
                .font_weight(FontWeight::SEMIBOLD)
        } else {
            visual
                .bg(c.panel_soft)
                .text_color(c.prose)
                .border_1()
                .border_color(c.line)
                .hover(move |s| s.bg(c.panel_mid))
        };
        visual = press(
            visual.focus(move |s| s.shadow(focus_ring(&c))),
            self.on_click.clone(),
        );

        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.label)
            .toggled(self.selected)
            .focus(&focus);
        if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

/// One tool, as a tile: a tinted field gives it its edge — no frame, no shadow — and the icon sits on a
/// small field of its own that takes the ink on hover.
#[derive(IntoElement)]
pub struct Tile {
    ui: Ui,
    id: SharedString,
    title: SharedString,
    hint: SharedString,
    symbol: SharedString,
    icon: Option<SharedString>,
    on_click: Option<Handler>,
}

impl Tile {
    /// The mark of the tool, from `icons`; it stands in the place of the symbol.
    pub fn icon(mut self, path: Option<SharedString>) -> Self {
        self.icon = path;
        self
    }
    /// One character or short word standing in for the icon, until the icons are drawn.
    pub fn symbol(mut self, symbol: impl Into<SharedString>) -> Self {
        self.symbol = symbol.into();
        self
    }
    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Tile {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        let focus = window
            .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| {
                cx.focus_handle().tab_stop(true)
            })
            .read(cx)
            .clone();
        let visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .group(self.id.clone())
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(16.))
            .rounded(px(radius::CARD))
            .bg(c.panel_soft)
            .hover(move |s| s.bg(c.panel_mid))
            .focus(move |s| s.shadow(focus_ring(&c)))
            .child(
                div()
                    .size(px(36.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(radius::NAV))
                    .bg(c.panel_mid)
                    .text_color(c.ink)
                    .font_family(family::SANS)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(size::BODY))
                    .group_hover(self.id.clone(), move |s| s.bg(c.ink).text_color(c.on_ink))
                    .child(match &self.icon {
                        Some(path) => gpui::svg()
                            .path(path.clone())
                            .size(px(18.))
                            .into_any_element(),
                        None => self.symbol.clone().into_any_element(),
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .font_family(family::SANS)
                    .child(
                        div()
                            .text_size(px(size::BODY))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.ink)
                            .child(self.title.clone()),
                    )
                    // At most two lines: a hint is a hint, not a paragraph.
                    .child(
                        div()
                            .text_size(px(size::SMALL))
                            // `prose`, not `muted`: on a tint `muted` measures Lc 59.3 in the dark theme.
                            .text_color(c.prose)
                            .line_clamp(2)
                            .child(self.hint.clone()),
                    ),
            );
        let visual = press(visual, self.on_click.clone());

        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.title.clone())
            .description(self.hint.clone())
            .focus(&focus);
        if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

/// An entry of the row of tabs: the chosen one is ink, semibold, with a 2 px line under it that rests on
/// the line of the header; the others are prose. It is navigation (`aria-current`), not a `tablist`.
#[derive(IntoElement)]
pub struct Tab {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    selected: bool,
    on_click: Option<Handler>,
    /// A handle the screen owns, so it can give the focus back to this tab when a menu shuts.
    focus: Option<FocusHandle>,
    /// What a screen reader says, when the text on the tab is not it (a small arrow on a group).
    name: Option<SharedString>,
    /// A line a screen reader adds to the name.
    note: Option<SharedString>,
}

impl Tab {
    pub fn accessible_name(mut self, name: impl Into<SharedString>) -> Self {
        self.name = Some(name.into());
        self
    }
    pub fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }
    pub fn focus_handle(mut self, handle: FocusHandle) -> Self {
        self.focus = Some(handle);
        self
    }
    pub fn on_click(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Tab {
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
        let mut visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .px(px(12.))
            .py(px(8.))
            .rounded(px(radius::NAV))
            .text_size(px(size::SMALL))
            .font_family(family::SANS)
            .border_b_2()
            .child(self.label.clone());
        visual = if self.selected {
            visual
                .text_color(c.ink)
                .font_weight(FontWeight::SEMIBOLD)
                .border_color(c.ink)
        } else {
            visual
                .text_color(c.prose)
                .border_color(gpui::transparent_black())
                .hover(move |s| s.bg(c.panel_soft))
        };
        visual = press(
            visual.focus(move |s| s.shadow(focus_ring(&c))),
            self.on_click.clone(),
        );

        // The chosen tab is said in words, not as „selected“: a selectable item is not invocable in UI
        // Automation, and a tab here is navigation — pressing it goes there.
        let mut note = self.note.map(|n| n.to_string());
        if self.selected {
            note = Some(match note {
                Some(n) => format!("Geöffnet. {n}"),
                None => "Geöffnet".into(),
            });
        }
        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.name.unwrap_or(self.label))
            .focus(&focus);
        if let Some(note) = note {
            node = node.description(note);
        }
        if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    /// Something happened, or is as it is.
    Info,
    /// Something needs attention.
    Warning,
    /// Something here does not run locally: the one statement the cool tint is for.
    NotLocal,
}

#[derive(IntoElement)]
pub struct Notice {
    ui: Ui,
    kind: NoticeKind,
    text: SharedString,
}

impl RenderOnce for Notice {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = self.ui.c;
        // A mark in the margin, not a box around the message: `●` for a statement, `!` for a warning.
        let mark = if self.kind == NoticeKind::Warning {
            "!"
        } else {
            "●"
        };
        let mut row = div()
            .flex()
            .gap(px(12.))
            .font_family(family::SANS)
            .text_size(px(size::SMALL))
            .text_color(c.prose)
            .child(
                div()
                    .w(px(14.))
                    .text_color(c.ink)
                    .font_weight(FontWeight::BOLD)
                    .child(mark),
            )
            .child(div().flex_1().child(self.text.clone()));
        if self.kind == NoticeKind::NotLocal {
            row = row
                .p(px(16.))
                .rounded(px(radius::CARD))
                .bg(c.panel_cool)
                .border_2()
                .border_color(c.ink)
                .font_weight(FontWeight::SEMIBOLD);
        }
        let role = if self.kind == NoticeKind::Warning {
            Role::Alert
        } else {
            Role::Status
        };
        accessible(eid(format!("hinweis-{}", self.text)), role, row)
            .label(self.text.clone())
            .value(self.text)
            .live()
    }
}

impl Ui {
    pub fn new(c: Colors) -> Self {
        Self { c }
    }

    pub fn button(&self, id: impl Into<SharedString>, label: impl Into<SharedString>) -> Button {
        Button {
            ui: *self,
            id: id.into(),
            label: label.into(),
            kind: ButtonKind::Quiet,
            small: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn chip(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> Chip {
        Chip {
            ui: *self,
            id: id.into(),
            label: label.into(),
            selected,
            on_click: None,
        }
    }

    pub fn tab(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> Tab {
        Tab {
            ui: *self,
            id: id.into(),
            label: label.into(),
            selected,
            on_click: None,
            focus: None,
            name: None,
            note: None,
        }
    }

    pub fn tile(
        &self,
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        hint: impl Into<SharedString>,
    ) -> Tile {
        Tile {
            ui: *self,
            id: id.into(),
            title: title.into(),
            hint: hint.into(),
            symbol: "·".into(),
            icon: None,
            on_click: None,
        }
    }

    pub fn notice(&self, kind: NoticeKind, text: impl Into<SharedString>) -> Notice {
        Notice {
            ui: *self,
            kind,
            text: text.into(),
        }
    }

    /// The ground of a window or a region: the sheet, in Public Sans, in the colour of running text.
    pub fn sheet(&self) -> Div {
        div()
            .bg(self.c.canvas)
            .text_color(self.c.prose)
            .font_family(family::SANS)
            .text_size(px(size::BODY))
    }

    /// A heading is a heading to a screen reader as well.
    pub fn heading(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("ueberschrift-{text}")),
            Role::Heading,
            div()
                .text_size(px(size::HEADING_SM))
                .font_weight(FontWeight::BOLD)
                .text_color(self.c.ink)
                .line_height(px(size::HEADING_SM * 1.25))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    pub fn display(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("ueberschrift-{text}")),
            Role::Heading,
            div()
                .text_size(px(size::HEADING))
                .font_weight(FontWeight::BOLD)
                .text_color(self.c.ink)
                .line_height(px(size::HEADING * 1.15))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// The heading of a section of a screen: 20 px.
    pub fn subheading(&self, text: impl Into<SharedString>) -> AnyElement {
        self.heading_at(text, size::SUBHEADING, FontWeight::SEMIBOLD, 1.3)
    }

    /// The heading of a group inside a section: body size, semibold.
    pub fn title(&self, text: impl Into<SharedString>) -> AnyElement {
        self.heading_at(text, size::BODY, FontWeight::SEMIBOLD, 1.4)
    }

    fn heading_at(
        &self,
        text: impl Into<SharedString>,
        px_size: f32,
        weight: FontWeight,
        line: f32,
    ) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("ueberschrift-{text}")),
            Role::Heading,
            div()
                .text_size(px(px_size))
                .font_weight(weight)
                .text_color(self.c.ink)
                .line_height(px(px_size * line))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// Running prose: 16 px, at a reading line height.
    pub fn prose(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("text-{text}")),
            Role::Label,
            div()
                .text_color(self.c.prose)
                .line_height(px(size::BODY * 1.55))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// A hint: small and muted.
    pub fn hint(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("hinweis-{text}")),
            Role::Label,
            div()
                .text_size(px(size::SMALL))
                .text_color(self.c.muted)
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// What the machine entered: measured values, file names, timecodes — in the face of entered things.
    pub fn value(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("wert-{text}")),
            Role::Label,
            div()
                .font_family(family::VALUE)
                .text_size(px(size::SMALL))
                .text_color(self.c.prose)
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// The word Sondra, in its own face: a binding promise, not decoration.
    pub fn wordmark(&self) -> AnyElement {
        accessible(
            "wortmarke",
            Role::Label,
            div()
                .font_family(family::WORDMARK)
                .font_weight(FontWeight::LIGHT)
                .text_size(px(25.))
                .text_color(self.c.ink)
                .child("Sondra"),
        )
        .label("Sondra")
        .into_any_element()
    }

    /// The line that opens a section: heavier than the hairline between rows.
    pub fn rule(&self) -> Div {
        div().h(px(1.)).w_full().bg(self.c.rule)
    }

    /// The hairline between rows.
    pub fn line(&self) -> Div {
        div().h(px(1.)).w_full().bg(self.c.line)
    }
}
