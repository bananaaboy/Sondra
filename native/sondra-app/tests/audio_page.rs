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
    open_with(cx, name, tone(4.0))
}

fn open_with<'a>(cx: &'a mut TestAppContext, name: std::path::PathBuf, audio: AudioData) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.audio_load(audio, name, cx);
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
    // Noise: without a profile the page says to learn it first, and learning needs a chosen stretch.
    w.press(Role::Button, "Werkzeug Säubern");
    assert!(w.said("Wählen Sie eine Stelle, an der nur das Rauschen zu hören ist"));
    w.shell.update(w.cx, |shell, cx| shell.audio_learn_noise(cx));
    w.draw();
    assert!(w.said("Wählen Sie eine Stelle, an der nur das Rauschen zu hören ist."), "{:?}", w.labels());
    // „Lokale KI“ finds the stretch by itself and learns from it; the chosen stretch shows where it lay.
    w.press(Role::Button, "Rauschprofil automatisch erkennen und lernen");
    assert!(w.said("Rauschprofil von selbst gefunden und gelernt"), "{:?}", w.labels());
    assert!(w.shell.read_with(w.cx, |s, _| s.audio_selection()).is_some());
    assert!(w.tree().find(Role::Button, "Rauschen neu lernen").is_some(), "now there is a profile");
    w.shell.update(w.cx, |shell, cx| shell.audio_select(None, cx));
    w.draw();

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

fn crossings(samples: &[f32]) -> usize {
    samples.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count()
}

#[gpui::test]
fn the_pitch_moves_without_the_length_and_the_tempo_changes_the_length_without_the_pitch(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Probe.wav"));
    let before = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    w.press(Role::Button, "Werkzeug Tonhöhe und Tempo");
    w.press(Role::Button, "+12 Halbtöne");
    w.settle();
    let up = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    assert_eq!(up.len(), before.len(), "the length stays");
    let (a, b) = (crossings(&before[2000..30000]), crossings(&up[2000..30000]));
    assert!((b as f64 / a as f64 - 2.0).abs() < 0.15, "an octave higher: {a} → {b} zero crossings");
    assert!(w.said("Tonhöhe +12 Halbtöne"), "{:?}", w.labels());

    // And back, to see that it is a step of the history like any other.
    w.press(Role::Button, "Werkzeug Verlauf");
    w.press(Role::Button, "Rückgängig");
    assert_eq!(w.frames(), 32000);

    w.press(Role::Button, "Werkzeug Tonhöhe und Tempo");
    w.press(Role::Button, "2×");
    w.settle();
    assert!((w.frames() as f64 - 16000.0).abs() < 600.0, "twice as fast: {}", w.frames());
    let fast = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    // The same pitch in half the time: as many crossings per second as before.
    let per_second = |s: &[f32], from: usize, to: usize| crossings(&s[from..to]) as f64 / ((to - from) as f64 / 8000.0);
    assert!((per_second(&fast, 2000, 14000) / per_second(&before, 2000, 30000) - 1.0).abs() < 0.1);
}

#[gpui::test]
fn clicks_are_taken_out_over_the_whole_file_and_a_clean_file_says_there_was_nothing(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    // A quiet tone with three ticks in it.
    let mut damaged = tone(4.0);
    for channel in &mut damaged.channels {
        for at in [5000usize, 12000, 20000] {
            channel[at] += 0.9;
        }
    }
    let mut w = open_with(cx, tmp.path().join("Platte.wav"), damaged);
    w.press(Role::Button, "Werkzeug Säubern");
    w.press(Role::Button, "Mittel");
    w.settle();
    let after = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    assert_eq!(after.len(), 32000);
    let clean = tone(4.0).channels[0].clone();
    for at in [5000usize, 12000, 20000] {
        assert!((after[at] - clean[at]).abs() < 0.05, "the tick at {at} is filled with what the tone would have been: {} against {}", after[at], clean[at]);
    }
    assert!(w.said("Klicks entfernt (mittel) · 3 Stellen ausgebessert"), "{:?}", w.labels());

    // The same again: nothing is left to find, and it says so instead of writing a step into the history.
    w.press(Role::Button, "Mittel");
    w.settle();
    assert!(w.said("Nichts gefunden, was wie ein Klick aussieht."), "{:?}", w.labels());
}

#[gpui::test]
fn speech_is_enhanced_in_one_click(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open_with(cx, tmp.path().join("Sprache.wav"), tone(2.0));
    w.press(Role::Button, "Werkzeug Säubern");
    w.press(Role::Button, "Sprache verbessern (Rauschen & Hall entfernen)");
    w.settle();
    assert!(w.said("Sprache verbessert (Rauschen und Hall entfernt) · ganze Datei"), "{:?}", w.labels());
    let after = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    assert_eq!(after.len(), 16000);
    let peak = after.iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.5 && peak < 0.99, "brought up to just under −1 dBFS: {peak}");
}

#[gpui::test]
fn the_file_turns_backwards_and_a_wav_is_written_at_the_chosen_depth(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Probe.wav"));
    let before = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    w.press(Role::Button, "Rückwärts drehen");
    w.settle();
    let after = w.shell.read_with(w.cx, |s, _| s.audio_take().unwrap().channels[0].clone());
    assert_eq!(after, before.iter().rev().copied().collect::<Vec<_>>());
    assert!(w.said("Umgekehrt"), "{:?}", w.labels());

    w.press(Role::Button, "Werkzeug Ausgabe");
    w.press(Role::Button, "24 bit");
    w.press(Role::Button, "Als WAV speichern");
    for _ in 0..200 {
        w.settle();
        if !w.shell.read_with(w.cx, |s, _| s.audio_made().is_empty()) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let made = w.shell.read_with(w.cx, |s, _| s.audio_made().to_vec());
    assert_eq!(made.len(), 1, "{:?}", w.labels());
    let bytes = std::fs::read(&made[0]).unwrap();
    assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 24, "the depth in the header");
    assert_eq!(bytes.len(), 44 + 32000 * 2 * 3);
}

#[gpui::test]
fn zoom_keep_keys_and_the_way_back_to_the_original(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Probe.wav"));
    // Zoomed in, a drag over the whole wave is a stretch of what is in view only.
    w.press(Role::Button, "Hineinzoomen (oder Mausrad)");
    let view = w.shell.read_with(w.cx, |s, _| s.audio_view());
    assert!((view.0 - 1.0).abs() < 1e-6 && (view.1 - 3.0).abs() < 1e-6, "{view:?}");
    let b = w.shell.read_with(w.cx, |s, _| s.audio_bounds());
    let at = |f: f32| point(b.origin.x + b.size.width * f, b.origin.y + b.size.height / 2.0);
    w.cx.simulate_mouse_down(at(0.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.5), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.5), MouseButton::Left, Modifiers::default());
    w.draw();
    let (from, to) = w.shell.read_with(w.cx, |s, _| s.audio_selection()).unwrap();
    assert!((from - 1.0).abs() < 0.02 && (to - 2.0).abs() < 0.02, "{from} {to}");
    w.press(Role::Button, "Herauszoomen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.audio_view()), (0.0, 4.0));
    // „Ausschnitt behalten“: only the second second is left.
    w.press(Role::Button, "Ausschnitt behalten");
    w.settle();
    assert!((w.frames() as f64 - 8000.0).abs() < 200.0, "{}", w.frames());
    // The keys: Strg+Z takes it back, Strg+Umschalt+Z does it again.
    w.cx.simulate_keystrokes("ctrl-z");
    w.draw();
    assert_eq!(w.frames(), 32000);
    w.cx.simulate_keystrokes("ctrl-shift-z");
    w.draw();
    assert!((w.frames() as f64 - 8000.0).abs() < 200.0);
    // „Zurück zum Original“.
    w.press(Role::Button, "Zurück zum Original");
    assert_eq!(w.frames(), 32000);
    // Tempo by tapping: four taps give a number.
    for _ in 0..4 {
        w.cx.simulate_keystrokes("t");
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    w.press(Role::Button, "Werkzeug Tonhöhe und Tempo");
    assert!(w.said(" BPM"), "{:?}", w.labels().into_iter().filter(|l| l.contains("BPM") || l.contains("tippen")).collect::<Vec<_>>());
}
