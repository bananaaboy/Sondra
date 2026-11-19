//! The Mikrofon page with a microphone made of numbers: switched on, the room recorded, the voice recorded,
//! the chain set and said in words, the takes written — and a voice that never came, said so.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::mic_page::{ListMics, OpenMic};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_audio::Capture;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;
const RATE: u32 = 16000;

/// A microphone that delivers half a second per look: the room for the first `quiet` seconds, then a voice
/// (or, with `mute`, more room).
struct Fake {
    delivered: usize,
    quiet: usize,
    mute: bool,
    last: f32,
}

impl Capture for Fake {
    fn name(&self) -> String {
        "Studio USB Audio".into()
    }
    fn rate(&self) -> u32 {
        RATE
    }
    fn level(&mut self) -> f32 {
        self.last
    }
    fn take(&mut self) -> Vec<f32> {
        let tau = 2.0 * std::f64::consts::PI;
        let chunk: Vec<f32> = (0..RATE as usize / 2)
            .map(|k| {
                let i = self.delivered + k;
                let t = i as f64 / f64::from(RATE);
                // A hash of the index stands in for noise.
                let noise = ((i as u64).wrapping_mul(2654435761) % 10007) as f64 / 10007.0 * 2.0 - 1.0;
                let talking = !self.mute && i >= self.quiet && ((t % 1.4) < 0.8);
                let tone = if talking { 0.3 * (tau * 190.0 * t).sin() + 0.08 * (tau * 570.0 * t).sin() } else { 0.0 };
                (0.006 * noise + 0.01 * (tau * 50.0 * t).sin() + tone) as f32
            })
            .collect();
        self.delivered += chunk.len();
        self.last = chunk.iter().fold(0f32, |p, v| p.max(v.abs()));
        chunk
    }
}

fn open<'a>(cx: &'a mut TestAppContext, mute: bool) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        let opener: OpenMic = Arc::new(move |_| Ok(Box::new(Fake { delivered: 0, quiet: (RATE * 4) as usize, mute, last: 0.0 }) as Box<dyn Capture>));
        let list: ListMics = Arc::new(|| vec!["Studio USB Audio".to_string()]);
        shell.mic_with(opener, list);
        shell.mic_set_seconds(4.0, 6.0);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(1600.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Mic, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(1600.))), move |_, _| view);
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
    fn tick(&mut self) {
        self.shell.update(self.cx, |shell, cx| shell.mic_tick(cx));
        self.cx.run_until_parked();
        self.draw();
    }
}

#[gpui::test]
fn the_room_and_then_the_voice_are_recorded_and_the_chain_is_set_and_said(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("SONDRA_DOWNLOADS", tmp.path());
    let mut w = open(cx, false);
    assert!(w.tree().find(Role::Heading, "Mikrofon testen und einstellen").is_some());
    assert!(w.tree().find(Role::ProgressIndicator, "Pegel").is_none(), "off until switched on");
    w.press(Role::Button, "Mikrofon einschalten");
    assert!(w.tree().find(Role::Button, "Mikrofon ausschalten").is_some());
    assert!(w.tree().find(Role::ProgressIndicator, "Pegel").is_some());
    w.press(Role::Button, "Für Podcast einstellen");
    w.tick();
    assert!(w.tree().find(Role::Heading, "Jetzt bitte ruhig sein").is_some());
    for _ in 0..8 {
        w.tick();
    }
    assert!(w.tree().find(Role::Heading, "Jetzt sprechen").is_some(), "{:?}", w.labels());
    assert!(w.said("Sprechen Sie ganz normal"));
    for _ in 0..14 {
        w.tick();
    }
    // The chain is calculated away from the window.
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().find(Role::Heading, "Was gemacht wurde").is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(w.tree().find(Role::Heading, "Was gemacht wurde").is_some(), "{:?}", w.labels());
    assert!(w.tree().find(Role::Heading, "Tiefen unter 80 Hz entfernt").is_some());
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| AsRef::<str>::as_ref(l).starts_with("Auf −16,0 LUFS gebracht"))));
    assert!(w.said("Rauschen im Raum"));
    let result = w.shell.read_with(w.cx, |s, _| s.mic_result()).unwrap();
    assert!((result.after.lufs + 16.0).abs() < 0.1);

    // The takes are written where downloads go.
    w.press(Role::Button, "Als WAV speichern");
    for _ in 0..100 {
        w.cx.run_until_parked();
        if w.shell.read_with(w.cx, |s, _| s.mic_made().len()) == 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let made = w.shell.read_with(w.cx, |s, _| s.mic_made().to_vec());
    assert_eq!(made.len(), 2);
    assert!(made.iter().all(|p| p.exists() && p.starts_with(tmp.path())));

    // Another purpose asks again; the old result goes.
    w.press(Role::Button, "Zweck Gesang");
    assert!(w.tree().find(Role::Heading, "Was gemacht wurde").is_none());
    assert!(w.tree().find(Role::Button, "Für Gesang einstellen").is_some());
    w.press(Role::Button, "Mikrofon ausschalten");
    assert!(w.tree().find(Role::Button, "Mikrofon einschalten").is_some());
}

#[gpui::test]
fn a_voice_that_never_came_is_said_so_and_nothing_is_set(cx: &mut TestAppContext) {
    let mut w = open(cx, true);
    w.press(Role::Button, "Mikrofon einschalten");
    w.press(Role::Button, "Für Podcast einstellen");
    for _ in 0..24 {
        w.tick();
    }
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if w.said("war nichts zu hören") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(w.said("In der zweiten Aufnahme war nichts zu hören"), "{:?}", w.labels());
    assert!(w.tree().find(Role::Heading, "Was gemacht wurde").is_none());
    assert!(w.tree().find(Role::Button, "Für Podcast einstellen").is_some(), "it can be tried again");
}

#[gpui::test]
fn without_a_microphone_the_page_says_why(cx: &mut TestAppContext) {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        let opener: OpenMic = Arc::new(|_| Err("Auf diesem Gerät gibt es kein Mikrofon.".into()));
        shell.mic_with(opener, Arc::new(Vec::new));
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Mic, cx));
    w.draw();
    w.press(Role::Button, "Mikrofon einschalten");
    assert!(w.said("kein Mikrofon"));
    assert!(w.tree().find(Role::Button, "Mikrofon einschalten").is_some(), "it can be tried again");
}
