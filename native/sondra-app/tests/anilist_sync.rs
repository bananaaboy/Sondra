//! AniList in the Merkliste: a token checked and kept (never shown or written in the clear), the progress sent
//! when an episode is marked seen — only once it was connected and asked for — and the list read in.

use std::cell::RefCell;
use std::io::Read;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::sqlite::{write_sqlite, Snapshot as Stored};
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(900.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn click(&mut self, id: accesskit::NodeId) {
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.click(id);
    }
    fn wait(&mut self, mut done: impl FnMut(&Window) -> bool) {
        for _ in 0..200 {
            self.cx.executor().advance_clock(std::time::Duration::from_millis(300));
            self.cx.run_until_parked();
            self.draw();
            if done(self) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("did not happen: {:?}", self.labels());
    }
}

/// What the stand-in AniList was asked: the token and the GraphQL document with its variables.
type Asked = Arc<Mutex<Vec<(String, String, serde_json::Value)>>>;

fn stand_in() -> (u16, Asked) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let asked: Asked = Arc::default();
    let record = asked.clone();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let token = request.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.to_string()).unwrap_or_default();
            let mut text = String::new();
            let _ = request.as_reader().read_to_string(&mut text);
            let body: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            let query = body["query"].as_str().unwrap_or_default().to_string();
            record.lock().unwrap().push((token.clone(), query.clone(), body["variables"].clone()));
            let answer = if query.contains("Viewer") {
                if token == "Bearer gueltig" { json!({ "data": { "Viewer": { "id": 7, "name": "Mia" } } }) } else { json!({ "errors": [{ "message": "Invalid token" }] }) }
            } else if query.contains("MediaListCollection") {
                json!({ "data": { "MediaListCollection": { "lists": [{ "entries": [
                    { "progress": 12, "status": "COMPLETED", "media": { "id": 1, "siteUrl": "https://anilist.co/anime/1", "episodes": 12, "title": { "romaji": "Cowboy Bebop", "english": "Cowboy Bebop" }, "coverImage": { "large": "https://example.invalid/b.jpg" } } },
                    { "progress": 2, "status": "DROPPED", "media": { "id": 2, "episodes": null, "title": { "romaji": "Long Runner" } } },
                    { "progress": 0, "status": "PLANNING", "media": { "id": 3, "episodes": 24, "title": { "romaji": "Soon" } } },
                ] }] } } })
            } else if query.contains("SaveMediaListEntry") {
                json!({ "data": { "SaveMediaListEntry": { "id": 1, "progress": 4, "status": "CURRENT" } } })
            } else {
                json!({ "data": { "Media": { "id": 154587, "title": { "romaji": "Sousou no Frieren" }, "episodes": 12 } } })
            };
            let response = if query.contains("Viewer") && token != "Bearer gueltig" { tiny_http::Response::from_string(answer.to_string()).with_status_code(401) } else { tiny_http::Response::from_string(answer.to_string()) };
            let _ = request.respond(response);
        }
    });
    (port, asked)
}

#[gpui::test]
fn a_token_is_checked_and_kept_the_progress_goes_when_asked_for_and_the_list_comes_in(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let (port, asked) = stand_in();
    std::env::set_var("SONDRA_DATA", dir.path());
    std::env::set_var("SONDRA_ANILIST", format!("http://127.0.0.1:{port}/"));
    let mut ids = Ids::system();
    let stored = Stored {
        items: vec![normalize(&json!({ "id": "fr", "title": "Frieren", "status": "watching", "season": 1, "episode": 4, "seasons": [{ "number": 1, "episodes": 12, "watched": [1, 2, 3] }] }), &mut ids)],
        ..Default::default()
    };
    let path = dir.path().join("Merkliste.sqlite");
    std::fs::write(&path, write_sqlite(&stored).unwrap()).unwrap();
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
    w.press(Role::Button, "Als Liste");

    let plus = |w: &Window| w.tree().nodes.iter().find(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).ends_with("von Frieren als gesehen markieren"))).map(|n| n.id).expect("the +1 of Frieren");
    // Not connected: an episode marked seen asks nobody.
    let id = plus(&w);
    w.click(id);
    for _ in 0..6 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(1300));
        w.cx.run_until_parked();
    }
    assert!(asked.lock().unwrap().is_empty(), "AniList is not asked before it is connected: {:?}", asked.lock().unwrap());

    // A token AniList does not know is not kept.
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "AniList …");
    assert!(w.tree().find(Role::Dialog, "AniList").is_some());
    let field = w.tree().find(Role::PasswordInput, "AniList-Token").expect("the token field").id;
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx));
    w.cx.simulate_input("falsch");
    w.draw();
    w.press(Role::Button, "Verbinden");
    w.wait(|w| w.labels().iter().any(|l| l.contains("nimmt das Token nicht an") || l.contains("Ungültiges")));
    assert!(!dir.path().join("anilist-schluessel.bin").exists());

    // The right one: kept, and nowhere in the clear.
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx));
    w.cx.simulate_keystrokes("cmd-a ctrl-a");
    w.cx.simulate_input("gueltig");
    w.draw();
    w.press(Role::Button, "Verbinden");
    w.wait(|w| w.labels().iter().any(|l| l.contains("Verbunden als „Mia“")));
    assert!(dir.path().join("anilist-schluessel.bin").exists());
    let settings = std::fs::read_to_string(dir.path().join("AniList.json")).unwrap();
    assert!(settings.contains("Mia") && !settings.contains("gueltig"), "{settings}");
    assert!(w.tree().find(Role::PasswordInput, "AniList-Token").is_none(), "the token is never shown again");

    // Now an episode marked seen tells the account how far one is (Frieren stands at 4 of 12 after this one).
    w.press(Role::Button, "Schließen");
    let id = plus(&w);
    w.click(id);
    w.cx.executor().advance_clock(std::time::Duration::from_millis(1300));
    for _ in 0..200 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(1300));
        w.cx.run_until_parked();
        if asked.lock().unwrap().iter().any(|(_, q, _)| q.contains("SaveMediaListEntry")) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let sent = asked.lock().unwrap().iter().find(|(_, q, _)| q.contains("SaveMediaListEntry")).cloned().expect("the progress was sent");
    assert_eq!(sent.0, "Bearer gueltig");
    assert_eq!(sent.2["mediaId"], 154587);
    assert_eq!(sent.2["progress"], 5, "four were seen before the first +1 and one more now: {:?}", sent.2);
    assert_eq!(sent.2["status"], "CURRENT");

    // The list of the account comes in, merged, and can be taken back.
    w.press(Role::Button, "Mehr");
    w.press(Role::MenuItem, "AniList …");
    w.press(Role::Button, "Anime-Liste von AniList einlesen");
    w.wait(|w| w.labels().iter().any(|l| l.contains("3 Serien von AniList abgeglichen")));
    let titles: Vec<String> = w.shell.read_with(w.cx, |s, _| s.merk_items().into_iter().map(|i| i.title).collect());
    for t in ["Frieren", "Cowboy Bebop", "Long Runner", "Soon"] {
        assert!(titles.iter().any(|x| x == t), "{t}: {titles:?}");
    }
    let items = w.shell.read_with(w.cx, |s, _| s.merk_items());
    let bebop = items.iter().find(|i| i.title == "Cowboy Bebop").unwrap();
    assert_eq!(bebop.status, sondra_merk::Status::Done);
    assert_eq!(bebop.seasons.as_ref().unwrap()[0].watched.len(), 12);
    let runner = items.iter().find(|i| i.title == "Long Runner").unwrap();
    assert_eq!(runner.status, sondra_merk::Status::Paused, "AniList's dropped is a pause here, as on the website");
    assert_eq!(runner.seasons.as_ref().unwrap()[0].watched, vec![1, 2]);

    // Disconnected: the key is gone and nothing is sent any more.
    w.press(Role::Button, "Verbindung trennen");
    assert!(!dir.path().join("anilist-schluessel.bin").exists());
}
