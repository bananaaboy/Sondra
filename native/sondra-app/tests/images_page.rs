//! The Bilder page with the real FFmpeg: a picture opened, cropped, turned, scaled, saved; many at once.

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
use sondra_media::image_ops::Format;
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
    /// Lets the background work finish, drawing as a window does.
    fn settle(&mut self) {
        for _ in 0..40 {
            self.cx.run_until_parked();
            self.draw();
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn preview(&self) -> Option<(u32, u32)> {
        self.cx.read_entity(&self.shell, |s, _| s.images_preview_size())
    }
}

fn picture(ff: &Ffmpeg, dir: &std::path::Path, name: &str, size: &str) -> PathBuf {
    let path = dir.join(name);
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=size={size}"), "-frames:v", "1"]).arg(&path).output().unwrap();
    assert!(out.status.success());
    path
}

#[gpui::test]
fn a_picture_is_cropped_turned_scaled_and_saved_and_many_go_through_together(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let a = picture(&ff, tmp.path(), "eins.png", "640x360");
    let b = picture(&ff, tmp.path(), "zwei.png", "320x240");
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
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Images, cx));
    w.draw();
    assert!(w.tree().find(Role::Button, "Bilder wählen").is_some());

    w.shell.update(w.cx, |shell, cx| shell.images_take(vec![a.clone()], cx));
    w.settle();
    assert_eq!(w.preview(), Some((640, 360)), "the stage shows the picture");
    assert!(w.tree().find(Role::Button, "Werkzeug Ausschnitt").is_some());
    assert!(w.tree().find(Role::Button, "Werkzeug Viele").is_none(), "one picture needs no batch");

    // Crop to a square: while the crop is drawn the stage shows the whole picture with the crop on it.
    w.press(Role::Button, "Seitenverhältnis 1:1");
    w.settle();
    assert_eq!(w.preview(), Some((640, 360)));
    let crop = w.cx.read_entity(&w.shell, |s, _| s.images_crop()).expect("a crop");
    assert!((crop.width * 640.0 - 360.0).abs() < 1.0 && (crop.height * 360.0 - 360.0).abs() < 1.0, "{crop:?}");
    // Turned: the crop turns with it, still square.
    w.press(Role::Button, "Werkzeug Drehen");
    w.press(Role::Button, "Nach rechts drehen");
    w.settle();
    assert_eq!(w.preview(), Some((360, 360)));
    // Scaled to 100 wide.
    w.press(Role::Button, "Werkzeug Größe");
    w.press(Role::Button, "Breite 800");
    w.settle();
    // (800 is more than the picture: the stage shows the preview size, not the result size.)
    w.press(Role::Button, "Breite 400");
    w.settle();
    // Saved as PNG beside the source.
    w.press(Role::Button, "Werkzeug Speichern");
    w.press(Role::Button, "Format PNG");
    w.settle();
    w.press(Role::Button, "Datei speichern");
    w.settle();
    let made = w.cx.read_entity(&w.shell, |s, _| s.images_made().to_vec());
    assert_eq!(made.len(), 1);
    assert_eq!((made[0].width, made[0].height), (400, 400));
    assert!(made[0].path.exists() && made[0].path.file_name().unwrap().to_string_lossy().contains("(bearbeitet)"));
    assert_eq!(made[0].path.extension().unwrap(), Format::Png.extension());
    assert!(w.tree().find(Role::Button, "eins (bearbeitet).png im Ordner zeigen").is_some());
    assert!(a.exists(), "the original is as it was");

    // Many at once: the size and the colour go for all, the crop only for the chosen one.
    w.shell.update(w.cx, |shell, cx| shell.images_take(vec![a.clone(), b.clone()], cx));
    w.settle();
    assert!(w.tree().find(Role::Button, "Werkzeug Viele").is_some());
    w.press(Role::Button, "Werkzeug Größe");
    w.press(Role::Button, "Breite 400");
    w.press(Role::Button, "Werkzeug Viele");
    w.press(Role::Button, "Alle 2 verarbeiten");
    w.settle();
    let made = w.cx.read_entity(&w.shell, |s, _| s.images_made().to_vec());
    assert_eq!(made.len(), 2);
    assert_eq!((made[0].width, made[0].height), (400, 225));
    assert_eq!((made[1].width, made[1].height), (400, 300));
}

#[gpui::test]
fn the_crop_is_drawn_on_the_picture_kept_to_a_ratio_and_shown_cropped_when_the_tool_is_left(cx: &mut TestAppContext) {
    use gpui::{Modifiers, MouseButton};
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let a = picture(&ff, tmp.path(), "eins.png", "640x360");
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
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Images, cx));
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.images_take(vec![a.clone()], cx));
    w.settle();
    w.draw();
    let b = w.cx.read_entity(&w.shell, |s, _| s.images_crop_bounds());
    assert!(f32::from(b.size.width) > 200.0, "the picture was measured: {b:?}");
    let at = |fx: f32, fy: f32| point(b.origin.x + b.size.width * fx, b.origin.y + b.size.height * fy);

    // A rectangle drawn from a quarter to three quarters (free).
    w.cx.simulate_mouse_down(at(0.25, 0.25), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.75, 0.75), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.75, 0.75), MouseButton::Left, Modifiers::default());
    w.draw();
    let crop = w.cx.read_entity(&w.shell, |s, _| s.images_crop()).expect("a crop");
    assert!((crop.width - 0.5).abs() < 0.04 && (crop.height - 0.5).abs() < 0.04, "{crop:?}");

    // With 1:1 chosen the rectangle stays square in pixels, whatever the hand does.
    w.press(Role::Button, "Seitenverhältnis 1:1");
    w.cx.simulate_mouse_down(at(0.0, 0.0), MouseButton::Left, Modifiers::default());
    w.cx.simulate_mouse_move(at(0.4, 0.3), Some(MouseButton::Left), Modifiers::default());
    w.cx.simulate_mouse_up(at(0.4, 0.3), MouseButton::Left, Modifiers::default());
    let square = w.cx.read_entity(&w.shell, |s, _| s.images_crop()).expect("a crop");
    assert!(((square.width * 640.0) - (square.height * 360.0)).abs() < 2.0, "{square:?}");

    // Leaving the tool: the stage shows what will be written.
    w.press(Role::Button, "Werkzeug Drehen");
    w.settle();
    let (pw, ph) = w.preview().unwrap();
    assert!((f64::from(pw) - square.width * 640.0).abs() < 3.0 && (f64::from(ph) - square.height * 360.0).abs() < 3.0, "{pw} × {ph}");
}

#[gpui::test]
fn settings_are_walked_back_and_forth_and_the_original_can_be_compared(cx: &mut TestAppContext) {
    let Some(ff) = Ffmpeg::locate() else { return };
    let tmp = tempfile::tempdir().unwrap();
    let a = picture(&ff, tmp.path(), "eins.png", "640x360");
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
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Images, cx));
    w.shell.update(w.cx, |shell, cx| shell.images_take(vec![a], cx));
    w.settle();
    w.press(Role::Button, "Werkzeug Drehen");
    w.press(Role::Button, "Nach rechts drehen");
    w.settle();
    assert_eq!(w.preview(), Some((360, 640)));
    // „Vergleichen“ shows the original, and back.
    w.press(Role::Button, "Mit dem Original vergleichen");
    w.settle();
    assert_eq!(w.preview(), Some((640, 360)));
    w.press(Role::Button, "Mit dem Original vergleichen");
    w.settle();
    // Strg+Z takes the turn back, Strg+Umschalt+Z does it again.
    // The keys reach the window from a control that does not use them.
    let undo = w.tree().find(Role::Button, "Werkzeug Drehen").unwrap().id;
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: undo, data: None }, window, cx));
    w.cx.simulate_keystrokes("ctrl-z");
    w.settle();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.images_ops().rotate), 0);
    let undo = w.tree().find(Role::Button, "Werkzeug Drehen").unwrap().id;
    w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: undo, data: None }, window, cx));
    w.cx.simulate_keystrokes("ctrl-shift-z");
    w.settle();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.images_ops().rotate), 90);
    // The buttons say the same.
    w.press(Role::Button, "Rückgängig (Strg+Z)");
    w.settle();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.images_ops().rotate), 0);
}
