//! The command palette and the overview of keys: Ctrl+K opens a search over what Sondra can do (the start page's search),
//! Enter or a click opens the tool, „?“ shows the keys, and a „?“ typed into a field is only a letter.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

const WIDTH: f32 = 1280.;


struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(900.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
}

fn open(cx: &mut TestAppContext) -> Window<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        Shell::new(window, cx)
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w
}


use sondra_app::nav::Panel;

#[gpui::test]
fn the_palette_finds_by_what_is_wanted_and_opens_the_tool(cx: &mut TestAppContext) {
    let mut w = open(cx);
    assert!(w.tree().find(Role::Dialog, "Befehlspalette").is_none());
    w.shell.update(w.cx, |shell, cx| shell.open_palette(cx));
    w.draw();
    assert!(w.tree().find(Role::Dialog, "Befehlspalette").is_some());
    w.shell.update(w.cx, |shell, cx| shell.palette_type_for_test("untertitel", cx));
    w.draw();
    let hits: Vec<String> = w.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| l.to_string())).filter(|l| l.contains(" — ")).collect();
    assert!(!hits.is_empty(), "something is found for „untertitel“");
    assert!(hits.iter().any(|h| h.to_lowercase().contains("untertitel")), "{hits:?}");
    // Enter in the field takes the first hit; the palette closes and the tool opens.
    w.shell.update(w.cx, |shell, cx| shell.palette_submit(cx));
    w.draw();
    assert!(w.tree().find(Role::Dialog, "Befehlspalette").is_none());
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Subtitles);
}

#[gpui::test]
fn a_click_on_a_hit_opens_that_tool_and_nothing_found_says_so(cx: &mut TestAppContext) {
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| {
        shell.open_palette(cx);
        shell.palette_type_for_test("qqqqzzzz", cx);
    });
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("Dazu fällt Sondra nichts ein"))));
    w.shell.update(w.cx, |shell, cx| shell.palette_type_for_test("mp3", cx));
    w.draw();
    let first = w.tree().nodes.iter().find(|n| n.role == Role::Button && n.label.as_ref().is_some_and(|l| l.contains(" — "))).map(|n| n.label.clone().unwrap().to_string()).expect("a hit for mp3");
    w.press(Role::Button, &first);
    assert!(w.tree().find(Role::Dialog, "Befehlspalette").is_none());
    assert_ne!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Start);
}

#[gpui::test]
fn the_keys_are_on_a_sheet_behind_the_question_mark_and_ctrl_k_opens_the_palette(cx: &mut TestAppContext) {
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.toggle_help(cx));
    w.draw();
    assert!(w.tree().find(Role::Dialog, "Tastenkürzel").is_some());
    let said = |w: &Window<'_>, needle: &str| w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)));
    assert!(said(&w, "Befehlspalette öffnen") && said(&w, "Lesezeichen setzen") && said(&w, "Das Pad auf dieser Taste spielen"));
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Tastenkürzel").is_none());
    // The real keys, on the window.
    w.cx.update(|window, cx| {
        let focus = w.shell.read(cx).focus_for_test();
        window.focus(&focus);
    });
    w.cx.simulate_keystrokes("ctrl-k");
    w.draw();
    assert!(w.tree().find(Role::Dialog, "Befehlspalette").is_some(), "Ctrl+K opens the palette");
}
