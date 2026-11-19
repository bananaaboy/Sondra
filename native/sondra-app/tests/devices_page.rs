//! The Geräte page with two devices of one account on the stand-in for Drive and a real loopback line:
//! this window is one of them, an engine in the test is the other.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::devices_page::Setup;
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::FileStore;
use sondra_devices::engine::{now_ms, Engine, State, Timing};
use sondra_devices::files::{files_to_send, folder_sinks};
use sondra_devices::registry::Hardware;
use sondra_devices::rtc::Config;
use sondra_devices::DeviceKeys;
use sondra_drive::fake::FakeDrive;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn engine(drive: &FakeDrive, name: &str, created: f64) -> Engine {
    Engine::start(
        drive.client(),
        DeviceKeys::generate(),
        name,
        created,
        Hardware { kind: "android".into(), platform: "Android-App".into(), caps: vec!["folder".into(), "text".into()] },
        Config { servers: vec![], loopback: true },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150) },
        false,
        None,
    )
}

fn setup(drive: &FakeDrive) -> Setup {
    let drive = drive.clone();
    Setup {
        configured: true,
        signed_in: Arc::new(|| true),
        sign_in: Arc::new(|| Ok(())),
        start: Arc::new(move || Ok(engine(&drive, "Laptop", now_ms() - 5.0 * 86_400_000.0))),
        forget: Arc::new(|| {}),
    }
}

fn open<'a>(cx: &'a mut TestAppContext, setup: Setup, memory: &std::path::Path, receive: &std::path::Path) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (memory, receive) = (memory.to_path_buf(), receive.to_path_buf());
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_devices(setup, FileStore::open(memory.join("Geraete.json")), cx);
        shell.devices_set_receive_dir(receive);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1400.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Devices, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1400.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn said(&self, needle: &str) -> bool {
        self.labels().iter().any(|l| l.contains(needle))
    }
    /// Lets the world go on (the engines run on their own threads) until the page says so.
    fn wait(&mut self, what: &str, secs: u64, mut ok: impl FnMut(&Self) -> bool) {
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            self.cx.run_until_parked();
            self.shell.update(self.cx, |_, cx| cx.notify());
            self.draw();
            if ok(self) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("gave up waiting: {what}; the page says {:?}", self.labels());
    }
}

fn wait_engine(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("gave up waiting: {what}");
}

#[gpui::test]
fn two_devices_meet_on_the_page_and_files_and_a_text_go_across(cx: &mut TestAppContext) {
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    let (mine, theirs) = (tmp.path().join("hier"), tmp.path().join("dort"));
    std::fs::create_dir_all(&mine).unwrap();
    let mut w = open(cx, setup(&drive), tmp.path(), &mine);
    assert!(w.tree().find(Role::Heading, "Ihre Geräte").is_some());
    // Nothing is connected until the person says so.
    assert!(w.tree().find(Role::Button, "Dieses Gerät verbinden").is_some());
    assert!(w.shell.read_with(w.cx, |s, _| s.devices_snapshot().is_none()));

    let other = engine(&drive, "Handy", now_ms() - 86_400_000.0);
    w.press(Role::Button, "Dieses Gerät verbinden");
    w.wait("the other device is listed", 30, |w| w.said("Handy") && w.tree().find(Role::Button, "Dateien an „Handy“ senden").is_some());
    assert!(w.tree().find(Role::Heading, "Ihre anderen Geräte").is_some());
    assert!(w.tree().find(Role::Button, "Text an „Handy“ senden").is_some());
    assert!(w.said("Laptop"), "this device is shown under its own name");
    let (mine_id, theirs_id) = (
        w.shell.read_with(w.cx, |s, _| s.devices_snapshot().unwrap().me.unwrap()["id"].as_str().unwrap().to_owned()),
        other.snapshot().devices.first().map(|d| d["id"].as_str().unwrap().to_owned()).or_else(|| None),
    );
    wait_engine("the other sees this one", 20, || !other.snapshot().devices.is_empty());
    let theirs_id = theirs_id.unwrap_or_else(|| other.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned());
    let _ = theirs_id;

    // From here to there: asked, accepted on the other side, arrived.
    let file = tmp.path().join("lied.bin");
    std::fs::write(&file, vec![9u8; 700_000]).unwrap();
    let their_id = other.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned();
    w.shell.update(w.cx, |shell, cx| shell.devices_send_paths(&their_id, vec![file.clone()], false, cx));
    wait_engine("the other is asked", 30, || other.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    other.accept(&other.snapshot().transfers[0].id.clone(), folder_sinks(theirs.clone()));
    w.wait("it arrived over there", 40, |w| w.said("ist bei „Handy“ angekommen"));
    assert_eq!(std::fs::metadata(theirs.join("lied.bin")).unwrap().len(), 700_000);

    // From there to here: the page asks; yes; it lands in the folder.
    let back = tmp.path().join("zurueck.bin");
    std::fs::write(&back, vec![3u8; 50_000]).unwrap();
    other.send(&mine_id, files_to_send(&[back]).unwrap());
    w.wait("this device is asked", 30, |w| w.tree().find(Role::Button, "„zurueck.bin“ annehmen").is_some());
    assert!(w.said("„Handy“ möchte „zurueck.bin“ senden"));
    assert!(!mine.join("zurueck.bin").exists(), "nothing is taken before the yes");
    w.press(Role::Button, "„zurueck.bin“ annehmen");
    w.wait("it arrived here", 40, |w| w.said("von „Handy“ ist da"));
    assert_eq!(std::fs::metadata(mine.join("zurueck.bin")).unwrap().len(), 50_000);

    // A no is a no.
    let no = tmp.path().join("nein.bin");
    std::fs::write(&no, b"x").unwrap();
    other.send(&mine_id, files_to_send(&[no]).unwrap());
    w.wait("asked again", 30, |w| w.tree().find(Role::Button, "„nein.bin“ ablehnen").is_some());
    w.press(Role::Button, "„nein.bin“ ablehnen");
    wait_engine("the other hears the no", 20, || other.snapshot().transfers.iter().any(|t| t.state == State::Declined));
    assert!(!mine.join("nein.bin").exists());

    // A link: shown, never opened by itself; a line of text stays text.
    other.send_text(&mine_id, "https://example.org/serie");
    w.wait("the link arrives", 30, |w| w.tree().find(Role::Button, "Link öffnen").is_some());
    assert!(w.said("Text von „Handy“"));
    w.press(Role::Button, "Trennen");
    assert!(w.shell.read_with(w.cx, |s, _| s.devices_snapshot().is_none()), "disconnected: no engine");
    assert!(w.tree().find(Role::Button, "Dieses Gerät verbinden").is_some());
}

#[gpui::test]
fn where_no_google_client_is_set_up_the_page_says_so_and_offers_nothing(cx: &mut TestAppContext) {
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    let mut s = setup(&drive);
    s.configured = false;
    let w = open(cx, s, tmp.path(), tmp.path());
    assert!(w.said("nicht eingerichtet"));
    assert!(w.tree().find(Role::Button, "Dieses Gerät verbinden").is_none());
}
