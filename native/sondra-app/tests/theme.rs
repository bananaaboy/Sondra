//! The theme switch in the header: every text field of every page changes with it. A field left out would
//! keep the other theme's colours and could not be read.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts, DARK, LIGHT};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(1280.)), AvailableSpace::Definite(px(900.))), move |_, _| view);
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.seen.borrow().last().unwrap().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn colors(&mut self) -> Vec<sondra_ui::Colors> {
        self.shell.read_with(self.cx, |s, cx| s.field_colors_for_test(cx))
    }
}

#[gpui::test]
fn every_field_follows_the_theme_switch(cx: &mut TestAppContext) {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(1280.), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    let first = w.colors();
    assert!(first.len() >= 16);
    let light = first[0] == LIGHT;
    assert!(first.iter().all(|c| *c == first[0]), "all fields start in one theme");
    w.press(Role::Button, if light { "Dunkles Thema" } else { "Helles Thema" });
    let after = w.colors();
    assert!(after.iter().all(|c| *c == if light { DARK } else { LIGHT }), "every field changed with the switch");
}

fn open_with_memory(cx: &mut TestAppContext, path: std::path::PathBuf) -> Window<'_> {
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_theme_memory(sondra_app::store::FileStore::open(path), cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(1280.), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w
}

#[gpui::test]
fn the_chosen_theme_is_kept_and_taken_again(cx: &mut TestAppContext) {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Thema.json");
    // No choice yet: dark, and nothing written.
    let mut w = open_with_memory(cx, file.clone());
    assert!(w.colors().iter().all(|c| *c == DARK));
    assert!(!file.exists());
    w.press(Role::Button, "Helles Thema");
    assert!(w.colors().iter().all(|c| *c == LIGHT));
    drop(w);
    // A new window with the same file starts light; choosing dark again is kept as well.
    let mut w = open_with_memory(cx, file.clone());
    assert!(w.colors().iter().all(|c| *c == LIGHT), "the choice was not taken");
    w.press(Role::Button, "Dunkles Thema");
    drop(w);
    let mut w = open_with_memory(cx, file.clone());
    assert!(w.colors().iter().all(|c| *c == DARK));
}

#[gpui::test]
fn the_first_start_is_dark_whatever_the_system_says(cx: &mut TestAppContext) {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    // The test window reports a light system; the booth starts with the lights down all the same.
    let dir = tempfile::tempdir().unwrap();
    let mut w = open_with_memory(cx, dir.path().join("Thema.json"));
    assert!(w.colors().iter().all(|c| *c == DARK));
    assert!(w.seen.borrow().last().unwrap().find(Role::Button, "Helles Thema").is_some(), "light is one switch away");
}
