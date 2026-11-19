//! The Spuren-trennen page: a song chosen, a setting picked, the four stems and the karaoke version made,
//! heard one by one and written as files.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_media::audio::AudioData;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

/// A voice-like tone in the middle and a click train on the sides.
fn song(seconds: f64) -> AudioData {
    let rate = 8000u32;
    let n = (f64::from(rate) * seconds) as usize;
    let left: Vec<f32> = (0..n).map(|i| (0.4 * (i as f64 * 0.15).sin() + if i % 2000 < 40 { 0.4 } else { 0.0 }) as f32).collect();
    let right: Vec<f32> = (0..n).map(|i| (0.4 * (i as f64 * 0.15).sin() + if i % 2000 < 40 { -0.4 } else { 0.0 }) as f32).collect();
    AudioData { channels: vec![left, right], sample_rate: rate }
}

fn open<'a>(cx: &'a mut TestAppContext, name: std::path::PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.stems_load(song(3.0), name, cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1500.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Stems, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1500.))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn labels(&self) -> Vec<String> {
        self.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| AsRef::<str>::as_ref(l).to_owned())).collect()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen: {:?}", self.labels())).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn settle(&mut self, done: impl Fn(&Shell) -> bool) {
        for _ in 0..600 {
            self.cx.run_until_parked();
            self.cx.executor().advance_clock(std::time::Duration::from_millis(200));
            self.draw();
            if self.shell.read_with(self.cx, |s, _| done(s)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("did not settle: {:?}", self.labels());
    }
}

#[gpui::test]
fn a_song_is_split_heard_stem_by_stem_and_written(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("lied.wav"));
    assert!(w.tree().find(Role::Button, "Spuren trennen").is_some());
    // Nothing is made before it is asked for, and no setting is changed by itself.
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_count()), 0);

    w.press(Role::Button, "Worauf es ankommt: Gesang");
    w.press(Role::Button, "Spuren trennen");
    assert!(w.shell.read_with(w.cx, |s, _| s.stems_running()));
    w.settle(|s| s.stems_count() == 5);
    for name in ["Gesang", "Schlagzeug", "Bass", "Übriges", "Instrumental"] {
        assert!(w.labels().iter().any(|l| l == name), "{name}: {:?}", w.labels());
    }
    // Every stem has the length of the song.
    for i in 0..5 {
        assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_audio(i)).unwrap().frames(), 24_000);
    }

    w.press(Role::Button, "Gesang anhören");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_playing()), Some(0));
    w.press(Role::Button, "Gesang anhalten");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.stems_playing()), None);

    w.press(Role::Button, "Alle als WAV speichern");
    w.settle(|s| s.stems_made().len() == 5);
    let folder = tmp.path().join("lied (Spuren)");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 5);
    assert!(folder.join("lied – Instrumental.wav").exists());
}
