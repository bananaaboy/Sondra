//! A line of a list that can be reached with Tab, opened or chosen with Enter or a click, and that a
//! screen reader finds as a list item with its name and what it says.

use std::rc::Rc;

use gpui::{div, point, prelude::*, px, AnyElement, App, BoxShadow, ElementId, SharedString, Window};
use sondra_a11y::{accessible, Role};
use sondra_ui::{radius, Colors};

pub type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One line of the list that can be reached with Tab and opened with Enter or a click, and that a screen
/// reader finds as a list item with its name and what it says.
#[derive(IntoElement)]
pub struct Line {
    pub colors: Colors,
    pub id: SharedString,
    pub name: SharedString,
    pub says: SharedString,
    pub first: bool,
    /// A tile of a shelf (a column: the picture, then the words) instead of a row of a list.
    pub tile: Option<f32>,
    /// Chosen among several (a file in a folder): tinted, and said in words — a selected item has no way
    /// to be invoked in UI Automation, so the word goes in the description.
    pub selected: bool,
    pub body: Vec<AnyElement>,
    /// Space and Enter go on to the page instead of opening the line (the files of the Ordner page: Space adds the
    /// file to the choice, Enter plays it).
    pub keys_pass: bool,
    pub on_open: Handler,
}

impl RenderOnce for Line {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.colors;
        let focus = window
            .use_keyed_state(ElementId::Name(format!("{}-fokus", self.id).into()), cx, |_, cx| cx.focus_handle().tab_stop(true))
            .read(cx)
            .clone();
        let open = self.on_open.clone();
        let key = self.on_open.clone();
        let passes = self.keys_pass;
        let mut line = div()
            .id(ElementId::Name(format!("{}-bild", self.id).into()))
            .track_focus(&focus)
            .flex()
            .rounded(px(radius::NAV))
            .cursor_pointer()
            .bg(if self.selected { c.panel_mid } else { c.canvas })
            .hover(move |s| s.bg(if self.selected { c.panel_mid } else { c.panel_soft }))
            .focus(move |s| {
                s.shadow(vec![
                    BoxShadow { color: c.ink.into(), offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(4.) },
                    BoxShadow { color: c.canvas.into(), offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.) },
                ])
            })
            .on_click(move |_, window, cx| open(window, cx))
            .on_key_down(move |event, window, cx| {
                if !passes && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key(window, cx);
                    cx.stop_propagation();
                }
            });
        line = match self.tile {
            // A tile: as wide as its column, the picture over the words.
            Some(width) => line.flex_col().gap(px(8.)).w(px(width)).flex_none().p(px(4.)),
            None => {
                let line = line.items_center().gap(px(14.)).px(px(8.)).py(px(10.));
                if self.first {
                    line
                } else {
                    line.border_t_1().border_color(c.line)
                }
            }
        };
        let on_open = self.on_open;
        accessible(ElementId::Name(self.id.clone()), Role::ListItem, line.children(self.body))
            .label(self.name)
            .description(if self.selected { SharedString::from(format!("Ausgewählt. {}", self.says)) } else { self.says })
            .focus(&focus)
            .on_activate(move |window, cx| on_open(window, cx))
    }
}
