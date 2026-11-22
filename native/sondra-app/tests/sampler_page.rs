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
    cx.simulate_resize(size(px(WIDTH), px(3400.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Sampler, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(3400.))), move |_, _| view);
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
            if !self.said("Schreibt") && !self.said("Rechnet") && !self.said("Rendert") {
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
    // Pads sound over one another (pad 3 and pad 1 both), and with „Choke“ on — as it is at first — a pad struck again
    // cuts its own earlier voice: three strikes, two voices.
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()), 2, "pads layer, a pad struck again cuts itself");
    // Sixteen pads: the keys reach the last row (Y X C V on a German keyboard).
    w.press(Role::Button, "Teile 16");
    assert_eq!(w.pads(), 16);
    assert!(w.shell.update(w.cx, |shell, cx| shell.sampler_key("v", cx)));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 15);
}

#[gpui::test]
fn a_midi_drum_pad_plays_the_pad_on_its_note_and_the_page_names_the_controller(cx: &mut TestAppContext) {
    use sondra_midi::{Input, Message};
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    assert!(!w.labels().iter().any(|l| l.starts_with("MIDI:")), "no controller, no word about it");
    let (input, send) = Input::for_test("Pad-Controller");
    w.shell.update(w.cx, |shell, cx| shell.sampler_midi_for_test(input, cx));
    w.draw();
    assert!(w.labels().iter().any(|l| l == "MIDI: Pad-Controller"), "{:?}", w.labels().iter().filter(|l| l.contains("MIDI")).collect::<Vec<_>>());
    // Note 38 is the third pad.
    send.send(Message::NoteOn { pad: 2, velocity: 0.5, note: 38 }).unwrap();
    for _ in 0..100 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(20));
        w.cx.run_until_parked();
        if w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()) == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()), 1, "the pad sounds");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 2);
    // A note whose pad does not exist (only four were cut) is not taken.
    send.send(Message::NoteOn { pad: 9, velocity: 1.0, note: 45 }).unwrap();
    for _ in 0..10 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(20));
        w.cx.run_until_parked();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // Nothing new sounds and the chosen pad stays. (The third pad's slice may have rung out by itself in the
    // meantime — a slow Windows runner took that long, run 105 — so its voice is not counted on.)
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()) <= 1);
    assert!(!w.shell.read_with(w.cx, |s, _| s.sampler_pad_sounding_for_test(9)), "no pad for note 45");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_selected()), 2);
    // Leaving the page lets the controllers go.
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Start, cx));
    for _ in 0..10 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(20));
        w.cx.run_until_parked();
    }
    assert!(!w.shell.read_with(w.cx, |s, _| s.sampler_midi_open()));
}

#[gpui::test]
fn a_held_pad_stops_when_its_key_is_let_go_and_the_others_ring_out(cx: &mut TestAppContext) {
    use sondra_media::pattern::PlayMode;
    use sondra_midi::{Input, Message};
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    // The third pad is „Gehalten“, the first stays a one-shot.
    w.shell.update(w.cx, |s, cx| {
        s.sampler_select(2, cx);
        s.sampler_pad(|p| p.mode = PlayMode::Gate, cx);
    });
    let (input, send) = Input::for_test("Pad-Controller");
    w.shell.update(w.cx, |shell, cx| shell.sampler_midi_for_test(input, cx));
    let settle = |w: &mut Window, voices: usize| {
        for _ in 0..100 {
            w.cx.executor().advance_clock(std::time::Duration::from_millis(20));
            w.cx.run_until_parked();
            if w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()) == voices {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()), voices);
    };
    // The held pad first: it sounds for as long as its key is down, however slow the machine is.
    send.send(Message::NoteOn { pad: 2, velocity: 1.0, note: 38 }).unwrap();
    settle(&mut w, 1);
    // A one-shot pressed and let go at once rings on: the note-off is not a stop. Checked right away — a
    // short slice of the break rings out by itself after a fraction of a second, and a slow runner took
    // that long between the two looks (seen on windows-latest).
    send.send(Message::NoteOn { pad: 0, velocity: 1.0, note: 36 }).unwrap();
    send.send(Message::NoteOff { pad: 0, note: 36 }).unwrap();
    settle(&mut w, 2);
    // Letting go of the held pad ends its voice (the one-shot may have rung out by then as well).
    send.send(Message::NoteOff { pad: 2, note: 38 }).unwrap();
    for _ in 0..100 {
        w.cx.executor().advance_clock(std::time::Duration::from_millis(20));
        w.cx.run_until_parked();
        if w.shell.read_with(w.cx, |s, _| s.sampler_voice_count()) == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!w.shell.read_with(w.cx, |s, _| s.sampler_pad_sounding_for_test(2)), "the held pad stopped with its key");
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

#[gpui::test]
fn a_pads_piano_roll_sets_lengthens_moves_and_takes_away_notes_with_the_pointer(cx: &mut TestAppContext) {
    use sondra_media::roll::{TOP};
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Verfahren Gleiche Teile");
    w.press(Role::Button, "Teile 4");
    // Opening the roll: a pad with steps starts with a note at its own pitch for each of them.
    w.press(Role::Button, "Pad 1 Schritt 3");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().cells[&"p1".to_string()][2]));
    w.press(Role::Button, "Klavierrolle für Pad 1");
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!((notes.len(), notes[0].step, notes[0].length, notes[0].semitone), (1, 2, 1, 0.0));
    assert!(w.tree().find(Role::Group, "Klavierrolle").is_some());
    assert!(w.tree().find(Role::ListItem, "C4, Schritt 3, 1 lang").is_some());

    let (grid, lane) = w.shell.read_with(w.cx, |s, _| s.sampler_roll_bounds()).unwrap();
    let at = |step: usize, semitone: i32| point(grid.origin.x + grid.size.width * ((step as f32 + 0.5) / 16.0), grid.origin.y + px((TOP - semitone) as f32 * 22.0 + 11.0));
    let down = |w: &mut Window<'_>, p| w.cx.simulate_mouse_down(p, MouseButton::Left, Modifiers::default());
    let to = |w: &mut Window<'_>, p| w.cx.simulate_mouse_move(p, Some(MouseButton::Left), Modifiers::default());
    let up = |w: &mut Window<'_>, p| {
        w.cx.simulate_mouse_up(p, MouseButton::Left, Modifiers::default());
        w.draw();
    };

    // A press on empty ground sets a note, as long as the last one (2), and a drag to step 8 lengthens it to 6.
    down(&mut w, at(5, 3));
    to(&mut w, at(8, 3));
    up(&mut w, at(8, 3));
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!(notes.len(), 2);
    assert_eq!((notes[1].step, notes[1].length, notes[1].semitone), (5, 4, 3.0));
    // The next note starts with that length.
    down(&mut w, at(12, -2));
    up(&mut w, at(12, -2));
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!((notes[2].step, notes[2].length), (12, 4));

    // A note is taken by its body and moved: two steps on and two keys up.
    down(&mut w, at(6, 3));
    to(&mut w, at(8, 5));
    up(&mut w, at(8, 5));
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!((notes[1].step, notes[1].semitone, notes[1].length), (7, 5.0, 4));

    // A click on it, without a drag, takes it away.
    down(&mut w, at(8, 5));
    up(&mut w, at(8, 5));
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes().len()), 2);

    // A chord is set with a stamp, and the notes are named for a screen reader.
    w.press(Role::Button, "Beim Klicken setzen: Moll-Akkord");
    down(&mut w, at(0, 0));
    up(&mut w, at(0, 0));
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!(notes.iter().filter(|n| n.step == 0).map(|n| n.semitone).collect::<Vec<_>>(), [0.0, 3.0, 7.0]);
    assert!(w.tree().find(Role::ListItem, "D♯4, Schritt 1, 4 lang").is_some(), "{:?}", w.labels());

    // The dynamics lane: the notes that sound in a step get the height.
    let step_of_first = point(lane.origin.x + lane.size.width * (12.5 / 16.0), lane.origin.y + lane.size.height * 0.5);
    w.cx.simulate_mouse_down(step_of_first, MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(step_of_first, MouseButton::Left, Modifiers::default());
    w.draw();
    let notes = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    let last = notes.iter().find(|n| n.step == 12).unwrap();
    assert!((last.velocity.unwrap() - 0.5).abs() < 0.02, "{last:?}");

    // An octave up, then all notes gone.
    w.press(Role::Button, "Eine Oktave höher");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes()).iter().all(|n| n.semitone >= 0.0 || n.semitone == -2.0 + 12.0));
    w.press(Role::Button, "Alle Noten löschen");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes()).is_empty());

    // Back to steps: every note's start is a step again, and the pad plays its steps.
    down(&mut w, at(9, 1));
    up(&mut w, at(9, 1));
    w.press(Role::Button, "Noten zurück in Schritte wandeln");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes().is_empty()));
    let pattern = w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().clone());
    assert!(!pattern.notes.contains_key("p1"));
    assert!(pattern.cells["p1"][9] && pattern.cells["p1"].iter().filter(|c| **c).count() == 1);
    // „Spice“: a chord progression and an arpeggio drawn in one press, as on the website.
    if w.tree().find(Role::Button, "Akkorde zeichnen").is_none() {
        w.press(Role::Button, "Klavierrolle für Pad 1");
    }
    let steps = w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().steps);
    w.press(Role::Button, "Akkorde zeichnen");
    let chords = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!(chords.len(), 3 * (steps / 4).min(4), "three notes for each chord that fits");
    w.press(Role::Button, "Arpeggio zeichnen");
    let arp = w.shell.read_with(w.cx, |s, _| s.sampler_roll_notes());
    assert_eq!(arp.len(), steps / 2);

}

#[gpui::test]
fn a_pad_is_halved_joined_nudged_copied_and_deleted(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Beat.wav"));
    let pads = |w: &Window| w.shell.read_with(w.cx, |s, _| s.sampler_pads().to_vec());
    let before = pads(&w);
    assert!(before.len() >= 2);
    // In two at the middle.
    w.press(Role::Button, "Halbieren");
    let after = pads(&w);
    assert_eq!(after.len(), before.len() + 1);
    assert!((after[0].end - (before[0].start + before[0].end) / 2.0).abs() < 1e-9);
    assert_eq!(after[1].start, after[0].end);
    // Joined again.
    w.press(Role::Button, "Mit nächstem verbinden");
    assert_eq!(pads(&w).len(), before.len());
    assert!((pads(&w)[0].end - before[0].end).abs() < 1e-9);
    // The start 10 ms later.
    w.press(Role::Button, "Anfang 10 ms später");
    assert!((pads(&w)[0].start - (before[0].start + 0.01)).abs() < 1e-9);
    // Its settings to all.
    w.press(Role::Button, "Rückwärts");
    w.press(Role::Button, "Einstellungen des gewählten Pads auf alle übertragen");
    assert!(pads(&w).iter().all(|p| p.reverse));
    // Gone.
    w.press(Role::Button, "Pad löschen");
    assert_eq!(pads(&w).len(), before.len() - 1);
}

#[gpui::test]
fn pads_are_written_as_heard_into_the_session_and_cut_at_the_pointer(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    let pads = |w: &Window| w.shell.read_with(w.cx, |s, _| s.sampler_pads().to_vec());
    // How pads are written: the blend, the normalisation, the length kept when transposed.
    w.press(Role::Button, "Blende an den Schnittkanten 20 ms");
    w.press(Role::Button, "Auf −0,3 dBFS normalisieren");
    let options = w.shell.read_with(w.cx, |s, _| s.sampler_export_options());
    assert!(options.normalize && options.keep_length && (options.edge_fade_ms - 20.0).abs() < 1e-9);
    w.press(Role::Button, "Tonhöhe +12");
    w.press(Role::Button, "So hören, wie es exportiert wird");
    w.settle();
    let heard = w.shell.read_with(w.cx, |s, _| s.sampler_heard_export()).expect("rendered");
    let pad = pads(&w)[0].clone();
    assert!((heard.seconds() - (pad.end - pad.start)).abs() < 0.01, "an octave up keeps its length: {} against {}", heard.seconds(), pad.end - pad.start);
    let peak = heard.channels.iter().flatten().fold(0f32, |m, v| m.max(v.abs()));
    assert!((20.0 * f64::from(peak).log10() + 0.3).abs() < 0.1, "{peak}");
    w.press(Role::Button, "Anhalten");

    // Into the session: the chosen pad, then all.
    w.press(Role::Button, "Pad 1 in die Sitzung");
    w.settle();
    let session = w.shell.read_with(w.cx, |s, _| s.session_files());
    assert_eq!(session.len(), 1);
    assert!(session[0].ends_with("Break (Pads)/Pad 01.wav"), "{session:?}");
    let count = pads(&w).len();
    w.press(Role::Button, &format!("Alle {count} Pads in die Sitzung"));
    w.settle();
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.session_files().len()), 1 + count);

    // The pointer: pressed on the waveform, the pad under it is cut there.
    let b = w.shell.read_with(w.cx, |s, _| s.sampler_bounds());
    let x = b.origin.x + b.size.width * 0.06;
    w.cx.simulate_mouse_down(gpui::point(x, b.origin.y + px(20.)), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(gpui::point(x, b.origin.y + px(20.)), MouseButton::Left, Modifiers::default());
    w.draw();
    let at = w.shell.read_with(w.cx, |s, _| s.sampler_cursor()).expect("a pointer");
    assert!((at - 0.12).abs() < 0.02, "{at}");
    w.press(Role::Button, "Am Zeiger teilen (ohne Zeiger in der Mitte)");
    let after = pads(&w);
    assert_eq!(after.len(), count + 1);
    assert!(after.iter().any(|p| (p.start - at).abs() < 0.002), "a pad begins at the pointer");
    assert!(w.said("Schnitt bei"));
    // The whole file as one pad.
    w.press(Role::Button, "Ganze Datei als Pad 1");
    let one = pads(&w);
    assert_eq!(one.len(), 1);
    assert!(one[0].start == 0.0 && (one[0].end - 2.0).abs() < 1e-6);
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().cells.keys().all(|k| *k == one[0].id)));
}

#[gpui::test]
fn four_pattern_places_a_song_chain_and_the_song_into_the_session(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    w.press(Role::Button, "Start-Beat legen");
    let a = w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().clone());
    // Copied into B and gone there; B changed, A stays.
    w.press(Role::Button, "Aktuelles Pattern in den nächsten Platz kopieren");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_slot()), 1);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().clone()), a);
    w.press(Role::Button, "Raster leeren");
    w.press(Role::Button, "Pad 1 Schritt 1");
    w.press(Role::Button, "Pattern A");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().clone()), a);
    w.press(Role::Button, "Pattern B");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_pattern_ref().cells.values().filter(|c| c.iter().any(|v| *v)).count()), 1);
    // The chain: A, B, A; a block taken out again.
    w.press(Role::Button, "Pattern B an die Song-Kette anhängen");
    w.press(Role::Button, "Pattern A an die Song-Kette anhängen");
    w.press(Role::Button, "Pattern A an die Song-Kette anhängen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_chain().to_vec()), vec![0, 1, 0, 0]);
    w.press(Role::Button, "Block 4: Pattern A entfernen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.sampler_chain().to_vec()), vec![0, 1, 0]);
    assert!(w.said("Kette: A → B → A"));
    // The song into the session: three bars long.
    w.press(Role::Button, "Song in die Sitzung");
    w.settle();
    let session = w.shell.read_with(w.cx, |s, _| s.session_files());
    assert_eq!(session.len(), 1, "{:?}", w.labels());
    assert!(session[0].file_name().unwrap().to_string_lossy().starts_with("Break-song-"), "{session:?}");
    // A single pattern, twice through.
    w.press(Role::Button, "Einzelnes Pattern (B)");
    w.press(Role::Button, "2× durchspielen");
    w.press(Role::Button, "Pattern in die Sitzung");
    w.settle();
    let session = w.shell.read_with(w.cx, |s, _| s.session_files());
    assert_eq!(session.len(), 2);
    assert!(session[1].file_name().unwrap().to_string_lossy().starts_with("Break-pattern-B-"), "{session:?}");
}

#[gpui::test]
fn the_wave_zooms_in_on_the_chosen_pad_moves_and_zooms_out_again(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = open(cx, tmp.path().join("Break.wav"));
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_view()).is_none());
    w.press(Role::Button, "Pad 3 wählen");
    w.press(Role::Button, "Hineinzoomen");
    let (a, b) = w.shell.read_with(w.cx, |s, _| s.sampler_view()).expect("zoomed in");
    assert!((b - a - 1.0).abs() < 1e-6, "half of two seconds: {a}–{b}");
    let pad = w.shell.read_with(w.cx, |s, _| s.sampler_pads()[2].clone());
    let middle = (pad.start + pad.end) / 2.0;
    assert!(a <= middle && middle <= b, "the chosen pad stays in view");
    // A press on the zoomed wave stands for a time in what is in view.
    let bounds = w.shell.read_with(w.cx, |s, _| s.sampler_bounds());
    let x = bounds.origin.x + bounds.size.width * 0.5;
    w.cx.simulate_mouse_down(gpui::point(x, bounds.origin.y + px(20.)), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_up(gpui::point(x, bounds.origin.y + px(20.)), MouseButton::Left, Modifiers::default());
    w.draw();
    let at = w.shell.read_with(w.cx, |s, _| s.sampler_cursor()).unwrap();
    assert!((at - (a + b) / 2.0).abs() < 0.02, "{at}");
    w.press(Role::Button, "Später");
    let (c, _) = w.shell.read_with(w.cx, |s, _| s.sampler_view()).unwrap();
    assert!(c > a);
    w.press(Role::Button, "Herauszoomen");
    assert!(w.shell.read_with(w.cx, |s, _| s.sampler_view()).is_none(), "the whole again");
}
