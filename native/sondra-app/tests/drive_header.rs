//! The Drive button in the header: signed out it offers the sign-in and the click does it (away from the window), signed
//! in it is quiet, a failed sign-in says why, and without a Google client built in there is no button.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

fn open(cx: &mut TestAppContext, drive: Option<sondra_app::drive_hub::Drive>) -> Window<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.drive = drive;
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w
}

fn stand_in(signed: Arc<AtomicBool>, fails: bool) -> sondra_app::drive_hub::Drive {
    let (check, sign) = (signed.clone(), signed);
    sondra_app::drive_hub::Drive {
        api: "http://127.0.0.1:1".into(),
        tokens: Arc::new(sondra_drive::fake::Always),
        configured: true,
        connected: Arc::new(move || check.load(Ordering::SeqCst)),
        sign_in: Arc::new(move || {
            if fails {
                Err("Die Anmeldung bei Google hat zu lange gedauert.".to_string())
            } else {
                sign.store(true, Ordering::SeqCst);
                Ok(())
            }
        }),
    }
}

fn settle(w: &mut Window<'_>, done: impl Fn(&Window<'_>) -> bool) {
    for _ in 0..300 {
        w.cx.run_until_parked();
        w.draw();
        if done(w) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("it did not settle");
}

#[gpui::test]
fn the_header_offers_drive_and_the_click_signs_in_and_it_is_quiet_afterwards(cx: &mut TestAppContext) {
    let signed = Arc::new(AtomicBool::new(false));
    let mut w = open(cx, Some(stand_in(signed.clone(), false)));
    assert!(w.tree().find(Role::Button, "Bei Google Drive anmelden").is_some());
    w.press(Role::Button, "Bei Google Drive anmelden");
    settle(&mut w, |w| w.tree().find(Role::Button, "Google Drive ist verbunden").is_some());
    assert!(signed.load(Ordering::SeqCst));
    assert!(w.tree().find(Role::Button, "Google Drive ist verbunden").unwrap().disabled, "nothing to press once connected");
}

#[gpui::test]
fn a_sign_in_that_fails_says_why_and_can_be_tried_again(cx: &mut TestAppContext) {
    let mut w = open(cx, Some(stand_in(Arc::new(AtomicBool::new(false)), true)));
    w.press(Role::Button, "Bei Google Drive anmelden");
    settle(&mut w, |w| w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("hat zu lange gedauert"))));
}

#[gpui::test]
fn without_a_google_client_there_is_no_drive_button(cx: &mut TestAppContext) {
    let w = open(cx, None);
    assert!(!w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Drive"))));
}
