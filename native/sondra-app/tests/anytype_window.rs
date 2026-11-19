//! „Anytype“ under „Mehr“ in the Merkliste: connecting with the four-digit code, choosing the space and the
//! page, a first round that writes the list, a round that brings in what another computer wrote, and a page
//! that already holds a list — loaded, with the replaced list taken back in. Against a stand-in for Anytype.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_anytype::fake::{FakeAnytype, CODE};
use sondra_anytype::{merkliste_from_markdown, merkliste_to_markdown, Anytype};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
use sondra_drive::keystore::FileKeyStore;
use sondra_merk::merge::Removed;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::sqlite::{read_shared, write_sqlite, Snapshot as Stored};
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
    fn settle(&mut self, what: &str, done: impl Fn(&Window<'_>) -> bool) {
        for _ in 0..400 {
            self.cx.run_until_parked();
            self.draw();
            if done(self) && !self.shell.read_with(self.cx, |s, _| s.anytype_running()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("it did not settle: {what}");
    }
    fn has(&self, role: Role, label: &str) -> bool {
        self.tree().find(role, label).is_some()
    }
}

fn item(id: &str, title: &str, updated: i64) -> sondra_merk::Item {
    normalize(&json!({ "id": id, "title": title, "status": "watching", "season": 1, "episode": 2, "updatedAt": updated, "seasons": [{ "number": 1, "episodes": 12, "watched": [1] }] }), &mut Ids::system())
}

fn open<'a>(cx: &'a mut TestAppContext, dir: &std::path::Path, link: Anytype, items: Vec<sondra_merk::Item>) -> Window<'a> {
    let path = dir.join("Merkliste.sqlite");
    std::fs::write(&path, write_sqlite(&Stored { items, ..Default::default() }).unwrap()).unwrap();
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(path), cx);
        shell.anytype_for_test(link);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Merkliste, cx));
    w.draw();
    w
}

fn link_for(fake: &FakeAnytype, dir: &std::path::Path) -> Anytype {
    Anytype::new(dir, fake.api(), Box::new(FileKeyStore::new(dir.join("anytype-schluessel.bin"))))
}

fn on_disk(dir: &std::path::Path) -> Vec<String> {
    let snapshot = read_shared(&std::fs::read(dir.join("Merkliste.sqlite")).unwrap(), &mut Ids::system()).unwrap();
    let mut titles: Vec<String> = snapshot.items.iter().map(|i| i.title.clone()).collect();
    titles.sort();
    titles
}

fn open_window(w: &mut Window<'_>) {
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Anytype …");
    w.settle("the window asks Anytype", |w| w.has(Role::Button, "Mit Anytype verbinden"));
}

#[gpui::test]
fn connecting_choosing_a_page_and_keeping_in_step(cx: &mut TestAppContext) {
    let fake = FakeAnytype::start();
    let data = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let link = link_for(&fake, data.path());
    let mut w = open(cx, dir.path(), link, vec![item("fr", "Frieren", 100), item("dk", "Dark", 100)]);

    open_window(&mut w);
    w.press(Role::Button, "Mit Anytype verbinden");
    w.settle("the code is asked for", |w| w.has(Role::Button, "Bestätigen"));
    // A wrong code is told so, and can be tried again.
    w.shell.update(w.cx, |s, cx| s.anytype_code_for_test("0000", cx));
    w.press(Role::Button, "Bestätigen");
    w.settle("the wrong code is told", |w| w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Dieser Code passt nicht"))));
    w.shell.update(w.cx, |s, cx| s.anytype_code_for_test(CODE, cx));
    w.press(Role::Button, "Bestätigen");
    w.settle("the spaces", |w| w.has(Role::Button, "Space Privat"));
    assert!(w.has(Role::Button, "Space Familie"));

    w.press(Role::Button, "Space Privat");
    w.settle("the pages", |w| w.has(Role::Button, "Neue Seite anlegen"));
    w.press(Role::Button, "Neue Seite anlegen");
    w.settle("connected", |w| w.has(Role::Button, "Jetzt abgleichen"));
    w.settle("the first round", |w| w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Zuletzt abgeglichen"))));
    let page = fake.live_pages().remove(0);
    let remote = merkliste_from_markdown(&fake.markdown(&page.id)).expect("the list is on the page");
    assert_eq!(remote.items.len(), 2);

    // Another computer adds a series; the round brings it in and the file on disk has it.
    let mut other = remote;
    other.items.push(item("mp", "Mob Psycho 100", 300));
    fake.set_markdown(&page.id, &merkliste_to_markdown(&other.items, &Removed::new()));
    w.press(Role::Button, "Jetzt abgleichen");
    w.settle("the round", |_| on_disk(dir.path()).len() == 3);
    assert_eq!(on_disk(dir.path()), ["Dark", "Frieren", "Mob Psycho 100"]);

    // Disconnecting takes the key away and offers the connection again.
    w.press(Role::Button, "Trennen");
    w.settle("disconnected", |w| w.has(Role::Button, "Mit Anytype verbinden"));
    assert!(!data.path().join("anytype-schluessel.bin").exists());
}

#[gpui::test]
fn a_page_with_a_list_is_loaded_and_the_replaced_list_taken_back(cx: &mut TestAppContext) {
    let fake = FakeAnytype::start();
    let data = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let link = link_for(&fake, data.path());
    // Another computer left a list on a page.
    let challenge = link.challenge().unwrap();
    link.pair(&challenge, CODE).unwrap();
    link.use_space("space-a", "Privat", None, None).unwrap();
    link.create_note(Some("space-a"), "Sondra · Merkliste", "Privat", &merkliste_to_markdown(&[item("jojo", "JoJo", 200), item("dk", "Dark", 100)], &Removed::new())).unwrap();
    link.use_space("space-a", "Privat", None, None).unwrap();

    let mut w = open(cx, dir.path(), link, vec![item("fr", "Frieren", 100)]);
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Anytype …");
    w.settle("the pages are found", |w| w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("Seite Sondra · Merkliste · 2 Serien"))));
    w.press(Role::Button, "Seite Sondra · Merkliste · 2 Serien");
    assert!(w.has(Role::Button, "Aus Anytype laden"));
    assert!(w.has(Role::Button, "Beide Listen zusammenführen"));
    w.press(Role::Button, "Aus Anytype laden");
    w.settle("loaded", |w| w.has(Role::Button, "Bisherige Liste dazunehmen"));
    assert_eq!(on_disk(dir.path()), ["Dark", "JoJo"]);

    w.press(Role::Button, "Bisherige Liste dazunehmen");
    w.settle("taken back", |_| on_disk(dir.path()).len() == 3);
    assert_eq!(on_disk(dir.path()), ["Dark", "Frieren", "JoJo"]);
    // And the page holds all three after the round that follows.
    w.settle("written", |_| {
        let page = fake.live_pages().remove(0);
        merkliste_from_markdown(&fake.markdown(&page.id)).is_some_and(|r| r.items.len() == 3)
    });
}
