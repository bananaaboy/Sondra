//! The window in GPUI's test window: what a screen reader finds, and what a click or a key does.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{
    point, prelude::*, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext,
};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

fn open(cx: &mut TestAppContext, width: f32) -> Window<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| {
        attach_sink(window, cx, move |snap| {
            sink.borrow_mut().push(Rc::new(snap.clone()))
        })
    });
    cx.simulate_resize(size(px(width), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw(width);
    w
}

impl Window<'_> {
    fn draw(&mut self, width: f32) {
        let view = self.shell.clone();
        self.cx.draw(
            point(px(0.), px(0.)),
            size(
                AvailableSpace::Definite(px(width)),
                AvailableSpace::Definite(px(900.)),
            ),
            move |_, _| view,
        );
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str, width: f32) {
        let tree = self.tree();
        let id = tree
            .find(role, label)
            .unwrap_or_else(|| panic!("{label} is on the screen"))
            .id;
        self.click(id, width);
    }
    /// A place in the rack, even where the page has a button of the same name.
    fn go(&mut self, label: &str, width: f32) {
        let id = self
            .tree()
            .find_in_navigation(Role::Button, label)
            .unwrap_or_else(|| panic!("{label} is in the rack"))
            .id;
        self.click(id, width);
    }
    fn click(&mut self, id: accesskit::NodeId, width: f32) {
        self.cx.update(|window, cx| {
            run_action(
                ActionRequest {
                    action: Action::Click,
                    target_tree: TreeId::ROOT,
                    target_node: id,
                    data: None,
                },
                window,
                cx,
            )
        });
        self.draw(width);
    }
}

#[gpui::test]
fn the_start_page_has_its_headings_its_tabs_and_its_tiles(cx: &mut TestAppContext) {
    let w = open(cx, 1280.);
    let tree = w.tree();
    assert!(tree.find(Role::Label, "Sondra").is_some());
    assert!(tree
        .find(Role::Heading, "Ton, Video und Bilder bearbeiten")
        .is_some());
    assert!(tree.find(Role::Heading, "Filme und Serien").is_some());
    assert!(tree.find(Role::Heading, "Werkzeuge").is_some());
    for group in ["Ton", "Video", "Bilder", "Für Musik"] {
        assert!(tree.find(Role::Heading, group).is_some(), "{group}");
    }
    assert!(tree.find(Role::Button, "Datei auswählen").is_some());
    assert!(tree.find(Role::Button, "Von Adresse laden").is_some());
    assert!(
        tree.find(Role::Navigation, "Werkzeuge und Aufgaben")
            .is_some(),
        "the rack is navigation"
    );
    assert!(
        placed(&tree, "Start").starts_with("Geöffnet"),
        "the chosen place says so in words (a selectable item is not invocable in UI Automation)"
    );
    assert!(
        tree.find(Role::Button, "Start")
            .unwrap()
            .default_action
            .is_some(),
        "and it can be pressed"
    );
    for tab in [
        "Merkliste",
        "Ordner",
        "Abspielen",
        "Herunterladen",
        "Geräte",
    ] {
        assert!(tree.find(Role::Button, tab).is_some(), "{tab}");
    }
    // Two rows of a group at four columns (the plate beside the rack): eight tiles, the rest behind a button.
    assert!(tree
        .find(Role::Button, "Noch 9 Werkzeuge für Ton")
        .is_some());
}

#[gpui::test]
fn every_place_is_one_click_in_the_rack(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    let tree = w.tree();
    for meta in sondra_app::nav::PANELS.iter() {
        assert!(tree.find_in_navigation(Role::Button, meta.label).is_some(), "{} stands in the rack", meta.label);
    }
    assert!(tree.find(Role::Menu, "Aufnehmen").is_none(), "no menu to open first");
    w.go("Bildschirm", 1280.);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Screen);
    let tree = w.tree();
    assert!(placed(&tree, "Bildschirm").starts_with("Geöffnet"));
    assert!(tree.find(Role::Heading, "Bildschirm aufnehmen").is_some());
    assert!(
        tree.find(Role::Status, "Dieses Werkzeug gibt es in der neuen App noch nicht. In der Windows-App und auf der Website funktioniert es wie gewohnt.").is_none(),
        "the screen recorder is built"
    );
}

#[gpui::test]
fn a_narrow_window_keeps_every_place_by_its_name(cx: &mut TestAppContext) {
    let mut w = open(cx, 760.);
    let tree = w.tree();
    for meta in sondra_app::nav::PANELS.iter() {
        assert!(tree.find_in_navigation(Role::Button, meta.label).is_some(), "{} is still there, as a mark", meta.label);
    }
    assert!(tree.find(Role::Button, "Mehr").is_none(), "nothing stands behind „Mehr“");
    w.go("Mikrofon", 760.);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Mic);
    assert!(placed(&w.tree(), "Mikrofon").starts_with("Geöffnet"));
}

#[gpui::test]
fn the_rest_of_a_group_unfolds_and_the_search_finds_by_what_people_type(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    assert!(
        w.tree().find(Role::Button, "Ordner durchsehen").is_none(),
        "the way in is not a tile of a group"
    );
    w.press(Role::Button, "Noch 9 Werkzeuge für Ton", 1280.);
    assert!(
        w.tree()
            .find(Role::Button, "Noch 9 Werkzeuge für Ton")
            .is_none(),
        "opened whole, the button is gone"
    );

    // Into the search field, by its name, and type.
    let field = w
        .tree()
        .find(Role::TextInput, "Werkzeuge durchsuchen")
        .expect("the search field")
        .id;
    w.cx.update(|window, cx| {
        run_action(
            ActionRequest {
                action: Action::Focus,
                target_tree: TreeId::ROOT,
                target_node: field,
                data: None,
            },
            window,
            cx,
        )
    });
    w.cx.simulate_input("ordner");
    w.draw(1280.);
    let tree = w.tree();
    assert!(tree.find(Role::Button, "Ordner durchsehen").is_some());
    assert!(
        tree.find(Role::Heading, "Für Musik").is_none(),
        "a search replaces the groups"
    );
    w.press(Role::Button, "Ordner durchsehen", 1280.);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Folder);
}

/// What a screen reader adds to the name of a place in the rack.
fn placed(tree: &Snapshot, label: &str) -> String {
    tree.find_in_navigation(Role::Button, label)
        .and_then(|n| n.description.as_ref().map(|d| d.to_string()))
        .unwrap_or_default()
}

fn said(tree: &Snapshot, role: Role, label: &str) -> String {
    tree.find(role, label)
        .and_then(|n| n.description.as_ref().map(|d| d.to_string()))
        .unwrap_or_default()
}

fn focused(tree: &Snapshot) -> String {
    tree.nodes
        .iter()
        .find(|n| n.focused)
        .and_then(|n| n.label.as_ref().map(|l| l.to_string()))
        .unwrap_or_else(|| "(nothing)".into())
}

#[gpui::test]
fn up_and_down_walk_the_rack(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    // The focus on the first place of the rack, the way a screen reader puts it there.
    let start = w.tree().find_in_navigation(Role::Button, "Start").expect("Start in the rack").id;
    w.cx.update(|window, cx| {
        run_action(
            ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: start, data: None },
            window,
            cx,
        )
    });
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Start");
    w.cx.simulate_keystrokes("down");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Merkliste");
    w.cx.simulate_keystrokes("down");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Ordner");
    w.cx.simulate_keystrokes("up");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Merkliste");
    w.cx.simulate_keystrokes("enter");
    w.draw(1280.);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Merkliste, "Enter goes there");
}

#[gpui::test]
fn a_tool_address_on_the_command_line_opens_that_tool(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![std::path::PathBuf::from("#spuren-trennen")], cx));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Stems);
    // A slug nobody knows is the start page, like the website.
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![std::path::PathBuf::from("#gibt-es-nicht")], cx));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Start);
}
