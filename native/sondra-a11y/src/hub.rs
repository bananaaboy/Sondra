//! The per-window collector: nodes while a frame paints, the finished snapshot
//! afterwards, and the sink that hands it to the platform.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use accesskit::{Action, ActionRequest, NodeId};
use gpui::{App, Global, Window, WindowId};

use crate::model::{NodeInfo, Snapshot};

type Sink = Box<dyn FnMut(&Snapshot)>;

#[derive(Default)]
struct WindowState {
    /// Between `begin_frame` and `end_frame`.
    open: bool,
    nodes: Vec<NodeInfo>,
    stack: Vec<NodeId>,
    used: HashSet<NodeId>,
    last_fingerprint: Option<u64>,
    /// The window's title, as set through [`set_window_title`] (GPUI cannot read it back on Windows).
    title: Option<String>,
    /// The last frame that was sent on, for answering requests from outside.
    current: Option<Rc<Snapshot>>,
    sink: Option<Sink>,
}

#[derive(Default)]
pub(crate) struct Hub {
    windows: HashMap<WindowId, WindowState>,
}

impl Global for Hub {}

fn state<'a>(window: &Window, cx: &'a mut App) -> &'a mut WindowState {
    let id = window.window_handle().window_id();
    cx.default_global::<Hub>().windows.entry(id).or_default()
}

/// Sets the window's title and tells assistive technology: the title is the window's name. Use this
/// rather than `Window::set_window_title`, because GPUI cannot read a title back on every platform.
pub fn set_window_title(window: &mut Window, cx: &mut App, title: &str) {
    window.set_window_title(title);
    state(window, cx).title = Some(title.to_owned());
    window.refresh();
}

/// Gives every changed frame to `sink`, and keeps the latest to answer
/// requests from assistive technology. Replaces an earlier sink.
pub fn attach_sink(window: &mut Window, cx: &mut App, sink: impl FnMut(&Snapshot) + 'static) {
    state(window, cx).sink = Some(Box::new(sink));
    // The first frame has to be painted for the tree to exist at all.
    window.refresh();
}

pub(crate) fn begin_frame(window: &Window, cx: &mut App) {
    let state = state(window, cx);
    state.open = true;
    state.nodes.clear();
    state.stack.clear();
    state.used.clear();
}

pub(crate) fn end_frame(window: &Window, cx: &mut App) {
    let snapshot = {
        let state = state(window, cx);
        if !state.open {
            return;
        }
        state.open = false;
        Snapshot {
            title: state.title.clone().unwrap_or_else(|| window.window_title()),
            size: window.viewport_size(),
            scale: window.scale_factor(),
            nodes: std::mem::take(&mut state.nodes),
        }
    };
    let fingerprint = snapshot.fingerprint();
    let (changed, sink) = {
        let state = state(window, cx);
        let changed = state.last_fingerprint != Some(fingerprint);
        if changed {
            state.last_fingerprint = Some(fingerprint);
        }
        (changed, if changed { state.sink.take() } else { None })
    };
    if !changed {
        return;
    }
    let snapshot = Rc::new(snapshot);
    // The sink may call into the app; it must not run while the state is borrowed.
    if let Some(mut sink) = sink {
        sink(&snapshot);
        state(window, cx).sink = Some(sink);
    }
    state(window, cx).current = Some(snapshot);
}

/// Records one node and makes it the parent of whatever paints next, until
/// [`end_node`]. `None` outside a root: such an element is simply not reported.
pub(crate) fn begin_node(window: &Window, cx: &mut App, mut info: NodeInfo) -> bool {
    let state = state(window, cx);
    if !state.open {
        return false;
    }
    // The same element id twice in one frame must not become one node.
    while !state.used.insert(info.id) {
        info.id = NodeId(info.id.0.wrapping_add(2) | (1 << 63));
    }
    info.parent = state.stack.last().copied();
    state.stack.push(info.id);
    state.nodes.push(info);
    true
}

pub(crate) fn end_node(window: &Window, cx: &mut App) {
    state(window, cx).stack.pop();
}

/// Carries out a request that came from assistive technology. Runs on the UI
/// thread, with the window.
pub fn run_action(request: ActionRequest, window: &mut Window, cx: &mut App) {
    let Some(snapshot) = state(window, cx).current.clone() else {
        return;
    };
    let Some(node) = snapshot.node(request.target_node) else {
        return;
    };
    match request.action {
        Action::Click => {
            if node.disabled {
                return;
            }
            // GPUI offers no way to feed it a mouse click from outside, so a control
            // that can be activated says what activation does (`Accessible::on_activate`).
            if let Some(action) = node.default_action.clone() {
                action(window, cx);
            }
        }
        Action::Focus => {
            if let Some(handle) = &node.focus_handle {
                handle.focus(window);
            }
        }
        _ => {}
    }
}
