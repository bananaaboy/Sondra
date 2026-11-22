//! The Handy-spiegeln page against the stand-in phone (real FFmpeg): the way in, the connection with its steps,
//! the picture, the mouse and the keyboard going back, the end.

use std::cell::RefCell;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::phone_page::Phase;
use sondra_app::shell::Shell;
use sondra_mirror::adb::Link;
use sondra_mirror::control::{self, KeyAction, Place, TouchAction};
use sondra_mirror::fake::{start, FakeConfig, PhoneHandle};
use sondra_mirror::hid::HID_KEYBOARD_ID;
use sondra_mirror::key::AdbKey;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn ffmpeg() -> Option<std::path::PathBuf> {
    let program = std::env::var_os("SONDRA_FFMPEG").map(|d| std::path::PathBuf::from(d).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })).unwrap_or_else(|| "ffmpeg".into());
    Command::new(&program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| program)
}

fn video(program: &std::path::Path) -> Vec<u8> {
    let out = Command::new(program)
        .args(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=180x320:rate=10", "-frames:v", "20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-f", "h264", "-"])
        .output()
        .unwrap();
    assert!(out.status.success());
    out.stdout
}

fn open<'a>(cx: &'a mut TestAppContext, program: &std::path::Path) -> (Window<'a>, PhoneHandle, sondra_mirror::fake::FakePhone) {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (link, phone, fake) = start(FakeConfig { video: video(program), width: 180, height: 320, ..FakeConfig::default() });
    let cable: Arc<Mutex<Option<Arc<dyn Link>>>> = Arc::new(Mutex::new(Some(link)));
    let program = program.to_path_buf();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        let key = AdbKey::from_pkcs8(include_bytes!("../../sondra-mirror/tests/fixtures/adb-test-key.der")).unwrap();
        shell.phone_with(Arc::new(move |_| cable.lock().unwrap().take().ok_or(sondra_mirror::MirrorError::Disconnected)), key, Some(program));
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1100.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Phone, cx));
    w.draw();
    (w, phone, fake)
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1100.))), move |_, _| view);
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
        for _ in 0..400 {
            self.cx.run_until_parked();
            self.cx.executor().advance_clock(Duration::from_millis(40));
            self.draw();
            if ok(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("waited for {what}: {:?}", self.labels());
    }
}

fn wait_control(phone: &PhoneHandle, what: &str, mut ok: impl FnMut(&[u8]) -> bool) {
    for _ in 0..300 {
        if ok(&phone.control()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("waited for {what}");
}

#[gpui::test]
fn a_phone_is_connected_shown_and_worked_with_mouse_and_keys_and_let_go(cx: &mut TestAppContext) {
    let Some(program) = ffmpeg() else { return };
    let (mut w, phone, _fake) = open(cx, &program);
    assert!(w.tree().find(Role::Heading, "Handy spiegeln").is_some());
    // The five steps stand there; nothing is connected until the person says so.
    assert!(w.said("Entwickleroptionen einschalten") && w.said("Zulassen"));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.phone_phase()), Phase::Idle);
    assert!(w.tree().find(Role::Button, "Handy verbinden").is_some());
    assert!(phone.commands().is_empty());

    w.press(Role::Button, "Handy verbinden");
    w.wait("the picture", |w| w.shell.read_with(w.cx, |s, _| s.phone_has_picture()));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.phone_phase()), Phase::Running);
    assert_eq!(phone.commands().len(), 1, "the server was started once");
    assert!(w.said("Bildschirm von Fake Phone"), "{:?}", w.labels());
    assert!(w.tree().find(Role::Button, "Beenden").is_some());

    // The mouse: a click on the picture is a tap at that place.
    let b = w.shell.read_with(w.cx, |s, _| s.phone_bounds());
    assert!(f32::from(b.size.width) > 100.0 && f32::from(b.size.height) > 100.0, "the screen was measured: {b:?}");
    let at = |fx: f32, fy: f32| point(b.origin.x + b.size.width * fx, b.origin.y + b.size.height * fy);
    // (Events go to the window as it was last drawn for real, not to a picture the test drew by hand.)
    w.cx.run_until_parked();
    let mark = phone.control().len();
    w.cx.simulate_mouse_down(at(0.5, 0.25), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(at(0.5, 0.25), MouseButton::Left, Modifiers::default());
    let place = Place::at(180, 320, 0.5, 0.25);
    let mut want = control::inject_touch(TouchAction::Down, place, 1.0);
    want.extend(control::inject_touch(TouchAction::Up, place, 0.0));
    wait_control(&phone, "the tap", |c| c.len() >= mark + want.len());
    assert_eq!(&phone.control()[mark..mark + want.len()], &want[..]);

    // The right button is „back“.
    w.cx.run_until_parked();
    let mark = phone.control().len();
    w.cx.simulate_mouse_down(at(0.5, 0.5), MouseButton::Right, Modifiers::default());
    let mut back = control::back_or_screen_on(KeyAction::Down);
    back.extend(control::back_or_screen_on(KeyAction::Up));
    wait_control(&phone, "back", |c| c.len() >= mark + back.len());
    assert_eq!(&phone.control()[mark..mark + back.len()], &back[..]);

    // A button of the phone, and the keyboard.
    w.press(Role::Button, "Startbildschirm");
    // A click on the picture takes the keyboard (and the tap goes to the phone, too).
    w.cx.run_until_parked();
    w.cx.simulate_mouse_down(at(0.1, 0.1), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(at(0.1, 0.1), MouseButton::Left, Modifiers::default());
    std::thread::sleep(Duration::from_millis(300));
    let mark = phone.control().len();
    w.cx.simulate_keystrokes("a");
    // (The test window sends the press; the letting go comes with a real keyboard.)
    let key_a = control::uhid_input(HID_KEYBOARD_ID, &[0, 0, 4, 0, 0, 0, 0, 0]);
    wait_control(&phone, "the key", |c| c.len() >= mark + key_a.len());
    assert_eq!(&phone.control()[mark..mark + key_a.len()], &key_a[..]);

    // A window of its own: the page says where the phone is and how it comes back; „Beenden“ closes it too.
    w.press(Role::Button, "In einem eigenen Fenster öffnen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.shell.read_with(w.cx, |s, _| s.phone_window_open()), "the window opened");
    assert!(w.said("Das Handy steht in einem eigenen Fenster."));
    w.press(Role::Button, "Zurück in die Seite");
    w.cx.run_until_parked();
    assert!(!w.shell.read_with(w.cx, |s, _| s.phone_window_open()));
    assert!(w.said("Bildschirm von Fake Phone"), "back in the page");
    w.press(Role::Button, "In einem eigenen Fenster öffnen");
    w.cx.run_until_parked();
    w.draw();

    // The end: by the person, and the phone is let go.
    w.press(Role::Button, "Beenden");
    assert!(!w.shell.read_with(w.cx, |s, _| s.phone_window_open()), "the window goes with it");
    assert!(matches!(w.shell.read_with(w.cx, |s, _| s.phone_phase()), Phase::Ended(_)));
    assert!(w.tree().find(Role::Button, "Handy verbinden").is_some(), "and again");
    let gone = control::uhid_destroy(HID_KEYBOARD_ID);
    wait_control(&phone, "the virtual keyboard taken away", |c| c.ends_with(&gone));
}

#[gpui::test]
fn a_cable_with_no_phone_says_what_to_do(cx: &mut TestAppContext) {
    let Some(program) = ffmpeg() else { return };
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        let key = AdbKey::from_pkcs8(include_bytes!("../../sondra-mirror/tests/fixtures/adb-test-key.der")).unwrap();
        shell.phone_with(Arc::new(|_| Err(sondra_mirror::MirrorError::Usb("Es ist kein Handy angeschlossen, das USB-Debugging anbietet.".into()))), key, Some(program));
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1100.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Phone, cx));
    w.draw();
    w.press(Role::Button, "Handy verbinden");
    w.wait("the answer", |w| matches!(w.shell.read_with(w.cx, |s, _| s.phone_phase()), Phase::Failed(_)));
    assert!(w.said("kein Handy angeschlossen"));
    assert!(w.tree().find(Role::Button, "Handy verbinden").is_some(), "the way is open to try again");
    // After a failure the usual troubles are open, and the library's own words one click away.
    assert!(w.said("Das Handy steht nicht in der Liste."));
    assert!(w.said("Der Zulassen-Dialog kommt nicht."));
    w.press(Role::Button, "Technische Einzelheiten");
    assert!(w.said("Usb("), "the detail is shown");
    w.press(Role::Button, "Wenn es nicht klappt");
    assert!(!w.said("Das Handy steht nicht in der Liste."), "folded away on request");
}
