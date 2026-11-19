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
use sondra_devices::engine::{now_ms, Engine, PlayItem, State, Timing};
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
        Hardware { kind: "android".into(), platform: "Android-App".into(), caps: vec!["folder".into(), "text".into(), "play".into()] },
        Config { servers: vec![], live: None, loopback: true, deaf: false },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150), ..Timing::default() },
        false,
        None,
    )
}

/// A device whose line can never open, and which calls that „no direct way“ quickly.
fn walled(drive: &FakeDrive, name: &str, created: f64) -> Engine {
    Engine::start(
        drive.client(),
        DeviceKeys::generate(),
        name,
        created,
        Hardware { kind: "android".into(), platform: "Android-App".into(), caps: vec!["folder".into(), "text".into()] },
        Config { servers: vec![], live: None, loopback: true, deaf: true },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150), no_direct_sender: Duration::from_millis(400), no_direct_receiver: Duration::from_millis(600) },
        false,
        None,
    )
}

fn setup_walled(drive: &FakeDrive) -> Setup {
    let mut setup = setup(drive);
    let drive = drive.clone();
    setup.start = Arc::new(move || Ok(walled(&drive, "Laptop", now_ms() - 5.0 * 86_400_000.0)));
    setup
}

fn setup(drive: &FakeDrive) -> Setup {
    let drive = drive.clone();
    Setup {
        configured: true,
        signed_in: Arc::new(|| true),
        sign_in: Arc::new(|| Ok(())),
        start: Arc::new(move || Ok(engine(&drive, "Laptop", now_ms() - 5.0 * 86_400_000.0))),
        forget: Arc::new(|| {}),
        servers: Default::default(),
        keep_servers: Arc::new(|_| {}),
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

    // Wherever the person is, the offer comes to them: on another page a small card asks, and the answer
    // given there is the answer.
    w.shell.update(w.cx, |shell, cx| shell.go(sondra_app::nav::Panel::Merkliste, cx));
    w.draw();
    let card = tmp.path().join("karte.bin");
    std::fs::write(&card, vec![5u8; 20_000]).unwrap();
    other.send(&mine_id, files_to_send(&[card]).unwrap());
    w.wait("the card asks", 30, |w| w.tree().find(Role::Button, "„karte.bin“ annehmen").is_some());
    assert!(w.tree().find(Role::Button, "Zu den Geräten").is_some());
    assert!(!mine.join("karte.bin").exists());
    w.press(Role::Button, "„karte.bin“ annehmen");
    wait_engine("it arrived from the card", 40, || mine.join("karte.bin").exists() && std::fs::metadata(mine.join("karte.bin")).map_or(0, |m| m.len()) == 20_000);
    w.shell.update(w.cx, |shell, cx| shell.go(sondra_app::nav::Panel::Devices, cx));
    w.draw();

    // A link: shown, never opened by itself; a line of text stays text.
    other.send_text(&mine_id, "https://example.org/serie");
    w.wait("the link arrives", 30, |w| w.tree().find(Role::Button, "Link öffnen").is_some());
    assert!(w.said("Text von „Handy“"));
    w.press(Role::Button, "Trennen");
    assert!(w.shell.read_with(w.cx, |s, _| s.devices_snapshot().is_none()), "disconnected: no engine");
    assert!(w.tree().find(Role::Button, "Dieses Gerät verbinden").is_some());
}

#[gpui::test]
fn a_device_asks_this_one_to_play_films_and_offers_one_to_be_played_not_kept(cx: &mut TestAppContext) {
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    // The cache of what is played lies in the test's own folder, not in the person's.
    std::env::set_var("SONDRA_DATA", tmp.path());
    let mine = tmp.path().join("hier");
    std::fs::create_dir_all(&mine).unwrap();
    let mut w = open(cx, setup(&drive), tmp.path(), &mine);
    let other = engine(&drive, "Handy", now_ms() - 86_400_000.0);
    w.press(Role::Button, "Dieses Gerät verbinden");
    w.wait("the other device is listed", 30, |w| w.tree().find(Role::Button, "Dateien an „Handy“ senden").is_some());
    // The phone can play: the button is there.
    assert!(w.tree().find(Role::Button, "Einen Film auf „Handy“ abspielen").is_some());
    wait_engine("the other sees this one", 20, || !other.snapshot().devices.is_empty());
    let mine_id = w.shell.read_with(w.cx, |s, _| s.devices_snapshot().unwrap().me.unwrap()["id"].as_str().unwrap().to_owned());

    // A request to play films in Drive: asked first, nothing starts by itself.
    other.play_on(&mine_id, vec![PlayItem { id: "1AbC-dEf_9xYz".into(), name: "Folge 1.mkv".into(), size: 5000, mime: "video/x-matroska".into() }]);
    w.wait("the card asks", 30, |w| w.said("„Folge 1.mkv“ auf diesem Gerät abspielen?"));
    assert!(w.said("Abspielen von „Handy“"));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Devices);
    // Here Drive is not set up, so the person is told instead of a film starting.
    w.shell.update(w.cx, |shell, _| shell.drive = None);
    w.press(Role::Button, "„Folge 1.mkv“ auf diesem Gerät abspielen");
    w.wait("the answer", 10, |w| w.said("Drive ist hier nicht eingerichtet"));
    assert!(!w.said("auf diesem Gerät abspielen?"), "the card is gone");

    // One film across to be played: asked, said to be kept nowhere, then „Abspielen“ starts it.
    let film = tmp.path().join("film.mp4");
    std::fs::write(&film, vec![1u8; 40_000]).unwrap();
    other.send_to_play(&mine_id, files_to_send(&[film]).unwrap().remove(0));
    w.wait("this device is asked", 30, |w| w.tree().find(Role::Button, "„film.mp4“ annehmen").is_some());
    assert!(w.said("zum Abspielen senden"));
    w.press(Role::Button, "„film.mp4“ annehmen");
    w.wait("it arrived", 40, |w| w.tree().find(Role::Button, "„film.mp4“ abspielen").is_some());
    assert!(!mine.join("film.mp4").exists(), "it is not put in the folder for what arrives");
    let kept = tmp.path().join("Drive-Ablage").join("Weitergegeben");
    assert!(std::fs::read_dir(&kept).unwrap().next().is_some(), "it lies in the cache");
    assert!(w.tree().find(Role::Button, "Im Ordner zeigen").is_none());
    w.press(Role::Button, "„film.mp4“ abspielen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Player);
}

#[gpui::test]
fn the_chosen_films_of_a_drive_folder_can_be_asked_to_play_on_a_device_that_can(cx: &mut TestAppContext) {
    use sondra_merk::folder::{AssetKind, DriveInfo, FolderFile, FolderScan};
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    let mine = tmp.path().join("hier");
    std::fs::create_dir_all(&mine).unwrap();
    let mut w = open(cx, setup(&drive), tmp.path(), &mine);
    let other = engine(&drive, "Handy", now_ms() - 86_400_000.0);
    w.press(Role::Button, "Dieses Gerät verbinden");
    w.wait("the other device is listed", 30, |w| w.tree().find(Role::Button, "Dateien an „Handy“ senden").is_some());
    wait_engine("the other sees this one", 20, || !other.snapshot().devices.is_empty());
    let film = |name: &str, id: &str, kind| FolderFile { path: name.into(), name: name.into(), dir: String::new(), size: 4000, modified: 0, kind, drive: Some(DriveInfo { id: id.into(), mime: "video/mp4".into(), parent: None, hint: None }) };
    let scan = FolderScan { name: "Sondra".into(), files: vec![film("Folge 1.mp4", "1AbC-dEf_9xYz", AssetKind::Video), film("Notiz.txt", "2AbC-dEf_9xYz", AssetKind::Document)], dirs: vec![], truncated: false, drive: true };
    w.shell.update(w.cx, |shell, cx| {
        shell.folder_show_for_test(scan, &[], cx);
        shell.go(Panel::Folder, cx);
    });
    w.draw();
    // Nothing chosen, no button; a film chosen, one button for the phone.
    assert!(w.tree().find(Role::Button, "Auf „Handy“ abspielen").is_none());
    let scan = w.shell.read_with(w.cx, |s, _| s.folder_scan_for_test()).unwrap();
    w.shell.update(w.cx, |shell, cx| shell.folder_show_for_test(scan, &["Folge 1.mp4"], cx));
    w.draw();
    w.press(Role::Button, "Auf „Handy“ abspielen");
    wait_engine("the phone is asked", 30, || other.snapshot().notes.iter().any(|n| n.play.len() == 1 && n.play[0].id == "1AbC-dEf_9xYz"));
    assert!(w.said("An „Handy“ gefragt"));
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

#[gpui::test]
fn an_own_server_is_put_in_checked_and_used_by_the_next_connection_without_showing_the_password(cx: &mut TestAppContext) {
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    let kept: Arc<std::sync::Mutex<Vec<sondra_devices::servers::ServerSettings>>> = Arc::default();
    let mut s = setup(&drive);
    let (servers, record) = (s.servers.clone(), kept.clone());
    s.keep_servers = Arc::new(move |settings| record.lock().unwrap().push(settings.clone()));
    let mut w = open(cx, s, tmp.path(), tmp.path());
    w.press(Role::Button, "Dieses Gerät verbinden");
    w.wait("connected", 30, |w| w.tree().find(Role::Heading, "Ihre anderen Geräte").is_some());

    // Closed until asked for; nothing is built in.
    assert!(w.tree().find(Role::TextInput, "STUN-Server").is_none());
    assert!(servers.lock().unwrap().stun.is_empty() && servers.lock().unwrap().turn.is_empty());
    w.press(Role::Button, "Eigener Server für andere Netze");

    let type_into = |w: &mut Window<'_>, role: Role, label: &str, text: &str| {
        let field = w.tree().find(role, label).unwrap_or_else(|| panic!("{label}: {:?}", w.labels())).id;
        w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx));
        w.cx.simulate_input(text);
        w.draw();
    };
    type_into(&mut w, Role::TextInput, "STUN-Server", "http://beispiel.de");
    assert!(w.said("Sie beginnt mit „stun:“"), "{:?}", w.labels());
    assert!(w.tree().find(Role::Button, "Übernehmen").is_some());

    // A right one, and a relay with a login.
    w.shell.update(w.cx, |shell, cx| shell.devices_servers_fill("stun:beispiel.de:3478", cx));
    w.draw();
    type_into(&mut w, Role::TextInput, "TURN-Server (Relay)", "turn:beispiel.de:3478");
    type_into(&mut w, Role::TextInput, "Benutzername", "mia");
    type_into(&mut w, Role::PasswordInput, "Passwort", "geheim");
    let password = w.tree().find(Role::PasswordInput, "Passwort").unwrap().clone();
    assert!(password.value.as_ref().is_none_or(|v| AsRef::<str>::as_ref(v).is_empty()), "the password is not told to a screen reader");

    w.press(Role::Button, "Übernehmen");
    let now = servers.lock().unwrap().clone();
    assert_eq!((now.stun.as_str(), now.turn.as_str(), now.user.as_str(), now.password.as_str()), ("stun:beispiel.de:3478", "turn:beispiel.de:3478", "mia", "geheim"));
    assert_eq!(sondra_devices::servers::ice_servers_for(&now).len(), 2, "the next connection is made with both");
    assert_eq!(kept.lock().unwrap().len(), 1, "the addresses are kept for the next start");
    assert!(w.said("gilt für die nächste Verbindung"));

    w.press(Role::Button, "Leeren");
    assert!(servers.lock().unwrap().stun.is_empty() && servers.lock().unwrap().password.is_empty());
}

#[gpui::test]
fn where_no_line_opens_the_page_offers_drive_and_the_files_arrive_that_way(cx: &mut TestAppContext) {
    let drive = FakeDrive::start();
    let tmp = tempfile::tempdir().unwrap();
    let (mine, theirs) = (tmp.path().join("hier"), tmp.path().join("dort"));
    std::fs::create_dir_all(&mine).unwrap();
    let mut w = open(cx, setup_walled(&drive), tmp.path(), &mine);
    let other = walled(&drive, "Handy", now_ms() - 86_400_000.0);
    w.press(Role::Button, "Dieses Gerät verbinden");
    w.wait("the other device is listed", 30, |w| w.tree().find(Role::Button, "Dateien an „Handy“ senden").is_some());
    wait_engine("the other sees this one", 20, || !other.snapshot().devices.is_empty());
    let file = tmp.path().join("film.bin");
    std::fs::write(&file, vec![7u8; 900_000]).unwrap();
    let their_id = other.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned();
    w.shell.update(w.cx, |shell, cx| shell.devices_send_paths(&their_id, vec![file.clone()], false, cx));
    wait_engine("the other is asked", 30, || other.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    other.accept(&other.snapshot().transfers[0].id.clone(), folder_sinks(theirs.clone()));
    // The line does not open: the page says so and offers the way, and does not take it by itself.
    w.wait("no direct way", 30, |w| w.tree().find(Role::Button, "Über Drive senden").is_some());
    assert!(w.said("Kein direkter Weg zu „Handy“"));
    assert!(w.said("Die Dateien liegen dann kurz in Ihrem Drive"), "said where the files go");
    assert!(!theirs.join("film.bin").exists());
    w.press(Role::Button, "Über Drive senden");
    w.wait("it arrived", 60, |w| w.said("ist bei „Handy“ angekommen"));
    assert_eq!(std::fs::metadata(theirs.join("film.bin")).unwrap().len(), 900_000);
    assert!(drive.files_named("000-film.bin").is_empty(), "taken out of Drive after it arrived");
}
