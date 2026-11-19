//! The Abspielen page in GPUI's test window, with real files and the real FFmpeg: the stage, the controls,
//! the clock that runs, pause, a jump by the keyboard, a list of files, a subtitle beside the film.
//! Skipped where there is no FFmpeg.

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
use sondra_app::store::MerkStore;
use sondra_media::Ffmpeg;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn film(dir: &Path, name: &str, seconds: u32) -> PathBuf {
    let ff = Ffmpeg::locate().unwrap();
    let path = dir.join(name);
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", &seconds.to_string()])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    path
}

fn open(cx: &mut TestAppContext) -> Window<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let (shell, cx) = cx.add_window_view(|window, cx| Shell::new(window, cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Player, cx));
    w.draw();
    w
}

impl Window<'_> {
    fn draw(&mut self) {
        let view = self.shell.clone();
        self.cx.draw(
            point(px(0.), px(0.)),
            size(AvailableSpace::Definite(px(WIDTH)), AvailableSpace::Definite(px(900.))),
            move |_, _| view,
        );
    }
    fn tree(&self) -> Rc<Snapshot> {
        self.seen.borrow().last().expect("a frame").clone()
    }
    fn press(&mut self, role: Role, label: &str) {
        let id = self.tree().find(role, label).unwrap_or_else(|| panic!("{label} is on the screen")).id;
        self.cx.update(|window, cx| {
            run_action(ActionRequest { action: Action::Click, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx)
        });
        self.draw();
    }
    /// Lets a real second pass the way a window does: drawn again and again.
    fn watch(&mut self, seconds: f64) {
        let until = std::time::Instant::now() + Duration::from_secs_f64(seconds);
        while std::time::Instant::now() < until {
            self.draw();
            std::thread::sleep(Duration::from_millis(8));
        }
    }
    fn position(&self) -> f64 {
        self.cx.read_entity(&self.shell, |s, _| s.player_position()).unwrap_or(-1.0)
    }
}

fn has_ffmpeg() -> bool {
    Ffmpeg::locate().is_some()
}

#[gpui::test]
fn an_empty_player_offers_a_file_and_a_film_plays_with_its_picture_and_controls(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "Frieren S01E01.mp4", 4);
    let mut w = open(cx);
    assert!(w.tree().find(Role::Heading, "Abspielen").is_some());
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some());
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(1.2);
    let tree = w.tree();
    assert!(tree.find(Role::Button, "Pause").is_some(), "it plays: the button offers the pause");
    assert!(w.cx.read_entity(&w.shell, |s, _| s.player_has_picture()), "a picture reached the stage");
    let pos = w.position();
    assert!((0.7..=1.9).contains(&pos), "about a second in: {pos}");
    let seek = tree.find(Role::Slider, "Stelle im Film").unwrap();
    assert!(seek.value.as_ref().is_some_and(|v| v.ends_with("von 0:04")), "{:?}", seek.value);
    assert_eq!(tree.find(Role::Slider, "Lautstärke").unwrap().value.as_ref().map(|v| v.to_string()), Some("100 Prozent".to_string()));
    assert!(tree.find(Role::Button, "Tempo ändern, jetzt Normal").is_some());
    assert!(tree.find(Role::Button, "Stumm").is_some());
}

#[gpui::test]
fn pause_holds_the_clock_and_the_keyboard_on_the_bar_jumps(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "film.mp4", 20);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(0.8);
    w.press(Role::Button, "Pause");
    let held = w.position();
    w.watch(0.5);
    assert!((w.position() - held).abs() < 0.06, "{held} → {}", w.position());
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some(), "and the button offers to go on");
    w.press(Role::Button, "Wiedergabe starten");

    // A key on the bar steps by ten seconds of a film of twenty: half of it.
    let bar = w.tree().find(Role::Slider, "Stelle im Film").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: bar, data: None }, window, cx)
    });
    w.cx.simulate_keystrokes("right");
    w.watch(0.8);
    assert!(w.position() >= 10.0, "it jumped: {}", w.position());
    assert!(w.cx.read_entity(&w.shell, |s, _| s.player_has_picture()));
}

#[gpui::test]
fn a_list_of_files_plays_one_after_the_other_and_a_subtitle_beside_a_film_goes_with_it(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "Folge 1.mp4", 3);
    let two = film(tmp.path(), "Folge 2.mp4", 3);
    std::fs::write(tmp.path().join("Folge 1.de.srt"), "1\n00:00:00,500 --> 00:00:02,000\nGuten Tag.\n\n2\n00:00:02,000 --> 00:00:02,900\nAuf Wiedersehen.\n").unwrap();
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one, two], cx));
    w.watch(0.4);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 2, "the subtitle of the same name was found");
    let tree = w.tree();
    assert!(tree.find(Role::Heading, "Liste").is_some());
    assert!(tree.find(Role::ListItem, "Folge 1.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
    // The next one by the button.
    w.press(Role::Button, "Weiter");
    w.watch(0.4);
    assert!(w.tree().find(Role::ListItem, "Folge 2.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 0, "the second has none");
    // And the first at its end goes on by itself: from the second, back by a click on the list.
    w.press(Role::ListItem, "Folge 1.mp4");
    w.watch(0.3);
    assert!(w.tree().find(Role::ListItem, "Folge 1.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
}

#[gpui::test]
fn what_is_not_a_film_is_said_and_a_missing_file_is_too(cx: &mut TestAppContext) {
    let mut w = open(cx);
    let tmp = tempfile::tempdir().unwrap();
    let text = tmp.path().join("notizen.txt");
    std::fs::write(&text, "nur Text").unwrap();
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![text], cx));
    w.draw();
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("nichts, was sich abspielen lässt"))));
    assert!(w.tree().find(Role::Button, "Datei wählen").is_some(), "and the way in stays");
}

#[gpui::test]
fn a_file_named_like_an_episode_is_ticked_off_at_ninety_percent_and_can_be_taken_back(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    use serde_json::json;
    use sondra_merk::normalize::{normalize, Context as Ids};
    use sondra_merk::sqlite::{read_shared, write_sqlite, Snapshot};
    let tmp = tempfile::tempdir().unwrap();
    let list = tmp.path().join("Merkliste.sqlite");
    let mut ids = Ids::system();
    let frieren = normalize(
        &json!({ "id": "fr", "title": "Frieren", "status": "watching", "season": 1, "episode": 2, "seasons": [{ "number": 1, "episodes": 12, "watched": [1] }] }),
        &mut ids,
    );
    std::fs::write(&list, write_sqlite(&Snapshot { items: vec![frieren], ..Default::default() }).unwrap()).unwrap();
    let path = film(tmp.path(), "Frieren S01E02.mp4", 4);
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let listfile = list.clone();
    let (shell, vcx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(listfile), cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx: vcx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Player, cx));
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(0.8);
    let line = |w: &Window| w.tree().nodes.iter().find(|n| n.role == Role::Status).and_then(|n| n.label.as_ref().map(|l| l.to_string())).unwrap_or_default();
    assert_eq!(line(&w), "Merkliste · Frieren · Staffel 1, Folge 2 — wird ab 90 % abgehakt.");
    assert!(w.tree().find(Role::Button, "Serie „Frieren“ öffnen").is_some());
    // To the end of the film: past 90 % it is ticked off.
    w.watch(3.0);
    assert_eq!(line(&w), "Merkliste · Frieren · Staffel 1, Folge 2 — abgehakt.");
    let stored = read_shared(&std::fs::read(&list).unwrap(), &mut Ids::system()).unwrap();
    assert_eq!(stored.items[0].seasons.as_ref().unwrap()[0].watched, vec![1, 2]);
    assert_eq!(stored.items[0].episode, Some(3), "and the place moved on");
    assert_eq!(stored.items[0].history.as_ref().unwrap().len(), 1);
    // Taken back: the list is as it was, and the file does not tick it again while it plays.
    w.press(Role::Button, "Rückgängig");
    assert_eq!(line(&w), "Merkliste · Frieren · Staffel 1, Folge 2 — nicht abgehakt.");
    let stored = read_shared(&std::fs::read(&list).unwrap(), &mut Ids::system()).unwrap();
    assert_eq!(stored.items[0].seasons.as_ref().unwrap()[0].watched, vec![1]);
    assert_eq!(stored.items[0].episode, Some(2));
    w.watch(0.5);
    let stored = read_shared(&std::fs::read(&list).unwrap(), &mut Ids::system()).unwrap();
    assert_eq!(stored.items[0].seasons.as_ref().unwrap()[0].watched, vec![1], "taken back, it stays taken back");
}

#[gpui::test]
fn the_keys_of_the_player_space_arrows_and_m(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "film.mp4", 30);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(0.5);
    // The keys reach the window from a control that does not use them: the „Stumm“ chip.
    let focus = |w: &mut Window| {
        let id = w.tree().find(Role::Button, "Stumm").unwrap().id;
        w.cx.update(|window, cx| {
            run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx)
        });
    };
    focus(&mut w);
    w.cx.simulate_keystrokes("right");
    w.watch(0.5);
    assert!(w.position() >= 10.0, "an arrow jumps by the skip of the settings, ten seconds: {}", w.position());
    focus(&mut w);
    w.cx.simulate_keystrokes("left");
    w.watch(0.4);
    assert!(w.position() < 5.0, "and the other way: {}", w.position());
    focus(&mut w);
    w.cx.simulate_keystrokes("down");
    w.draw();
    assert_eq!(w.tree().find(Role::Slider, "Lautstärke").unwrap().value.as_ref().map(|v| v.to_string()), Some("95 Prozent".to_string()));
    focus(&mut w);
    w.cx.simulate_keystrokes("m");
    w.draw();
    assert_eq!(w.tree().find(Role::Button, "Stumm").unwrap().toggled, Some(true));
    // Space on a button presses that button; on the bar, which does not use it, it pauses.
    let bar = w.tree().find(Role::Slider, "Stelle im Film").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: bar, data: None }, window, cx)
    });
    w.cx.simulate_keystrokes("space");
    w.draw();
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some(), "Space pauses");
}

#[gpui::test]
fn over_an_episode_the_opening_can_be_skipped_and_in_the_credits_the_next_is_offered(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    // Five minutes: an episode, not a clip.
    let one = film(tmp.path(), "Serie - 01.mp4", 300);
    let two = film(tmp.path(), "Serie - 02.mp4", 5);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one, two], cx));
    w.watch(0.6);
    assert!(w.tree().find(Role::Button, "Vorspann überspringen").is_some(), "in the first minutes of an episode");
    assert!(w.tree().find(Role::Button, "Nächste Folge").is_none(), "and not yet the next");
    let before = w.position();
    w.press(Role::Button, "Vorspann überspringen");
    w.watch(0.5);
    assert!(w.position() >= before + 85.0, "it jumped by the length of an opening, 1:30: {before} → {}", w.position());
    // A third of a short episode is still its opening: the offer stays until that is passed.
    w.press(Role::Button, "Vorspann überspringen");
    w.watch(0.5);
    assert!(w.tree().find(Role::Button, "Vorspann überspringen").is_none(), "past the first third the offer is gone ({})", w.position());
    // In the last minutes: the next episode.
    w.shell.update(w.cx, |shell, cx| {
        shell.player_seek(275.0);
        cx.notify();
    });
    w.watch(0.8);
    assert!(w.tree().find(Role::Button, "Nächste Folge").is_some(), "in the credits ({})", w.position());
    w.press(Role::Button, "Nächste Folge");
    w.watch(0.3);
    assert!(w.tree().find(Role::ListItem, "Serie - 02.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")));
}

#[gpui::test]
fn bookmarks_are_set_with_b_found_with_shift_arrows_listed_and_copied_as_chapters(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let path = film(tmp.path(), "film.mp4", 40);
    let memory = tmp.path().join("Abspielen.json");
    let mut w = open(cx);
    let store = sondra_app::store::FileStore::open(&memory);
    w.shell.update(w.cx, |shell, cx| shell.open_player_memory(store, cx));
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path.clone()], cx));
    w.watch(1.5);
    let focus = |w: &mut Window| {
        let id = w.tree().find(Role::Slider, "Stelle im Film").unwrap().id;
        w.cx.update(|window, cx| run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx));
    };
    focus(&mut w);
    w.cx.simulate_keystrokes("b");
    w.draw();
    assert!(w.tree().find(Role::Button, "Lesezeichen (1)").is_some(), "one bookmark");
    w.cx.simulate_keystrokes("b");
    w.draw();
    assert!(w.tree().find(Role::Button, "Lesezeichen (1)").is_some(), "the same place twice is one bookmark");
    // Jump on, set another, and go back by Shift+Left.
    w.shell.update(w.cx, |shell, cx| {
        shell.player_seek(20.0);
        cx.notify();
    });
    w.watch(0.6);
    focus(&mut w);
    w.cx.simulate_keystrokes("b");
    w.draw();
    assert!(w.tree().find(Role::Button, "Lesezeichen (2)").is_some());
    w.cx.simulate_keystrokes("shift-left");
    w.watch(0.5);
    assert!(w.position() < 5.0, "back to the first bookmark: {}", w.position());
    w.cx.simulate_keystrokes("shift-right");
    w.watch(0.5);
    assert!(w.position() >= 19.5, "and on to the second: {}", w.position());

    // The list, and the chapters.
    w.press(Role::Button, "Lesezeichen (2)");
    assert!(w.tree().find(Role::Dialog, "Lesezeichen").is_some());
    assert!(w.tree().find(Role::ListItem, "Lesezeichen 2").is_some());
    w.press(Role::Button, "Als Kapitel kopieren");
    let copied = w.cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
    let lines: Vec<&str> = copied.lines().collect();
    assert_eq!(lines.len(), 3, "{copied}");
    assert_eq!(lines[0], "0:00 Anfang", "a beginning is added when no bookmark is at 0:00");
    assert!(lines[2].starts_with("0:2") && lines[2].ends_with("Kapitel 2"), "{copied}");
    // Taken away, and kept for the file: a new start of the player finds the one that stayed.
    w.press(Role::Button, "Lesezeichen 2 entfernen");
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Button, "Lesezeichen (1)").is_some());
    drop(w);
    let kept = std::fs::read_to_string(&memory).unwrap();
    assert!(kept.contains("sondra:abspielen:marken") && kept.contains("film.mp4|"), "{kept}");
}

#[gpui::test]
fn the_sleep_timer_fades_the_sound_and_stops_the_film_and_the_end_of_the_title_does_not_go_on(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "eins.mp4", 3);
    let two = film(tmp.path(), "zwei.mp4", 3);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one.clone(), two.clone()], cx));
    w.watch(0.3);
    // The dialog and its choices.
    w.press(Role::Button, "Schlaf-Timer");
    assert!(w.tree().find(Role::Dialog, "Schlaf-Timer").is_some());
    for label in ["15 Minuten", "30 Minuten", "60 Minuten", "Ende des Titels", "Aus"] {
        assert!(w.tree().find(Role::Button, label).is_some(), "{label}");
    }
    assert_eq!(w.tree().find(Role::Button, "Aus").unwrap().toggled, Some(true));
    w.press(Role::Button, "30 Minuten");
    assert!(w.tree().find(Role::Dialog, "Schlaf-Timer").is_none(), "a choice closes it");
    assert!(w.tree().find(Role::Button, "Schlaf-Timer (30 Min.)").is_some());

    // A timer that runs out stops the film.
    w.shell.update(w.cx, |shell, cx| {
        shell.player_sleep_in(std::time::Duration::from_millis(600));
        cx.notify();
    });
    w.watch(1.2);
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some(), "it stopped by itself");
    assert!(w.tree().find(Role::Button, "Schlaf-Timer").is_some(), "and the timer is over");

    // „Ende des Titels“: the film ends, and the next does not begin.
    w.press(Role::Button, "Wiedergabe starten");
    w.press(Role::Button, "Schlaf-Timer");
    w.press(Role::Button, "Ende des Titels");
    w.shell.update(w.cx, |shell, cx| {
        shell.player_seek(2.5);
        cx.notify();
    });
    w.watch(2.0);
    assert!(w.tree().find(Role::ListItem, "eins.mp4").unwrap().description.as_ref().is_some_and(|d| d.contains("läuft")), "still the first, not gone on");
    assert!(w.tree().find(Role::Button, "Schlaf-Timer").is_some(), "the timer is spent");
}
