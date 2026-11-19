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
        let id = self
            .tree()
            .find(role, label)
            .unwrap_or_else(|| panic!("{label} is on the screen"))
            .id;
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
        "the row of tabs is navigation"
    );
    assert!(
        said(&tree, Role::Button, "Start").starts_with("Geöffnet"),
        "the chosen tab says so in words (a selectable item is not invocable in UI Automation)"
    );
    assert!(
        tree.find(Role::Button, "Start")
            .unwrap()
            .default_action
            .is_some(),
        "and it can be pressed"
    );
    assert!(said(&tree, Role::Button, "Ton").contains("Menü mit 6 Werkzeugen"));
    for tab in [
        "Merkliste",
        "Ordner",
        "Abspielen",
        "Herunterladen",
        "Geräte",
    ] {
        assert!(tree.find(Role::Button, tab).is_some(), "{tab}");
    }
    // Two rows of a group at five columns: ten tiles, and the rest behind a button.
    assert!(tree
        .find(Role::Button, "Noch 7 Werkzeuge für Ton")
        .is_some());
}

#[gpui::test]
fn a_group_tab_opens_its_menu_and_a_choice_goes_there(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    assert!(w.tree().find(Role::Menu, "Ton").is_none());
    w.press(Role::Button, "Ton", 1280.);
    let tree = w.tree();
    assert!(
        tree.find(Role::Menu, "Ton").is_some(),
        "the group is a menu"
    );
    for tool in [
        "Ton",
        "Mischen",
        "Spuren trennen",
        "Lautstärke",
        "Zerschneiden",
        "Tonart",
    ] {
        assert!(tree.find(Role::MenuItem, tool).is_some(), "{tool}");
    }
    w.press(Role::MenuItem, "Mischen", 1280.);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Mix);
    let tree = w.tree();
    assert!(
        tree.find(Role::Menu, "Ton").is_none(),
        "a choice shuts the menu"
    );
    assert!(
        tree.find(Role::Button, "Ton · Mischen").is_some(),
        "the group names the tool chosen in it"
    );
    assert!(said(&tree, Role::Button, "Ton · Mischen").starts_with("Geöffnet"));
    assert!(tree.find(Role::Heading, "Mischen").is_some());
    assert!(
        tree.find(Role::Status, "Dieses Werkzeug gibt es in der neuen App noch nicht. In der Windows-App und auf der Website funktioniert es wie gewohnt.").is_some(),
        "a tool that is not built says so"
    );
}

#[gpui::test]
fn escape_shuts_a_menu(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    w.press(Role::Button, "Bearbeiten", 1280.);
    assert!(w.tree().find(Role::Menu, "Bearbeiten").is_some());
    w.cx.simulate_keystrokes("escape");
    w.draw(1280.);
    assert!(w.tree().find(Role::Menu, "Bearbeiten").is_none());
}

#[gpui::test]
fn what_does_not_fit_stands_behind_more_and_nothing_is_lost(cx: &mut TestAppContext) {
    let mut w = open(cx, 700.);
    let tree = w.tree();
    assert!(
        tree.find(Role::Button, "Mehr").is_some(),
        "a narrow window has „Mehr“"
    );
    assert!(
        tree.find(Role::Button, "Start").is_some(),
        "the tasks stay in the row"
    );
    assert!(
        tree.find(Role::Button, "Aufnehmen").is_none(),
        "the tools went behind it"
    );
    w.press(Role::Button, "Mehr", 700.);
    let tree = w.tree();
    assert!(tree.find(Role::Menu, "Weitere Werkzeuge").is_some());
    assert!(
        tree.find(Role::MenuItem, "Mikrofon").is_some(),
        "every tool is still reachable"
    );
    assert!(tree.find(Role::MenuItem, "Umwandeln").is_some());
}

#[gpui::test]
fn the_chosen_tool_is_always_in_the_row(cx: &mut TestAppContext) {
    let mut w = open(cx, 700.);
    w.press(Role::Button, "Mehr", 700.);
    w.press(Role::MenuItem, "Mikrofon", 700.);
    let tree = w.tree();
    assert!(
        tree.find(Role::Button, "Aufnehmen · Mikrofon").is_some(),
        "even in a narrow window the chosen group stays in the row"
    );
}

#[gpui::test]
fn the_rest_of_a_group_unfolds_and_the_search_finds_by_what_people_type(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    assert!(
        w.tree().find(Role::Button, "Ordner durchsehen").is_none(),
        "the way in is not a tile of a group"
    );
    w.press(Role::Button, "Noch 7 Werkzeuge für Ton", 1280.);
    assert!(
        w.tree()
            .find(Role::Button, "Noch 7 Werkzeuge für Ton")
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
fn escape_gives_the_focus_back_to_the_tab_that_opened_the_menu(cx: &mut TestAppContext) {
    let mut w = open(cx, 1280.);
    w.press(Role::Button, "Ton", 1280.);
    assert_eq!(
        focused(&w.tree()),
        "Ton",
        "the first entry of the menu takes the focus"
    );
    w.cx.simulate_keystrokes("escape");
    w.draw(1280.);
    assert!(w.tree().find(Role::Menu, "Ton").is_none());
    assert_eq!(
        focused(&w.tree()),
        "Ton",
        "the tab that opened it has the focus again"
    );
    // Left and Right walk the row.
    w.cx.simulate_keystrokes("right");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Aufnehmen");
    w.cx.simulate_keystrokes("left");
    w.cx.simulate_keystrokes("left");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Bearbeiten");
    w.cx.simulate_keystrokes("enter");
    w.draw(1280.);
    assert!(
        w.tree().find(Role::Menu, "Bearbeiten").is_some(),
        "Enter opens it"
    );
    w.cx.simulate_keystrokes("down");
    w.draw(1280.);
    assert_eq!(focused(&w.tree()), "Video", "Down walks the menu");
}
