//! „Über Google Drive abgleichen“ under „Mehr“: the list goes into `Sondra/Merkliste/Sondra-Merkliste.sqlite`,
//! what another device wrote there is merged in, a file that is no Merkliste is left alone, and the switch
//! stays off until chosen. Against a stand-in for Drive.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::drive_hub::Drive;
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
use sondra_drive::fake::{Always, FakeDrive};
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::sqlite::{read_shared, write_sqlite, Snapshot as Stored};
use sondra_ui::{bind_keys, fonts};

/// `SONDRA_DATA` is process-wide: the tests that point it somewhere run one at a time.
static DATA: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
            if done(self) && !self.shell.read_with(self.cx, |s, _| s.merk_drive_running()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("it did not settle: {what}");
    }
}

fn item(id: &str, title: &str, episode: i64, updated: i64) -> sondra_merk::Item {
    normalize(&json!({ "id": id, "title": title, "status": "watching", "season": 1, "episode": episode, "updatedAt": updated, "seasons": [{ "number": 1, "episodes": 12, "watched": [1] }] }), &mut Ids::system())
}

fn stand_in(fake: &FakeDrive) -> Drive {
    Drive { api: fake.api(), tokens: Arc::new(Always), configured: true, connected: Arc::new(|| true), sign_in: Arc::new(|| Ok(())) }
}

fn open<'a>(cx: &'a mut TestAppContext, dir: &std::path::Path, drive: Drive, items: Vec<sondra_merk::Item>) -> Window<'a> {
    let path = dir.join("Merkliste.sqlite");
    std::fs::write(&path, write_sqlite(&Stored { items, ..Default::default() }).unwrap()).unwrap();
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(path), cx);
        shell.set_drive_for_test(drive);
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

fn on_disk(dir: &std::path::Path) -> Vec<(String, Option<i64>)> {
    let snapshot = read_shared(&std::fs::read(dir.join("Merkliste.sqlite")).unwrap(), &mut Ids::system()).unwrap();
    let mut rows: Vec<(String, Option<i64>)> = snapshot.items.iter().map(|i| (i.title.clone(), i.episode)).collect();
    rows.sort();
    rows
}

fn in_drive(fake: &FakeDrive) -> Vec<(String, Option<i64>)> {
    let file = fake.files_named("Sondra-Merkliste.sqlite").remove(0);
    let mut rows: Vec<(String, Option<i64>)> = read_shared(&file.data, &mut Ids::system()).unwrap().items.iter().map(|i| (i.title.clone(), i.episode)).collect();
    rows.sort();
    rows
}

#[gpui::test]
fn the_list_goes_through_drive_both_ways_once_chosen(cx: &mut TestAppContext) {
    let _one_at_a_time = DATA.lock().unwrap_or_else(|e| e.into_inner());
    // The switch is a file of the program's own; keep this test's away from the real one.
    let data = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", data.path());
    let fake = FakeDrive::start();
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, dir.path(), stand_in(&fake), vec![item("fr", "Frieren", 4, 100), item("dk", "Dark", 1, 100)]);

    // Off until chosen: nothing is in Drive.
    w.cx.run_until_parked();
    assert!(fake.files_named("Sondra-Merkliste.sqlite").is_empty());

    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Über Google Drive abgleichen");
    w.settle("the first round", |_| !fake.files_named("Sondra-Merkliste.sqlite").is_empty());
    assert_eq!(in_drive(&fake), [("Dark".into(), Some(1)), ("Frieren".into(), Some(4))]);
    {
        let state = fake.state.lock().unwrap();
        let file = state.entries.values().find(|e| e.name == "Sondra-Merkliste.sqlite").unwrap();
        let folder = state.entries.get(&file.parent).unwrap();
        assert_eq!(folder.name, "Merkliste");
        assert_eq!(state.entries.get(&folder.parent).unwrap().name, "Sondra");
    }

    // Another device ticked an episode and added a series; the round brings it in.
    let file_id = fake.state.lock().unwrap().entries.iter().find(|(_, e)| e.name == "Sondra-Merkliste.sqlite").map(|(id, _)| id.clone()).unwrap();
    let theirs = Stored { items: vec![item("fr", "Frieren", 5, 300), item("dk", "Dark", 1, 100), item("mp", "Mob Psycho 100", 1, 250)], ..Default::default() };
    fake.state.lock().unwrap().entries.get_mut(&file_id).unwrap().data = write_sqlite(&theirs).unwrap();
    w.shell.update(w.cx, |s, cx| s.merk_drive_sync(cx));
    w.settle("the round that receives", |_| on_disk(dir.path()).len() == 3);
    assert_eq!(on_disk(dir.path()), [("Dark".into(), Some(1)), ("Frieren".into(), Some(5)), ("Mob Psycho 100".into(), Some(1))]);
    assert!(w.shell.read_with(w.cx, |s, _| s.merk_drive_said()).unwrap().contains("Aus Google Drive: 2 Serien"));

    // The same again: nothing to send, nothing received.
    let before = fake.state.lock().unwrap().entries.get(&file_id).unwrap().modified;
    w.shell.update(w.cx, |s, cx| s.merk_drive_sync(cx));
    w.settle("a quiet round", |w| w.shell.read_with(w.cx, |s, _| s.merk_drive_said()).is_some_and(|t| t.contains("Gleichschritt")));
    assert_eq!(fake.state.lock().unwrap().entries.get(&file_id).unwrap().modified, before, "the file is not written again");
}

#[gpui::test]
fn a_file_that_is_no_merkliste_is_never_written_over(cx: &mut TestAppContext) {
    let _one_at_a_time = DATA.lock().unwrap_or_else(|e| e.into_inner());
    let data = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", data.path());
    let fake = FakeDrive::start();
    // Someone put something else at that name.
    let client = sondra_drive::DriveClient::new(Always, fake.api());
    let folder = client.ensure_path(&["Sondra", "Merkliste"]).unwrap();
    client.create(&folder, "Sondra-Merkliste.sqlite", b"das ist keine Merkliste", "application/octet-stream", &Default::default()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, dir.path(), stand_in(&fake), vec![item("fr", "Frieren", 4, 100)]);
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Über Google Drive abgleichen");
    w.settle("the refusal", |w| w.shell.read_with(w.cx, |s, _| s.merk_drive_said()).is_some_and(|t| t.contains("keine Merkliste")));
    assert_eq!(fake.files_named("Sondra-Merkliste.sqlite")[0].data, b"das ist keine Merkliste");
}
