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
    // The shelf: the cover is asked for on the first draw, and made in the background.
    for _ in 0..80 {
        w.cx.run_until_parked();
        w.draw();
        if w.cx.read_entity(&w.shell, |s, _| s.covers_ready()) > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_asked()), 1, "one series has a cover; the other is not asked for");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_ready()), 1, "and it was made");
    // Another view is another size: asked for again, once.
    w.press(Role::Button, "Als Liste");
    for _ in 0..80 {
        w.cx.run_until_parked();
        w.draw();
        if w.cx.read_entity(&w.shell, |s, _| s.covers_ready()) > 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_ready()), 2);
    // Drawing again does not ask again.
    w.draw();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.covers_asked()), 2);
}
