//! The two wrappers a component author uses.

use std::panic::Location;

use accesskit::Role;
use gpui::{
    AnyElement, App, Bounds, ElementId, FocusHandle, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, SharedString, Window,
};

use crate::hub;
use crate::model::{node_id_for, DefaultAction, NodeInfo};

/// Says what the wrapped element is. Give it the same id every frame.
pub fn accessible(id: impl Into<ElementId>, role: Role, child: impl IntoElement) -> Accessible {
    Accessible {
        id: id.into(),
        child: child.into_any_element(),
        role,
        label: None,
        description: None,
        value: None,
        disabled: false,
        toggled: None,
        selected: None,
        live: false,
        focus: None,
        action: None,
    }
}

pub struct Accessible {
    id: ElementId,
    child: AnyElement,
    role: Role,
    label: Option<SharedString>,
    description: Option<SharedString>,
    value: Option<SharedString>,
    disabled: bool,
    toggled: Option<bool>,
    selected: Option<bool>,
    live: bool,
    focus: Option<FocusHandle>,
    action: Option<DefaultAction>,
}

impl Accessible {
    /// The name a screen reader speaks: what the control does, not how it looks.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// A longer explanation, spoken after the name.
    pub fn description(mut self, text: impl Into<SharedString>) -> Self {
        self.description = Some(text.into());
        self
    }

    /// The current value of a field, slider or readout.
    pub fn value(mut self, value: impl Into<SharedString>) -> Self {
        self.value = Some(value.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// For switches, check boxes and toggle buttons.
    pub fn toggled(mut self, on: bool) -> Self {
        self.toggled = Some(on);
        self
    }

    /// For tabs and list items.
    pub fn selected(mut self, on: bool) -> Self {
        self.selected = Some(on);
        self
    }

    /// Changes to this node are announced without moving the focus (progress, status).
    pub fn live(mut self) -> Self {
        self.live = true;
        self
    }

    /// The keyboard focus of this control, so that assistive technology can move it here
    /// and so that the tree says where it is.
    pub fn focus(mut self, handle: &FocusHandle) -> Self {
        self.focus = Some(handle.clone());
        self
    }

    /// What activation does — the same thing the control's own click handler does.
    /// Without it the control is not offered as activatable: GPUI gives no way to
    /// make a click from outside, so a screen reader's "activate" needs this.
    pub fn on_activate(mut self, action: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.action = Some(std::rc::Rc::new(action));
        self
    }
}

impl IntoElement for Accessible {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for Accessible {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut (),
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let reported = id.is_some_and(|id| {
            let focused = self
                .focus
                .as_ref()
                .is_some_and(|handle| handle.is_focused(window));
            hub::begin_node(
                window,
                cx,
                NodeInfo {
                    id: node_id_for(id),
                    parent: None,
                    role: self.role,
                    label: self.label.clone(),
                    description: self.description.clone(),
                    value: self.value.clone(),
                    bounds,
                    disabled: self.disabled,
                    toggled: self.toggled,
                    selected: self.selected,
                    live: self.live,
                    focus_handle: self.focus.clone(),
                    focused,
                    default_action: self.action.clone(),
                },
            )
        });
        self.child.paint(window, cx);
        if reported {
            hub::end_node(window, cx);
        }
    }
}

/// Wraps the window's root element. It opens the frame for the [`accessible`]
/// elements inside it and closes it when they have all painted, which is the
/// moment the tree of this frame is complete (after the deferred draws, which paint last).
pub fn a11y_root(child: impl IntoElement) -> A11yRoot {
    A11yRoot {
        child: child.into_any_element(),
    }
}

pub struct A11yRoot {
    child: AnyElement,
}

impl IntoElement for A11yRoot {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl gpui::Element for A11yRoot {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        (self.child.request_layout(window, cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut (),
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        hub::begin_frame(window, cx);
        self.child.paint(window, cx);
        // Deferred elements (menus, popovers) paint after the root is done, and a menu a screen reader
        // cannot find is not finished: the tree of this frame is closed once they have all painted.
        window.defer(cx, |window, cx| hub::end_frame(window, cx));
    }
}
