//! The Ton page: a take on a waveform, a stretch chosen by dragging, the tools working on it, the history
//! walked back, the take played and written.

use std::cell::RefCell;
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};
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

fn tone(seconds: f64) -> AudioData {
    let rate = 8000u32;
    let n = (f64::from(rate) * seconds) as usize;
    let one: Vec<f32> = (0..n).map(|i| (0.5 * (i as f64 * 0.2).sin()) as f32).collect();
    AudioData { channels: vec![one.clone(), one], sample_rate: rate }
}

fn open<'a>(cx: &'a mut TestAppContext, name: std::path::PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.audio_load(tone(4.0), name, cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1500.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Audio, cx));
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
    fn settle(&mut self) {
        for _ in 0..200 {
            self.cx.run_until_parked();
            self.draw();
            if !self.said("Rechnet") && !self.said("Schreibt") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    fn frames(&self) -> usize {
        self.shell.read_with(self.cx, |s, _| s.audio_take().unwrap().frames())
    }
}

#[gpui::test]
fn a_stretch_is_dragged_cut_and_walked_back(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Probe.wav"));
    assert!(w.tree().find(Role::Heading, "Ton bearbeiten").is_some());
    assert!(w.tree().find(Role::Group, "Wellenform").is_some());
    assert!(w.said("Keine Auswahl"));
    assert_eq!(w.frames(), 32000);

    // A drag from a quarter to a half of the waveform.
    let b = w.shell.read_with(w.cx, |s, _| s.audio_bounds());
    assert!(f32::from(b.size.width) > 100.0, "the waveform was measured: {b:?}");
    let at = |f: f32| point(b.origin.x + b.size.width * f, b.origin.y + b.size.height / 2.0);
    w.cx.simulate_mouse_down(at(0.25), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.5), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.5), MouseButton::Left, Modifiers::default());
    w.draw();
    let (from, to) = w.shell.read_with(w.cx, |s, _| s.audio_selection()).expect("a selection");
    assert!((from - 1.0).abs() < 0.02 && (to - 2.0).abs() < 0.02, "{from} {to}");
    assert!(w.said("Auswahl 0:01,0 bis 0:02,0"), "{:?}", w.labels());

    w.press(Role::Button, "Ausschneiden");
    w.settle();
    assert!((w.frames() as f64 - 24000.0).abs() < 400.0, "{}", w.frames());
    assert!(w.shell.read_with(w.cx, |s, _| s.audio_selection()).is_none(), "what was cut cannot stay chosen");
    assert!(w.said("herausgeschnitten"));

    w.press(Role::Button, "Werkzeug Verlauf");
    assert!(w.said("1. "), "{:?}", w.labels());
    w.press(Role::Button, "Rückgängig");
    assert_eq!(w.frames(), 32000);
    w.press(Role::Button, "Wiederholen");
    assert!((w.frames() as f64 - 24000.0).abs() < 400.0);

    // Pegel for everything: the loudest sample follows.
    w.press(Role::Button, "Werkzeug Pegel");
    w.press(Role::Button, "−6,0 dB");
    w.settle();
    let peak = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].iter().fold(0f32, |p, v| p.max(v.abs())));
    assert!((peak - 0.25).abs() < 0.01, "{peak}");
}

#[gpui::test]
fn the_refusals_come_as_words_and_the_take_is_played_and_written(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Probe.wav"));
    // No stretch chosen: cutting asks for one, and nothing changes.
    w.press(Role::Button, "Ausschneiden");
    w.settle();
    assert!(w.said("Wählen Sie zuerst die Stelle"));
    assert_eq!(w.frames(), 32000);
    // Noise: without a profile, taking it out says what to do first.
    w.press(Role::Button, "Werkzeug Säubern");
    w.press(Role::Button, "6,0 dB");
    w.settle();
    assert!(w.said("Rauschprofil"), "{:?}", w.labels());

    // Playing: the button turns into „Anhalten“ and back.
    w.press(Role::Button, "Anhören");
    assert!(w.tree().find(Role::Button, "Anhalten").is_some(), "playing: {} / {:?}", w.shell.read_with(w.cx, |s, _| s.audio_is_playing()), w.labels());
    assert!(w.shell.read_with(w.cx, |s, _| s.audio_is_playing()));
    w.press(Role::Button, "Anhalten");
    assert!(!w.shell.read_with(w.cx, |s, _| s.audio_is_playing()));

    // Writing: beside the file, never over it.
    w.press(Role::Button, "Werkzeug Ausgabe");
    w.press(Role::Button, "Als WAV speichern");
    for _ in 0..200 {
        w.settle();
        if !w.shell.read_with(w.cx, |s, _| s.audio_made().is_empty()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    let made = w.shell.read_with(w.cx, |s, _| s.audio_made().to_vec());
    assert_eq!(made.len(), 1, "{:?}", w.labels());
    assert!(made[0].exists() && made[0].file_name().unwrap().to_string_lossy().contains("(bearbeitet)"));
    assert!(!tmp.path().join("Probe.wav").exists(), "the original name is not written over");
}
