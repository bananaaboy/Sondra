//! The crop rectangle on a picture, drawn and dragged (`CropOverlay.tsx`): four panes of shade around the part
//! that stays, thirds in it, eight handles and a middle to move it; a press outside draws a new one. What a
//! drag does to the rectangle is `sondra_media::crop_drag`, checked against the web editors. Shared by the Bilder
//! and the Video page: each hands in the rectangle and what to do with a press, a move and a release.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{canvas, div, prelude::*, px, AnyElement, App, Bounds, MouseButton, Pixels, Point};
use sondra_media::crop_drag::{Drag, Handle, MIN};
use sondra_media::image_ops::Rect;
use sondra_ui::Colors;

/// How far from a corner or an edge a press still takes hold of the handle, in pixels.
const GRAB: f32 = 10.0;
/// Whether the rectangle is the whole picture: then there is nothing to move, and a press means „draw one“.
pub fn is_full(rect: &Rect) -> bool {
    rect.width >= 0.999 && rect.height >= 0.999
}

/// A place on the picture as fractions of it, from a window place and where the picture was drawn.
pub fn fractions(bounds: Bounds<Pixels>, at: Point<Pixels>) -> Option<(f64, f64)> {
    let (w, h): (f32, f32) = (bounds.size.width.into(), bounds.size.height.into());
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let (x, y): (f32, f32) = ((at.x - bounds.origin.x).into(), (at.y - bounds.origin.y).into());
    Some(((f64::from(x) / f64::from(w)).clamp(0.0, 1.0), (f64::from(y) / f64::from(h)).clamp(0.0, 1.0)))
}

/// What a press at this place takes hold of: a handle of the rectangle, its middle, or nothing (a new one).
pub fn handle_at(rect: &Rect, x: f64, y: f64, width_px: f64, height_px: f64) -> Handle {
    let near = |a: f64, b: f64, size_px: f64| ((a - b).abs() * size_px) <= f64::from(GRAB);
    let (right, bottom) = (rect.x + rect.width, rect.y + rect.height);
    let inside_x = x >= rect.x - f64::from(GRAB) / width_px && x <= right + f64::from(GRAB) / width_px;
    let inside_y = y >= rect.y - f64::from(GRAB) / height_px && y <= bottom + f64::from(GRAB) / height_px;
    if is_full(rect) {
        return Handle::New;
    }
    if inside_x && inside_y {
        let (l, r) = (near(x, rect.x, width_px), near(x, right, width_px));
        let (t, b) = (near(y, rect.y, height_px), near(y, bottom, height_px));
        return match (l, r, t, b) {
            (true, _, true, _) => Handle::Nw,
            (_, true, true, _) => Handle::Ne,
            (true, _, _, true) => Handle::Sw,
            (_, true, _, true) => Handle::Se,
            (true, ..) => Handle::W,
            (_, true, ..) => Handle::E,
            (_, _, true, _) => Handle::N,
            (_, _, _, true) => Handle::S,
            _ if x >= rect.x && x <= right && y >= rect.y && y <= bottom => Handle::Move,
            _ => Handle::New,
        };
    }
    Handle::New
}

/// The start of a drag from a press at `(x, y)`: a new rectangle begins as the smallest one at the press.
pub fn begin(rect: &Rect, x: f64, y: f64, width_px: f64, height_px: f64) -> Drag {
    let handle = handle_at(rect, x, y, width_px, height_px);
    let start = if handle == Handle::New { Rect { x, y, width: MIN, height: MIN } } else { *rect };
    Drag { handle, start, origin_x: x, origin_y: y }
}

/// Handlers for the overlay: a press and a move with the button down (each with where the picture was drawn
/// and where in the window the pointer is), and a release.
pub struct Handlers {
    pub down: Rc<dyn Fn(Bounds<Pixels>, Point<Pixels>, &mut App)>,
    pub drag: Rc<dyn Fn(Bounds<Pixels>, Point<Pixels>, &mut App)>,
    pub up: Rc<dyn Fn(&mut App)>,
}

/// The overlay for a picture drawn in `measure`'s box (the box is measured on every draw). It covers its parent
/// completely, so the parent must be exactly the picture.
pub fn overlay(c: Colors, rect: Rect, measure: Rc<Cell<Bounds<Pixels>>>, handlers: Handlers) -> AnyElement {
    let bounds = measure.clone();
    let pane = |top: f32, left: f32, width: f32, height: f32| {
        div().absolute().top(gpui::relative(top)).left(gpui::relative(left)).w(gpui::relative(width)).h(gpui::relative(height)).bg(c.stage).opacity(0.6)
    };
    let (x, y, w, h) = (rect.x as f32, rect.y as f32, rect.width as f32, rect.height as f32);
    let mut layer = div().id("ausschnitt").absolute().top_0().left_0().size_full().cursor_crosshair();
    layer = layer.child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().top_0().left_0().size_full());
    // Four panes of shade rather than one shadow: the part that stays is unobstructed.
    layer = layer
        .child(pane(0.0, 0.0, 1.0, y))
        .child(pane(y + h, 0.0, 1.0, (1.0 - y - h).max(0.0)))
        .child(pane(y, 0.0, x, h))
        .child(pane(y, x + w, (1.0 - x - w).max(0.0), h));
    let mut frame = div().absolute().top(gpui::relative(y)).left(gpui::relative(x)).w(gpui::relative(w)).h(gpui::relative(h)).border_1().border_color(c.stage_ink);
    // Thirds: the one guide worth drawing unprompted.
    for f in [1.0 / 3.0, 2.0 / 3.0] {
        frame = frame
            .child(div().absolute().top_0().bottom_0().left(gpui::relative(f)).w(px(1.)).bg(c.stage_ink).opacity(0.4))
            .child(div().absolute().left_0().right_0().top(gpui::relative(f)).h(px(1.)).bg(c.stage_ink).opacity(0.4));
    }
    layer = layer.child(frame);
    if !is_full(&rect) {
        for (fx, fy) in [(0.0, 0.0), (0.5, 0.0), (1.0, 0.0), (0.0, 0.5), (1.0, 0.5), (0.0, 1.0), (0.5, 1.0), (1.0, 1.0)] {
            let (hx, hy) = (x + w * fx, y + h * fy);
            layer = layer.child(div().absolute().top(gpui::relative(hy)).left(gpui::relative(hx)).ml(px(-5.)).mt(px(-5.)).w(px(10.)).h(px(10.)).bg(c.stage_ink));
        }
    }
    let (down, drag, up, up_out) = (handlers.down.clone(), handlers.drag.clone(), handlers.up.clone(), handlers.up.clone());
    layer
        .on_mouse_down(MouseButton::Left, {
            let bounds = bounds.clone();
            move |event, _, app| down(bounds.get(), event.position, app)
        })
        .on_mouse_move(move |event, _, app| {
            if event.pressed_button == Some(MouseButton::Left) {
                drag(bounds.get(), event.position, app);
            }
        })
        .on_mouse_up(MouseButton::Left, move |_, _, app| up(app))
        .on_mouse_up_out(MouseButton::Left, move |_, _, app| up_out(app))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: Rect = Rect { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

    #[test]
    fn a_press_takes_hold_of_what_is_under_it() {
        // A picture of 1000 × 500 pixels.
        let at = |x: f64, y: f64| handle_at(&R, x, y, 1000.0, 500.0);
        assert_eq!(at(0.4, 0.4), Handle::Move);
        assert_eq!(at(0.2, 0.2), Handle::Nw);
        assert_eq!(at(0.6, 0.2), Handle::Ne);
        assert_eq!(at(0.2, 0.6), Handle::Sw);
        assert_eq!(at(0.6, 0.6), Handle::Se);
        assert_eq!(at(0.6, 0.4), Handle::E);
        assert_eq!(at(0.2, 0.4), Handle::W);
        assert_eq!(at(0.4, 0.2), Handle::N);
        assert_eq!(at(0.4, 0.6), Handle::S);
        assert_eq!(at(0.9, 0.9), Handle::New);
        // Nine pixels off a corner still takes hold of it; twenty does not.
        assert_eq!(at(0.2 - 9.0 / 1000.0, 0.2), Handle::Nw);
        assert_eq!(at(0.2 - 20.0 / 1000.0, 0.2), Handle::New);
    }

    #[test]
    fn a_rectangle_that_covers_everything_has_nothing_to_hold() {
        let full = Rect { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };
        assert!(is_full(&full));
        assert_eq!(handle_at(&full, 0.5, 0.5, 1000.0, 500.0), Handle::New);
        let drag = begin(&full, 0.3, 0.4, 1000.0, 500.0);
        assert_eq!((drag.handle, drag.start.x, drag.start.y, drag.start.width), (Handle::New, 0.3, 0.4, MIN));
    }

    #[test]
    fn places_are_fractions_of_the_picture() {
        let b = Bounds { origin: gpui::point(px(100.), px(50.)), size: gpui::size(px(400.), px(200.)) };
        assert_eq!(fractions(b, gpui::point(px(300.), px(150.))), Some((0.5, 0.5)));
        assert_eq!(fractions(b, gpui::point(px(0.), px(0.))), Some((0.0, 0.0)), "outside is held at the edge");
        assert_eq!(fractions(Bounds::default(), gpui::point(px(1.), px(1.))), None, "not measured yet");
    }
}
