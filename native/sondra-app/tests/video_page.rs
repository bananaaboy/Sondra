//! The Video page with the real FFmpeg: opened, cut, cropped, sped up, written; sound pulled out; a still saved.

use std::cell::RefCell;
use std::path::PathBuf;
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
    /// A tall window, for what lies low on the page.
    tall: bool,
}

const WIDTH: f32 = 1280.;

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(point(px(0.), px(0.)), size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(if self.tall { 1800. } else { 1000. }))), move |_, _| view);
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
        self.draw();
    }
    fn settle(&mut self, rounds: usize) {
        for _ in 0..rounds {
            self.cx.run_until_parked();
            self.draw();
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    fn made(&self) -> Vec<PathBuf> {
        self.cx.read_entity(&self.shell, |s, _| s.video_made().to_vec())
    }
}

fn dims(ff: &Ffmpeg, path: &std::path::Path) -> (u32, u32, f64) {
    let p = ff.probe(path).unwrap();
    let v = p.streams.iter().find(|s| s.kind == "video").unwrap();
    (v.width.unwrap() as u32, v.height.unwrap() as u32, p.duration.unwrap_or(0.0))
}

#[gpui::test]
fn a_video_is_cut_cropped_sped_up_and_written_its_sound_pulled_out_and_a_still_saved(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let film = tmp.path().join("film.mp4");
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&film)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, vcx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(1000.)));
    let mut w = Window { cx: vcx, shell, seen, tall: false };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Video, cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Video wählen").is_some());

    w.shell.update(w.cx, |shell, cx| shell.video_take(film.clone(), cx));
    w.settle(20);
    assert!(w.cx.read_entity(&w.shell, |s, _| s.video_has_still()), "the stage shows a still");
    assert!(w.tree().find(Role::Button, "Anfang hier (0:00,5)").is_some() || w.tree().find(Role::Button, "Werkzeug Schnitt").is_some());

    // The cut: from 2 s to 8 s, set at the slider's place.
    w.shell.update(w.cx, |shell, cx| shell.video_set_position(2.0, cx));
    w.draw();
    w.press(Role::Button, "Anfang hier (0:00)");
    w.shell.update(w.cx, |shell, cx| shell.video_set_position(8.0, cx));
    w.draw();
    w.press(Role::Button, "Ende hier (Ende)");
    let ops = w.cx.read_entity(&w.shell, |s, _| s.video_ops().clone());
    assert!((ops.start - 2.0).abs() < 0.05 && (ops.end - 8.0).abs() < 0.05, "{} {}", ops.start, ops.end);
    // Square, and twice as fast.
    w.press(Role::Button, "Werkzeug Ausschnitt");
    w.press(Role::Button, "Seitenverhältnis 1:1");
    w.settle(10);
    w.press(Role::Button, "Werkzeug Tempo");
    w.press(Role::Button, "Tempo 2×");
    // Written as an MP4 at 480p-or-less.
    w.press(Role::Button, "Werkzeug Speichern");
    w.press(Role::Button, "Qualität 480p");
    w.press(Role::Button, "Video speichern");
    w.settle(120);
    let made = w.made();
    assert_eq!(made.len(), 1, "{:?}", w.cx.read_entity(&w.shell, |s, _| s.video_made().to_vec()));
    let (mw, mh, md) = dims(&ff, &made[0]);
    assert_eq!(mw, mh, "square: {mw} × {mh}");
    assert!((2.5..=3.6).contains(&md), "six seconds at double speed: {md}");
    assert!(film.exists());
    assert!(made[0].file_name().unwrap().to_string_lossy().contains("(bearbeitet)"));

    // The sound, as WAV.
    w.press(Role::Button, "Ton als WAV herausziehen");
    w.settle(60);
    let made = w.made();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].extension().unwrap(), "wav");
    // A still at 2 s.
    w.press(Role::Button, "Standbild speichern");
    w.settle(60);
    let made = w.made();
    assert_eq!(made[0].extension().unwrap(), "png");
    // A GIF.
    w.press(Role::Button, "Format GIF");
    w.press(Role::Button, "Video speichern");
    w.settle(120);
    let made = w.made();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].extension().unwrap(), "gif");
}

#[gpui::test]
fn the_timeline_moves_the_place_and_both_ends_of_what_stays(cx: &mut TestAppContext) {
    use gpui::{Modifiers, MouseButton};
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let film = tmp.path().join("film.mp4");
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=10", "-pix_fmt", "yuv420p"])
        .arg(&film)
        .output()
        .unwrap();
    assert!(out.status.success());
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, vcx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(1000.)));
    let mut w = Window { cx: vcx, shell, seen, tall: false };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Video, cx));
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.video_take(film.clone(), cx));
    w.settle(20);

    let b = w.cx.read_entity(&w.shell, |s, _| s.video_timeline_bounds());
    assert!(f32::from(b.size.width) > 200.0, "the timeline was measured: {b:?}");
    let at = |f: f32, dx: f32| point(b.origin.x + b.size.width * f + px(dx), b.origin.y + b.size.height / 2.0);

    // A press in the middle moves the place, and only the place.
    w.cx.simulate_mouse_down(at(0.25, 0.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.5, 0.0), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.5, 0.0), MouseButton::Left, Modifiers::default());
    w.draw();
    let ops = w.cx.read_entity(&w.shell, |s, _| s.video_ops().clone());
    assert_eq!((ops.start, ops.end), (0.0, 0.0), "nothing was cut by moving the place");
    assert!(w.tree().nodes.iter().any(|n| n.value.as_ref().is_some_and(|v| v.contains("Stelle 0:05"))), "{:?}", w.tree().nodes.iter().filter_map(|n| n.value.clone()).collect::<Vec<_>>());

    // The left end taken hold of and drawn in to 2 s, the right end to 8 s.
    w.cx.simulate_mouse_down(at(0.0, 3.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.2, 0.0), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.2, 0.0), MouseButton::Left, Modifiers::default());
    w.draw();
    w.cx.simulate_mouse_down(at(1.0, -3.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.8, 0.0), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.8, 0.0), MouseButton::Left, Modifiers::default());
    w.draw();
    let ops = w.cx.read_entity(&w.shell, |s, _| s.video_ops().clone());
    assert!((ops.start - 2.0).abs() < 0.1 && (ops.end - 8.0).abs() < 0.1, "{} {}", ops.start, ops.end);
    assert!(w.tree().nodes.iter().any(|n| n.value.as_ref().is_some_and(|v| v.contains("Es bleibt 0:02 bis 0:08"))));

    // An end cannot be drawn past the other.
    w.cx.simulate_mouse_down(at(0.8, 0.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.0, 0.0), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.0, 0.0), MouseButton::Left, Modifiers::default());
    let ops = w.cx.read_entity(&w.shell, |s, _| s.video_ops().clone());
    assert!(ops.end > ops.start, "{} {}", ops.start, ops.end);
    w.settle(10);
}

#[gpui::test]
fn the_crop_is_drawn_moved_and_taken_back_on_the_picture(cx: &mut TestAppContext) {
    use gpui::{Modifiers, MouseButton};
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let film = tmp.path().join("film.mp4");
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=4", "-pix_fmt", "yuv420p"])
        .arg(&film)
        .output()
        .unwrap();
    assert!(out.status.success());
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, vcx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(1800.)));
    let mut w = Window { cx: vcx, shell, seen, tall: false };
    w.tall = true;
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Video, cx));
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.video_take(film.clone(), cx));
    w.settle(20);
    w.press(Role::Button, "Werkzeug Ausschnitt");
    w.settle(20);
    // The stage shows the picture whole; draw twice so the picture's place is measured.
    w.draw();
    let b = w.cx.read_entity(&w.shell, |s, _| s.video_crop_bounds());
    assert!(f32::from(b.size.width) > 200.0, "the picture was measured: {b:?}");
    let at = |fx: f32, fy: f32| point(b.origin.x + b.size.width * fx, b.origin.y + b.size.height * fy);

    // A new rectangle from a quarter to three quarters.
    w.cx.simulate_mouse_down(at(0.25, 0.25), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.75, 0.75), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.75, 0.75), MouseButton::Left, Modifiers::default());
    w.draw();
    let crop = w.cx.read_entity(&w.shell, |s, _| s.video_ops().crop).expect("a crop");
    assert!((crop.x - 0.25).abs() < 0.03 && (crop.y - 0.25).abs() < 0.03 && (crop.width - 0.5).abs() < 0.04 && (crop.height - 0.5).abs() < 0.04, "{crop:?}");

    // Its middle moves it, and it stays the size it was.
    w.cx.simulate_mouse_down(at(0.5, 0.5), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.6, 0.55), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.6, 0.55), MouseButton::Left, Modifiers::default());
    w.draw();
    let moved = w.cx.read_entity(&w.shell, |s, _| s.video_ops().crop).unwrap();
    assert!((moved.x - (crop.x + 0.1)).abs() < 0.03 && (moved.width - crop.width).abs() < 1e-9, "{moved:?}");

    // A corner drawn out to the edge of the picture, then the whole picture is taken back.
    w.press(Role::Button, "Ganzes Bild");
    assert!(w.cx.read_entity(&w.shell, |s, _| s.video_ops().crop).is_none());
    w.settle(10);
}
