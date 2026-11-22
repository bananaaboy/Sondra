//! Files dragged over the window: „Loslassen zum Öffnen“ says it can take them and where they go, and let go of on a
//! tool's page they go into the session and to the tool.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{point, px, size, AvailableSpace, ExternalPaths, FileDropEvent, TestAppContext};
use sondra_a11y::{attach_sink, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

#[gpui::test]
fn files_dragged_over_the_window_are_announced_and_go_to_the_open_tool(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("Aufnahme.wav");
    std::fs::write(&file, b"RIFF").unwrap();
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Rc<RefCell<Vec<Rc<Snapshot>>>> = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(1280.), px(900.)));
    let draw = |cx: &mut gpui::VisualTestContext| {
        let view = shell.clone();
        cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(1280.)), AvailableSpace::Definite(px(900.))), move |_, _| view);
    };
    let said = |needle: &str| seen.borrow().last().unwrap().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)));
    draw(cx);
    shell.update(cx, |s, cx| s.go(Panel::Normalize, cx));
    draw(cx);
    assert!(!said("Loslassen zum Öffnen"), "nothing is said before something is dragged");
    let at = point(px(700.), px(450.));
    cx.simulate_event(FileDropEvent::Entered { position: at, paths: ExternalPaths::default() });
    cx.simulate_event(FileDropEvent::Pending { position: at });
    draw(cx);
    assert!(said("Loslassen zum Öffnen"));
    assert!(said("gehen an „Lautstärke“"), "it says where they go");
    // (The test platform cannot carry paths in a drag; what a drop hands over goes the same way as here.)
    cx.simulate_event(FileDropEvent::Submit { position: at });
    cx.run_until_parked();
    draw(cx);
    assert!(!said("Loslassen zum Öffnen"));
    shell.update(cx, |s, cx| s.dropped(vec![file.clone()], cx));
    cx.run_until_parked();
    assert_eq!(shell.read_with(cx, |s, _| s.session_files()), vec![file]);
    assert_eq!(shell.read_with(cx, |s, _| s.panel()), Panel::Normalize);
}
