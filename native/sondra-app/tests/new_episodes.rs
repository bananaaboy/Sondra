//! Neue Folgen melden: a round looks at the series „Am Schauen“ with an AniWorld address, the first look only
//! notes where a series stands, a later episode is announced once on a card, and „Ansehen“ opens the series.
//! Against stand-in pages whose newest episode the test moves.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use serde_json::json;
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::MerkStore;
use sondra_extract::fetch::Fetch;
use sondra_extract::testing::Pages;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::sqlite::{write_sqlite, Snapshot as Stored};
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

const WIDTH: f32 = 1280.;

/// The site with Frieren whose newest episode is `newest` (season 1 is counted on the series page itself).
fn site(newest: u32) -> Box<dyn Fetch> {
    let row = |n: u32| format!(r#"<tr data-episode-id="{n}"><td><meta itemprop="episodeNumber" content="{n}" /><a href="/anime/stream/frieren/staffel-1/episode-{n}">Folge {n}</a></td></tr>"#);
    let page = format!(r#"<div class="series-title"><h1 itemprop="name"><span>Frieren</span></h1></div><a href="/anime/stream/frieren/staffel-1" title="Staffel 1">1</a>{}{}"#, row(1), row(newest));
    Box::new(Pages::new(&[("https://aniworld.to/anime/stream/frieren", page.as_str())]))
}

fn list() -> Stored {
    let mut ids = Ids::system();
    let items = vec![
        normalize(&json!({ "id": "fr", "title": "Frieren", "status": "watching", "url": "https://aniworld.to/anime/stream/frieren", "season": 1, "episode": 4, "updatedAt": 1000 }), &mut ids),
        normalize(&json!({ "id": "dk", "title": "Dark", "status": "done", "url": "https://aniworld.to/anime/stream/dark" }), &mut ids),
        normalize(&json!({ "id": "mp", "title": "Mob Psycho 100", "status": "watching" }), &mut ids),
    ];
    Stored { items, ..Default::default() }
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
    fn round(&mut self) {
        self.shell.update(self.cx, |shell, cx| shell.new_episodes_round(cx));
        for _ in 0..200 {
            self.cx.run_until_parked();
            self.draw();
            if !self.shell.read_with(self.cx, |shell, _| shell.new_episodes_running()) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the round did not end");
    }
}

#[gpui::test]
fn a_later_episode_is_announced_once_and_ansehen_opens_the_series(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DATA", dir.path());
    let path = dir.path().join("Merkliste.sqlite");
    std::fs::write(&path, write_sqlite(&list()).unwrap()).unwrap();
    let newest = Arc::new(AtomicU32::new(12));

    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let n = newest.clone();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(path), cx);
        shell.new_episodes_for_test(true);
        shell.download_with(Arc::new(move || site(n.load(Ordering::SeqCst))), true, std::env::temp_dir());
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();

    // The first look only notes where the series stands.
    w.round();
    assert!(w.shell.read_with(w.cx, |s, _| s.announcements()).is_empty());
    let frieren = w.shell.read_with(w.cx, |s, _| s.merk_items()).into_iter().find(|i| i.id == "fr").unwrap();
    let online = frieren.online_available.expect("it learned how far the series is");
    assert_eq!((online.max_season, online.max_episode), (1, 12));
    assert_eq!(frieren.updated_at, 1000, "a look is not a change of the entry");
    let dark = w.shell.read_with(w.cx, |s, _| s.merk_items()).into_iter().find(|i| i.id == "dk").unwrap();
    assert!(dark.online_available.is_none(), "a finished series is not looked at");

    // The same again: nothing is new.
    w.round();
    assert!(w.shell.read_with(w.cx, |s, _| s.announcements()).is_empty());

    // A newer episode: one card.
    newest.store(13, Ordering::SeqCst);
    w.round();
    let notes = w.shell.read_with(w.cx, |s, _| s.announcements());
    assert_eq!(notes.len(), 1);
    assert_eq!((notes[0].title.as_str(), notes[0].season, notes[0].episode), ("Frieren", 1, 13));
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Neue Folge: Frieren"))));

    // It is not announced again, after the card is closed or in a later round.
    w.press(Role::Button, "Meldung zu Frieren schließen");
    w.round();
    assert!(w.shell.read_with(w.cx, |s, _| s.announcements()).is_empty());

    // The next one is, and „Ansehen“ opens the series.
    newest.store(14, Ordering::SeqCst);
    w.round();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.announcements()).len(), 1);
    w.press(Role::Button, "Frieren ansehen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Merkliste);
    assert!(w.shell.read_with(w.cx, |s, _| s.announcements()).is_empty());
    assert!(w.tree().find(Role::Heading, "Frieren").is_some(), "the page of the series");

    // A notification of the system says the same as the card, and a click on it opens the series too.
    newest.store(15, Ordering::SeqCst);
    w.round();
    w.shell.update(w.cx, |shell, cx| {
        shell.go(Panel::Start, cx);
    });
    w.draw();
    let lines = w.shell.read_with(w.cx, |s, _| s.attention_lines_for_test());
    assert_eq!(lines, [("Neue Folge: Frieren".to_string(), "Staffel 1, Folge 15 ist auf AniWorld erschienen.".to_string())]);
    w.shell.read_with(w.cx, |s, _| s.tray_notification_clicked_for_test());
    w.draw();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Merkliste);
    assert!(w.shell.read_with(w.cx, |s, _| s.announcements()).is_empty(), "the card is gone once it is opened");
}
