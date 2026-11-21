//! Motion says where something comes from and that something happened — never decoration (`DESIGN.md`,
//! „Motion“). Three durations, two curves, no springs; entrances only, and a person who asked the system
//! for less motion gets none.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use gpui::{
    px, Animation, AnimationExt, AnyElement, ElementId, IntoElement, ParentElement, Styled,
};

/// Feedback to a press or a hover.
pub const FAST: Duration = Duration::from_millis(130);
/// A change of state: something new arrives.
pub const BASE: Duration = Duration::from_millis(240);
/// A way travelled: a tool coming in from the side of its tab.
pub const SLOW: Duration = Duration::from_millis(420);

static REDUCED: AtomicBool = AtomicBool::new(false);

/// Whether the person asked for less motion: set once from the system's setting.
pub fn set_reduced(reduced: bool) {
    REDUCED.store(reduced, Ordering::Relaxed);
}

pub fn reduced() -> bool {
    REDUCED.load(Ordering::Relaxed)
}

/// `cubic-bezier(x1, y1, x2, y2)` as CSS evaluates it: the y for a given progress of time.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let coord = |a: f32, b: f32, s: f32| {
        let u = 1.0 - s;
        3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
    };
    // The curve is parametrised by s, not by time: find the s whose x is t (bisection is plenty).
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = (lo + hi) / 2.0;
        if coord(x1, x2, mid) < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    coord(y1, y2, (lo + hi) / 2.0)
}

/// `--ease-out`: the default curve of an entrance.
pub fn ease_out(t: f32) -> f32 {
    cubic_bezier(0.22, 0.72, 0.28, 1.0, t)
}

/// `--ease-settle`: exponential, for what travels farther.
pub fn ease_settle(t: f32) -> f32 {
    cubic_bezier(0.16, 1.0, 0.3, 1.0, t)
}

/// How far an entrance has come at `elapsed` of `total`, once it has waited `delay` — `0` until its turn,
/// then the eased progress. Staggered lists use the delay; nothing else does.
pub fn progress(elapsed: f32, total: Duration, delay: Duration, duration: Duration) -> f32 {
    let waited = elapsed * total.as_secs_f32() - delay.as_secs_f32();
    ease_out((waited / duration.as_secs_f32()).clamp(0.0, 1.0))
}

/// Brings an element in: it fades in while travelling `from` (in pixels, x and y) to where it belongs,
/// after `delay`. Keyed by `id`: a new id (another tool, another list) plays it again; the same id once.
pub fn enter<E>(
    element: E,
    id: impl Into<ElementId>,
    from: (f32, f32),
    delay: Duration,
    duration: Duration,
) -> AnyElement
where
    E: Styled + ParentElement + IntoElement + 'static,
{
    if reduced() {
        return element.into_any_element();
    }
    let total = delay + duration;
    element
        .with_animation(id, Animation::new(total), move |element, elapsed| {
            let t = progress(elapsed, total, delay, duration);
            element
                .relative()
                .left(px(from.0 * (1.0 - t)))
                .top(px(from.1 * (1.0 - t)))
                .opacity(t)
        })
        .into_any_element()
}

/// `enter` for what floats (`absolute`): the same way in, but moved by its margins, so its own position
/// stays — `enter` makes an element `relative`, and a layer that was absolute then left the window (the
/// dialogs and the drawer were laid out off-screen, 21.11.2026).
pub fn enter_floating<E>(element: E, id: impl Into<ElementId>, from: (f32, f32), delay: Duration, duration: Duration) -> AnyElement
where
    E: Styled + ParentElement + IntoElement + 'static,
{
    if reduced() {
        return element.into_any_element();
    }
    let total = delay + duration;
    element
        .with_animation(id, Animation::new(total), move |element, elapsed| {
            let t = progress(elapsed, total, delay, duration);
            element.ml(px(from.0 * (1.0 - t))).mt(px(from.1 * (1.0 - t))).opacity(t)
        })
        .into_any_element()
}

/// Only the opacity: a layer that fades in where it is.
pub fn fade<E>(element: E, id: impl Into<ElementId>, duration: Duration) -> AnyElement
where
    E: Styled + ParentElement + IntoElement + 'static,
{
    if reduced() {
        return element.into_any_element();
    }
    element
        .with_animation(id, Animation::new(duration), move |element, elapsed| element.opacity(progress(elapsed, duration, Duration::ZERO, duration)))
        .into_any_element()
}

/// The stagger of a list: 30 ms between neighbours, never more than 240 ms in all.
pub fn stagger(index: usize) -> Duration {
    Duration::from_millis((index as u64 * 30).min(240))
}
