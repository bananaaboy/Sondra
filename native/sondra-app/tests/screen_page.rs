//! Bildschirm aufnehmen against a test pattern in place of the screen: the choices, the recording with its
//! clock, the end, the file that comes out and the way to play it.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::Ffmpeg;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn open<'a>(cx: &'a mut TestAppContext, out: &std::path::Path) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let out = out.to_path_buf();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.screen_with(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=15"].iter().map(|s| (*s).to_owned()).collect(), out);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Screen, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(900.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn said(&self, needle: &str) -> bool {
        self.labels().iter().any(|l| l.contains(needle))
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn wait(&mut self, what: &str, mut ok: impl FnMut(&mut Window) -> bool) {
        for _ in 0..300 {
            self.cx.run_until_parked();
            self.cx.executor().advance_clock(Duration::from_millis(250));
            self.draw();
            if ok(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        panic!("waited for {what}: {:?}", self.labels());
    }
}

#[gpui::test]
fn the_screen_is_recorded_ended_and_the_file_is_there(cx: &mut TestAppContext) {
    let Some(ffmpeg) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path());
    assert!(w.tree().find(Role::Heading, "Bildschirm aufnehmen").is_some());
    // Nothing runs until it is asked for; the choices are chips, nothing is hidden behind a form.
    assert!(!w.shell.read_with(w.cx, |s, _| s.screen_recording()));
    assert_eq!(w.tree().find(Role::Button, "Ganzer Bildschirm").unwrap().toggled, Some(true));
    w.press(Role::Button, "60");
    assert_eq!(w.tree().find(Role::Button, "60").unwrap().toggled, Some(true));
    w.press(Role::Button, "30");

    w.press(Role::Button, "Aufnahme starten");
    assert!(w.shell.read_with(w.cx, |s, _| s.screen_recording()));
    assert!(w.said("Nimmt auf"), "{:?}", w.labels());
    assert!(w.tree().find(Role::Button, "Aufnahme beenden").is_some());
    std::thread::sleep(Duration::from_millis(1500));
    w.press(Role::Button, "Aufnahme beenden");
    w.wait("the file", |w| !w.shell.read_with(w.cx, |s, _| s.screen_made()).is_empty());
    let made = w.shell.read_with(w.cx, |s, _| s.screen_made());
    assert_eq!(made.len(), 1);
    assert!(made[0].starts_with(tmp.path()) && made[0].extension().is_some_and(|e| e == "mp4"), "{:?}", made[0]);
    let probe = ffmpeg.probe(&made[0]).unwrap();
    assert!(probe.has("video"));
    assert!(probe.duration.unwrap_or(0.0) > 0.8, "{:?}", probe.duration);
    assert!(w.tree().find(Role::Button, "Abspielen").is_some() && w.tree().find(Role::Button, "Im Ordner zeigen").is_some());
    assert!(w.tree().find(Role::Button, "Aufnahme starten").is_some(), "and the next one can begin");
}

#[gpui::test]
fn choosing_a_window_has_to_end_in_a_window(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path());
    w.press(Role::Button, "Ein Fenster");
    // Not on Windows there is no list of windows; the page says so, and no window is chosen, so no start.
    assert!(w.tree().find(Role::Button, "Erneut suchen").is_some());
    let start = w.tree().find(Role::Button, "Aufnahme starten").unwrap().clone();
    assert!(start.disabled, "a window has to be picked first");
    w.press(Role::Button, "Ganzer Bildschirm");
    assert!(!w.tree().find(Role::Button, "Aufnahme starten").unwrap().disabled);
}
