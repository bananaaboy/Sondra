//! „Protokoll“: what was done, the newest first, opened from the rack and emptied with „Leeren“.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, TestAppContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

#[gpui::test]
fn what_was_done_is_in_the_protocol_and_can_be_emptied(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("Probe.wav");
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
    let tree = || seen.borrow().last().unwrap().clone();
    let said = |needle: &str| tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)));
    let press = |cx: &mut gpui::VisualTestContext, label: &str| {
        let id = tree().find(Role::Button, label).unwrap_or_else(|| panic!("{label}")).id;
        cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
    };
    draw(cx);
    sondra_app::protocol::clear();
    shell.update(cx, |s, cx| s.session_add(vec![file.clone()], cx));
    draw(cx);
    press(cx, "Protokoll: was Sondra getan hat");
    draw(cx);
    assert!(said("Probe.wav in die Sitzung übernommen"), "the step is written down");
    press(cx, "Leeren");
    draw(cx);
    assert!(said("Noch keine Einträge."));
    press(cx, "Schliessen");
    draw(cx);
    assert!(!said("Noch keine Einträge."));
}
