//! What the Windows app left behind, taken over: found without anyone asking, shown before anything is taken,
//! merged into the Merkliste (and taken back from there), added to the settings that are empty, and never offered
//! again once decided.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
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
            if done(self) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("it did not settle: {what}");
    }
    fn has(&self, role: Role, label: &str) -> bool {
        self.tree().find(role, label).is_some()
    }
    fn says(&self, part: &str) -> bool {
        self.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(part)))
    }
}

fn item(id: &str, title: &str, updated: i64) -> sondra_merk::Item {
    normalize(&json!({ "id": id, "title": title, "status": "watching", "season": 1, "episode": 2, "updatedAt": updated, "seasons": [{ "number": 1, "episodes": 12, "watched": [1] }] }), &mut Ids::system())
}

fn open<'a>(cx: &'a mut TestAppContext, list: &std::path::Path, old: Vec<std::path::PathBuf>) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let list = list.to_path_buf();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(list), cx);
        shell.old_app_dirs_for_test(old);
        shell.look_for_old_app(cx);
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

fn titles(path: &std::path::Path) -> Vec<String> {
    let snapshot = read_shared(&std::fs::read(path).unwrap(), &mut Ids::system()).unwrap();
    let mut titles: Vec<String> = snapshot.items.iter().map(|i| i.title.clone()).collect();
    titles.sort();
    titles
}

#[gpui::test]
fn the_old_apps_list_and_settings_are_shown_then_taken_without_undoing_anything(cx: &mut TestAppContext) {
    let _one_at_a_time = DATA.lock().unwrap_or_else(|e| e.into_inner());
    let data = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", data.path());
    let old = tempfile::tempdir().unwrap();
    // The old app's list (a SQLite file as base64, as it keeps it), what its Ordner and Player pages remembered.
    let sqlite = write_sqlite(&Stored { items: vec![item("fr", "Frieren", 300), item("dk", "Dark", 100)], ..Default::default() }).unwrap();
    let packed = base64_of(&sqlite);
    sondra_electron::write_fixture(
        old.path(),
        "http://127.0.0.1:47199",
        &[
            ("sondra:sqlite_db", &packed),
            ("sondra:ordner:je", "{\"Anime\":{\"sort\":\"datum\"},\"Musik\":{\"sort\":\"name\"}}"),
            ("sondra:abspielen:marken", "{\"film.mp4|1\":[{\"at\":12}]}"),
            ("sondra:umwandeln:vorlagen", "[{\"name\":\"Meine\"}]"),
        ],
    )
    .unwrap();
    // What is already set here must stay: one folder's view, and a list with another series.
    std::fs::write(data.path().join("Ordner.json"), "{\"sondra:ordner:je\":\"{\\\"Anime\\\":{\\\"sort\\\":\\\"name\\\"}}\"}").unwrap();
    let list = data.path().join("Merkliste.sqlite");
    std::fs::write(&list, write_sqlite(&Stored { items: vec![item("mp", "Mob Psycho 100", 200), item("fr", "Frieren", 100)], ..Default::default() }).unwrap()).unwrap();

    let mut w = open(cx, &list, vec![old.path().to_path_buf()]);
    w.settle("the offer", |w| w.has(Role::Button, "Ansehen und übernehmen"));
    w.press(Role::Button, "Ansehen und übernehmen");
    assert!(w.says("Merkliste: 2 Serien (1 neu, 1 aktualisiert)"), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    assert!(w.says("Ordner: Ansichten"));
    assert!(w.says("Abspielen: Einstellungen"));
    assert!(w.says("Umwandeln: eigene Vorlagen"));
    // Showing changes nothing.
    assert_eq!(titles(&list), ["Frieren", "Mob Psycho 100"]);

    w.press(Role::Button, "Übernehmen");
    w.settle("taken over", |w| w.shell.read_with(w.cx, |s, _| s.panel()) == Panel::Merkliste);
    assert_eq!(titles(&list), ["Dark", "Frieren", "Mob Psycho 100"], "merged: nothing doubled, the newer Frieren came");
    let ordner: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(data.path().join("Ordner.json")).unwrap()).unwrap();
    let je: serde_json::Value = serde_json::from_str(ordner["sondra:ordner:je"].as_str().unwrap()).unwrap();
    assert_eq!(je["Anime"]["sort"], "name", "what is set here stays");
    assert_eq!(je["Musik"]["sort"], "name", "what was missing comes");
    assert!(std::fs::read_to_string(data.path().join("Abspielen.json")).unwrap().contains("film.mp4|1"));
    assert!(std::fs::read_to_string(data.path().join("Umwandeln.json")).unwrap().contains("Meine"));
    // Taken back from the Merkliste, as a file read in.
    assert!(w.has(Role::Button, "Zurücknehmen"));
    w.press(Role::Button, "Zurücknehmen");
    assert_eq!(titles(&list), ["Frieren", "Mob Psycho 100"]);

    // Decided: another start does not ask again.
    let mut again = open(cx, &list, vec![old.path().to_path_buf()]);
    for _ in 0..30 {
        again.cx.run_until_parked();
        again.draw();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!again.has(Role::Button, "Ansehen und übernehmen"));
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[gpui::test]
fn a_folder_without_anything_of_ours_offers_nothing_and_not_asking_ends_the_offer(cx: &mut TestAppContext) {
    let _one_at_a_time = DATA.lock().unwrap_or_else(|e| e.into_inner());
    let data = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", data.path());
    let nothing = tempfile::tempdir().unwrap();
    sondra_electron::write_fixture(nothing.path(), "http://127.0.0.1:47199", &[("ganz:fremd", "nichts")]).unwrap();
    let list = data.path().join("Merkliste.sqlite");
    let mut w = open(cx, &list, vec![nothing.path().to_path_buf()]);
    for _ in 0..30 {
        w.cx.run_until_parked();
        w.draw();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!w.has(Role::Button, "Ansehen und übernehmen"));
}
