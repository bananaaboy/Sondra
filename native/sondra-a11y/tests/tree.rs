//! The accessibility tree of real GPUI frames, drawn in GPUI's test window.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use accesskit::{Action, ActionRequest, NodeId, Toggled, TreeId};
use gpui::{div, point, prelude::*, px, size, AvailableSpace, TestAppContext, VisualTestContext};
use sondra_a11y::{a11y_root, accessible, attach_sink, Role, Snapshot, ROOT_ID};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

fn window(cx: &mut TestAppContext) -> (&mut VisualTestContext, Seen) {
    let seen: Seen = Rc::default();
    let cx = cx.add_empty_window();
    let sink = seen.clone();
    cx.update(|window, cx| {
        attach_sink(window, cx, move |snap| {
            sink.borrow_mut().push(Rc::new(snap.clone()))
        })
    });
    (cx, seen)
}

fn draw(cx: &mut VisualTestContext, play_label: &'static str, muted: bool, on_play: Rc<Cell<u32>>) {
    cx.draw(
        point(px(0.), px(0.)),
        size(
            AvailableSpace::Definite(px(400.)),
            AvailableSpace::Definite(px(300.)),
        ),
        move |_, _| {
            a11y_root(
                div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .child(
                        accessible(
                            "toolbar",
                            Role::Toolbar,
                            div()
                                .flex()
                                .child(
                                    accessible("play", Role::Button, div().w(px(100.)).h(px(40.)))
                                        .label(play_label)
                                        .on_activate(move |_, _| on_play.set(on_play.get() + 1)),
                                )
                                .child(
                                    accessible("mute", Role::Button, div().w(px(100.)).h(px(40.)))
                                        .label("Stumm")
                                        .toggled(muted),
                                ),
                        )
                        .label("Steuerung"),
                    )
                    .child(accessible("title", Role::Label, div().h(px(20.))).label("Frieren")),
            )
        },
    );
}

#[gpui::test]
fn reports_roles_names_bounds_and_who_contains_whom(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    draw(cx, "Abspielen", false, Rc::default());

    let snapshots = seen.borrow();
    let snap = snapshots.last().expect("the first frame is reported");
    let toolbar = snap.find(Role::Toolbar, "Steuerung").expect("toolbar");
    let play = snap.find(Role::Button, "Abspielen").expect("play button");
    let mute = snap.find(Role::Button, "Stumm").expect("mute button");
    let title = snap.find(Role::Label, "Frieren").expect("title");

    assert_eq!(
        toolbar.parent, None,
        "a top-level node belongs to the window"
    );
    assert_eq!(play.parent, Some(toolbar.id));
    assert_eq!(mute.parent, Some(toolbar.id));
    assert_eq!(title.parent, None);

    assert_eq!(
        (play.bounds.origin.x, play.bounds.origin.y),
        (px(0.), px(0.))
    );
    assert_eq!(
        (play.bounds.size.width, play.bounds.size.height),
        (px(100.), px(40.))
    );
    assert_eq!(mute.bounds.origin.x, px(100.), "laid out beside the first");
    assert_eq!(title.bounds.origin.y, px(40.), "below the toolbar");

    let order: Vec<_> = snap
        .nodes
        .iter()
        .map(|n| n.label.as_deref().map(|s| s.to_string()))
        .collect();
    assert_eq!(
        order,
        [
            Some("Steuerung".into()),
            Some("Abspielen".into()),
            Some("Stumm".into()),
            Some("Frieren".into())
        ],
        "paint order is reading order"
    );
}

#[gpui::test]
fn the_accesskit_tree_is_complete_and_consistent(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    draw(cx, "Abspielen", true, Rc::default());
    let update = seen.borrow().last().unwrap().to_tree_update();

    assert_eq!(update.tree_id, TreeId::ROOT);
    assert_eq!(update.tree.as_ref().map(|t| t.root), Some(ROOT_ID));
    assert_eq!(update.focus, ROOT_ID, "nothing focused: the window has it");
    assert_eq!(update.nodes.len(), 5, "the window and four nodes");

    let nodes: std::collections::HashMap<NodeId, &accesskit::Node> =
        update.nodes.iter().map(|(id, n)| (*id, n)).collect();
    // Every child named by a node is in the tree, and every node but the root has exactly one parent.
    let mut parents = std::collections::HashMap::new();
    for (id, node) in &update.nodes {
        for child in node.children() {
            assert!(
                nodes.contains_key(child),
                "child {child:?} of {id:?} is missing"
            );
            assert!(
                parents.insert(*child, *id).is_none(),
                "{child:?} has two parents"
            );
        }
    }
    assert_eq!(parents.len(), 4);

    let root = nodes[&ROOT_ID];
    assert_eq!(root.role(), Role::Window);
    // Static text is named by its value: that is where AccessKit takes a Label's name from.
    let (_, title) = update
        .nodes
        .iter()
        .find(|(_, n)| n.role() == Role::Label)
        .unwrap();
    assert_eq!(title.value(), Some("Frieren"));
    assert_eq!(root.children().len(), 2, "toolbar and title");

    let (play_id, play) = update
        .nodes
        .iter()
        .find(|(_, n)| n.label() == Some("Abspielen"))
        .unwrap();
    assert_eq!(play.role(), Role::Button);
    assert!(play.supports_action(Action::Click), "it has an activation");
    let (_, mute) = update
        .nodes
        .iter()
        .find(|(_, n)| n.label() == Some("Stumm"))
        .unwrap();
    assert!(
        !mute.supports_action(Action::Click),
        "a button that does nothing is not offered as activatable"
    );
    assert_eq!(mute.toggled(), Some(Toggled::True));
    let bounds = play.bounds().expect("bounds");
    // The tree is in physical pixels, which is what the platform wants; GPUI's test window
    // is a 2x display, so 100 x 40 logical pixels are 200 x 80 physical ones.
    let scale = f64::from(seen.borrow().last().unwrap().scale);
    assert_eq!(scale, 2.0);
    assert_eq!(
        (bounds.x0, bounds.y0, bounds.x1, bounds.y1),
        (0.0, 0.0, 100.0 * scale, 40.0 * scale)
    );
    let _ = play_id;
}

#[gpui::test]
fn an_unchanged_frame_is_not_sent_again_but_a_change_is(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    draw(cx, "Abspielen", false, Rc::default());
    draw(cx, "Abspielen", false, Rc::default());
    assert_eq!(seen.borrow().len(), 1, "the same frame twice is one update");

    draw(cx, "Pause", false, Rc::default());
    assert_eq!(seen.borrow().len(), 2);
    let snaps = seen.borrow();
    let before = snaps[0].find(Role::Button, "Abspielen").unwrap();
    let after = snaps[1].find(Role::Button, "Pause").unwrap();
    assert_eq!(
        before.id, after.id,
        "the same control keeps its id, so a screen reader keeps its place"
    );
}

#[gpui::test]
fn activation_runs_the_controls_own_action(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    let pressed = Rc::new(Cell::new(0));
    draw(cx, "Abspielen", false, pressed.clone());
    let target = seen
        .borrow()
        .last()
        .unwrap()
        .find(Role::Button, "Abspielen")
        .unwrap()
        .id;

    let request = |action| ActionRequest {
        action,
        target_tree: TreeId::ROOT,
        target_node: target,
        data: None,
    };
    cx.update(|window, cx| sondra_a11y::run_action(request(Action::Click), window, cx));
    assert_eq!(pressed.get(), 1);

    // A node that is not in the tree, or an action that is not offered, does nothing.
    cx.update(|window, cx| {
        sondra_a11y::run_action(
            ActionRequest {
                target_node: NodeId(42),
                ..request(Action::Click)
            },
            window,
            cx,
        );
        sondra_a11y::run_action(request(Action::Increment), window, cx);
    });
    assert_eq!(pressed.get(), 1);
}

#[gpui::test]
fn the_focused_control_is_the_trees_focus_and_can_be_focused_from_outside(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    let handles: Rc<RefCell<Vec<gpui::FocusHandle>>> = Rc::default();
    let draw_with_focus = |cx: &mut VisualTestContext,
                           handles: Rc<RefCell<Vec<gpui::FocusHandle>>>| {
        cx.draw(
            point(px(0.), px(0.)),
            size(
                AvailableSpace::Definite(px(400.)),
                AvailableSpace::Definite(px(300.)),
            ),
            move |_, cx| {
                if handles.borrow().is_empty() {
                    handles
                        .borrow_mut()
                        .extend([cx.focus_handle(), cx.focus_handle()]);
                }
                let (first, second) = (handles.borrow()[0].clone(), handles.borrow()[1].clone());
                a11y_root(
                    div()
                        .child(
                            accessible("a", Role::TextInput, div().w(px(100.)).h(px(30.)))
                                .label("Suche")
                                .focus(&first),
                        )
                        .child(
                            accessible("b", Role::TextInput, div().w(px(100.)).h(px(30.)))
                                .label("Adresse")
                                .focus(&second),
                        ),
                )
            },
        );
    };

    draw_with_focus(cx, handles.clone());
    let snap = seen.borrow().last().unwrap().clone();
    assert_eq!(snap.to_tree_update().focus, ROOT_ID);
    let second = snap.find(Role::TextInput, "Adresse").unwrap().id;

    // Assistive technology moves the focus to the second field.
    cx.update(|window, cx| {
        sondra_a11y::run_action(
            ActionRequest {
                action: Action::Focus,
                target_tree: TreeId::ROOT,
                target_node: second,
                data: None,
            },
            window,
            cx,
        )
    });
    draw_with_focus(cx, handles.clone());
    let snap = seen.borrow().last().unwrap().clone();
    assert_eq!(
        snap.to_tree_update().focus,
        second,
        "the tree says where the focus is now"
    );
    assert!(snap.find(Role::TextInput, "Adresse").unwrap().focused);
    assert!(!snap.find(Role::TextInput, "Suche").unwrap().focused);
}

#[gpui::test]
fn two_elements_with_one_id_stay_two_nodes(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    cx.draw(
        point(px(0.), px(0.)),
        size(
            AvailableSpace::Definite(px(400.)),
            AvailableSpace::Definite(px(300.)),
        ),
        |_, _| {
            a11y_root(
                div()
                    .child(accessible("same", Role::Button, div().h(px(20.))).label("Eins"))
                    .child(accessible("same", Role::Button, div().h(px(20.))).label("Zwei")),
            )
        },
    );
    let snap = seen.borrow().last().unwrap().clone();
    let ids: std::collections::HashSet<_> = snap.nodes.iter().map(|n| n.id).collect();
    assert_eq!(snap.nodes.len(), 2);
    assert_eq!(ids.len(), 2, "no id is used twice");
}

#[gpui::test]
fn an_accessible_element_outside_a_root_is_ignored_not_a_crash(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    cx.draw(
        point(px(0.), px(0.)),
        size(
            AvailableSpace::Definite(px(400.)),
            AvailableSpace::Definite(px(300.)),
        ),
        |_, _| accessible("lonely", Role::Button, div().h(px(20.))).label("Allein"),
    );
    assert!(seen.borrow().is_empty());
}

#[gpui::test]
fn the_window_title_is_the_windows_name(cx: &mut TestAppContext) {
    let (cx, seen) = window(cx);
    cx.update(|window, cx| sondra_a11y::set_window_title(window, cx, "Sondra · Merkliste"));
    draw(cx, "Abspielen", false, Rc::default());
    let snapshots = seen.borrow();
    let snap = snapshots.last().expect("a frame");
    assert_eq!(snap.title, "Sondra · Merkliste");
    let update = snap.to_tree_update();
    let (_, root) = update.nodes.iter().find(|(id, _)| *id == ROOT_ID).unwrap();
    assert_eq!(root.label(), Some("Sondra · Merkliste"));
}
