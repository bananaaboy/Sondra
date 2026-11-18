//! Accessibility for GPUI.
//!
//! GPUI draws every pixel itself and tells the operating system nothing about
//! what is on screen, so a screen reader sees an empty window. This crate adds
//! what is missing, from the outside, without a fork of GPUI:
//!
//! * [`accessible`] wraps an element and says what it *is* (a button, a tab, a
//!   slider …), what it is *called*, and what it does when activated.
//! * [`a11y_root`] wraps the window's root element. While it paints, every
//!   [`accessible`] inside it reports its role, name and bounds; when the frame
//!   is done the result is one [`Snapshot`], the accessibility tree of that frame.
//! * [`set_window_title`] names the window for assistive technology.
//! * [`attach`] hands each changed snapshot to the platform: on Windows,
//!   AccessKit's UI Automation provider. Requests from assistive technology
//!   (activate, focus) come back and are carried out on the UI thread.
//!
//! The rule for the component library built on top: **a component is not done
//! until it is accessible** — every control wraps itself in [`accessible`].
//!
//! Constraints worth knowing: a view drawn with `AnyView::cached` is not painted
//! again while cached, so its nodes would be missing from the tree; do not cache
//! views that hold accessible elements.

mod element;
mod hub;
mod model;
#[cfg(windows)]
mod windows;

pub use accesskit::{Action, ActionRequest, Role};
pub use element::{a11y_root, accessible, A11yRoot, Accessible};
pub use hub::{attach_sink, run_action, set_window_title};
pub use model::{node_id_for, NodeInfo, Snapshot, ROOT_ID};

use gpui::{App, Window};

/// Connects this window to the platform's accessibility API.
///
/// Call it once per window, from the code that owns the window, while it is being
/// created. **On Windows the window must not have been shown yet:** open it with
/// `WindowOptions { show: false, .. }`, call `attach` in the opening closure, then
/// `window.activate_window()` to show it. Returns whether the window is now connected;
/// on a platform without a bridge yet it does nothing and returns `false` ([`attach_sink`] is the
/// hook for testing and for other platforms).
pub fn attach(window: &mut Window, cx: &mut App) -> bool {
    #[cfg(windows)]
    {
        windows::attach(window, cx)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, cx);
        false
    }
}
