//! The components. Each one is built from the palette of the [`Ui`] it comes from (so a light and a
//! dark window can stand side by side), at desktop density — controls 28 to 32 px high, 13 to 14 px text —
//! rounded only through the radius tokens, and wraps itself in [`sondra_a11y::accessible`]: a control
//! without a name and a role is not finished. Mint fills exactly one thing per screen: the page's primary
//! action; everything else is a tint of the plate.

use std::rc::Rc;

use gpui::{
    div, point, prelude::*, px, AnyElement, App, BoxShadow, Div, ElementId, FocusHandle,
    FontWeight, IntoElement, ParentElement, SharedString, Stateful, Styled, Window,
};
use sondra_a11y::{accessible, Role};

use crate::theme::{family, radius, size, Colors};

/// The reading measure of running text: about 70 characters of 14 px Barlow.
pub const MEASURE: f32 = 640.0;

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

/// The one shadow of the window, for what floats over the plate: a menu, a dialog, a floating bar. Soft
/// and offset downward, as a thing held a little above a lit surface.
pub fn float_shadow() -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: gpui::hsla(0., 0., 0., 0.28),
            offset: point(px(0.), px(12.)),
            blur_radius: px(32.),
            spread_radius: px(-4.),
        },
        BoxShadow {
            color: gpui::hsla(0., 0., 0., 0.18),
            offset: point(px(0.), px(2.)),
            blur_radius: px(6.),
            spread_radius: px(0.),
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
        .on_click(move |_, window, cx| {
            // A control inside a clickable row (the step forward on a line of the list) is clicked alone.
            cx.stop_propagation();
            on_mouse(window, cx)
        })
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
    /// A soft tint with a hairline edge.
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
    /// What a screen reader says, when the text on the button is not enough on its own („+1“).
    name: Option<SharedString>,
    /// A handle the screen owns, so it can give this button the focus (the safe answer of a dialog).
    focus: Option<FocusHandle>,
}

impl Button {
    /// A focus handle the screen owns.
    pub fn focus_handle(mut self, handle: FocusHandle) -> Self {
        self.focus = Some(handle);
        self
    }
    /// The name a screen reader reads instead of the text on the button.
    pub fn accessible_name(mut self, name: impl Into<SharedString>) -> Self {
        self.name = Some(name.into());
        self
    }
    pub fn primary(mut self) -> Self {
        self.kind = ButtonKind::Primary;
        self
    }
    /// Primary only while `on`: the way in is the page's one action until there is something to run.
    pub fn primary_when(mut self, on: bool) -> Self {
        if on {
            self.kind = ButtonKind::Primary;
        }
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
        let focus = match &self.focus {
            Some(handle) => handle.clone(),
            None => window
                .use_keyed_state(key_id(&self.id, "fokus"), cx, |_, cx| {
                    cx.focus_handle().tab_stop(true)
                })
                .read(cx)
                .clone(),
        };
        let (text_size, pad_x, height) = if self.small {
            (size::SMALL, 10.0, 28.0)
        } else {
            (size::BODY, 14.0, 32.0)
        };

        let mut visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .text_size(px(text_size))
            .font_family(family::SANS)
            .font_weight(if self.kind == ButtonKind::Primary {
                FontWeight::SEMIBOLD
            } else {
                FontWeight::MEDIUM
            })
            .whitespace_nowrap()
            .child(self.label.clone());
        visual = match self.kind {
            ButtonKind::Primary => visual
                .flex()
                .items_center()
                .h(px(height))
                .px(px(pad_x))
                .rounded(px(radius::NAV))
                .bg(c.ink)
                .text_color(c.on_ink)
                .hover(move |s| s.bg(c.ink_hover)),
            ButtonKind::Quiet => visual
                .flex()
                .items_center()
                .h(px(height))
                .px(px(pad_x))
                .rounded(px(radius::NAV))
                .bg(c.panel_soft)
                .text_color(c.prose)
                .border_1()
                .border_color(c.line)
                .hover(move |s| s.bg(c.panel_mid).border_color(c.rule)),
            ButtonKind::Ghost => visual
                .flex()
                .items_center()
                .h(px(height))
                .px(px(6.))
                .rounded(px(radius::NAV))
                .text_color(c.ink)
                .hover(move |s| s.bg(c.ink_wash)),
        };
        visual = visual.focus(move |s| s.shadow(focus_ring(&c)));
        visual = if self.disabled {
            visual.opacity(0.4).cursor_not_allowed()
        } else {
            press(visual, self.on_click.clone())
        };

        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.name.clone().unwrap_or_else(|| self.label.clone()))
            .focus(&focus);
        if self.disabled {
            node = node.disabled(true);
        } else if let Some(handler) = self.on_click {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

/// A filter that is on or off: a kind of file, one of four ratios. On is the ink wash with an ink edge and ink text.
#[derive(IntoElement)]
pub struct Chip {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    selected: bool,
    on_click: Option<Handler>,
    /// What a screen reader says, when the text on the chip is not enough on its own („4“ for an episode).
    name: Option<SharedString>,
}

impl Chip {
    /// The name a screen reader reads instead of the text on the chip.
    pub fn accessible_name(mut self, name: impl Into<SharedString>) -> Self {
        self.name = Some(name.into());
        self
    }
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
            .flex()
            .items_center()
            .h(px(28.))
            .px(px(12.))
            .rounded(px(radius::PILL))
            .text_size(px(size::SMALL))
            .font_family(family::SANS)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .border_1()
            .child(self.label.clone());
        // On is the light thinned onto the plate, with the light's own colour for the word — the filled
        // plate is kept for the one action of the page.
        visual = if self.selected {
            visual
                .bg(c.ink_wash)
                .border_color(c.ink)
                .text_color(c.ink)
                .font_weight(FontWeight::SEMIBOLD)
        } else {
            visual
                .bg(c.panel_soft)
                .text_color(c.prose)
                .border_color(c.line)
                .hover(move |s| s.bg(c.panel_mid).border_color(c.rule))
        };
        visual = press(
            visual.focus(move |s| s.shadow(focus_ring(&c))),
            self.on_click.clone(),
        );

        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.name.clone().unwrap_or_else(|| self.label.clone()))
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
            .items_start()
            .gap(px(12.))
            .px(px(14.))
            .py(px(12.))
            .rounded(px(radius::CARD))
            .bg(c.panel_soft)
            // No frame at rest — the tint is the edge; the hover lifts it a step.
            .hover(move |s| s.bg(c.panel_mid))
            .focus(move |s| s.shadow(focus_ring(&c)))
            .child(
                div()
                    .flex_none()
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(radius::NAV))
                    .bg(c.ink_wash)
                    .text_color(c.ink)
                    .font_family(family::SANS)
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(size::BODY))
                    .child(match &self.icon {
                        Some(path) => gpui::svg()
                            .path(path.clone())
                            .size(px(17.))
                            .text_color(c.ink)
                            .into_any_element(),
                        None => self.symbol.clone().into_any_element(),
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .font_family(family::SANS)
                    .child(
                        div()
                            .text_size(px(size::BODY))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(c.prose)
                            .line_height(px(18.))
                            .child(self.title.clone()),
                    )
                    // At most two lines: a hint is a hint, not a paragraph.
                    .child(
                        div()
                            .text_size(px(size::SMALL))
                            // Measured: `muted` on `panel_soft` holds Lc 63.1 in the dark theme.
                            .text_color(c.muted)
                            // No clamp: GPUI's clamp cut the second line off mid-word. A hint is
                            // written short instead, and a row of tiles takes the tallest one's height.
                            .line_height(px(17.))
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
            .flex()
            .items_center()
            .h(px(28.))
            .px(px(12.))
            .rounded(px(radius::NAV))
            .text_size(px(size::SMALL))
            .font_family(family::SANS)
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .child(self.label.clone());
        visual = if self.selected {
            visual
                .bg(c.panel_mid)
                .text_color(c.prose)
                .font_weight(FontWeight::SEMIBOLD)
        } else {
            visual
                .text_color(c.muted)
                .hover(move |s| s.bg(c.panel_soft).text_color(c.prose))
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

/// A place in the rack (the sidebar): a mark and a name, 30 px high. The chosen place is lit — the plate's
/// tint with a small mint dot and the name in prose semibold — the others are muted until hovered. In a
/// narrow window the rack shows the marks alone; the name stays for the screen reader and as a tooltip.
#[derive(IntoElement)]
pub struct RackItem {
    ui: Ui,
    id: SharedString,
    label: SharedString,
    icon: Option<SharedString>,
    selected: bool,
    compact: bool,
    /// Something waits here (new episodes, a device that offers files): a count in the margin.
    count: Option<usize>,
    on_click: Option<Handler>,
    focus: Option<FocusHandle>,
    name: Option<SharedString>,
    disabled: bool,
}

impl RackItem {
    /// Nothing to press here now (Drive already connected): the line only says so, and is not a stop.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
    /// What a screen reader says, when the name on the item is not enough on its own.
    pub fn accessible_name(mut self, name: impl Into<SharedString>) -> Self {
        self.name = Some(name.into());
        self
    }
    pub fn icon(mut self, path: Option<SharedString>) -> Self {
        self.icon = path;
        self
    }
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }
    pub fn count(mut self, count: Option<usize>) -> Self {
        self.count = count.filter(|n| *n > 0);
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

impl RenderOnce for RackItem {
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
        let selected = self.selected;
        let mark = div()
            .flex_none()
            .size(px(18.))
            .flex()
            .items_center()
            .justify_center()
            .text_color(if selected { c.ink } else { c.muted })
            .child(match &self.icon {
                Some(path) => gpui::svg()
                    .path(path.clone())
                    .size(px(16.))
                    .text_color(if selected { c.ink } else { c.muted })
                    .into_any_element(),
                None => div()
                    .size(px(5.))
                    .rounded(px(radius::PILL))
                    .bg(if selected { c.ink } else { c.faint })
                    .into_any_element(),
            });
        let mut visual = div()
            .id(key_id(&self.id, "bild"))
            .track_focus(&focus)
            .relative()
            .flex()
            .items_center()
            .gap(px(10.))
            .h(px(30.))
            .rounded(px(radius::NAV))
            .font_family(family::SANS)
            .text_size(px(size::BODY))
            .whitespace_nowrap()
            .focus(move |s| s.shadow(focus_ring(&c)))
            .child(mark);
        visual = if self.compact {
            visual.w(px(36.)).justify_center()
        } else {
            visual
                .w_full()
                .px(px(10.))
                .child(div().flex_1().min_w_0().overflow_hidden().text_ellipsis().child(self.label.clone()))
        };
        if let Some(n) = self.count {
            let badge = div()
                .flex_none()
                .min_w(px(18.))
                .h(px(18.))
                .px(px(5.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(radius::PILL))
                .bg(c.ink)
                .text_color(c.on_ink)
                .text_size(px(size::MICRO))
                .font_weight(FontWeight::BOLD)
                .child(n.to_string());
            visual = if self.compact {
                visual.child(div().absolute().top(px(-4.)).right(px(-6.)).child(badge))
            } else {
                visual.child(badge)
            };
        }
        visual = if selected {
            visual
                .bg(c.ink_wash)
                .text_color(c.prose)
                .font_weight(FontWeight::SEMIBOLD)
        } else {
            let quiet = visual.text_color(c.muted).font_weight(FontWeight::MEDIUM);
            if self.disabled {
                quiet
            } else {
                quiet.hover(move |s| s.bg(c.panel_soft).text_color(c.prose))
            }
        };
        if self.compact {
            let label = self.label.clone();
            visual = visual.tooltip(move |_, cx| cx.new(|_| TooltipText(label.clone())).into());
        }
        let visual = if self.disabled { visual } else { press(visual, self.on_click.clone()) };
        let mut node = accessible(self.id.clone(), Role::Button, visual)
            .label(self.name.clone().unwrap_or_else(|| self.label.clone()))
            .focus(&focus);
        if self.disabled {
            node = node.disabled(true);
        }
        let mut note: Vec<String> = Vec::new();
        if selected {
            note.push("Geöffnet".into());
        }
        if let Some(n) = self.count {
            note.push(format!("{n} neu"));
        }
        if !note.is_empty() {
            node = node.description(note.join(". "));
        }
        if let (false, Some(handler)) = (self.disabled, self.on_click) {
            node = node.on_activate(move |window, cx| handler(window, cx));
        }
        node
    }
}

/// The name of a place in a narrow rack, shown when the pointer rests on its mark.
struct TooltipText(SharedString);

impl Render for TooltipText {
    fn render(&mut self, _window: &mut Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
        let c = crate::theme::DARK;
        div()
            .px(px(8.))
            .py(px(4.))
            .rounded(px(radius::NAV))
            .bg(c.panel_strong)
            .text_color(c.prose)
            .font_family(family::SANS)
            .text_size(px(size::SMALL))
            .child(self.0.clone())
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
                .px(px(14.))
                .py(px(12.))
                .rounded(px(radius::CARD))
                .bg(c.panel_cool)
                .border_1()
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
            name: None,
            focus: None,
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
            name: None,
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

    pub fn rack_item(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> RackItem {
        RackItem {
            ui: *self,
            id: id.into(),
            label: label.into(),
            icon: None,
            selected,
            compact: false,
            count: None,
            on_click: None,
            focus: None,
            name: None,
            disabled: false,
        }
    }

    /// The name over a group of places in the rack: small, semibold, muted — a label, not a page heading.
    pub fn rack_heading(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("rack-gruppe-{text}")),
            Role::Label,
            div()
                .text_size(px(12.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(self.c.muted)
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
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

    /// The ground of a window or a region: the sheet, in Barlow, in the colour of running text.
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
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(self.c.prose)
                .line_height(px(size::HEADING_SM * 1.15))
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
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(self.c.prose)
                .line_height(px(size::HEADING * 1.1))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// The heading of a section of a screen: 17 px.
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
                .text_color(self.c.prose)
                .line_height(px(px_size * line))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// The head of a page: its title, and under it what the page does in a sentence or two, held to a
    /// reading measure (about 70 characters) — on a wide plate a summary ran to 160 characters a line. A
    /// hairline closes it off from the work below.
    pub fn page_head(&self, title: impl Into<SharedString>, summary: impl Into<SharedString>) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .pb(px(20.))
            .border_b_1()
            .border_color(self.c.line)
            .child(self.heading(title))
            .child(div().max_w(px(MEASURE)).child(self.muted_prose(summary)))
            .into_any_element()
    }

    /// Prose a step back: the summary under a title.
    fn muted_prose(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("text-{text}")),
            Role::Label,
            div()
                .text_color(self.c.muted)
                .line_height(px(size::BODY * 1.5))
                .child(text.clone()),
        )
        .label(text)
        .into_any_element()
    }

    /// Running prose: 14 px, at a reading line height.
    pub fn prose(&self, text: impl Into<SharedString>) -> AnyElement {
        let text: SharedString = text.into();
        accessible(
            eid(format!("text-{text}")),
            Role::Label,
            div()
                .max_w(px(MEASURE))
                .text_color(self.c.prose)
                .line_height(px(size::BODY * 1.5))
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
                .text_size(px(26.))
                .text_color(self.c.ink)
                .child("Sondra"),
        )
        .label("Sondra")
        .into_any_element()
    }

    /// The wordmark's initial, for a rack too narrow for the word.
    pub fn wordmark_initial(&self) -> AnyElement {
        accessible(
            "wortmarke",
            Role::Label,
            div()
                .font_family(family::WORDMARK)
                .font_weight(FontWeight::LIGHT)
                .text_size(px(28.))
                .text_color(self.c.ink)
                .child("S"),
        )
        .label("Sondra")
        .into_any_element()
    }

    /// A bar that shows how far something is: the played part in ink on a hairline ground, 4 px high. With
    /// no fraction there is nothing to show but the ground. A screen reader gets the label and the value.
    pub fn bar(&self, id: impl Into<SharedString>, fraction: Option<f32>, label: impl Into<SharedString>) -> AnyElement {
        let id: SharedString = id.into();
        let label: SharedString = label.into();
        let fraction = fraction.map(|f| f.clamp(0.0, 1.0));
        let value = match fraction {
            Some(f) => format!("{} %", (f * 100.0).round() as i32),
            None => "unbekannt".to_string(),
        };
        accessible(
            eid(format!("balken-{id}")),
            Role::ProgressIndicator,
            div()
                .w_full()
                .h(px(4.))
                .rounded(px(radius::PILL))
                .bg(self.c.line)
                .overflow_hidden()
                .child(div().h_full().w(gpui::relative(fraction.unwrap_or(0.0))).bg(self.c.ink)),
        )
        .label(label)
        .value(value)
        .into_any_element()
    }

    /// The line that opens a section. In the booth a section is separated by air and a hairline, so this
    /// is the hairline too.
    pub fn rule(&self) -> Div {
        div().h(px(1.)).w_full().bg(self.c.line)
    }

    /// The hairline between rows.
    pub fn line(&self) -> Div {
        div().h(px(1.)).w_full().bg(self.c.line)
    }
}
