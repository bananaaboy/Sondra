//! What one frame says about the screen, and how it becomes an AccessKit tree.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

use accesskit::{Action, Live, Node, NodeId, Rect, Role, Toggled, TreeId, TreeInfo, TreeUpdate};
use gpui::{App, Bounds, FocusHandle, GlobalElementId, Pixels, SharedString, Size, Window};

/// The window itself. Every other node's id has its top bit set, so none is this.
pub const ROOT_ID: NodeId = NodeId(1);

/// What an activation does, when the element says so itself.
pub type DefaultAction = Rc<dyn Fn(&mut Window, &mut App)>;

/// A stable id for an element, from its path of element ids. The same element
/// keeps the same id from frame to frame, which is what lets a screen reader
/// keep its place.
pub fn node_id_for(global: &GlobalElementId) -> NodeId {
    let mut hasher = DefaultHasher::new();
    global.hash(&mut hasher);
    NodeId(hasher.finish() | (1 << 63))
}

#[derive(Clone)]
pub struct NodeInfo {
    pub id: NodeId,
    /// `None`: a child of the window.
    pub parent: Option<NodeId>,
    pub role: Role,
    pub label: Option<SharedString>,
    pub description: Option<SharedString>,
    pub value: Option<SharedString>,
    /// In logical pixels, from the window's top left corner.
    pub bounds: Bounds<Pixels>,
    pub disabled: bool,
    pub toggled: Option<bool>,
    pub selected: Option<bool>,
    /// Announce changes to this node's text without moving the focus.
    pub live: bool,
    pub focus_handle: Option<FocusHandle>,
    pub focused: bool,
    pub default_action: Option<DefaultAction>,
}

/// The accessibility tree of one finished frame.
#[derive(Clone)]
pub struct Snapshot {
    pub title: String,
    pub size: Size<Pixels>,
    pub scale: f32,
    /// In paint order, which is reading order.
    pub nodes: Vec<NodeInfo>,
}

impl Snapshot {
    /// Decides whether anything changed: everything the platform is told, and
    /// nothing it is not (callbacks do not count). Two frames with the same
    /// fingerprint need only one update.
    pub fn fingerprint(&self) -> u64 {
        let mut h = DefaultHasher::new();
        self.title.hash(&mut h);
        self.scale.to_bits().hash(&mut h);
        f32::from(self.size.width).to_bits().hash(&mut h);
        f32::from(self.size.height).to_bits().hash(&mut h);
        for node in &self.nodes {
            node.id.0.hash(&mut h);
            node.parent.map(|p| p.0).hash(&mut h);
            (node.role as u32).hash(&mut h);
            node.label.hash(&mut h);
            node.description.hash(&mut h);
            node.value.hash(&mut h);
            for edge in [
                node.bounds.origin.x,
                node.bounds.origin.y,
                node.bounds.size.width,
                node.bounds.size.height,
            ] {
                f32::from(edge).to_bits().hash(&mut h);
            }
            (
                node.disabled,
                node.toggled,
                node.selected,
                node.live,
                node.focused,
            )
                .hash(&mut h);
            node.focus_handle.is_some().hash(&mut h);
            node.default_action.is_some().hash(&mut h);
        }
        h.finish()
    }

    pub fn node(&self, id: NodeId) -> Option<&NodeInfo> {
        self.nodes.iter().find(|node| node.id == id)
    }

    /// The node of this role with this name — for tests and for finding one's place. When the page and the
    /// navigation both have one (the rack's place „Umwandeln“ beside the page's own button „Umwandeln“),
    /// the one on the page: that is what someone looking for an action means. `find_in_navigation` asks
    /// for the other.
    pub fn find(&self, role: Role, label: &str) -> Option<&NodeInfo> {
        let mut named = self.nodes.iter().filter(|node| {
            node.role == role
                && node
                    .label
                    .as_ref()
                    .is_some_and(|l| AsRef::<str>::as_ref(l) == label)
        });
        let first = named.next()?;
        if !self.in_navigation(first) {
            return Some(first);
        }
        Some(named.find(|node| !self.in_navigation(node)).unwrap_or(first))
    }

    /// The node of this role with this name inside a navigation landmark (the rack).
    pub fn find_in_navigation(&self, role: Role, label: &str) -> Option<&NodeInfo> {
        self.nodes.iter().find(|node| {
            node.role == role
                && node
                    .label
                    .as_ref()
                    .is_some_and(|l| AsRef::<str>::as_ref(l) == label)
                && self.in_navigation(node)
        })
    }

    fn in_navigation(&self, node: &NodeInfo) -> bool {
        let mut at = node.parent;
        while let Some(id) = at {
            let Some(parent) = self.node(id) else { return false };
            if parent.role == Role::Navigation {
                return true;
            }
            at = parent.parent;
        }
        false
    }

    /// The whole tree, ready for AccessKit.
    pub fn to_tree_update(&self) -> TreeUpdate {
        let scale = f64::from(self.scale);
        let px = |value: Pixels| f64::from(f32::from(value)) * scale;
        let rect = |b: &Bounds<Pixels>| Rect {
            x0: px(b.origin.x),
            y0: px(b.origin.y),
            x1: px(b.origin.x + b.size.width),
            y1: px(b.origin.y + b.size.height),
        };

        let mut children: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
        for node in &self.nodes {
            children
                .entry(node.parent.unwrap_or(ROOT_ID))
                .or_default()
                .push(node.id);
        }

        let mut root = Node::new(Role::Window);
        root.set_label(self.title.as_str());
        root.set_bounds(Rect {
            x0: 0.0,
            y0: 0.0,
            x1: px(self.size.width),
            y1: px(self.size.height),
        });
        root.set_children(children.remove(&ROOT_ID).unwrap_or_default());

        let mut nodes = vec![(ROOT_ID, root)];
        let mut focus = ROOT_ID;
        for info in &self.nodes {
            let mut node = Node::new(info.role);
            if let Some(label) = &info.label {
                node.set_label(label.as_ref());
                // Static text is named by its value, not its label: that is where AccessKit
                // (and so UI Automation) takes a Label's name from.
                if info.role == Role::Label && info.value.is_none() {
                    node.set_value(label.as_ref());
                }
            }
            if let Some(description) = &info.description {
                node.set_description(description.as_ref());
            }
            if let Some(value) = &info.value {
                node.set_value(value.as_ref());
            }
            node.set_bounds(rect(&info.bounds));
            if info.disabled {
                node.set_disabled();
            }
            if let Some(on) = info.toggled {
                node.set_toggled(if on { Toggled::True } else { Toggled::False });
            }
            if let Some(on) = info.selected {
                node.set_selected(on);
            }
            if info.live {
                node.set_live(Live::Polite);
            }
            if let Some(kids) = children.remove(&info.id) {
                node.set_children(kids);
            }
            if !info.disabled && info.default_action.is_some() {
                node.add_action(Action::Click);
            }
            if info.focus_handle.is_some() && !info.disabled {
                node.add_action(Action::Focus);
            }
            if info.focused {
                focus = info.id;
            }
            nodes.push((info.id, node));
        }

        TreeUpdate {
            nodes,
            tree: Some(TreeInfo::new(ROOT_ID)),
            tree_id: TreeId::ROOT,
            focus,
        }
    }
}
