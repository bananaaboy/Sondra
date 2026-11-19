//! The Tonart page with the real FFmpeg: a chord is listened to, a melody followed, MIDI files written.

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
        // The listening is real work, and slow in a build for tests.
        for _ in 0..1600 {
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

fn open(cx: &mut TestAppContext) -> Window<'_> {
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
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Harmony, cx));
    w.draw();
    w
}

fn make(ff: &Ffmpeg, dir: &Path, name: &str, filter: &[&str]) -> PathBuf {
    let path = dir.join(name);
    let mut args = vec!["-v", "error", "-y"];
    args.extend_from_slice(filter);
    let out = Command::new(ff.program()).args(args).arg(&path).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    path
}

#[gpui::test]
fn a_chord_gives_its_key_and_chords_and_a_melody_its_notes_and_both_go_out_as_midi(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    // C major held for six seconds: three sines.
    let chord = make(&ff, tmp.path(), "akkord.wav", &["-f", "lavfi", "-i", "aevalsrc=0.25*sin(2*PI*261.63*t)+0.25*sin(2*PI*329.63*t)+0.25*sin(2*PI*392.0*t):s=44100:d=6"]);
    // A rising scale, one note at a time, half a second each.
    let notes = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];
    let expr: String = notes.iter().enumerate().map(|(i, f)| format!("between(t\\,{}\\,{})*0.5*sin(2*PI*{f}*t)", i as f64 * 0.5, (i + 1) as f64 * 0.5)).collect::<Vec<_>>().join("+");
    let scale = make(&ff, tmp.path(), "tonleiter.wav", &["-f", "lavfi", "-i", &format!("aevalsrc={expr}:s=44100:d=4")]);

    let mut w = open(cx);
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some());
    w.shell.update(w.cx, |shell, cx| shell.harmony_take(chord.clone(), cx));
    w.draw();
    w.wait_for(Role::Button, "Akkorde als MIDI");
    let (key, chords) = w.cx.read_entity(&w.shell, |s, _| s.harmony_heard().map(|h| (h.key.label.clone(), h.chords.iter().filter(|c| c.root.is_some()).count())).unwrap());
    assert!(key.starts_with('C'), "the key is C: {key}");
    assert!(chords >= 1, "a chord is heard");
    assert!(w.tree().find(Role::Heading, &format!("Akkorde · {chords}")).is_some());
    // The chord goes out as a file beside the source.
    w.press(Role::Button, "Akkorde als MIDI");
    let midi = tmp.path().join("akkord-akkorde.mid");
    let bytes = std::fs::read(&midi).expect("the MIDI file is there");
    assert_eq!(&bytes[..4], b"MThd");
    assert!(w.tree().find(Role::Button, "Im Ordner zeigen").is_some());

    // A melody is followed.
    w.shell.update(w.cx, |shell, cx| shell.harmony_take(scale.clone(), cx));
    w.wait_for(Role::Button, "Melodie als MIDI");
    let n = w.cx.read_entity(&w.shell, |s, _| s.harmony_heard().unwrap().notes.len());
    assert!(n >= 6, "the eight notes of the scale are found: {n}");
    w.press(Role::Button, "Melodie als MIDI");
    let melody = std::fs::read(tmp.path().join("tonleiter-melodie.mid")).expect("the melody file is there");
    assert_eq!(&melody[..4], b"MThd");
    // Without the melody there is none to write.
    w.press(Role::Button, "Melodie verfolgen");
    w.press(Role::Button, "Neu berechnen");
    // (The scale has no chords to speak of, so the page waits for its own button to say it is done.)
    w.wait_for(Role::Button, "Noch einmal hören");
    assert!(w.tree().find(Role::Button, "Melodie als MIDI").is_none());
    assert!(w.tree().find(Role::Heading, "Melodie · 8 Noten").is_none());
}
