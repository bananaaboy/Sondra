//! The Lautstärke page with the real FFmpeg: a sound measured, brought to a target, written beside the source.

use std::cell::RefCell;
use std::path::PathBuf;
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::audio::decode_file;
use sondra_media::loudness::measure_loudness;
use sondra_media::Ffmpeg;
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
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn wait_for(&mut self, role: Role, label: &str) {
        for _ in 0..400 {
            self.cx.run_until_parked();
            self.draw();
            if self.tree().find(role, label).is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{label} did not come");
    }
}

#[gpui::test]
fn a_quiet_sound_is_measured_and_brought_to_the_target_without_touching_the_original(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let src: PathBuf = tmp.path().join("leise.wav");
    // A quiet tone: a tenth of full scale, five seconds.
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-af", "volume=0.15", "-ac", "2", "-t", "5"]).arg(&src).output().unwrap();
    assert!(out.status.success());
    let before = std::fs::read(&src).unwrap();

    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, vcx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx: vcx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Normalize, cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some());
    w.shell.update(w.cx, |shell, cx| shell.normalize_take(src.clone(), cx));
    w.draw();
    // Measured: the facts stand on the page.
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().find(Role::Button, "Ziel Streaming (Spotify, Apple), −14 LUFS").is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(w.tree().find(Role::Button, "Ziel Streaming (Spotify, Apple), −14 LUFS").is_some());
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("Jetzt: −"))), "it says how loud the sound is now");
    w.press(Role::Button, "Ziel Podcast, −16 LUFS");
    w.press(Role::Button, "Auf −16 LUFS bringen");
    w.wait_for(Role::Heading, "Fertig");
    let made = tmp.path().join("leise (angeglichen).flac");
    assert!(made.exists(), "written beside the source");
    assert_eq!(std::fs::read(&src).unwrap(), before, "the original is as it was");
    // And it really is at the target.
    let report = measure_loudness(&decode_file(&ff, &made, None).unwrap(), &mut |_| {});
    assert!((report.integrated_lufs + 16.0).abs() < 0.6, "about −16 LUFS: {}", report.integrated_lufs);
    assert!(report.true_peak_dbtp <= -0.9, "and not over the ceiling: {}", report.true_peak_dbtp);
    assert!(w.tree().find(Role::Button, "leise (angeglichen).flac abspielen").is_some());
}
