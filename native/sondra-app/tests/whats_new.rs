//! „Was ist neu“: the list of what each version brought, from the file the website and the apps read; opened
//! from the version beside the name; a line after an update, once.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::shell::Shell;
use sondra_app::store::FileStore;
use sondra_app::whats_new::{app_version, date_label, releases};
use sondra_merk::folder_memory::Store;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn open<'a>(cx: &'a mut TestAppContext, store: FileStore) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_whats_new_memory(store, cx);
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
}

#[test]
fn the_list_is_the_one_the_website_reads_and_the_newest_is_this_version() {
    let all = releases();
    assert!(all.len() > 5);
    assert_eq!(all[0].version, app_version(), "the newest entry is the version of package.json (the website checks it too)");
    assert!(all.iter().all(|r| !r.items.is_empty() && r.date.len() == 10));
    assert_eq!(date_label("2026-10-28"), "28. Okt. 2026");
    assert_eq!(date_label("2026-03-02"), "2. März 2026");
}

#[gpui::test]
fn the_version_beside_the_name_opens_what_is_new(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, FileStore::open(tmp.path().join("e.json")));
    let version = app_version();
    w.press(Role::Button, &format!("Was ist neu, Version {version}"));
    assert!(w.tree().find(Role::Dialog, "Was ist neu").is_some());
    assert!(w.said("Diese Fassung"));
    assert!(w.said("Handy spiegeln"), "the entries are the file's");
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Was ist neu").is_none());
}

#[gpui::test]
fn a_line_says_what_is_new_after_an_update_once_and_not_on_a_first_visit(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("e.json");
    // A first visit: nobody to compare with, nothing said — and the version is remembered.
    let w = open(cx, FileStore::open(&file));
    assert!(w.shell.read_with(w.cx, |s, _| s.news_line()).is_none());
    assert_eq!(FileStore::open(&file).get_item("gesehene-version").as_deref(), Some(app_version().as_str()));
    drop(w);
}

#[gpui::test]
fn after_an_update_the_line_is_there_and_opens_the_list(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("e.json");
    let mut earlier = FileStore::open(&file);
    earlier.set_item("gesehene-version", "1.0.0".into());
    let mut w = open(cx, FileStore::open(&file));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.news_line()), Some(app_version()));
    assert!(w.said(&format!("Neu in {}", app_version())));
    w.press(Role::Button, "Was ist neu");
    assert!(w.tree().find(Role::Dialog, "Was ist neu").is_some());
    assert!(w.shell.read_with(w.cx, |s, _| s.news_line()).is_none(), "read: gone");
    // The next start knows this version has been seen.
    assert_eq!(FileStore::open(&file).get_item("gesehene-version").as_deref(), Some(app_version().as_str()));
}

#[gpui::test]
fn the_licences_open_from_the_list_with_the_texts_that_have_to_travel_along(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, FileStore::open(dir.path().join("Einstellungen.json")));
    let version = sondra_app::whats_new::app_version();
    w.press(Role::Button, &format!("Was ist neu, Version {version}"));
    w.press(Role::Button, "Lizenzen");
    assert!(w.tree().find(Role::Dialog, "Lizenzen").is_some());
    for needle in ["MIT License", "FFmpeg", "scrcpy-Server 3.3.3", "yt-dlp", "Apache License", "GNU GENERAL PUBLIC LICENSE"] {
        assert!(w.said(needle), "{needle}");
    }
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Lizenzen").is_none());
}
