//! The Zerschneiden page: a break cut at its hits, the pads heard and changed, a beat laid on the grid and
//! written as sound and as MIDI.

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

const WIDTH: f32 = 1500.;

/// Eight clear hits, a quarter of a second apart, each a short decaying tone burst of its own pitch.
fn breakbeat() -> AudioData {
    let rate = 16000u32;
    let n = rate as usize * 2;
    let mut samples = vec![0.0f32; n];
    for hit in 0..8 {
        let start = (hit as f64 * 0.25 * f64::from(rate)) as usize;
        let hz = 150.0 + 90.0 * hit as f64;
        for k in 0..2400 {
            let t = k as f64 / f64::from(rate);
            if start + k < n {
                samples[start + k] += (0.8 * (-t * 22.0).exp() * (2.0 * std::f64::consts::PI * hz * t).sin()) as f32;
            }
        }
    }
    AudioData { channels: vec![samples.clone(), samples], sample_rate: rate }
}

fn open<'a>(cx: &'a mut TestAppContext, name: std::path::PathBuf) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.sampler_load(breakbeat(), name, cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(2600.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Sampler, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(2600.))), move |_, _| view);
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
        for _ in 0..300 {
            self.cx.run_until_parked();
            self.draw();
            if !self.said("Schreibt") && !self.said("Rechnet") {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    fn pads(&self) -> usize {
        self.shell.read_with(self.cx, |s, _| s.sampler_pads().len())
    }
}

#[gpui::test]
fn a_break_is_cut_at_its_hits_and_the_pads_are_changed_and_heard(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    assert!(w.tree().find(Role::Heading, "Zerlegen und auf Tasten legen").is_some());
    assert!(w.tree().find(Role::Group, "Wellenform mit Schnitten").is_some());
    // Eight hits make about eight pads.
    let n = w.pads();
    assert!((7..=9).contains(&n), "{n} pads: {:?}", w.labels());
    assert!(w.said(&format!("{n} Pads")));

    // Even parts: exactly as many as asked.
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    assert_eq!(w.pads(), 4);
    w.press(Role::Button, "Verfahren Feste Länge");
    w.press(Role::Button, "Länge je Teil 500 ms");
    assert_eq!(w.pads(), 4, "two seconds in halves of a second: four");
    // Back to the hits; a change of a pad survives a new plan with the same number of pads.
    w.press(Role::Button, "Verfahren Schläge");
    let n = w.pads();
    w.press(Role::Button, "Pad 2 wählen");
    w.press(Role::Button, "Tonhöhe +12");
    w.press(Role::Button, "Spielart Gehalten");
    w.press(Role::Button, "Klang 808 Bass");
    let (semitones, sound) = w.shell.read_with(w.cx, |s, _| (s.sampler_pads()[1].semitones, s.sampler_pads()[1].sound));
    assert_eq!(semitones, 12.0);
    assert_eq!(format!("{sound:?}"), "Sub808");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 1);

    // A pad is heard, and the same button stops it.
    w.press(Role::Button, "Pad 1 anhören");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()));
    w.press(Role::Button, "Pad 1 anhören");
    assert!(!w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()));
    assert_eq!(n, w.pads());
}

#[gpui::test]
fn a_cut_is_dragged_on_the_waveform_and_both_pads_follow_and_a_press_elsewhere_chooses_a_pad(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    let pads = w.shell.read_with(w.cx, |s, _| s.sampler_pads().iter().map(|p| (p.start, p.end)).collect::<Vec<_>>());
    assert_eq!(pads.len(), 4);
    let b = w.shell.read_with(w.cx, |s, _| s.sampler_bounds());
    let total = 2.0;
    let at = |seconds: f64| point(b.origin.x + b.size.width * (seconds / total) as f32, b.origin.y + b.size.height / 2.0);
    // The cut between pad 2 and pad 3 lies at one second; take hold of it and pull it to 0.7.
    assert!((pads[1].1 - 1.0).abs() < 0.01 && (pads[2].0 - 1.0).abs() < 0.01, "{pads:?}");
    w.cx.simulate_mouse_down(at(1.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.85), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_move(at(0.7), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.7), MouseButton::Left, Modifiers::default());
    w.draw();
    let moved = w.shell.read_with(w.cx, |s, _| s.sampler_pads().iter().map(|p| (p.start, p.end)).collect::<Vec<_>>());
    assert!((moved[1].1 - 0.7).abs() < 0.02 && (moved[2].0 - 0.7).abs() < 0.02, "both sides follow: {moved:?}");
    assert_eq!(moved[0], pads[0]);
    assert_eq!(moved[3], pads[3]);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 0, "taking hold of a cut chooses no pad");
    // A drag past the neighbour stops short of it.
    w.cx.simulate_mouse_down(at(0.7), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.0), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.0), MouseButton::Left, Modifiers::default());
    w.draw();
    let held = w.shell.read_with(w.cx, |s, _| s.sampler_pads().iter().map(|p| (p.start, p.end)).collect::<Vec<_>>());
    assert!(held[1].1 - held[1].0 >= 0.0149, "{held:?}");
    assert!((held[1].0 - pads[1].0).abs() < 1e-9, "the cut before it did not move");
    // A press in the middle of a pad chooses it, as before.
    w.cx.simulate_mouse_down(at(1.75), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(at(1.75), MouseButton::Left, Modifiers::default());
    w.draw();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 3);
}

#[gpui::test]
fn sixteen_keys_play_sixteen_pads_and_a_key_with_no_pad_is_not_taken(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    assert_eq!(w.pads(), 4);
    // 1 2 3 4 are the first row; Q is the fifth pad — there is none yet.
    assert!(!w.shell.update(w.cx, |shell, cx| shell.sampler_key("q", cx)), "no fifth pad: the key is not taken");
    assert!(!w.shell.update(w.cx, |shell, cx| shell.sampler_key("ö", cx)), "no pad sits on that key");
    assert!(w.shell.update(w.cx, |shell, cx| shell.sampler_key("3", cx)));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 2);
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()));
    // Another key plays at once, and the same key plays again (it is no switch).
    assert!(w.shell.update(w.cx, |shell, cx| shell.sampler_key("1", cx)));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 0);
    assert!(w.shell.update(w.cx, |shell, cx| shell.sampler_key("1", cx)));
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()), "the same key again plays again");
    // Sixteen pads: the keys reach the last row (Y X C V on a German keyboard).
    w.press(Role::Button, "Teile 16");
    assert_eq!(w.pads(), 16);
    assert!(w.shell.update(w.cx, |shell, cx| shell.sampler_key("v", cx)));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 15);
}

#[gpui::test]
fn a_beat_is_laid_heard_and_written_as_sound_and_as_midi(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    // Nothing on the grid yet; one step by hand, then the starter beat.
    w.press(Role::Button, "Pad 1 Schritt 3");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().cells["p1"][2]));
    w.press(Role::Button, "Start-Beat legen");
    let kick = w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().cells["p1"].clone());
    assert!(kick[0] && kick[8] && kick[10] && !kick[2]);
    w.press(Role::Button, "Tempo 140 BPM");
    w.press(Role::Button, "32 Schritte");
    assert_eq!(w.shell.read_with(w.cx, |s, _| (s.sampler_pattern_ref().bpm, s.sampler_pattern_ref().steps, s.sampler_pattern_ref().cells["p1"].len())), (140.0, 32, 32));

    // Heard: the button turns into „Anhalten“.
    w.press(Role::Button, "Beat anhören");
    w.settle();
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()));
    w.press(Role::Button, "Anhalten");
    assert!(!w.shell.read_with(w.cx, |s, _| s.sampler_is_playing()));

    // Written: the sound, the MIDI, the pads, the cut marks — beside the file, nothing over it.
    for label in ["Beat als WAV", "Beat als MIDI", "Schnittmarken als CUE", "Schnittmarken für Audacity", "Pads als WAV-Dateien"] {
        w.press(Role::Button, label);
        w.settle();
        let made = w.shell.read_with(w.cx, |s, _| s.sampler_made().to_vec());
        assert!(!made.is_empty() && made.iter().all(|p| p.exists()), "{label}: {made:?} {:?}", w.labels());
    }
    let names: Vec<String> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    for want in ["Break (Beat).wav", "Break (Beat).mid", "Break.cue", "Break-labels.txt", "Break (Pads)"] {
        assert!(names.iter().any(|n| n == want), "{want} in {names:?}");
    }
    let midi = std::fs::read(tmp.path().join("Break (Beat).mid")).unwrap();
    assert_eq!(&midi[..4], b"MThd");
    let pads = std::fs::read_dir(tmp.path().join("Break (Pads)")).unwrap().count();
    assert!(pads >= 7, "{pads} pad files");
}
