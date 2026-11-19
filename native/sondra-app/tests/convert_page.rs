//! The Umwandeln page with the real FFmpeg: files chosen, a format or a template, converted one after the
//! other with a way to see and stop it, and what came out offered to play. Skipped without FFmpeg.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
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

fn tone(dir: &Path, name: &str) -> PathBuf {
    let ff = Ffmpeg::locate().unwrap();
    let path = dir.join(name);
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2"]).arg(&path).output().unwrap();
    assert!(out.status.success());
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
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Converter, cx));
    w.draw();
    w
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
    /// Draws again until the work is done (or a while has passed).
    fn until_done(&mut self) {
        for _ in 0..400 {
            self.cx.run_until_parked();
            self.draw();
            if self.tree().find(Role::Heading, "Fertig").is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

#[gpui::test]
fn files_are_converted_one_after_the_other_and_offered_in_a_list(cx: &mut TestAppContext) {
    if Ffmpeg::locate().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let a = tone(tmp.path(), "eins.wav");
    let b = tone(tmp.path(), "zwei.wav");
    let out = tmp.path().join("raus");
    let mut w = open(cx);
    assert!(w.tree().find(Role::Heading, "Umwandeln").is_some());
    assert!(w.tree().find(Role::Button, "Dateien wählen").is_some());
    w.shell.update(w.cx, |shell, cx| {
        shell.convert_take(vec![a, b], cx);
        shell.convert_into(out.clone());
    });
    w.draw();
    let tree = w.tree();
    assert!(tree.find(Role::Button, "Format MP3: Überall abspielbar").unwrap().toggled == Some(true), "MP3 is the one the website starts with");
    assert!(tree.find(Role::Button, "Vorlage Hörbuch: Sprache, klein und gut verständlich").is_some() || tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("Vorlage Hörbuch"))));
    w.press(Role::Button, "256 kbit/s");
    w.press(Role::Button, "Umwandeln");
    w.until_done();
    assert!(w.tree().find(Role::Heading, "Fertig").is_some());
    let mut names: Vec<String> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, ["eins.mp3", "zwei.mp3"], "both, named after their sources, in the folder chosen");
    assert!(w.tree().find(Role::ListItem, "eins.mp3").is_some());
    assert!(w.tree().find(Role::Button, "eins.mp3 abspielen").is_some());
    // The result is a real MP3 with the length of the source.
    let probe = Ffmpeg::locate().unwrap().probe(&out.join("eins.mp3")).unwrap();
    assert!(probe.format.contains("mp3"));
    assert!((1.8..=2.4).contains(&probe.duration.unwrap()));
}

#[gpui::test]
fn what_cannot_be_converted_is_said_in_a_sentence_and_the_others_still_are(cx: &mut TestAppContext) {
    if Ffmpeg::locate().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let good = tone(tmp.path(), "gut.wav");
    let bad = tmp.path().join("kaputt.wav");
    std::fs::write(&bad, "das ist kein Ton").unwrap();
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| {
        shell.convert_take(vec![bad, good], cx);
        shell.convert_choose_format("flac", cx);
        shell.convert_into(tmp.path().join("raus"));
    });
    w.draw();
    w.press(Role::Button, "Umwandeln");
    w.until_done();
    let tree = w.tree();
    assert!(tree.nodes.iter().any(|n| n.description.as_ref().is_some_and(|d| d.starts_with("Nicht umgewandelt: Die Datei ist beschädigt"))), "the broken one says why");
    assert!(tree.find(Role::ListItem, "gut.flac").is_some(), "and the good one was made");
    assert!(tmp.path().join("raus/gut.flac").exists());
}
