//! Sondra's own pictures, drawn from its mark: the five rounded bars of the logo (`public/favicon.svg`). The
//! mark itself, the brand's square; and the bars large, as the picture of a place that has nothing on it yet
//! — they rise in one after the other, like a level meter waking up. Drawn as rounded boxes, so they are
//! sharp at any size and take the theme's colours.

use std::time::Duration;

use gpui::{div, prelude::*, px, AnyElement, FontWeight, SharedString};
use sondra_a11y::{accessible, Role};

use crate::motion;
use crate::theme::{hex, radius, size};
use crate::ui::Ui;

/// The bars of the mark on its 32 × 32 grid: left edge and width; every bar is 3.3 high, 4.5 apart.
const BARS: [(f32, f32); 5] = [(9.0, 13.99), (7.73, 20.95), (4.6, 22.8), (3.33, 20.95), (9.0, 13.99)];

impl Ui {
    /// The mark: white bars on the forest square, as on the program's icon — the same in both themes.
    pub fn mark(&self, side: f32) -> AnyElement {
        let unit = side / 32.0;
        // The bars sit at 78 % around the middle, as in the icon.
        let scale = 0.78;
        let inner = 32.0 * scale;
        let offset = (32.0 - inner) / 2.0;
        let mut square = div()
            .relative()
            .flex_none()
            .size(px(side))
            .rounded(px(7.0 * unit))
            .bg(hex(0x0f3e1c));
        for (n, (x, w)) in BARS.iter().enumerate() {
            let y = 5.35 + 4.5 * n as f32;
            square = square.child(
                div()
                    .absolute()
                    .left(px((offset + x * scale) * unit))
                    .top(px((offset + y * scale) * unit))
                    .w(px(w * scale * unit))
                    .h(px(3.3 * scale * unit))
                    .rounded(px(radius::PILL))
                    .bg(gpui::white()),
            );
        }
        accessible("sondra-zeichen", Role::Image, square).label("Sondra").into_any_element()
    }

    /// The bars of the mark at the size of a picture, in the plate's tints with the middle one lit; they slide
    /// in one after the other. `id` keeps the animation of one place apart from another's.
    pub fn bars_art(&self, id: impl Into<SharedString>, height: f32) -> AnyElement {
        let id: SharedString = id.into();
        let c = self.c;
        let unit = height / 26.0;
        let mut art = div().relative().flex_none().w(px(28.0 * unit)).h(px(height));
        for (n, (x, w)) in BARS.iter().enumerate() {
            let y = 4.5 * n as f32 + 1.0;
            let colour = match n {
                2 => c.ink,
                1 | 3 => c.panel_strong,
                _ => c.panel_mid,
            };
            let bar = div()
                .absolute()
                .left(px((x - 3.33) * unit))
                .top(px(y * unit))
                .w(px(w * unit))
                .h(px(3.3 * unit))
                .rounded(px(radius::PILL))
                .bg(colour);
            art = art.child(motion::enter(
                div().child(bar),
                gpui::ElementId::Name(format!("{id}-balken-{n}").into()),
                (-18.0, 0.0),
                Duration::from_millis(70 * n as u64),
                motion::SLOW,
            ));
        }
        accessible(gpui::ElementId::Name(format!("{id}-bild").into()), Role::Image, art).label("").into_any_element()
    }

    /// A place with nothing on it yet: the bars as its picture, a title and a sentence — and, when given, what
    /// to do about it. On its tint, rounded; it wraps under the picture on a narrow plate.
    pub fn empty(&self, id: impl Into<SharedString>, title: impl Into<SharedString>, text: impl Into<SharedString>, actions: Vec<AnyElement>) -> AnyElement {
        let id: SharedString = id.into();
        let c = self.c;
        let mut words = div()
            .flex_1()
            .min_w(px(220.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.heading_at(title, size::SUBHEADING, FontWeight::SEMIBOLD, 1.3))
            .child(div().max_w(px(520.)).child(self.muted_prose(text)));
        if !actions.is_empty() {
            words = words.child(div().pt(px(6.)).flex().flex_wrap().items_center().gap(px(10.)).children(actions));
        }
        motion::enter(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(28.))
                .px(px(28.))
                .py(px(26.))
                .rounded(px(radius::CARD))
                .bg(c.panel_soft)
                .child(self.bars_art(id.clone(), 92.0))
                .child(words),
            gpui::ElementId::Name(format!("{id}-leer").into()),
            (0.0, 10.0),
            Duration::ZERO,
            motion::BASE,
        )
    }
}
