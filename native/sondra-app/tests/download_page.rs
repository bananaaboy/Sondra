//! The Herunterladen page: an address typed in, what is behind it found, loaded into a folder with the way
//! there in view, and offered to play. Against a server on this computer.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AppContext as _, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_extract::fetch::UreqFetch;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

/// A server that serves one file of this many bytes at `/lied.mp3`, and a page that is not a media page.
fn server(bytes: usize) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let header = |n: &str, v: &str| tiny_http::Header::from_bytes(n, v).unwrap();
            match request.url().split('?').next().unwrap_or("") {
                "/lied.mp3" => {
                    let body = vec![7u8; bytes];
                    let _ = request.respond(tiny_http::Response::from_data(body).with_header(header("Content-Type", "audio/mpeg")));
                }
                "/seite" => {
                    let _ = request.respond(tiny_http::Response::from_string("<html><body>Nichts zu laden</body></html>").with_header(header("Content-Type", "text/html")));
                }
                _ => {
                    let _ = request.respond(tiny_http::Response::empty(404));
                }
            }
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn open<'a>(cx: &'a mut TestAppContext, folder: &std::path::Path) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let folder = folder.to_path_buf();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.download_with(Arc::new(|| Box::new(UreqFetch::default())), true, folder);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Downloader, cx));
    w.draw();
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
    fn type_address(&mut self, text: &str) {
        let field = self.tree().find(Role::TextInput, "Adresse").unwrap().id;
        self.cx.update(|window, cx| {
            run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx)
        });
        self.cx.simulate_input(text);
        self.draw();
    }
    fn said(&self, needle: &str) -> bool {
        self.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)))
    }
}

#[gpui::test]
fn an_address_of_a_file_is_found_loaded_into_the_folder_and_offered_to_play(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(300_000);
    let mut w = open(cx, tmp.path());
    assert!(w.tree().find(Role::Heading, "Herunterladen").is_some());
    // The honest line stands on the page: this does not run locally.
    assert!(w.said("läuft nicht lokal"));
    assert!(w.tree().find(Role::Button, "Suchen").is_some());

    w.type_address(&format!("{base}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.tree().find(Role::Heading, "lied").is_some(), "found: the file's own name");
    assert!(w.tree().find(Role::Button, "Laden").is_some());

    w.press(Role::Button, "Laden");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.tree().find(Role::Heading, "Geladen").is_some(), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    let file = tmp.path().join("lied.mp3");
    assert_eq!(std::fs::metadata(&file).unwrap().len(), 300_000);
    assert!(w.tree().find(Role::Button, "Abspielen").is_some());
    assert!(w.tree().find(Role::Button, "Im Ordner zeigen").is_some());
    // The address is cleared for the next one.
    assert!(w.tree().find(Role::Button, "Laden").is_none());

    // Loading it again does not replace what is there.
    w.type_address(&format!("{base}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    w.press(Role::Button, "Laden");
    w.cx.run_until_parked();
    w.draw();
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2, "an existing file is never replaced: the second got a number");
    assert_eq!(std::fs::metadata(tmp.path().join("lied.mp3")).unwrap().len(), 300_000);

    // „Stream sofort abspielen“: the player reads the address, nothing is saved.
    w.type_address(&format!("{base}/film.mp4"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    w.press(Role::Button, "Stream sofort abspielen, ohne zu laden");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.panel()), Panel::Player);
    let shown = w.cx.read_entity(&w.shell, |s, _| s.player_queue_now());
    assert_eq!(sondra_playback::source_of(&shown[0]).0, std::path::PathBuf::from(format!("{base}/film.mp4")));
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2, "nothing was saved");
}

#[gpui::test]
fn what_is_no_address_and_what_has_nothing_to_load_is_said(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(10);
    let mut w = open(cx, tmp.path());
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.said("Geben Sie eine Adresse ein"));
    w.type_address("kein link");
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.said("keine Adresse"));
    w.shell.update(w.cx, |shell, cx| shell.download_set_input(&format!("{base}/seite"), cx));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.said("keine Quelle gefunden"), "a page with nothing behind it says so");
    assert!(w.tree().find(Role::Button, "Laden").is_none());
}

#[gpui::test]
fn a_pasted_list_is_found_address_by_address_and_loaded_in_turn(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(50_000);
    let mut w = open(cx, tmp.path());
    // Two files, one page with nothing behind it, and the first again: it counts once.
    w.shell.update(w.cx, |shell, cx| {
        shell.download_set_input(&format!("{base}/lied.mp3, {base}/lied.mp3?zweite=1; {base}/seite {base}/lied.mp3"), cx)
    });
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.said("2 Quellen gefunden"), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    assert!(w.said("keine Quelle gefunden"), "the page that gave nothing is named");
    assert!(w.tree().find(Role::Button, "Laden").is_none(), "one button for the list, not one for the first");

    w.press(Role::Button, "Alle laden");
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if std::fs::read_dir(tmp.path()).unwrap().count() == 2 && w.tree().find(Role::Button, "Alle laden").is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2, "both were loaded, the second under its own number: {:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    assert!(w.tree().find(Role::Heading, "Geladen").is_some());
}

/// A reader that gives a file slowly, so a download is still running when another page is opened.
struct Slow {
    left: usize,
}

impl std::io::Read for Slow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 {
            return Ok(0);
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
        let n = buf.len().min(8_000).min(self.left);
        buf[..n].fill(7);
        self.left -= n;
        Ok(n)
    }
}

#[gpui::test]
fn a_download_goes_on_behind_another_page_and_a_small_card_says_so_and_leads_back(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let header = tiny_http::Header::from_bytes("Content-Type", "audio/mpeg").unwrap();
            let body = Slow { left: 160_000 };
            let _ = request.respond(tiny_http::Response::new(tiny_http::StatusCode(200), vec![header], body, Some(160_000), None));
        }
    });
    let mut w = open(cx, tmp.path());
    w.type_address(&format!("http://127.0.0.1:{port}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    w.press(Role::Button, "Laden");
    // On its own page the card is not there: the page shows the way.
    assert!(w.tree().find(Role::Button, "Zum Herunterladen").is_none());
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Merkliste, cx));
    w.draw();
    assert!(w.said("Lädt: lied"), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    assert!(w.tree().find(Role::Button, "Abbrechen").is_some());
    w.press(Role::Button, "Zum Herunterladen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Downloader);
    assert!(w.tree().find(Role::Button, "Zum Herunterladen").is_none());
    // It finishes by itself, and the file is whole.
    for _ in 0..300 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().find(Role::Heading, "Geladen").is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    assert_eq!(std::fs::metadata(tmp.path().join("lied.mp3")).unwrap().len(), 160_000);
}

#[gpui::test]
fn a_download_can_be_held_and_goes_on_where_it_stopped(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let header = tiny_http::Header::from_bytes("Content-Type", "audio/mpeg").unwrap();
            let body = Slow { left: 160_000 };
            let _ = request.respond(tiny_http::Response::new(tiny_http::StatusCode(200), vec![header], body, Some(160_000), None));
        }
    });
    let mut w = open(cx, tmp.path());
    w.type_address(&format!("http://127.0.0.1:{port}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    w.press(Role::Button, "Laden");
    w.draw();
    assert!(w.tree().find(Role::Button, "Anhalten").is_some());
    assert!(w.tree().find(Role::Button, "Fortsetzen").is_none());
    w.press(Role::Button, "Anhalten");
    w.draw();
    assert!(w.tree().find(Role::Button, "Fortsetzen").is_some());
    assert!(w.said("Angehalten: lied"));
    // Held, the file does not grow: the part file keeps its size over a stretch of time.
    let size = |dir: &std::path::Path| std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().metadata().unwrap().len()).sum::<u64>();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let before = size(tmp.path());
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(size(tmp.path()), before, "it grew while held");
    assert!(before < 160_000);
    w.press(Role::Button, "Fortsetzen");
    for _ in 0..400 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().find(Role::Heading, "Geladen").is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    assert_eq!(std::fs::metadata(tmp.path().join("lied.mp3")).unwrap().len(), 160_000);
}

#[gpui::test]
fn what_is_loaded_how_it_is_named_and_merken_put_it_on_the_list(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(300_000);
    let mut w = open(cx, tmp.path());
    // The choices of the website stand in the settings column.
    for label in ["Video mit Ton", "Nur Ton", "Beste", "720p", "Sprache automatisch", "Deutsch (Dub)", "Originaltitel", "Neutral (media_…)", "Wie eine Office-Datei"] {
        assert!(w.tree().find(Role::Button, label).is_some(), "{label}");
    }
    w.press(Role::Button, "Nur Ton");
    assert!(w.tree().find(Role::Button, "Mittel (192 kbps)").is_some(), "for the sound, its quality");
    w.press(Role::Button, "Video mit Ton");
    // A neutral name: the file is not called what it is.
    w.press(Role::Button, "Neutral (media_…)");
    w.type_address(&format!("{base}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    // „Merken“ puts the address on the Merkliste.
    w.press(Role::Button, "Auf die Merkliste setzen, mit Staffel und Folge");
    let items = w.shell.read_with(w.cx, |s, _| s.merk_items());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].url, format!("{base}/lied.mp3"));
    w.press(Role::Button, "Laden");
    w.cx.run_until_parked();
    w.draw();
    let names: Vec<String> = std::fs::read_dir(tmp.path()).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with('.')).collect();
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].starts_with("media_") && names[0].ends_with(".mp3"), "{names:?}");
}

#[gpui::test]
fn an_address_in_the_clipboard_is_offered_and_only_taken_on_a_click(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(1000);
    let mut w = open(cx, tmp.path());
    w.shell.update(w.cx, |shell, cx| shell.go(sondra_app::nav::Panel::Start, cx));
    w.cx.write_to_clipboard(gpui::ClipboardItem::new_string(format!("schau mal: {base}/lied.mp3")));
    w.shell.update(w.cx, |shell, cx| shell.go(sondra_app::nav::Panel::Downloader, cx));
    w.draw();
    assert!(w.said("In der Zwischenablage"));
    assert!(w.tree().find(Role::Button, "Laden").is_none(), "nothing is looked up by itself");
    w.press(Role::Button, "Einfügen und nachsehen");
    w.cx.run_until_parked();
    w.draw();
    assert!(w.tree().find(Role::Button, "Laden").is_some());
    // Turned down, the same address is not offered again.
    w.shell.update(w.cx, |shell, cx| {
        shell.download_set_input("", cx);
        shell.go(sondra_app::nav::Panel::Start, cx);
        shell.go(sondra_app::nav::Panel::Downloader, cx);
    });
    w.draw();
    w.press(Role::Button, "Nicht jetzt");
    w.shell.update(w.cx, |shell, cx| {
        shell.go(sondra_app::nav::Panel::Start, cx);
        shell.go(sondra_app::nav::Panel::Downloader, cx);
    });
    w.draw();
    assert!(!w.said("In der Zwischenablage"));
}

#[gpui::test]
fn a_loaded_file_goes_into_the_session_is_kept_under_zuletzt_and_links_come_from_a_file(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let base = server(50_000);
    let mut w = open(cx, tmp.path());
    // What is said under the field: the portals behind „alle zeigen“, and what is allowed.
    assert!(w.said("Bitte nur laden, was erlaubt ist"));
    assert!(!w.said("Bandcamp"));
    w.press(Role::Button, "Alle Portale zeigen");
    assert!(w.said("Bandcamp"));
    // „In die Sitzung legen“ after the load.
    w.press(Role::Button, "In die Sitzung legen");
    w.type_address(&format!("{base}/lied.mp3"));
    w.press(Role::Button, "Suchen");
    w.cx.run_until_parked();
    w.draw();
    w.press(Role::Button, "Laden");
    w.cx.run_until_parked();
    w.draw();
    let file = tmp.path().join("lied.mp3");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.session_files()), vec![file.clone()]);
    // „Zuletzt geladen“ keeps it, with the way to load it again.
    let recent = w.shell.read_with(w.cx, |s, _| s.download_recent().to_vec());
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, file);
    assert_eq!(recent[0].address.as_deref(), Some(format!("{base}/lied.mp3").as_str()));
    assert!(w.tree().find(Role::Heading, "Zuletzt geladen").is_some());
    assert!(w.tree().find(Role::Button, "lied wieder laden").is_some() || w.said("Wieder laden"));
    // A text file with links: its addresses go into the field.
    let links = tmp.path().join("links.m3u");
    std::fs::write(&links, format!("#EXTM3U\n{base}/a.mp3\n{base}/b.mp3\n")).unwrap();
    w.shell.update(w.cx, |s, cx| s.dropped(vec![links], cx));
    w.draw();
    let field = w.tree().find(Role::TextInput, "Adresse").and_then(|n| n.value.as_ref().map(|v| v.to_string())).unwrap_or_default();
    assert!(field.contains("/a.mp3") && field.contains("/b.mp3"), "{field}");
}
