//! The session: files chosen or dropped, in a list under the header, in an order, handed to the tool that is picked,
//! and — only when the person says so — offered again at the next start.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::FileStore;
use sondra_media::audio::{write_wav_f32, AudioData};
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn song(path: &std::path::Path) {
    let n = 8000 * 2;
    let tone: Vec<f32> = (0..n).map(|i| (0.3 * (i as f64 * 0.1).sin()) as f32).collect();
    write_wav_f32(path, &AudioData { channels: vec![tone.clone(), tone], sample_rate: 8000 }).unwrap();
}

fn open<'a>(cx: &'a mut TestAppContext, memory: PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_session_memory(FileStore::open(memory), cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1500.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1500.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
}

fn names(files: Vec<PathBuf>) -> Vec<String> {
    files.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect()
}

#[gpui::test]
fn chosen_files_form_a_list_with_an_order_that_goes_to_the_tool_picked(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (a, b, c) = (dir.path().join("a.wav"), dir.path().join("b.wav"), dir.path().join("bild.png"));
    song(&a);
    song(&b);
    std::fs::write(&c, b"png").unwrap();
    let mut w = open(cx, dir.path().join("Sitzung.json"));
    // Nothing chosen, no button for it.
    assert!(w.tree().find(Role::Button, "Dateien der Sitzung, 0").is_none());
    assert!(!w.labels().iter().any(|l| l.starts_with("Dateien der Sitzung")));
    // A file that is not there is not taken; the same file twice is one.
    w.shell.update(w.cx, |s, cx| s.session_add(vec![a.clone(), b.clone(), c.clone(), a.clone(), dir.path().join("fehlt.wav")], cx));
    w.draw();
    assert_eq!(names(w.shell.read_with(w.cx, |s, _| s.session_files())), ["a.wav", "b.wav", "bild.png"]);
    w.press(Role::Button, "Dateien der Sitzung, 3");
    assert!(w.tree().find(Role::Heading, "Dateien der Sitzung").is_some());
    // The order.
    w.press(Role::Button, "b.wav nach oben");
    assert_eq!(names(w.shell.read_with(w.cx, |s, _| s.session_files())), ["b.wav", "a.wav", "bild.png"]);
    w.press(Role::Button, "bild.png aus der Sitzung nehmen");
    assert_eq!(names(w.shell.read_with(w.cx, |s, _| s.session_files())), ["b.wav", "a.wav"]);
    // A song goes to a tool of its kind: the tool opens with it.
    assert!(w.tree().find(Role::Button, "a.wav in Spuren trennen öffnen").is_some());
    assert!(w.tree().find(Role::Button, "a.wav in Bilder öffnen").is_none(), "a song is not a picture");
    w.press(Role::Button, "a.wav in Spuren trennen öffnen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Stems);
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if w.labels().iter().any(|l| l.contains("a.wav")) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(w.labels().iter().any(|l| l.contains("a.wav")), "the tool shows the file: {:?}", w.labels());
    // Nothing was kept: the person did not ask.
    assert!(!dir.path().join("Sitzung.json").exists() || std::fs::read_to_string(dir.path().join("Sitzung.json")).unwrap().contains("[]"));
}

#[gpui::test]
fn a_kept_session_is_offered_at_the_next_start_and_never_loaded_by_itself(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let memory = dir.path().join("Sitzung.json");
    let (a, b) = (dir.path().join("a.wav"), dir.path().join("b.wav"));
    song(&a);
    song(&b);
    {
        let mut w = open(cx, memory.clone());
        w.shell.update(w.cx, |s, cx| s.session_add(vec![a.clone(), b.clone()], cx));
        w.draw();
        w.press(Role::Button, "Dateien der Sitzung, 2");
        w.press(Role::Button, "Sitzung auf diesem Gerät behalten");
    }
    // Another start: a line offers it; the list is empty until the person says yes.
    std::fs::remove_file(&b).unwrap();
    let mut w = open(cx, memory.clone());
    assert!(w.shell.read_with(w.cx, |s, _| s.session_files()).is_empty());
    assert!(w.labels().iter().any(|l| l == "Letzte Sitzung: 1 Datei"), "a file that is gone is not offered: {:?}", w.labels());
    w.press(Role::Button, "Wiederherstellen");
    assert_eq!(names(w.shell.read_with(w.cx, |s, _| s.session_files())), ["a.wav"]);
    assert!(!w.labels().iter().any(|l| l.starts_with("Letzte Sitzung")));
    // Switched off, it forgets: the next start has nothing to offer.
    w.press(Role::Button, "Sitzung auf diesem Gerät behalten");
    drop(w);
    let w = open(cx, memory);
    assert!(w.shell.read_with(w.cx, |s, _| s.session_offer()).is_none());
}

fn wait_said(w: &mut Window, what: &str) -> Result<String, String> {
    for _ in 0..300 {
        w.cx.run_until_parked();
        w.draw();
        if let Some(said) = w.shell.read_with(w.cx, |s, _| s.session_said()) {
            return said;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("{what}: nothing was said");
}

#[gpui::test]
fn the_session_is_saved_as_a_project_the_website_opens_and_a_project_opens_its_files_and_its_tool(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DOWNLOADS", dir.path().join("Downloads"));
    std::env::set_var("SONDRA_DATA", dir.path().join("Daten"));
    let (a, b) = (dir.path().join("lied.wav"), dir.path().join("zweites.wav"));
    song(&a);
    song(&b);
    let mut w = open(cx, dir.path().join("Sitzung.json"));
    w.shell.update(w.cx, |s, cx| s.session_add(vec![a.clone(), b.clone()], cx));
    w.draw();
    w.press(Role::Button, "Dateien der Sitzung, 2");
    w.press(Role::Button, "Die Sitzung als Projektdatei speichern");
    let said = wait_said(&mut w, "save").expect("saved");
    assert!(said.starts_with("Projekt gespeichert:") && said.contains("(2 Dateien)"), "{said}");
    let project = dir.path().join("Downloads").join("lied.sondra");
    assert!(project.is_file(), "beside what Sondra makes");
    // The archive is the website's: its manifest names both files.
    let read = sondra_media::project::read(&std::fs::read(&project).unwrap(), "lied.sondra").unwrap();
    assert_eq!(read.assets.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["lied.wav", "zweites.wav"]);

    // Opening it (a double click, or a drop): its files are in the session again, in a folder of their own, and the
    // tool that was open opens.
    let mut w = open(cx, dir.path().join("Sitzung2.json"));
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![project.clone()], cx));
    let said = wait_said(&mut w, "open").expect("opened");
    assert_eq!(said, "Projekt geöffnet: 2 Dateien");
    let files = w.shell.read_with(w.cx, |s, _| s.session_files());
    assert_eq!(names(files.clone()), ["lied.wav", "zweites.wav"]);
    assert!(files[0].starts_with(dir.path().join("Daten").join("Projekte")));
    assert_eq!(std::fs::read(&files[0]).unwrap(), std::fs::read(&a).unwrap());
    assert!(w.tree().find(Role::Button, "Dateien der Sitzung, 2, schließen").is_some(), "the list is open");

    // A file that is no project says so in words and takes nothing.
    let broken = dir.path().join("kaputt.sondra");
    std::fs::write(&broken, b"nichts").unwrap();
    let mut w = open(cx, dir.path().join("Sitzung3.json"));
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![broken], cx));
    let said = wait_said(&mut w, "broken").unwrap_err();
    assert!(said.contains("kein gültiges ZIP"), "{said}");
    assert!(w.shell.read_with(w.cx, |s, _| s.session_files()).is_empty());
    assert!(w.labels().iter().any(|l| l.contains("kein gültiges ZIP")), "said where the person is");
}
