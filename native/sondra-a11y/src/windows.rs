//! Windows: AccessKit's UI Automation provider, on the window GPUI made.
//!
//! AccessKit subclasses the window's procedure itself, so GPUI's own message
//! handling is not touched: `WM_GETOBJECT` (the question "what is in this window?"
//! from a screen reader) is answered from the latest [`Snapshot`], and focus
//! changes of the window are followed by AccessKit.

use std::cell::RefCell;
use std::ffi::c_void;
use std::rc::Rc;

use accesskit::{ActionHandler, ActionRequest, ActivationHandler, TreeUpdate};
use accesskit_windows::{SubclassingAdapter, HWND};
use gpui::{App, Window};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// Gives the tree to a screen reader the first time one asks.
struct Activation {
    latest: Rc<RefCell<Option<TreeUpdate>>>,
}

impl ActivationHandler for Activation {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.latest.borrow().clone()
    }
}

/// Requests from assistive technology may arrive on any thread. They are sent to the
/// UI thread and carried out there.
struct Forward(async_channel::Sender<ActionRequest>);

impl ActionHandler for Forward {
    fn do_action(&mut self, request: ActionRequest) {
        let _ = self.0.try_send(request);
    }
}

pub(crate) fn attach(window: &mut Window, cx: &mut App) {
    let hwnd = match window.window_handle().map(|handle| handle.as_raw()) {
        Ok(RawWindowHandle::Win32(handle)) => HWND(handle.hwnd.get() as *mut c_void),
        _ => return,
    };

    let (sender, receiver) = async_channel::unbounded();
    let latest: Rc<RefCell<Option<TreeUpdate>>> = Rc::default();
    let adapter = Rc::new(RefCell::new(SubclassingAdapter::new(
        hwnd,
        Activation {
            latest: latest.clone(),
        },
        Forward(sender),
    )));

    crate::attach_sink(window, cx, move |snapshot| {
        let update = snapshot.to_tree_update();
        *latest.borrow_mut() = Some(update.clone());
        if let Some(events) = adapter.borrow_mut().update_if_active(|| update) {
            events.raise();
        }
    });

    window
        .spawn(cx, async move |cx| {
            while let Ok(request) = receiver.recv().await {
                if cx
                    .update(|window, cx| crate::run_action(request, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
}
