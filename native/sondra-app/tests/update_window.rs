//! The update in the window: a newer version is looked for, loaded and checked in the background, a card says it is
//! ready, „Später“ puts it away, „Jetzt aktualisieren“ runs the setup, and „Was ist neu“ has the line and the button.
//! Against a stand-in release page; the setup that would run is a recording.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use accesskit::{Action, ActionRequest, TreeId};
use base64::Engine;
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sha2::{Digest, Sha512};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::shell::Shell;
use sondra_app::updater::Status;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

const WIDTH: f32 = 1280.;

static RAN: Mutex<Option<PathBuf>> = Mutex::new(None);
static CALLED: AtomicBool = AtomicBool::new(false);

fn record(path: &Path) -> Result<(), String> {
    *RAN.lock().unwrap() = Some(path.to_path_buf());
    CALLED.store(true, Ordering::SeqCst);
    Ok(())
}

fn page(version: &str, setup: Vec<u8>) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    let sum = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&setup));
    let yaml = format!("version: {version}\nfiles:\n  - url: Sondra-Nativ-Setup-{version}.exe\n    sha512: {sum}\n    size: {}\n", setup.len());
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let body = if url.ends_with("latest-nativ.yml") { yaml.clone().into_bytes() } else { setup.clone() };
            let _ = request.respond(tiny_http::Response::from_data(body));
        }
    });
    base
}

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
    fn said(&self, needle: &str) -> bool {
        self.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)))
    }
    fn wait_for(&mut self, done: impl Fn(&Status) -> bool) {
        for _ in 0..300 {
            self.cx.run_until_parked();
            self.draw();
            if done(&self.shell.read_with(self.cx, |s, _| s.update.status.clone())) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the update did not get there: {:?}", self.shell.read_with(self.cx, |s, _| s.update.status.clone()));
    }
}

fn open<'a>(cx: &'a mut TestAppContext, feed: Option<String>, folder: PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.update.status = if feed.is_some() { Status::Idle } else { Status::Off };
        shell.update.feed = feed;
        shell.update.current = "1.0.0".into();
        shell.update.run = record;
        shell.update.quit_after = false;
        shell.update.folder = folder;
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

#[gpui::test]
fn a_newer_version_is_loaded_and_checked_then_a_card_waits_for_the_click(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let setup = vec![42u8; 120_000];
    let base = page("1.0.1", setup.clone());
    let mut w = open(cx, Some(base), dir.path().to_path_buf());
    assert!(!w.said("ist bereit"));
    w.shell.update(w.cx, |shell, cx| shell.update_check(false, cx));
    w.wait_for(|s| matches!(s, Status::Ready { .. }));
    assert!(w.said("Sondra 1.0.1 ist bereit"));
    let kept = dir.path().join("Sondra-Nativ-Setup-1.0.1.exe");
    assert_eq!(std::fs::read(&kept).unwrap(), setup, "the setup lies there, checked");

    // „Später“ puts the card away; the setup is not run.
    w.press(Role::Button, "Update später");
    assert!(!w.said("ist bereit"));
    assert!(!CALLED.load(Ordering::SeqCst));
    // „Was ist neu“ has the line and the button, and it installs from there too.
    w.shell.update(w.cx, |shell, cx| {
        shell.open_whats_new(cx);
    });
    w.draw();
    assert!(w.said("Sondra 1.0.1 ist geladen und geprüft."));
    w.press(Role::Button, "Auf 1.0.1 aktualisieren");
    assert!(CALLED.load(Ordering::SeqCst), "the setup was run");
    assert_eq!(RAN.lock().unwrap().as_deref(), Some(kept.as_path()));
}

#[gpui::test]
fn nothing_newer_says_so_when_asked_and_stays_quiet_otherwise(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let base = page("1.0.0", vec![1, 2, 3]);
    let mut w = open(cx, Some(base), dir.path().to_path_buf());
    w.shell.update(w.cx, |shell, cx| shell.open_whats_new(cx));
    w.draw();
    assert!(w.said("Sondra sucht von selbst"));
    w.press(Role::Button, "Nach Updates suchen");
    w.wait_for(|s| matches!(s, Status::Current));
    assert!(w.said("Sie haben die neueste Fassung (1.0.0)."));
    assert!(!w.said("ist bereit"));
}

#[gpui::test]
fn a_program_that_is_not_installed_does_not_look_and_a_failed_look_is_shown_only_when_asked(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, None, dir.path().to_path_buf());
    w.shell.update(w.cx, |shell, cx| shell.update_check(true, cx));
    w.cx.run_until_parked();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.update.status.clone()), Status::Off);
    w.shell.update(w.cx, |shell, cx| shell.open_whats_new(cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Nach Updates suchen").is_none(), "nothing to ask for");

    // A page that is not there: quiet when the program looked on its own, a sentence when a person asked.
    let nothing = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let dead = format!("http://{}", nothing.server_addr().to_ip().unwrap());
    std::thread::spawn(move || {
        for request in nothing.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_string("nein").with_status_code(404));
        }
    });
    let other = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(dead), other.path().to_path_buf());
    w.shell.update(w.cx, |shell, cx| shell.update_check(false, cx));
    w.wait_for(|s| matches!(s, Status::Idle));
    w.shell.update(w.cx, |shell, cx| shell.update_check(true, cx));
    w.wait_for(|s| matches!(s, Status::Failed(_)));
}

#[gpui::test]
fn while_the_new_version_loads_a_bar_says_how_far_it_is(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some("http://127.0.0.1:9".into()), dir.path().to_path_buf());
    w.shell.update(w.cx, |shell, cx| {
        shell.update.status = Status::Downloading { version: "1.0.1".into(), fraction: Some(0.4) };
        shell.open_whats_new(cx);
    });
    w.draw();
    assert!(w.said("Sondra 1.0.1 wird geladen"));
    let bar = w.tree().nodes.iter().find(|n| n.label.as_ref().is_some_and(|l| l.contains("Sondra 1.0.1: geladen"))).cloned().expect("the bar");
    assert_eq!(bar.value.as_ref().map(|v| AsRef::<str>::as_ref(v)), Some("40 %"));
}
