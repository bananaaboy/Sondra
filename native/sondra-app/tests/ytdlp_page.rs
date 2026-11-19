//! The Herunterladen page and yt-dlp: an address with nothing of Sondra's own behind it offers to fetch
//! yt-dlp (only on a click, checked against its published sum), and then loads through it. The program is a
//! stand-in (`fake-ytdlp`) that answers like yt-dlp does.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sha2::{Digest, Sha256};
use sondra_extract::fetch::UreqFetch;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

/// A page with nothing to load, and the release files: the sums and the program (the stand-in).
fn server(program: &'static [u8], claimed: String) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            let header = |n: &str, v: &str| tiny_http::Header::from_bytes(n, v).unwrap();
            if url.ends_with("SHA2-256SUMS") {
                let _ = request.respond(tiny_http::Response::from_string(format!("{claimed}  {}\n", sondra_download::ytdlp::asset_name())));
            } else if url.contains("/release/") {
                let _ = request.respond(tiny_http::Response::from_data(program.to_vec()));
            } else if url.starts_with("/seite") {
                let _ = request.respond(tiny_http::Response::from_string("<html><body>Nichts zu laden</body></html>").with_header(header("Content-Type", "text/html")));
            } else {
                let _ = request.respond(tiny_http::Response::empty(404));
            }
        }
    });
    format!("http://127.0.0.1:{port}")
}

fn open<'a>(cx: &'a mut TestAppContext, folder: &std::path::Path, tools: &std::path::Path, releases: String) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (folder, tools) = (folder.to_path_buf(), tools.to_path_buf());
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.download_with(Arc::new(|| Box::new(UreqFetch::default())), true, folder);
        shell.download_ytdlp_with(tools, releases);
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
    fn said(&self, needle: &str) -> bool {
        self.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains(needle)))
    }
    fn settle(&mut self, until: impl Fn(&Window<'_>) -> bool) {
        for _ in 0..300 {
            self.cx.run_until_parked();
            self.draw();
            if until(self) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

fn program() -> &'static [u8] {
    Box::leak(std::fs::read(env!("CARGO_BIN_EXE_fake-ytdlp")).expect("the stand-in").into_boxed_slice())
}

fn sum(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[gpui::test]
fn yt_dlp_is_offered_fetched_on_a_click_and_then_loads_the_address(cx: &mut TestAppContext) {
    let (folder, tools) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let bytes = program();
    let base = server(bytes, sum(bytes));
    let mut w = open(cx, folder.path(), tools.path(), format!("{base}/release/"));

    w.shell.update(w.cx, |shell, cx| shell.download_set_input(&format!("{base}/seite"), cx));
    w.press(Role::Button, "Suchen");
    w.settle(|w| w.tree().find(Role::Button, "yt-dlp laden").is_some());
    assert!(w.said("keine Quelle gefunden"));
    assert!(w.tree().find(Role::Button, "yt-dlp laden").is_some(), "the offer stands there, nothing was fetched by itself");
    assert!(!tools.path().join(sondra_download::ytdlp::own_name()).exists());

    w.press(Role::Button, "yt-dlp laden");
    w.settle(|w| w.said("Über yt-dlp"));
    assert!(tools.path().join(sondra_download::ytdlp::own_name()).exists());
    assert!(w.tree().find(Role::Button, "yt-dlp laden").is_none(), "the offer is gone once it is there");

    w.press(Role::Button, "Laden");
    w.settle(|w| w.tree().find(Role::Heading, "Geladen").is_some());
    assert_eq!(std::fs::metadata(folder.path().join("Ein Film.mp4")).unwrap().len(), 4000);
    assert!(w.tree().find(Role::Button, "Abspielen").is_some());
}

#[gpui::test]
fn a_program_that_does_not_match_the_published_sum_is_not_kept(cx: &mut TestAppContext) {
    let (folder, tools) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let base = server(program(), "0".repeat(64));
    let mut w = open(cx, folder.path(), tools.path(), format!("{base}/release/"));
    w.shell.update(w.cx, |shell, cx| shell.download_set_input(&format!("{base}/seite"), cx));
    w.press(Role::Button, "Suchen");
    w.settle(|w| w.tree().find(Role::Button, "yt-dlp laden").is_some());
    w.press(Role::Button, "yt-dlp laden");
    w.settle(|w| w.said("Prüfsumme"));
    assert!(w.said("Prüfsumme"));
    assert!(!tools.path().join(sondra_download::ytdlp::own_name()).exists());
    assert!(w.tree().find(Role::Button, "Laden").is_none());
}
