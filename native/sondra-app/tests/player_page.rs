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
    assert!(w.tree().find(Role::Button, "Dateien auswählen").is_some());
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
    assert!(w.tree().find(Role::Button, "Dateien auswählen").is_some(), "and the way in stays");
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
    // To the end of the film: past 90 % it is ticked off. (Waited for, not timed: on a loaded machine the
    // film starts late.)
    let limit = std::time::Instant::now() + Duration::from_secs(40);
    while std::time::Instant::now() < limit && !line(&w).ends_with("— abgehakt.") {
        w.watch(0.1);
    }
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
    // The picture of the moment becomes the cover of the series.
    w.press(Role::Button, "Dieses Bild als Cover der Serie auf der Merkliste festlegen");
    let limit = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < limit && !w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("jetzt das Cover von „Frieren“"))) {
        w.cx.run_until_parked();
        w.watch(0.1);
    }
    let cover = w.shell.read_with(w.cx, |s, _| s.merk_items()[0].cover.clone()).unwrap_or_default();
    assert!(cover.starts_with("data:image/jpeg;base64,"), "{} — {:?}", &cover[..cover.len().min(40)], w.tree().nodes.iter().filter_map(|n| n.label.as_ref().map(|l| l.to_string())).filter(|l| l.contains("Cover") || l.contains("Bild")).collect::<Vec<_>>());
}

#[gpui::test]
fn the_list_is_edited_the_clock_turns_round_a_subtitle_is_loaded_by_hand_and_the_film_goes_to_an_editor(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let files: Vec<PathBuf> = (1..=3).map(|n| film(tmp.path(), &format!("Clip {n}.mp4"), 3)).collect();
    let srt = tmp.path().join("eigene.srt");
    std::fs::write(&srt, "1\n00:00:00,100 --> 00:00:02,500\nVon Hand.\n").unwrap();
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(files.clone(), cx));
    w.watch(0.4);
    // „Als Nächstes“ puts the third right after the first; the one that plays has no such buttons.
    assert!(w.tree().find(Role::Button, "Clip 1.mp4 als Nächstes").is_none());
    w.press(Role::Button, "Clip 3.mp4 als Nächstes");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_queue_names()), ["Clip 1.mp4", "Clip 3.mp4", "Clip 2.mp4"]);
    w.press(Role::Button, "Clip 2.mp4 aus der Liste nehmen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_queue_names()), ["Clip 1.mp4", "Clip 3.mp4"]);
    // The clock: a click shows what is left.
    w.press(Role::Button, "Laufzeit — umschalten auf Restzeit");
    assert!(w.tree().find(Role::Button, "Restzeit — umschalten auf Laufzeit").is_some());
    // A subtitle file by hand.
    w.shell.update(w.cx, |s, cx| s.player_load_subtitle(&srt, cx)).unwrap();
    w.watch(0.2);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 1);
    // Into the sound editor: the file goes there by the session, and the film here pauses.
    w.press(Role::Button, "Im Ton-Editor öffnen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Audio);
    assert!(w.shell.read_with(w.cx, |s, _| s.session_files()).contains(&files[0]));
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

#[gpui::test]
fn sound_tracks_and_subtitles_are_chosen_in_one_window_and_their_looks_are_kept(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    // A film with two sound tracks and a subtitle inside it.
    let srt = tmp.path().join("innen.srt");
    std::fs::write(&srt, "1\n00:00:00,300 --> 00:00:01,500\nEingebaut.\n\n2\n00:00:01,600 --> 00:00:02,500\nZweite Zeile.\n").unwrap();
    let path = tmp.path().join("zwei-spuren.mp4");
    let ff = Ffmpeg::locate().unwrap();
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-i"])
        .arg(&srt)
        .args(["-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "mov_text"])
        .args(["-metadata:s:a:0", "language=deu", "-metadata:s:a:1", "language=eng", "-metadata:s:s:0", "language=deu"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![path], cx));
    w.watch(0.3);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 0, "nothing shown until chosen");

    w.press(Role::Button, "Ton und Untertitel");
    assert!(w.tree().find(Role::Dialog, "Ton und Untertitel").is_some());
    assert!(w.tree().find(Role::Button, "Tonspur deu").is_some(), "both tracks are offered");
    assert!(w.tree().find(Role::Button, "Tonspur eng").is_some());
    assert_eq!(w.tree().find(Role::Button, "Untertitel aus").unwrap().toggled, Some(true));
    // Another track plays on.
    w.press(Role::Button, "Tonspur eng");
    assert_eq!(w.tree().find(Role::Button, "Tonspur eng").unwrap().toggled, Some(true));
    // The subtitle inside the film is read out of it.
    w.press(Role::Button, "Untertitel deu");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 2);
    assert_eq!(w.tree().find(Role::Button, "Untertitel deu").unwrap().toggled, Some(true));
    // Their looks are kept.
    w.press(Role::Button, "Schriftgrösse Gross");
    assert_eq!(w.tree().find(Role::Button, "Schriftgrösse Gross").unwrap().toggled, Some(true));
    w.press(Role::Button, "Untertitel aus");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_cues()), 0);
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Ton und Untertitel").is_none());
}

#[gpui::test]
fn picture_and_sound_have_their_window_and_what_is_chosen_is_kept_and_taken_back(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "bild.mp4", 3);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one], cx));
    w.watch(0.3);
    w.press(Role::Button, "Bild und Ton");
    assert!(w.tree().find(Role::Dialog, "Bild und Ton").is_some());
    assert_eq!(w.tree().find(Role::Button, "Bildpassung Einpassen").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Helligkeit 100 %").unwrap().toggled, Some(true));
    w.press(Role::Button, "Bildpassung Füllen");
    assert_eq!(w.tree().find(Role::Button, "Bildpassung Füllen").unwrap().toggled, Some(true));
    w.press(Role::Button, "Helligkeit 150 %");
    assert_eq!(w.tree().find(Role::Button, "Helligkeit 150 %").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Helligkeit 100 %").unwrap().toggled, Some(false));
    w.press(Role::Button, "Sättigung 0 %");
    w.press(Role::Button, "Verstärkung 200 %");
    w.press(Role::Button, "Spiegeln");
    w.press(Role::Button, "Nachtmodus: Leises lauter, Lautes leiser");
    assert_eq!(w.tree().find(Role::Button, "Nachtmodus: Leises lauter, Lautes leiser").unwrap().toggled, Some(true));
    w.press(Role::Button, "Karaoke: Stimme in der Mitte entfernen");
    assert_eq!(w.tree().find(Role::Button, "Karaoke: Stimme in der Mitte entfernen").unwrap().toggled, Some(true));
    // The equalizer: a preset sets the five bands and switches it on.
    // As in the web player it is on from the start, flat.
    assert_eq!(w.tree().find(Role::Button, "Entzerrer an").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Entzerrer: Flat").unwrap().toggled, Some(true));
    w.press(Role::Button, "Entzerrer an");
    assert_eq!(w.tree().find(Role::Button, "Entzerrer an").unwrap().toggled, Some(false));
    w.press(Role::Button, "Entzerrer: Bass Boost");
    assert_eq!(w.tree().find(Role::Button, "Entzerrer: Bass Boost").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Entzerrer an").unwrap().toggled, Some(true));
    let bass = w.tree().find(Role::Slider, "Bässe (80 Hz)").unwrap().value.clone().unwrap();
    assert_eq!(bass.as_ref(), "+6 dB");
    let mids = w.tree().find(Role::Slider, "Mitten (1000 Hz)").unwrap().value.clone().unwrap();
    assert_eq!(mids.as_ref(), "0 dB");
    // The film goes on through all the restarts.
    w.watch(0.8);
    assert!(w.position() > 0.5, "{}", w.position());
    // Everything back.
    w.press(Role::Button, "Zurücksetzen");
    assert_eq!(w.tree().find(Role::Button, "Karaoke: Stimme in der Mitte entfernen").unwrap().toggled, Some(false));
    assert_eq!(w.tree().find(Role::Button, "Entzerrer: Flat").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Slider, "Bässe (80 Hz)").unwrap().value.clone().unwrap().as_ref(), "0 dB");
    assert_eq!(w.tree().find(Role::Button, "Helligkeit 100 %").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Bildpassung Einpassen").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Verstärkung 100 %").unwrap().toggled, Some(true));
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Dialog, "Bild und Ton").is_none());
}

#[gpui::test]
fn a_big_film_can_be_watched_smaller_and_the_next_film_is_as_it_is_again(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let big = tmp.path().join("gross.mp4");
    let ff = Ffmpeg::locate().unwrap();
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&big)
        .output()
        .unwrap();
    assert!(out.status.success());
    let small = film(tmp.path(), "klein.mp4", 3);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![big, small], cx));
    w.watch(0.3);
    w.press(Role::Button, "Bild und Ton");
    assert_eq!(w.tree().find(Role::Button, "Qualität Original").unwrap().toggled, Some(true));
    assert!(w.tree().find(Role::Button, "Qualität 720p").is_none(), "only steps below the film's own are offered");
    w.press(Role::Button, "Qualität 480p");
    assert_eq!(w.tree().find(Role::Button, "Qualität 480p").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Qualität Original").unwrap().toggled, Some(false));
    w.watch(0.8);
    assert!(w.position() > 0.3, "the film goes on: {}", w.position());
    // A small film has no step to offer.
    w.press(Role::Button, "Schliessen");
    w.press(Role::Button, "Weiter");
    w.watch(0.3);
    w.press(Role::Button, "Bild und Ton");
    assert!(w.tree().find(Role::Button, "Qualität Original").is_none());
}

#[gpui::test]
fn a_song_has_its_visualizer_and_the_window_chooses_its_look(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let song = tmp.path().join("lied.wav");
    let ff = Ffmpeg::locate().unwrap();
    let out = Command::new(ff.program()).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3"]).arg(&song).output().unwrap();
    assert!(out.status.success());
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![song], cx));
    w.watch(0.5);
    w.press(Role::Button, "Bild und Ton");
    // On from the start, as bars (as the web player has it).
    assert_eq!(w.tree().find(Role::Button, "Visualizer zeigen").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Visualizer Balken").unwrap().toggled, Some(true));
    w.press(Role::Button, "Visualizer Ring");
    assert_eq!(w.tree().find(Role::Button, "Visualizer Ring").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Visualizer Balken").unwrap().toggled, Some(false));
    w.press(Role::Button, "Visualizer zeigen");
    assert_eq!(w.tree().find(Role::Button, "Visualizer zeigen").unwrap().toggled, Some(false));
    w.watch(0.3);
    assert!(w.position() > 0.3, "the song goes on: {}", w.position());
}

#[gpui::test]
fn a_film_has_no_visualizer_to_choose(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "bild.mp4", 3);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one], cx));
    w.watch(0.3);
    w.press(Role::Button, "Bild und Ton");
    assert!(w.tree().find(Role::Button, "Visualizer zeigen").is_none());
}

#[gpui::test]
fn the_picture_has_four_sizes_and_over_the_whole_window_the_controls_go_when_nobody_asks_for_them(cx: &mut TestAppContext) {
    use sondra_app::player_page::PlayerSize;
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let a = film(tmp.path(), "a.mp4", 4);
    let b = film(tmp.path(), "b.mp4", 4);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![a, b], cx));
    w.watch(0.3);
    assert!(w.tree().find(Role::Heading, "Liste").is_some(), "beside the list at first");
    // The cinema mode: wide, and the list is out of the way.
    w.press(Role::Button, "Kinomodus (T)");
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_size()), PlayerSize::Kino);
    assert!(w.tree().find(Role::Heading, "Liste").is_none());
    assert!(w.tree().find(Role::Button, "Pause").is_some(), "the controls are there");
    w.press(Role::Button, "Kinomodus (T)");
    assert!(w.tree().find(Role::Heading, "Liste").is_some());
    // The window can be kept above all others, and let go again.
    assert!(!w.cx.read_entity(&w.shell, |s, _| s.player_pinned()));
    w.press(Role::Button, "Immer im Vordergrund");
    assert!(w.cx.read_entity(&w.shell, |s, _| s.player_pinned()));
    assert!(w.tree().find(Role::Button, "Immer im Vordergrund beenden").is_some());
    w.press(Role::Button, "Immer im Vordergrund beenden");
    assert!(!w.cx.read_entity(&w.shell, |s, _| s.player_pinned()));
    // Over the whole window: no header, the controls over the picture.
    w.press(Role::Button, "Bild über das ganze Fenster (W)");
    w.watch(0.2);
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_size()), PlayerSize::Fill);
    assert!(w.tree().find(Role::Button, "Pause").is_some());
    assert!(w.tree().find(Role::Heading, "Abspielen").is_none(), "the page is the picture alone");
    // Quiet for a while: the controls go; the mouse (or a key) brings them back.
    w.shell.update(w.cx, |s, cx| {
        s.player_quiet_for(std::time::Duration::from_secs(10));
        cx.notify();
    });
    w.draw();
    assert!(w.tree().find(Role::Button, "Pause").is_none(), "gone after the quiet");
    w.cx.simulate_keystrokes("left");
    w.draw();
    assert!(w.tree().find(Role::Button, "Pause").is_some(), "a key brings them back");
    // Escape goes back to the page; it does not stop the film.
    w.cx.simulate_keystrokes("escape");
    w.draw();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_size()), PlayerSize::Normal);
    assert!(w.tree().find(Role::Heading, "Abspielen").is_some());
    // Over the whole screen, by the key: the window is asked, and the next film stays at that size.
    w.cx.simulate_keystrokes("f");
    w.draw();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_size()), PlayerSize::Full);
    w.cx.simulate_keystrokes("escape");
    w.draw();
    assert_eq!(w.cx.read_entity(&w.shell, |s, _| s.player_size()), PlayerSize::Normal);
}

#[gpui::test]
fn a_minimised_window_pauses_only_when_asked_to_and_does_not_begin_again_by_itself(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let a = film(tmp.path(), "a.mp4", 5);
    let mut w = open(cx);
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![a], cx));
    w.watch(0.3);
    // Off to begin with: minimising changes nothing.
    w.shell.update(w.cx, |s, _| s.player_minimized(true));
    w.draw();
    assert!(w.tree().find(Role::Button, "Pause").is_some(), "still playing");
    // Turned on in the window, then it stops, and coming back does not start it.
    w.press(Role::Button, "Bild und Ton");
    w.press(Role::Button, "Beim Minimieren pausieren");
    assert_eq!(w.tree().find(Role::Button, "Beim Minimieren pausieren").unwrap().toggled, Some(true));
    w.press(Role::Button, "Schliessen");
    w.shell.update(w.cx, |s, _| s.player_minimized(true));
    w.draw();
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some(), "paused");
    w.shell.update(w.cx, |s, _| s.player_minimized(false));
    w.watch(0.3);
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some(), "and it stays so");
}

#[gpui::test]
fn a_film_goes_on_behind_another_tool_and_a_small_bar_says_so_and_stops_it_and_leads_back(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let a = film(tmp.path(), "hinten.mp4", 6);
    let mut w = open(cx);
    assert!(w.tree().find(Role::Button, "Zum Player").is_none(), "no film, no bar");
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![a], cx));
    w.watch(0.3);
    assert!(w.tree().find(Role::Button, "Zum Player").is_none(), "on its own page there is no bar");
    let before = w.position();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Merkliste, cx));
    w.watch(0.8);
    assert!(w.position() > before + 0.5, "it goes on");
    assert!(w.tree().find(Role::Button, "Zum Player").is_some(), "and the bar says so");
    w.press(Role::Button, "Pause");
    let stopped = w.position();
    w.watch(0.4);
    assert!((w.position() - stopped).abs() < 0.05, "stopped from the bar");
    assert!(w.tree().find(Role::Button, "Wiedergabe starten").is_some());
    w.press(Role::Button, "Zum Player");
    assert!(w.tree().find(Role::Heading, "Abspielen").is_some(), "back on the page of the player");
    assert!(w.tree().find(Role::Button, "Zum Player").is_none());
}

#[gpui::test]
fn the_film_can_go_in_a_small_window_of_its_own_that_keeps_the_clock_and_comes_back(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "bild.mp4", 30);
    let mut w = open(cx);
    // No film, no window.
    assert!(!w.cx.read_entity(&w.shell, |s, _| s.pip_open()));
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one], cx));
    w.watch(0.3);
    assert_eq!(w.cx.update(|_, cx| cx.windows().len()), 1);
    w.press(Role::Button, "Bild im Bild");
    w.cx.run_until_parked();
    assert!(w.cx.read_entity(&w.shell, |s, _| s.pip_open()));
    assert_eq!(w.cx.update(|_, cx| cx.windows().len()), 2, "a window of its own");
    assert!(w.tree().find(Role::Button, "Bild im Bild beenden").is_some());
    // The small window keeps the clock: the film goes on although the page is no longer what ticks.
    let drive = |w: &mut Window, seconds: f64| {
        let until = std::time::Instant::now() + Duration::from_secs_f64(seconds);
        while std::time::Instant::now() < until {
            let shell = w.shell.clone();
            w.cx.update(|window, cx| shell.update(cx, |s, _| { s.pip_drive(window); }));
            std::thread::sleep(Duration::from_millis(8));
        }
    };
    let before = w.position();
    drive(&mut w, 0.6);
    let after = w.position();
    assert!(after > before + 0.2, "the film stood still: {before} -> {after}");
    // A click on the picture pauses it; a second one goes on.
    w.shell.update(w.cx, |shell, cx| shell.pip_toggle(cx));
    drive(&mut w, 0.1);
    let held = w.position();
    drive(&mut w, 0.4);
    assert!((w.position() - held).abs() < 0.05, "it went on while paused");
    w.shell.update(w.cx, |shell, cx| shell.pip_toggle(cx));
    drive(&mut w, 0.5);
    assert!(w.position() > held + 0.2, "it did not go on");
    w.press(Role::Button, "Bild im Bild beenden");
    assert!(!w.cx.read_entity(&w.shell, |s, _| s.pip_open()));
    assert_eq!(w.cx.update(|_, cx| cx.windows().len()), 1);
}

#[gpui::test]
fn the_keys_of_the_website_and_the_settings_of_wiedergabe(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let one = film(tmp.path(), "eins.mp4", 30);
    let two = film(tmp.path(), "zwei.mp4", 30);
    let mut w = open(cx);
    let store = sondra_app::store::FileStore::open(tmp.path().join("Einstellungen.json"));
    w.shell.update(w.cx, |shell, cx| shell.open_player_memory(store, cx));
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one, two], cx));
    w.watch(0.5);
    let focus = |w: &mut Window| {
        let id = w.tree().find(Role::Button, "Stumm").unwrap().id;
        w.cx.update(|window, cx| {
            run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: id, data: None }, window, cx)
        });
    };
    // 5 → half of the film; L ten seconds on; J ten back.
    focus(&mut w);
    w.cx.simulate_keystrokes("5");
    w.watch(0.4);
    assert!((14.0..17.0).contains(&w.position()), "5 goes to the middle: {}", w.position());
    focus(&mut w);
    w.cx.simulate_keystrokes("l");
    w.watch(0.4);
    assert!(w.position() >= 24.0, "L ten on: {}", w.position());
    focus(&mut w);
    w.cx.simulate_keystrokes("j");
    w.watch(0.4);
    assert!(w.position() < 20.0, "J ten back: {}", w.position());
    // „>“ is faster, N the next file, P back.
    focus(&mut w);
    w.cx.simulate_keystrokes("shift-.");
    w.draw();
    let kept = |w: &Window| -> serde_json::Value { serde_json::from_str(&w.shell.read_with(w.cx, |s, _| s.player_setting("sondra:abspielen")).unwrap_or_default()).unwrap_or_default() };
    assert_eq!(kept(&w)["rate"], serde_json::json!(1.25), "{}", kept(&w));
    focus(&mut w);
    w.cx.simulate_keystrokes("n");
    w.watch(0.3);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_playing_name()), Some("zwei.mp4".to_string()));
    focus(&mut w);
    w.cx.simulate_keystrokes("p");
    w.watch(0.3);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_playing_name()), Some("eins.mp4".to_string()));

    // „Wiedergabe“ in „Bild und Ton“: the end, the jump, the opening, ticking off — kept for the next start.
    w.press(Role::Button, "Bild und Ton");
    w.press(Role::Button, "Liste wiederholen");
    w.press(Role::Button, "Sprungweite 30 Sekunden");
    w.press(Role::Button, "Feste Länge des Vorspanns 2:00");
    w.press(Role::Button, "In der Merkliste abhaken");
    w.press(Role::Button, "Automatisch weiter");
    let k = kept(&w);
    assert_eq!(k["repeat"], serde_json::json!("liste"));
    assert_eq!(k["skip"], serde_json::json!(30.0));
    assert_eq!(k["opening"], serde_json::json!(120.0));
    assert_eq!(k["merkliste"], serde_json::json!(false));
    // A–B: the first press sets A, the second B, the third ends it.
    w.press(Role::Button, "Schleife A–B: hier beginnen");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("A bei "))));
}

/// An episode: its own beginning (noise of `seed`), then the opening the series shares (a gliding tone, 30 s), then
/// its own rest.
fn episode(dir: &Path, name: &str, cold_open: u32, seed: u32) -> PathBuf {
    let ff = Ffmpeg::locate().unwrap();
    let path = dir.join(name);
    let total = cold_open + 30 + 20;
    let out = Command::new(ff.program())
        .args(["-v", "error", "-y"])
        .args(["-f", "lavfi", "-i", &format!("anoisesrc=d={cold_open}:c=pink:seed={seed}:a=0.3:r=48000")])
        .args(["-f", "lavfi", "-i", "aevalsrc=0.3*sin(2*PI*(400+300*sin(2*PI*0.37*t)+150*sin(2*PI*1.3*t))*t):d=30:s=48000"])
        .args(["-f", "lavfi", "-i", &format!("anoisesrc=d=20:c=brown:seed={}:a=0.3:r=48000", seed + 100)])
        .args(["-f", "lavfi", "-i", &format!("testsrc2=size=160x90:rate=10:d={total}")])
        .args(["-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]", "-map", "3:v", "-map", "[a]"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    path
}

#[gpui::test]
fn the_opening_is_learned_from_two_episodes_found_in_each_and_skipped_to_its_end(cx: &mut TestAppContext) {
    if !has_ffmpeg() {
        return;
    }
    use serde_json::json;
    use sondra_app::player_intro::IntroHere;
    use sondra_merk::normalize::{normalize, Context as Ids};
    use sondra_merk::sqlite::{write_sqlite, Snapshot};
    let tmp = tempfile::tempdir().unwrap();
    let list = tmp.path().join("Merkliste.sqlite");
    let mut ids = Ids::system();
    let series = normalize(&json!({ "id": "ts", "title": "Testserie", "status": "watching", "season": 1, "episode": 1, "seasons": [{ "number": 1, "episodes": 12, "watched": [] }] }), &mut ids);
    std::fs::write(&list, write_sqlite(&Snapshot { items: vec![series], ..Default::default() }).unwrap()).unwrap();
    let one = episode(tmp.path(), "Testserie S01E01.mp4", 5, 1);
    let two = episode(tmp.path(), "Testserie S01E02.mp4", 12, 7);
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let listfile = list.clone();
    let memory = tmp.path().join("Abspielen.json");
    let (shell, vcx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_merkliste(MerkStore::at(listfile), cx);
        shell.open_player_memory(sondra_app::store::FileStore::open(memory), cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    vcx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    vcx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx: vcx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Player, cx));
    w.shell.update(w.cx, |shell, cx| shell.play_files(vec![one, two], cx));
    w.watch(0.3);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_intro_here()), IntroHere::Unknown, "nothing learned yet, nothing looked for");
    w.press(Role::Button, "Bild und Ton");
    w.press(Role::Button, "Vorspann erkennen — vergleicht mit „Testserie S01E02.mp4“");
    let wait = |w: &mut Window, ok: &dyn Fn(&Window) -> bool| {
        let limit = std::time::Instant::now() + Duration::from_secs(60);
        while std::time::Instant::now() < limit && !ok(w) {
            w.cx.run_until_parked();
            w.watch(0.05);
        }
    };
    wait(&mut w, &|w| w.shell.read_with(w.cx, |s, _| s.merk_items()[0].intros.as_ref().is_some_and(|l| !l.is_empty())));
    let learned = w.shell.read_with(w.cx, |s, _| s.merk_items()[0].intros.clone()).expect("an opening is kept on the series");
    assert!((learned[0].seconds - 30.0).abs() < 3.0, "about the 30 s both share: {}", learned[0].seconds);
    // The episode that plays is looked at with it: the opening lies 5 s in.
    wait(&mut w, &|w| matches!(w.shell.read_with(w.cx, |s, _| s.player_intro_here()), IntroHere::Found { .. }));
    let IntroHere::Found { start, end } = w.shell.read_with(w.cx, |s, _| s.player_intro_here()) else { panic!("found") };
    assert!((start - 5.0).abs() < 1.5 && (end - 35.0).abs() < 2.0, "{start}–{end}");
    // While it plays, the button jumps to its end.
    w.press(Role::Button, "Schliessen");
    w.shell.update(w.cx, |s, _| s.player_seek(10.0));
    w.watch(0.3);
    w.press(Role::Button, "Vorspann überspringen");
    w.watch(0.3);
    assert!(w.position() >= end - 1.0, "jumped to the end of the opening: {}", w.position());
}
