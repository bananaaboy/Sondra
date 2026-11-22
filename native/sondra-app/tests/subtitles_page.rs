//! The Untertitel page: the model is fetched only when asked, from a server on this computer here; and, where
//! `SONDRA_WHISPER_DIR` holds a model and the sample voice, a real voice becomes real subtitles that are
//! written next to the file.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn open<'a>(cx: &'a mut TestAppContext, models: std::path::PathBuf, source: String, file: std::path::PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.subtitles_set_places(models, source);
        shell.subtitles_take(file, cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1800.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Subtitles, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1800.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn said(&self, needle: &str) -> bool {
        self.labels().iter().any(|l| l.contains(needle))
    }
    fn until(&mut self, what: &str, secs: u64, mut ok: impl FnMut(&Self) -> bool) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < end {
            // The page looks at its worker on a timer; a test's clock only moves when told to.
            self.cx.executor().advance_clock(std::time::Duration::from_millis(200));
            self.cx.run_until_parked();
            self.shell.update(self.cx, |_, cx| cx.notify());
            self.draw();
            if ok(self) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("gave up: {what}; {:?}", self.labels());
    }
}

fn serve(bytes: usize) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let _ = request.respond(tiny_http::Response::from_data(vec![3u8; bytes]));
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[gpui::test]
fn the_model_is_fetched_only_when_asked_and_then_the_page_offers_to_listen(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let models = tmp.path().join("Modelle");
    // The „Schnell“ model is 59,707,625 bytes: a server holding as many.
    let mut w = open(cx, models.clone(), serve(59_707_625), tmp.path().join("Film.mp4"));
    assert!(w.tree().find(Role::Heading, "Untertitel").is_some());
    assert!(w.said("Das Sprachmodell fehlt noch"));
    assert!(w.said("nur das Modell, nie Ihr Ton"));
    assert!(w.tree().find(Role::Button, "Untertitel erzeugen").is_none(), "nothing to listen with yet");
    assert!(!models.exists(), "nothing fetched by itself");
    w.press(Role::Button, "Modell laden (60 MB)");
    w.until("the model arrived", 120, |w| w.tree().find(Role::Button, "Untertitel erzeugen").is_some());
    assert_eq!(std::fs::metadata(models.join("ggml-base-q5_1.bin")).unwrap().len(), 59_707_625);
    // Another model is another file to fetch.
    w.press(Role::Button, "Modell Genauer");
    assert!(w.said("Das Sprachmodell fehlt noch"));
}

#[gpui::test]
fn a_real_voice_becomes_subtitles_that_are_written_beside_the_file(cx: &mut TestAppContext) {
    let Some(dir) = std::env::var_os("SONDRA_WHISPER_DIR").map(std::path::PathBuf::from) else {
        eprintln!("skipped: SONDRA_WHISPER_DIR is not set");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("Rede.wav");
    std::fs::copy(dir.join("jfk.wav"), &file).unwrap();
    let mut w = open(cx, dir.clone(), "http://127.0.0.1:9".into(), file.clone());
    w.press(Role::Button, "Sprache Englisch");
    w.press(Role::Button, "Untertitel erzeugen");
    w.until("it listened", 120, |w| !w.shell.read_with(w.cx, |s, _| s.subtitles_running()));
    w.until("the words are on the page", 10, |w| w.said("country"));
    let text = w.shell.read_with(w.cx, |s, _| s.subtitles_segments().iter().map(|g| g.text.to_lowercase()).collect::<Vec<_>>().join(" "));
    assert!(text.contains("ask not what your country can do for you"), "{text}");
    w.press(Role::Button, "Als SRT");
    w.until("written", 20, |w| !w.shell.read_with(w.cx, |s, _| s.subtitles_made().is_empty()));
    let srt = std::fs::read_to_string(tmp.path().join("Rede.srt")).unwrap();
    assert!(srt.starts_with("1\n00:00:0"), "{srt}");
    assert!(srt.contains(" --> "));
    assert!(file.exists(), "the recording is untouched");
}

#[gpui::test]
fn a_heard_line_is_corrected_before_it_is_saved(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("Gespräch.wav");
    std::fs::write(&file, b"RIFF").unwrap();
    let mut w = open(cx, tmp.path().join("Modelle"), "http://127.0.0.1:9".into(), file.clone());
    w.shell.update(w.cx, |shell, cx| {
        shell.subtitles_put_segments(
            file.clone(),
            vec![
                sondra_speech::Segment { start: 0.0, end: 2.0, text: " Hallo Wellt".into() },
                sondra_speech::Segment { start: 2.0, end: 4.0, text: " Das bleibt.".into() },
            ],
            cx,
        )
    });
    w.draw();
    assert!(w.labels().iter().any(|l| l.contains("Jede Zeile lässt sich korrigieren")));
    w.press(Role::Button, "Zeile bei 0:00 korrigieren");
    w.shell.update(w.cx, |shell, cx| shell.subtitles_correcting_field().unwrap().update(cx, |f, cx| f.set_text("Hallo Welt", cx)));
    w.draw();
    w.press(Role::Button, "Übernehmen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.subtitles_segments()[0].text.clone()), "Hallo Welt");
    w.press(Role::Button, "Als SRT");
    for _ in 0..100 {
        w.cx.run_until_parked();
        w.draw();
        if tmp.path().join("Gespräch.srt").exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let srt = std::fs::read_to_string(tmp.path().join("Gespräch.srt")).unwrap();
    assert!(srt.contains("Hallo Welt") && !srt.contains("Wellt"), "{srt}");
}
