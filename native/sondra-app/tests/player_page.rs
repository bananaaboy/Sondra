//! The Abspielen page in GPUI's test window, with real files and the real FFmpeg: the stage, the controls,
//! the clock that runs, pause, a jump by the keyboard, a list of files, a subtitle beside the film.
//! Skipped where there is no FFmpeg.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AppContext as _, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::Ffmpeg;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn film(dir: &Path, name: &str, seconds: u32) -> PathBuf {
    let ff = Ffmpeg::locate().unwrap();
    let path = dir.join(name);
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", &seconds.to_string()])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    path
}

fn open(cx: &mut TestAppContext) -> Window<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Player, cx));
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
    /// Lets a real second pass the way a window does: drawn again and again.
    fn watch(&mut self, seconds: f64) {
        let until = std::time::Instant::now() + Duration::from_secs_f64(seconds);
        while std::time::Instant::now() < until {
            self.draw();
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    fn position(&self) -> f64 {
        self.cx.read_entity(&self.shell, |s, _| s.player_position()).unwrap_or(-1.0)
    }
}

fn has_ffmpeg() -> bool {
    Ffmpeg::locate().is_some()
}

#[gpui::test]
fn an_empty_player_offers_a_file_and_a_film_plays_with_its_picture_and_controls(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "Frieren S01E01.mp4", 4);
    let mut w = open(cx);
    assert!(w.tree().find(Role::Heading, "Abspielen").is_some());
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some());
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(1.2);
    let tree = w.tree();
    assert!(tree.find(Role::Button, "Pause").is_some(), "it plays: the button offers the pause");
    assert!(w.cx.read_entity(&w.shell, |s, _| s.player_has_picture()), "a picture reached the stage");
    let pos = w.position();
    assert!((0.7..=1.9).contains(&pos), "about a second in: {pos}");
    let seek = tree.find(Role::Slider, "Stelle im Film").unwrap();
    assert!(seek.value.as_ref().is_some_and(|v| v.ends_with("von 0:04")), "{:?}", seek.value);
    assert_eq!(tree.find(Role::Slider, "Lautstärke").unwrap().value.as_ref().map(|v| v.to_string()), Some("100 Prozent".to_string()));
    assert!(tree.find(Role::Button, "Tempo ändern, jetzt Normal").is_some());
    assert!(tree.find(Role::Button, "Stumm").is_some());
}

#[gpui::test]
fn pause_holds_the_clock_and_the_keyboard_on_the_bar_jumps(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "film.mp4", 20);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(0.8);
    w.press(Role::Button, "Pause");
    let held = w.position();
    w.watch(0.5);
    assert!((w.position() - held).abs() < 0.06, "{held} → {}", w.position());
    assert!(w.tree().find(Role::Button, "Abspielen").is_some(), "and the button offers to go on");
    w.press(Role::Button, "Abspielen");

    // A key on the bar steps by ten seconds of a film of twenty: half of it.
    let bar = w.tree().find(Role::Slider, "Stelle im Film").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: bar, data: None }, window, cx)
    });
    w.cx.simulate_keystrokes("right");
    w.watch(0.8);
    assert!(w.position() >= 10.0, "it jumped: {}", w.position());
    assert!(w.cx.read_entity(&w.shell, |s, _| s.player_has_picture()));
}

#[gpui::test]
fn a_list_of_files_plays_one_after_the_other_and_a_subtitle_beside_a_film_goes_with_it(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "Folge 1.mp4", 3);
    let two = film(tmp.path(), "Folge 2.mp4", 3);
    std::fs::write(tmp.path().join("Folge 1.de.srt"), "1\n00:00:00,500 --> 00:00:02,000\nGuten Tag.\n\n2\n00:00:02,000 --> 00:00:02,900\nAuf Wiedersehen.\n").unwrap();
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one, two], cx));
    w.watch(0.4);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 2, "the subtitle of the same name was found");
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Liste").is_some());
    assert!(tree.find(Role::ListItem, "Folge 1.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
    // The next one by the button.
    w.press(Role::Button, "Weiter");
    w.watch(0.4);
    assert!(w.tree().find(Role::ListItem, "Folge 2.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 0, "the second has none");
    // And the first at its end goes on by itself: from the second, back by a click on the list.
    w.press(Role::ListItem, "Folge 1.mp4");
    w.watch(0.3);
    assert!(w.tree().find(Role::ListItem, "Folge 1.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
}

#[gpui::test]
fn what_is_not_a_film_is_said_and_a_missing_file_is_too(cx: &mut TestAppContext) {
    let mut w = open(cx);
    let tmp = tempfile::tempdir().unwrap();
    let text = tmp.path().join("notizen.txt");
    std::fs::write(&text, "nur Text").unwrap();
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![text], cx));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("nichts, was sich abspielen lässt"))));
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some(), "and the way in stays");
}
