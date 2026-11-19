//! The crop rectangle while it is dragged (`dragRect` in `CropOverlay.tsx`). Eight handles and a draggable middle;
//! a new rectangle drawn from a corner; coordinates are fractions of the source, so the rectangle survives a
//! resize and goes to FFmpeg as fractions of `iw`/`ih`. A drag works from the snapshot taken when it began.

use crate::image_ops::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Move,
    N,
    S,
    E,
    W,
    Nw,
    Ne,
    Sw,
    Se,
    /// A rectangle drawn from nothing.
    New,
}

impl Handle {
    pub fn from_name(name: &str) -> Option<Handle> {
        Some(match name {
            "move" => Handle::Move,
            "n" => Handle::N,
            "s" => Handle::S,
            "e" => Handle::E,
            "w" => Handle::W,
            "nw" => Handle::Nw,
            "ne" => Handle::Ne,
            "sw" => Handle::Sw,
            "se" => Handle::Se,
            "new" => Handle::New,
            _ => return None,
        })
    }
    fn has_w(self) -> bool {
        matches!(self, Handle::W | Handle::Nw | Handle::Sw)
    }
    fn has_e(self) -> bool {
        matches!(self, Handle::E | Handle::Ne | Handle::Se)
    }
    fn has_n(self) -> bool {
        matches!(self, Handle::N | Handle::Nw | Handle::Ne)
    }
    fn has_s(self) -> bool {
        matches!(self, Handle::S | Handle::Sw | Handle::Se)
    }
}

/// What a press on the rectangle was: which handle, the rectangle as it was, and where the pointer landed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Drag {
    pub handle: Handle,
    pub start: Rect,
    pub origin_x: f64,
    pub origin_y: f64,
}

/// The smallest crop that still has pixels in it, as a fraction.
pub const MIN: f64 = 0.02;

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// The rectangle after the pointer moved to `(px, py)` (fractions of the source). `ratio` is width over height in
/// pixels, or none for a free crop; `source_aspect` is the source's own width over height.
pub fn drag_rect(drag: &Drag, px: f64, py: f64, ratio: Option<f64>, source_aspect: f64) -> Rect {
    let start = drag.start;
    let (mut x, mut y, mut width, mut height) = (start.x, start.y, start.width, start.height);

    if drag.handle == Handle::Move {
        x = clamp01(start.x + (px - drag.origin_x));
        y = clamp01(start.y + (py - drag.origin_y));
        // Pushing against an edge stops the rectangle rather than shrinking it.
        x = x.min(1.0 - start.width);
        y = y.min(1.0 - start.height);
        return Rect { x, y, width: start.width, height: start.height };
    }

    let handle = if drag.handle == Handle::New { Handle::Se } else { drag.handle };
    // Each edge is moved to the pointer; the opposite edge stays where it is.
    let left = if handle.has_w() { px } else { start.x };
    let right = if handle.has_e() { px } else { start.x + start.width };
    let top = if handle.has_n() { py } else { start.y };
    let bottom = if handle.has_s() { py } else { start.y + start.height };

    if drag.handle == Handle::New {
        x = drag.origin_x.min(px);
        y = drag.origin_y.min(py);
        width = (px - drag.origin_x).abs();
        height = (py - drag.origin_y).abs();
    } else {
        x = left.min(right);
        y = top.min(bottom);
        width = (right - left).abs();
        height = (bottom - top).abs();
    }

    width = width.max(MIN);
    height = height.max(MIN);

    if let Some(ratio) = ratio {
        // The ratio is in pixels, the rectangle is in fractions of the source.
        let wanted = ratio / source_aspect;
        // Grow from whichever dimension the pointer moved further in, so the rectangle follows the hand.
        if width / wanted > height {
            height = width / wanted;
        } else {
            width = height * wanted;
        }
        // Then pull it back inside the frame, keeping the anchored corner put.
        let anchor_right = handle.has_w();
        let anchor_bottom = handle.has_n();
        if width > 1.0 {
            width = 1.0;
            height = width / wanted;
        }
        if height > 1.0 {
            height = 1.0;
            width = height * wanted;
        }
        if anchor_right {
            x = (start.x + start.width).min(1.0) - width;
        }
        if anchor_bottom {
            y = (start.y + start.height).min(1.0) - height;
        }
    }

    x = clamp01(x.min(1.0 - width));
    y = clamp01(y.min(1.0 - height));
    width = width.min(1.0 - x);
    height = height.min(1.0 - y);

    Rect { x, y, width, height }
}
