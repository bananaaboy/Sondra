//! The Merkliste screen in GPUI's test window: what a screen reader finds on its lines, what „+1“ does to
//! the list and to the file, the empty page, and a series typed in.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AppContext as _, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::sqlite::{read_shared, write_sqlite, Snapshot as Stored};
use sondra_ui::{bind_keys, fonts};

/// `SONDRA_DOWNLOADS` is process-wide: tests that point it somewhere run one at a time.
static DOWNLOADS: std::sync::Mutex<()> = std::sync::Mutex::new(());

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn list(n: usize) -> Stored {
    let mut ids = Ids::system();
    let mut items = vec![
        normalize(
            &json!({ "id": "fr", "title": "Frieren", "status": "watching", "season": 1, "episode": 4,
                "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2, 3] }] }),
            &mut ids,
        ),
        normalize(
            &json!({ "id": "dk", "title": "Dark", "status": "done", "season": 1, "episode": 2,
                "seasons": [{ "number": 1, "episodes": 2, "watched": [1, 2] }] }),
            &mut ids,
        ),
        normalize(&json!({ "id": "mp", "title": "Mob Psycho 100", "status": "later" }), &mut ids),
    ];
    for i in 0..n.saturating_sub(items.len()) {
        items.push(normalize(&json!({ "id": format!("x{i}"), "title": format!("Serie {i}"), "status": "later" }), &mut ids));
    }
    Stored { items, ..Default::default() }
}

fn open<'a>(cx: &'a mut TestAppContext, stored: Option<&Stored>, dir: &std::path::Path) -> Window<'a> {
    open_as(cx, stored, dir, true)
}

fn open_as<'a>(cx: &'a mut TestAppContext, stored: Option<&Stored>, dir: &std::path::Path, lines: bool) -> Window<'a> {
    let path = dir.join("Merkliste.sqlite");
    if let Some(stored) = stored {
        std::fs::write(&path, write_sqlite(stored).unwrap()).unwrap();
    }
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(path), cx);
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
    // The page opens on the shelf of posters; most of these tests are about the lines of the list.
    if lines && w.tree().find(Role::Button, "Als Liste").is_some() {
        w.press(Role::Button, "Als Liste");
    }
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(
            point(px(0.), px(0.)),
            size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(900.))),
            move |_, _| view,
        );
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| {
            run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx)
        });
        self.draw();
    }
}

fn said(tree: &Snapshot, role: Role, label: &str) -> String {
    tree.find(role, label).and_then(|n| n.description.as_ref().map(|d| d.to_string())).unwrap_or_default()
}

#[gpui::test]
fn the_lines_say_where_each_series_stands(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let w = open(cx, Some(&list(3)), dir.path());
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Merkliste").is_some());
    // Sections by stand, only the ones somebody is in.
    for heading in ["Am Schauen", "Später", "Fertig"] {
        assert!(tree.find(Role::Heading, heading).is_some(), "{heading}");
    }
    assert!(tree.find(Role::Heading, "Pausiert").is_none());
    assert_eq!(said(&tree, Role::ListItem, "Frieren"), "Staffel 1, Folge 4. 3/12. noch 9 · 3 Std. 36 Min.");
    assert!(said(&tree, Role::ListItem, "Dark").starts_with("Alles gesehen."));
    assert!(said(&tree, Role::ListItem, "Mob Psycho 100").starts_with("Nicht angefangen"));
    // Pills with their counts; a stand nobody is in has none.
    assert!(tree.find(Role::Button, "Alle 3").is_some());
    assert!(tree.find(Role::Button, "Am Schauen 1").is_some());
    assert!(tree.find(Role::Button, "Pausiert 0").is_none());
    // A step forward is on a line that has one — and has a name that says what it does.
    assert!(tree.find(Role::Button, "Staffel 1, Folge 4 von Frieren als gesehen markieren").is_some());
    assert!(tree.find(Role::Button, "Alles gesehen von Dark als gesehen markieren").is_none());
    // The bar tells how far.
    assert_eq!(tree.find(Role::ProgressIndicator, "Frieren: gesehen").and_then(|n| n.value.as_ref().map(|v| v.to_string())).as_deref(), Some("25 %"));
    // Three entries are not worth a search.
    assert!(tree.find(Role::TextInput, "Merkliste durchsuchen").is_none());
}

#[gpui::test]
fn plus_one_marks_the_episode_seen_and_writes_the_file(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.press(Role::Button, "Staffel 1, Folge 4 von Frieren als gesehen markieren");
    let tree = w.tree();
    assert_eq!(said(&tree, Role::ListItem, "Frieren"), "Staffel 1, Folge 5. 4/12. noch 8 · 3 Std. 12 Min.");
    // On disk the website would read the same: the episode seen, the stand moved, the history written.
    let bytes = std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap();
    let back = read_shared(&bytes, &mut Ids::system()).unwrap();
    let frieren = back.items.iter().find(|i| i.id == "fr").unwrap();
    assert_eq!(frieren.episode, Some(5));
    assert_eq!(frieren.seasons.as_ref().unwrap()[0].watched, vec![1, 2, 3, 4]);
    let history = frieren.history.as_ref().unwrap();
    assert_eq!((history[0].season, history[0].episode), (1, 4));
    assert_eq!(back.items.len(), 3, "nothing else on the list was touched");
}

#[gpui::test]
fn an_empty_list_says_what_to_do_and_a_typed_name_becomes_a_series(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, None, dir.path());
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Noch nichts auf der Merkliste").is_some());
    assert!(tree.find(Role::Button, "Ordner mit Serien wählen").is_some());
    assert!(tree.find(Role::Button, "Eine Serie eintippen").is_some());
    w.press(Role::Button, "Eine Serie eintippen");
    assert!(w.tree().find(Role::TextInput, "Name der neuen Serie").is_some());
    let field = w.tree().find(Role::TextInput, "Name der neuen Serie").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx)
    });
    w.cx.simulate_input("Frieren");
    w.cx.simulate_keystrokes("enter");
    w.draw();
    let tree = w.tree();
    assert!(tree.find(Role::ListItem, "Frieren").is_some(), "the series is on the page");
    assert!(tree.find(Role::Heading, "Noch nichts auf der Merkliste").is_none());
    assert_eq!(said(&tree, Role::ListItem, "Frieren"), "Staffel 1, Folge 1. 0 gesehen. —", "a new series stands at the start, its length not asked");
    w.press(Role::Button, "Als Liste");
    w.press(Role::Button, "Staffel 1, Folge 1 von Frieren als gesehen markieren");
    assert_eq!(said(&w.tree(), Role::ListItem, "Frieren"), "Staffel 1, Folge 2. 1 gesehen. —");
    let bytes = std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap();
    let back = read_shared(&bytes, &mut Ids::system()).unwrap();
    assert_eq!(back.items.len(), 1);
    assert_eq!(back.items[0].title, "Frieren");
}

#[gpui::test]
fn a_long_list_has_a_search_and_a_file_that_is_no_list_is_left_alone(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(8)), dir.path());
    assert!(w.tree().find(Role::TextInput, "Merkliste durchsuchen").is_some());
    w.press(Role::Button, "Später 6");
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Später").is_some());
    assert!(tree.find(Role::Heading, "Fertig").is_none(), "the pill narrowed the page to one stand");
    drop(w);

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("Merkliste.sqlite");
    std::fs::write(&path, b"this is somebody's other file").unwrap();
    let mut w = open(cx, None, dir.path());
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("keine Merkliste"))), "it says why");
    w.press(Role::Button, "Serie hinzufügen");
    drop(w);
    assert_eq!(std::fs::read(&path).unwrap(), b"this is somebody's other file", "and it is never written over");
}

#[gpui::test]
fn a_series_opens_to_its_page_where_episodes_are_ticked(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    assert!(w.tree().find(Role::ListItem, "Frieren").unwrap().default_action.is_some(), "a line can be opened by a screen reader");
    w.press(Role::ListItem, "Frieren");
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Frieren").is_some());
    assert!(tree.find(Role::Button, "Zurück zur Merkliste").is_some());
    assert!(tree.find(Role::Heading, "Staffel 1").is_some());
    // Where one is is said on the episode, in words.
    assert!(tree.find(Role::Button, "Folge 4, hier sind Sie").is_some());
    assert_eq!(tree.find(Role::Button, "Folge 2").unwrap().toggled, Some(true), "seen episodes are pressed");
    assert_eq!(tree.find(Role::Button, "Folge 5").unwrap().toggled, Some(false));
    assert_eq!(tree.find(Role::Button, "Stand: Am Schauen").unwrap().toggled, Some(true));

    // Ticking a later episode leaves the place at the first one not seen.
    w.press(Role::Button, "Folge 5");
    assert_eq!(w.tree().find(Role::Button, "Folge 5").unwrap().toggled, Some(true));
    assert!(w.tree().find(Role::Button, "Folge 4, hier sind Sie").is_some());
    // The big button steps forward: 4 is seen, the place moves to 6 (5 is seen already).
    w.press(Role::Button, "Folge 4 gesehen");
    assert!(w.tree().find(Role::Button, "Folge 6, hier sind Sie").is_some());
    // The length of a season can be changed.
    w.press(Role::Button, "Eine Folge mehr in Staffel 1");
    assert!(w.tree().find(Role::Button, "Folge 13").is_some());
    // And the stand.
    w.press(Role::Button, "Stand: Pausiert");
    assert_eq!(w.tree().find(Role::Button, "Stand: Pausiert").unwrap().toggled, Some(true));

    let bytes = std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap();
    let back = read_shared(&bytes, &mut Ids::system()).unwrap();
    let frieren = back.items.iter().find(|i| i.id == "fr").unwrap();
    assert_eq!(frieren.seasons.as_ref().unwrap()[0].watched, vec![1, 2, 3, 4, 5]);
    assert_eq!(frieren.seasons.as_ref().unwrap()[0].episodes, Some(13));
    assert_eq!(frieren.episode, Some(6));
    assert_eq!(frieren.status, sondra_merk::Status::Paused);

    w.press(Role::Button, "Zurück zur Merkliste");
    assert!(w.tree().find(Role::Heading, "Merkliste").is_some());
    assert!(w.tree().find(Role::Heading, "Pausiert").is_some(), "the entry is in its new section");
}

#[gpui::test]
fn removing_a_series_can_be_undone_and_is_noted_on_the_file(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.press(Role::ListItem, "Dark");
    w.press(Role::Button, "Von der Merkliste entfernen");
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Merkliste").is_some(), "the page closed");
    assert!(tree.find(Role::ListItem, "Dark").is_none());
    assert!(tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("„Dark“ ist von der Merkliste"))));
    let back = read_shared(&std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap(), &mut Ids::system()).unwrap();
    assert_eq!(back.items.len(), 2);
    assert!(back.removed.contains_key("dk"), "the removal is noted, so Drive does not bring it back");

    w.press(Role::Button, "Rückgängig");
    assert!(w.tree().find(Role::ListItem, "Dark").is_some());
    let back = read_shared(&std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap(), &mut Ids::system()).unwrap();
    assert_eq!(back.items.len(), 3);
    assert!(back.removed.is_empty());
}

#[gpui::test]
fn the_page_opens_on_a_shelf_of_posters_and_a_poster_opens_its_series(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open_as(cx, Some(&list(3)), dir.path(), false);
    let tree = w.tree();
    assert_eq!(tree.find(Role::Button, "Als Poster").unwrap().toggled, Some(true));
    assert_eq!(tree.find(Role::Button, "Als Liste").unwrap().toggled, Some(false));
    // A poster says what a line says, and has no step forward of its own: that is one click further.
    assert_eq!(said(&tree, Role::ListItem, "Frieren"), "Staffel 1, Folge 4. 3/12. noch 9 · 3 Std. 36 Min.");
    assert!(tree.find(Role::Button, "Staffel 1, Folge 4 von Frieren als gesehen markieren").is_none());
    w.press(Role::ListItem, "Frieren");
    assert!(w.tree().find(Role::Button, "Folge 4 gesehen").is_some());
    w.press(Role::Button, "Zurück zur Merkliste");
    w.press(Role::Button, "Als Liste");
    assert!(w.tree().find(Role::Button, "Staffel 1, Folge 4 von Frieren als gesehen markieren").is_some());
}

#[gpui::test]
fn the_order_of_the_series_is_chosen_behind_mehr(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(8)), dir.path());
    // By recent activity, the entries that were changed last come first; by title they go A to Z.
    let first_of = |w: &Window| -> Vec<String> { w.tree().nodes.iter().filter(|n| n.role == Role::ListItem).filter_map(|n| n.label.as_ref().map(|l| l.to_string())).collect() };
    assert!(w.tree().find(Role::Menu, "Mehr").is_none());
    w.press(Role::Button, "Mehr");
    assert!(w.tree().find(Role::Menu, "Mehr").is_some());
    for label in ["Zuletzt aktiv", "Titel (A–Z)", "Beste Bewertung (★)", "Höchster Fortschritt (%)", "Am wenigsten übrig", "Meiste Folgen"] {
        assert!(w.tree().find(Role::MenuItem, label).is_some(), "{label}");
    }
    assert!(said(&w.tree(), Role::MenuItem, "Zuletzt aktiv").starts_with("Geöffnet"));
    w.press(Role::MenuItem, "Titel (A–Z)");
    assert!(w.tree().find(Role::Menu, "Mehr").is_none(), "a choice shuts the menu");
    let later: Vec<String> = first_of(&w).into_iter().filter(|t| t.starts_with("Serie ")).collect();
    let mut sorted = later.clone();
    sorted.sort();
    assert_eq!(later, sorted, "the series of one section stand A to Z");
    w.press(Role::Button, "Mehr");
    // The button keeps the focus it got from the click (or from Enter), and Escape reaches the window from it.
    let button = w.tree().find(Role::Button, "Mehr").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: button, data: None }, window, cx)
    });
    w.cx.simulate_keystrokes("escape");
    w.draw();
    assert!(w.tree().find(Role::Menu, "Mehr").is_none(), "Escape shuts it");
}

#[gpui::test]
fn a_series_with_a_cover_gets_its_picture_on_the_shelf_and_in_the_list(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    // A cover on the web (a picture from a file does not travel in the list and stays on its device).
    let mut img = image::RgbaImage::new(200, 300);
    for p in img.pixels_mut() {
        p.0 = [200, 30, 30, 255];
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_data(bytes.clone()).with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"image/png"[..]).unwrap()));
        }
    });
    let url = format!("http://127.0.0.1:{port}/cover.png");
    let mut ids = Ids::system();
    let stored = Stored {
        items: vec![
            normalize(&json!({ "id": "fr", "title": "Frieren", "status": "watching", "season": 1, "episode": 4, "cover": url,
                "coverFrame": { "x": 50, "y": 50, "zoom": 1.5 },
                "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2, 3] }] }), &mut ids),
            normalize(&json!({ "id": "dk", "title": "Dark", "status": "done" }), &mut ids),
        ],
        ..Default::default()
    };
    let mut w = open_as(cx, Some(&stored), tmp.path(), false);
    // The start page shows the series being watched with its cover (a small one, as in the list), and the
    // shelf another, bigger: each size is asked for once and made in the background.
    for _ in 0..80 {
        w.cx.run_until_parked();
        w.draw();
        if w.cx.read_entity(&w.shell, |s, _| s.covers_ready()) > 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_asked()), 2, "one series has a cover, at two sizes; the other is not asked for");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_ready()), 2, "and both were made");
    // The list shows it at the size the start page did: nothing is made again.
    w.press(Role::Button, "Als Liste");
    for _ in 0..10 {
        w.cx.run_until_parked();
        w.draw();
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_asked()), 2);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_ready()), 2);
}

#[gpui::test]
fn the_planner_says_how_much_there_is_to_watch_to_a_chosen_point_and_when_it_is_done(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.press(Role::ListItem, "Frieren");
    assert!(w.tree().find(Role::Heading, "Bis wohin?").is_some());
    assert!(w.tree().find(Role::Heading, "Bis Staffel 1, Folge 12").is_none(), "nothing before a target is chosen");
    w.press(Role::Button, "Ziel Ganze Serie");
    // Stand: episode 4 of 12 → 9 episodes to watch.
    let tree = w.tree();
    let said: Vec<String> = ["9 Folgen"].iter().map(|s| s.to_string()).collect();
    let found = said.iter().all(|s| tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with(s.as_str()))));
    assert!(found, "nine episodes are left to watch: {:?}", tree.nodes.iter().filter_map(|n| n.label.as_ref().map(|l| l.to_string())).filter(|l| l.contains("Folge") || l.contains("Bis")).collect::<Vec<_>>());
    // A pace gives a day.
    w.press(Role::Button, "3 am Tag");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Fertig "))));
    // The end of the season, from the last episode, is reached: nothing to watch.
    w.press(Role::Button, "Ziel Ende Staffel 1");
    w.press(Role::Button, "Planer Tempo 2×");
    assert_eq!(w.tree().find(Role::Button, "Planer Tempo 2×").unwrap().toggled, Some(true));
}

#[gpui::test]
fn the_statistics_window_gives_the_numbers_and_a_year_looked_back_on(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut ids = Ids::system();
    use chrono::TimeZone as _;
    let at = |month: u32, day: u32| chrono::Local.with_ymd_and_hms(2025, month, day, 20, 0, 0).unwrap().timestamp_millis();
    let history: Vec<_> = [(1, at(3, 1)), (2, at(3, 2)), (3, at(3, 3)), (4, at(7, 9))].iter().map(|(e, t)| json!({ "id": format!("h{e}"), "season": 1, "episode": e, "at": t })).collect();
    let stored = Stored {
        items: vec![normalize(&json!({ "id": "fr", "title": "Frieren", "status": "watching", "season": 1, "episode": 5, "history": history,
            "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2, 3, 4] }] }), &mut ids)],
        ..Default::default()
    };
    let mut w = open(cx, Some(&stored), dir.path());
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Statistik und Rückblick");
    let tree = w.tree();
    assert!(tree.find(Role::Dialog, "Statistik und Rückblick").is_some());
    assert!(tree.find(Role::Button, "Rückblick 2025").is_some());
    assert!(tree.find(Role::Heading, "Rückblick 2025").is_some());
    assert!(tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("4 Folgen"))), "four episodes that year");
    assert!(tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Stärkster Monat: März mit 3"))));
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Statistik und Rückblick").is_none());
}

#[gpui::test]
fn the_list_is_exported_and_a_file_read_in_without_doubling_and_taken_back(cx: &mut TestAppContext) {
    let _guard = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("aus");
    std::env::set_var("SONDRA_DOWNLOADS", &out);
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Exportieren");
    let exported: Vec<_> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(exported.len(), 1);
    assert!(exported[0].extension().unwrap() == "sqlite");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Die Merkliste liegt in"))));
    w.press(Role::Button, "Schliessen");
    // Reading the same file in changes nothing; a MyAnimeList file brings one new series.
    let file = exported[0].clone();
    w.shell.update(w.cx, |s, cx| s.merk_import_file(&file, cx));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).contains("schon gleich"))));
    let mal = dir.path().join("mal.xml");
    std::fs::write(&mal, "<myanimelist><anime><series_title><![CDATA[Cowboy Bebop]]></series_title><series_episodes>26</series_episodes><my_watched_episodes>5</my_watched_episodes><my_status>Watching</my_status></anime></myanimelist>").unwrap();
    w.shell.update(w.cx, |s, cx| s.merk_import_file(&mal, cx));
    w.draw();
    assert!(w.tree().find(Role::ListItem, "Cowboy Bebop").is_some(), "the new series is on the list");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).contains("1 neu"))));
    w.press(Role::Button, "Zurücknehmen");
    assert!(w.tree().find(Role::ListItem, "Cowboy Bebop").is_none(), "taken back");
    assert!(w.tree().find(Role::ListItem, "Frieren").is_some());
    // A file that is no list says so.
    let junk = dir.path().join("x.txt");
    std::fs::write(&junk, "nichts").unwrap();
    w.shell.update(w.cx, |s, cx| s.merk_import_file(&junk, cx));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Die Datei ist keine Merkliste"))));
}

#[gpui::test]
fn a_series_can_be_added_as_already_begun(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, None, dir.path());
    w.press(Role::Button, "Eine Serie eintippen");
    assert!(w.tree().find(Role::Button, "Ganz neu").unwrap().toggled == Some(true));
    for _ in 0..4 {
        w.press(Role::Button, "Eine Folge mehr");
    }
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l) == "Schon angefangen: weiter mit Folge 5")));
    let field = w.tree().find(Role::TextInput, "Name der neuen Serie").unwrap().id;
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx));
    w.cx.simulate_input("Dark");
    w.cx.simulate_keystrokes("enter");
    w.draw();
    assert_eq!(said(&w.tree(), Role::ListItem, "Dark"), "Staffel 1, Folge 5. 4 gesehen. —");
}

#[cfg(unix)]
#[gpui::test]
fn in_discord_zeigen_is_off_until_chosen_and_then_says_what_the_page_is(cx: &mut TestAppContext) {
    use std::io::{Read, Write};
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("run");
    std::fs::create_dir_all(&runtime).unwrap();
    std::env::set_var("XDG_RUNTIME_DIR", &runtime);
    let listener = std::os::unix::net::UnixListener::bind(runtime.join("discord-ipc-0")).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(listener.accept().is_err(), "nothing connects while it is off");
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "In Discord zeigen");
    w.draw();
    let mut peer = None;
    for _ in 0..100 {
        if let Ok((s, _)) = listener.accept() {
            peer = Some(s);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let mut peer = peer.expect("Sondra connects once it is on");
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(std::time::Duration::from_millis(500))).unwrap();
    let mut buf = [0u8; 4096];
    let n = peer.read(&mut buf).unwrap();
    assert!(String::from_utf8_lossy(&buf[8..n]).contains("client_id"));
    peer.write_all(&sondra_discord::encode_frame(1, "{\"cmd\":\"DISPATCH\",\"evt\":\"READY\"}")).unwrap();
    let n = peer.read(&mut buf).unwrap();
    let text = String::from_utf8_lossy(&buf[8..n]).to_string();
    assert!(text.contains("SET_ACTIVITY") && text.contains("\"details\":\"Merkliste\"") && text.contains("3 Serien (1 aktiv)"), "{text}");
}

#[gpui::test]
fn suchen_asks_anilist_only_when_pressed_and_adds_the_series_with_its_length(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = asked.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let body = r#"{"data":{"Media":{"id":154587,"title":{"romaji":"Sousou no Frieren"},"episodes":28,"seasonYear":2023,"coverImage":{"large":"https://example.invalid/c.jpg"}}}}"#;
            let _ = request.respond(tiny_http::Response::from_string(body));
        }
    });
    std::env::set_var("SONDRA_ANILIST", format!("http://127.0.0.1:{port}/"));
    let mut w = open(cx, None, dir.path());
    w.press(Role::Button, "Eine Serie eintippen");
    let field = w.tree().find(Role::TextInput, "Name der neuen Serie").unwrap().id;
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx));
    w.cx.simulate_input("Frieren");
    w.draw();
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0, "typing asks nobody");
    w.press(Role::Button, "Suchen");
    for _ in 0..80 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Sousou no Frieren"))) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l) == "Sousou no Frieren (2023) — 28 Folgen")));
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    w.press(Role::Button, "Hinzufügen");
    assert!(said(&w.tree(), Role::ListItem, "Frieren").contains("0/28. noch 28"), "{}", said(&w.tree(), Role::ListItem, "Frieren"));
}

#[gpui::test]
fn the_list_is_shared_as_a_link_that_opens_again_as_text_as_a_qr_code_and_as_a_file(cx: &mut TestAppContext) {
    let _guard = DOWNLOADS.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("teilen");
    std::env::set_var("SONDRA_DOWNLOADS", &out);
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Teilen …");
    assert!(w.tree().find(Role::Dialog, "Merkliste teilen").is_some());
    // Am Schauen is chosen at the start: Frieren only.
    assert_eq!(w.tree().find(Role::Button, "Am Schauen mitnehmen, 1 Serien").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Später mitnehmen, 1 Serien").unwrap().toggled, Some(false));
    let (links, text) = w.cx.read_entity(&w.shell, |s, _| s.share_outputs());
    assert_eq!(links.len(), 1);
    assert!(links[0].starts_with("https://sondra.lizge.ch/#g="));
    assert!(text.contains("Frieren"), "{text}");
    assert!(!text.contains("Mob Psycho"), "what is not chosen does not go");
    let back = sondra_merk::share::decode_share(sondra_merk::share::shared_from_hash(&links[0][links[0].find('#').unwrap()..]).unwrap()).expect("the link opens again");
    assert_eq!(back.items.len(), 1);
    assert_eq!(back.items[0].title, "Frieren");
    // Another stand joins.
    w.press(Role::Button, "Später mitnehmen, 1 Serien");
    let (links, _) = w.cx.read_entity(&w.shell, |s, _| s.share_outputs());
    assert_eq!(sondra_merk::share::decode_share(sondra_merk::share::shared_from_hash(&links[0][links[0].find('#').unwrap()..]).unwrap()).unwrap().items.len(), 2);
    // The QR code stands for the link, with its three finder squares.
    w.press(Role::Button, "QR-Code zeigen");
    let rows = sondra_app::share_window::qr_modules(&links[0]).unwrap();
    assert!(rows.len() >= 21 && rows.len() == rows[0].len());
    assert!((0..7).all(|i| rows[0][i] && rows[i][0] && rows[6][i] && rows[i][6]), "the corner square");
    // As a file that reads back.
    w.press(Role::Button, "Als Datei speichern");
    let files: Vec<_> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().path()).collect();
    assert_eq!(files.len(), 1);
    assert!(files[0].to_string_lossy().ends_with(".sondra-liste"));
    assert_eq!(sondra_merk::share::read_share_file(&std::fs::read(&files[0]).unwrap()).unwrap().items.len(), 2);
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Merkliste teilen").is_none());
}

#[gpui::test]
fn a_received_list_is_set_beside_the_own_and_what_is_new_is_taken(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    // Mia has Frieren (as the own list does, in other spelling), a film and a series with a little picture.
    let mut ids = Ids::system();
    let theirs = vec![
        normalize(&json!({ "id": "a", "title": "FRIEREN", "status": "done", "season": 1, "episode": 12 }), &mut ids),
        normalize(&json!({ "id": "b", "title": "Das wandelnde Schloss", "status": "done", "rating": 5 }), &mut ids),
        normalize(&json!({ "id": "c", "title": "Cowboy Bebop", "status": "watching", "season": 1, "episode": 7 }), &mut ids),
    ];
    let mut thumbs = std::collections::HashMap::new();
    // Six by nine mid-grey pixels, packed as „winzig“.
    thumbs.insert("c".to_string(), sondra_merk::cover::pack_raw(&[128u8; sondra_merk::cover::RAW_W * sondra_merk::cover::RAW_H * 4]).unwrap());
    let shared = sondra_merk::share::shareable_list(&theirs, "Mia", true, &thumbs);
    let link = sondra_merk::share::share_links(&shared, "https://sondra.lizge.ch", sondra_merk::share::LINK_MAX).remove(0);

    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Liste empfangen …");
    assert!(w.tree().find(Role::Dialog, "Liste empfangen").is_some());
    // Rubbish says so, and nothing is shown of it.
    w.shell.update(w.cx, |s, _| s.receive_read("das ist kein Link"));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("keine Liste"))));

    w.shell.update(w.cx, |s, _| {
        s.receive_with_parts(Box::new(sondra_app::receive_window::MemoryParts::default()));
        s.receive_read(&link)
    });
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Beide haben 1 · nur bei Ihnen 2 · nur bei Mia 2"))), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    // Both new ones are ticked; the one already on the list is not offered.
    assert_eq!(w.tree().find(Role::Button, "Cowboy Bebop aufnehmen").unwrap().toggled, Some(true));
    assert!(w.tree().find(Role::Button, "FRIEREN aufnehmen").is_none());
    // The film is left out, the other taken as it stands there.
    w.press(Role::Button, "Das wandelnde Schloss aufnehmen");
    w.press(Role::Button, "1 Serie aufnehmen");
    let items = w.cx.read_entity(&w.shell, |s, _| s.merk_items());
    assert_eq!(items.len(), 4);
    let bebop = items.iter().find(|i| i.title == "Cowboy Bebop").expect("taken");
    assert_eq!(bebop.status, sondra_merk::Status::Watching);
    assert_eq!((bebop.season, bebop.episode), (1, Some(7)));
    assert!(bebop.cover.as_deref().is_some_and(|c| c.starts_with("data:image/png;base64,")), "the little picture came along");
    assert!(items.iter().all(|i| i.title != "Das wandelnde Schloss"));
    // And it is on disk: the file the website reads.
    let on_disk = read_shared(&std::fs::read(dir.path().join("Merkliste.sqlite")).unwrap(), &mut Ids::system()).unwrap();
    assert!(on_disk.items.iter().any(|i| i.title == "Cowboy Bebop"));
}

#[gpui::test]
fn one_series_is_recommended_from_its_own_page_whatever_its_stand(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    // Dark is finished: the usual choice (Am Schauen) would leave it out.
    w.press(Role::ListItem, "Dark");
    w.press(Role::Button, "Empfehlen");
    assert!(w.tree().find(Role::Dialog, "Serie empfehlen").is_some());
    assert!(w.tree().find(Role::Button, "Am Schauen mitnehmen, 1 Serien").is_none(), "no choice of stands for one series");
    let (links, text) = w.cx.read_entity(&w.shell, |s, _| s.share_outputs());
    let list = sondra_merk::share::decode_share(sondra_merk::share::shared_from_hash(&links[0][links[0].find('#').unwrap()..]).unwrap()).unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].title, "Dark");
    assert!(!text.contains("Frieren"));
    // The list's own „Teilen …“ afterwards is the whole choice again.
    w.press(Role::Button, "Schliessen");
    w.press(Role::Button, "Zurück zur Merkliste");
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "Teilen …");
    assert!(w.tree().find(Role::Dialog, "Merkliste teilen").is_some());
    assert!(w.tree().find(Role::Button, "Am Schauen mitnehmen, 1 Serien").is_some());
}

#[gpui::test]
fn a_shared_list_handed_to_the_program_opens_the_window_for_receiving(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    let mut ids = Ids::system();
    let theirs = vec![normalize(&json!({ "id": "c", "title": "Cowboy Bebop", "status": "watching", "season": 1, "episode": 7 }), &mut ids)];
    let shared = sondra_merk::share::shareable_list(&theirs, "Mia", true, &std::collections::HashMap::new());
    let file = dir.path().join("Mia.sondra-liste");
    std::fs::write(&file, sondra_merk::share::share_file(&shared)).unwrap();
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![file], cx));
    w.draw();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Merkliste);
    assert!(w.tree().find(Role::Dialog, "Liste empfangen").is_some());
    assert!(w.tree().find(Role::Button, "Cowboy Bebop aufnehmen").is_some());
    // A file that is no list says so and takes nothing.
    let broken = dir.path().join("kaputt.sondra-liste");
    std::fs::write(&broken, b"nichts").unwrap();
    w.shell.update(w.cx, |s, cx| s.open_paths(vec![broken], cx));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("keine Liste"))));
    assert!(w.tree().find(Role::Button, "Cowboy Bebop aufnehmen").is_none());
}

#[gpui::test]
fn the_start_page_leads_back_to_what_is_watched(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    // Nothing is watched: the heading is not there.
    let mut w = open(cx, Some(&Stored { items: Vec::new(), ..Default::default() }), dir.path());
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Start, cx));
    w.draw();
    assert!(w.tree().find(Role::Heading, "Heute weiterschauen").is_none());
}

#[gpui::test]
fn what_is_watched_is_one_click_from_the_start_page(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let mut w = open(cx, Some(&list(3)), dir.path());
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Start, cx));
    w.draw();
    assert!(w.tree().find(Role::Heading, "Heute weiterschauen").is_some());
    // Frieren is being watched (Dark is done, Mob Psycho 100 is for later).
    assert_eq!(said(&w.tree(), Role::ListItem, "Frieren"), "Staffel 1, Folge 4. Weiter");
    assert!(w.tree().find(Role::ListItem, "Dark").is_none());
    w.press(Role::ListItem, "Frieren");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Merkliste);
    assert!(w.tree().find(Role::Heading, "Frieren").is_some(), "the series' own page is open");
}
