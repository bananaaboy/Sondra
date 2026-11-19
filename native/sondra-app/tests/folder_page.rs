//! The Ordner page in GPUI's test window, on real folders on disk: reading, kinds, search, order, going
//! into a folder, choosing files the way a file manager does, and what the page remembers.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{point, px, size, AvailableSpace, Entity, TestAppContext, VisualTestContext};
use sondra_a11y::{attach_sink, run_action, Role, Snapshot};
use sondra_app::nav::Panel;
use sondra_app::shell::Shell;
use sondra_app::store::FileStore;
use sondra_ui::{bind_keys, fonts};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

struct Window<'a> {
    cx: &'a mut VisualTestContext,
    shell: Entity<Shell>,
    seen: Seen,
}

const WIDTH: f32 = 1280.;

fn put(root: &Path, path: &str, bytes: usize) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, vec![0u8; bytes]).unwrap();
}

fn folder(parent: &Path) -> PathBuf {
    let root = parent.join("Anime");
    put(&root, "Frieren/Staffel 1/Frieren S01E01.mkv", 3000);
    put(&root, "Frieren/Staffel 1/Frieren S01E02.mkv", 2000);
    put(&root, "Frieren/Staffel 1/Frieren S01E10.mkv", 1000);
    put(&root, "Musik/lied.flac", 500);
    put(&root, "poster.png", 700);
    put(&root, "film.mp4", 9000);
    put(&root, "notizen.txt", 3);
    put(&root, ".versteckt.mkv", 1);
    root
}

fn open<'a>(cx: &'a mut TestAppContext, data: &Path) -> Window<'a> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let data = data.to_path_buf();
    let (shell, cx) = cx.add_window_view(move |window, cx| {
        let mut shell = Shell::new(window, cx);
        shell.open_ordner_memory(FileStore::open(data.join("Ordner.json")), cx);
        shell
    });
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| attach_sink(window, cx, move |snap| sink.borrow_mut().push(Rc::new(snap.clone()))));
    cx.simulate_resize(size(px(WIDTH), px(900.)));
    let mut w = Window { cx, shell, seen };
    w.draw();
    w.shell.update(w.cx, |shell, cx| shell.go(Panel::Folder, cx));
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
    /// Reads the folder the way the app does, and waits for it.
    fn read(&mut self, path: &Path) {
        let path = path.to_path_buf();
        self.shell.update(self.cx, |shell, cx| shell.open_folder(path, cx));
        self.cx.run_until_parked();
        self.draw();
    }
    fn files(&self) -> Vec<String> {
        self.tree()
            .nodes
            .iter()
            .filter(|n| n.role == Role::ListItem)
            .filter_map(|n| n.label.as_ref().map(|l| l.to_string()))
            .collect()
    }
}

fn said(tree: &Snapshot, role: Role, label: &str) -> String {
    tree.find(role, label).and_then(|n| n.description.as_ref().map(|d| d.to_string())).unwrap_or_default()
}

#[gpui::test]
fn an_empty_page_offers_the_way_in_and_a_folder_is_read_into_lines(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    assert!(w.tree().find(Role::Button, "Ordner wählen").is_some());
    assert!(w.tree().find(Role::Heading, "Ihre Dateien, aus einem Ordner").is_some());

    w.read(&root);
    let tree = w.tree();
    // The top of the folder: the three folders below it first, then its files, in natural order.
    assert_eq!(w.files(), ["Frieren", "Musik", "film.mp4", "notizen.txt", "poster.png"]);
    assert!(said(&tree, Role::ListItem, "Frieren").starts_with("Ordner. 3 Dateien, "), "{}", said(&tree, Role::ListItem, "Frieren"));
    assert!(said(&tree, Role::ListItem, "film.mp4").starts_with("Video MP4 · 8.8 KB · "), "{}", said(&tree, Role::ListItem, "film.mp4"));
    // The pills count what is in view; hidden files are not there.
    assert!(tree.find(Role::Button, "Alle 3").is_some());
    assert!(tree.find(Role::Button, "Video 1").is_some());
    assert!(tree.find(Role::Button, "Bilder 1").is_some());
    assert!(tree.find(Role::Button, "Andere 1").is_some());
    assert!(tree.find(Role::Button, "Ton 0").is_none(), "a kind nobody has is no pill (the lied is one folder down)");
}

#[gpui::test]
fn one_goes_into_a_folder_and_back_and_can_look_below_everything(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    w.press(Role::ListItem, "Frieren");
    assert_eq!(w.files(), ["Staffel 1"]);
    w.press(Role::ListItem, "Staffel 1");
    assert_eq!(w.files(), ["Frieren S01E01.mkv", "Frieren S01E02.mkv", "Frieren S01E10.mkv"], "2 before 10, as a person counts");
    // The way back is a row of steps.
    assert!(w.tree().find(Role::Button, "Anime").is_some());
    assert!(w.tree().find(Role::Button, "Frieren").is_some());
    w.press(Role::Button, "Anime");
    assert!(w.files().contains(&"film.mp4".to_string()));

    w.press(Role::Button, "Mit Unterordnern");
    let all = w.files();
    assert_eq!(all.len(), 7, "every file below, no folders: {all:?}");
    assert!(all.contains(&"lied.flac".to_string()));
    assert!(w.tree().find(Role::Button, "Ton 1").is_some());
}

#[gpui::test]
fn kinds_order_and_search_narrow_the_lines(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    w.press(Role::Button, "Bilder 1");
    assert_eq!(w.files(), ["Frieren", "Musik", "poster.png"], "folders stay: a kind narrows files, not the way down");
    w.press(Role::Button, "Alle 3");
    // The order: by size, then the same again turns it round.
    w.press(Role::Button, "Ordnung: Grösse");
    assert_eq!(w.files()[2..], ["notizen.txt", "poster.png", "film.mp4"]);
    w.press(Role::Button, "Ordnung: Grösse, aufsteigend");
    assert_eq!(w.files()[2..], ["film.mp4", "poster.png", "notizen.txt"]);
    // A search looks below too.
    let field = w.tree().find(Role::TextInput, "Dateinamen durchsuchen").unwrap().id;
    w.cx.update(|window, cx| {
        run_action(ActionRequest { action: Action::Focus, target_tree: TreeId::ROOT, target_node: field, data: None }, window, cx)
    });
    w.cx.simulate_input("s01e0");
    w.draw();
    assert_eq!(w.files(), ["Frieren S01E01.mkv", "Frieren S01E02.mkv"]);
    assert!(said(&w.tree(), Role::ListItem, "Frieren S01E01.mkv").ends_with("in Frieren/Staffel 1"), "it says where each one is");
}

#[gpui::test]
fn files_are_chosen_the_way_a_file_manager_does(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    w.press(Role::ListItem, "film.mp4");
    assert!(said(&w.tree(), Role::ListItem, "film.mp4").starts_with("Ausgewählt."));
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.as_ref() == "1 Datei ausgewählt")));
    w.press(Role::ListItem, "poster.png");
    assert!(!said(&w.tree(), Role::ListItem, "film.mp4").starts_with("Ausgewählt."), "a plain click chooses one");
    w.press(Role::Button, "Auswahl aufheben");
    assert!(!said(&w.tree(), Role::ListItem, "poster.png").starts_with("Ausgewählt."));
    assert!(w.tree().find(Role::Button, "Auswahl aufheben").is_none());
}

#[gpui::test]
fn what_was_set_on_a_folder_is_kept_and_the_folder_is_offered_the_next_time(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    {
        let mut w = open(cx, tmp.path());
        w.read(&root);
        w.press(Role::Button, "Video 1");
        w.press(Role::Button, "Ordnung: Grösse");
        w.press(Role::Button, "Mit Unterordnern");
    }
    // A new start: the folder is offered, never read on its own; read again, it looks as it did.
    let mut w = open(cx, tmp.path());
    assert!(w.tree().find(Role::Button, "„Anime“ wieder öffnen").is_some());
    assert!(w.files().is_empty(), "nothing is read until asked");
    w.press(Role::Button, "„Anime“ wieder öffnen");
    w.cx.run_until_parked();
    w.draw();
    assert_eq!(w.tree().find(Role::Button, "Video 4").unwrap().toggled, Some(true), "the kind came back");
    assert_eq!(w.tree().find(Role::Button, "Mit Unterordnern").unwrap().toggled, Some(true));
    assert_eq!(w.tree().find(Role::Button, "Ordnung: Grösse, aufsteigend").unwrap().toggled, Some(true));
    assert_eq!(w.files(), ["Frieren S01E10.mkv", "Frieren S01E02.mkv", "Frieren S01E01.mkv", "film.mp4"]);
}

fn focused(tree: &Snapshot) -> String {
    tree.nodes
        .iter()
        .find(|n| n.focused)
        .and_then(|n| n.label.as_ref().map(|l| l.to_string()))
        .unwrap_or_else(|| "(nothing)".into())
}

#[gpui::test]
fn deleting_asks_first_moves_into_sondras_bin_and_can_be_undone(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    w.press(Role::ListItem, "film.mp4");
    // Ctrl and a click adds the poster to what is chosen.
    w.cx.simulate_modifiers_change(gpui::Modifiers::control());
    w.press(Role::ListItem, "poster.png");
    w.cx.simulate_modifiers_change(gpui::Modifiers::default());
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.as_ref() == "2 Dateien ausgewählt")));

    w.press(Role::Button, "Löschen …");
    let tree = w.tree();
    assert!(tree.find(Role::Dialog, "2 Dateien löschen?").is_some(), "it asks before anything goes");
    assert!(root.join("film.mp4").exists() && root.join("poster.png").exists(), "nothing has gone yet");
    assert_eq!(focused(&tree), "Abbrechen", "the safe answer has the focus");
    assert!(tree.find(Role::Button, "In den Papierkorb").is_some());
    assert!(tree.find(Role::Button, "Endgültig löschen").is_some());

    // Escape answers no.
    w.cx.simulate_keystrokes("escape");
    w.draw();
    assert!(w.tree().find(Role::Dialog, "2 Dateien löschen?").is_none());
    assert!(root.join("film.mp4").exists());

    // Ask again, and say yes.
    w.press(Role::Button, "Löschen …");
    w.press(Role::Button, "In den Papierkorb");
    w.cx.run_until_parked();
    w.draw();
    let tree = w.tree();
    assert!(tree.find(Role::Dialog, "2 Dateien löschen?").is_none());
    assert!(!root.join("film.mp4").exists() && !root.join("poster.png").exists());
    assert!(root.join(sondra_merk::bin::BIN_NAME).join("film.mp4").exists(), "they lie in the bin");
    assert_eq!(w.files(), ["Frieren", "Musik", "notizen.txt"], "and are off the page");
    assert!(tree.nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.as_ref() == "2 Dateien in den Papierkorb gelegt.")));
    assert!(tree.find(Role::Button, "Papierkorb (2)").is_some());

    // Undo: back where they lay.
    w.press(Role::Button, "Rückgängig");
    w.cx.run_until_parked();
    w.draw();
    assert!(root.join("film.mp4").exists() && root.join("poster.png").exists());
    assert!(w.files().contains(&"film.mp4".to_string()), "and on the page again");
    assert!(w.tree().find(Role::Button, "Papierkorb (2)").is_none());
}

#[gpui::test]
fn the_bin_window_puts_back_and_erases_only_after_a_second_question(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    for name in ["film.mp4", "notizen.txt"] {
        w.press(Role::ListItem, name);
        w.press(Role::Button, "Löschen …");
        w.press(Role::Button, "In den Papierkorb");
        w.cx.run_until_parked();
        w.draw();
    }
    w.press(Role::Button, "Papierkorb (2)");
    let tree = w.tree();
    assert!(tree.find(Role::Dialog, "Papierkorb").is_some());
    assert!(said(&tree, Role::ListItem, "film.mp4").contains("aus dem obersten Ordner"), "{}", said(&tree, Role::ListItem, "film.mp4"));
    assert!(tree.find(Role::Button, "Zurücklegen").unwrap().disabled, "nothing chosen, nothing to do");

    // Put one back.
    w.press(Role::ListItem, "film.mp4");
    assert!(said(&w.tree(), Role::ListItem, "film.mp4").starts_with("Ausgewählt."));
    w.press(Role::Button, "Zurücklegen");
    w.cx.run_until_parked();
    w.draw();
    assert!(root.join("film.mp4").exists());
    assert!(!root.join(sondra_merk::bin::BIN_NAME).join("film.mp4").exists());

    // Erase the other: the first click only asks.
    w.press(Role::ListItem, "notizen.txt");
    w.press(Role::Button, "Endgültig löschen …");
    assert!(root.join(sondra_merk::bin::BIN_NAME).join("notizen.txt").exists(), "the question is not the deed");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("lässt sich nicht rückgängig machen"))));
    w.press(Role::Button, "Zurück");
    assert!(root.join(sondra_merk::bin::BIN_NAME).join("notizen.txt").exists());
    w.press(Role::Button, "Endgültig löschen …");
    w.press(Role::Button, "Ja, endgültig löschen");
    w.cx.run_until_parked();
    w.draw();
    assert!(!root.join(sondra_merk::bin::BIN_NAME).join("notizen.txt").exists(), "gone for good");
    assert!(!root.join("notizen.txt").exists());
}

#[gpui::test]
fn the_files_are_tiles_with_a_picture_and_a_length_and_the_look_is_kept(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Bilder");
    fs::create_dir_all(&root).unwrap();
    // A real picture, and — where FFmpeg is — a film of ten seconds and a song of three.
    let mut png = Vec::new();
    image::DynamicImage::new_rgb8(64, 48).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    fs::write(root.join("foto.png"), &png).unwrap();
    let ff = sondra_media::Ffmpeg::locate();
    if let Some(ff) = &ff {
        let make = |args: &[&str], out: &str| {
            assert!(std::process::Command::new(ff.program()).args(["-v", "error", "-y"]).args(args).arg(root.join(out)).status().unwrap().success());
        };
        make(&["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=10", "-pix_fmt", "yuv420p"], "film.mp4");
        make(&["-f", "lavfi", "-i", "sine=frequency=440:duration=3"], "lied.wav");
    }
    let wanted = if ff.is_some() { 2 } else { 1 };
    let mut w = open(cx, tmp.path());
    w.read(&root);
    // Tiles are the first look; each file is still one item with its name for a screen reader.
    assert!(w.tree().find(Role::Button, "Ansicht: Kacheln").is_some());
    assert!(w.tree().find(Role::ListItem, "foto.png").is_some());
    for _ in 0..300 {
        w.cx.run_until_parked();
        w.draw();
        if w.shell.read_with(w.cx, |s, _| s.thumbs_state().0) >= wanted {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let (made, waiting) = w.shell.read_with(w.cx, |s, _| s.thumbs_state());
    assert_eq!((made, waiting), (wanted, 0), "the picture and the film have a picture; the song has none");
    if ff.is_some() {
        for _ in 0..100 {
            w.cx.run_until_parked();
            if w.shell.read_with(w.cx, |s, _| s.thumb_seconds().len()) >= 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let lengths = w.shell.read_with(w.cx, |s, _| s.thumb_seconds());
        assert!(lengths.iter().any(|s| (s - 3.0).abs() < 0.3) && lengths.iter().any(|s| (s - 10.0).abs() < 0.3), "{lengths:?}");
    }

    // The list, kept for this folder.
    w.press(Role::Button, "Ansicht: Liste");
    assert!(w.tree().find(Role::ListItem, "foto.png").is_some());
    drop(w);
    let kept = fs::read_to_string(tmp.path().join("Ordner.json")).unwrap();
    assert!(kept.contains("liste"), "the look is kept: {kept}");
}

#[gpui::test]
fn the_chosen_files_are_played_in_the_order_of_the_list_and_what_cannot_be_played_says_so(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = folder(tmp.path());
    let mut w = open(cx, tmp.path());
    w.read(&root);
    // A picture is nothing to play: the page says so and stays where it is.
    w.press(Role::ListItem, "poster.png");
    w.press(Role::Button, "Gewählte Dateien abspielen");
    let said_it = w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("nichts, was sich abspielen lässt")));
    assert!(said_it, "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Folder);
    // A film: the Player opens with it.
    w.press(Role::ListItem, "film.mp4");
    w.press(Role::Button, "Gewählte Dateien abspielen");
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.panel()), Panel::Player);
    assert_eq!(w.shell.read_with(w.cx, |s, _| s.player_queue_names()), ["film.mp4"]);
}

#[gpui::test]
fn copies_are_found_by_their_content_and_chosen_not_deleted(cx: &mut TestAppContext) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Doppelt");
    // Three of the same bytes (one named like a copy), one of the same size with other bytes, and a loner.
    put(&root, "a/Film.mkv", 4000);
    put(&root, "a/Film (1).mkv", 4000);
    put(&root, "b/Film.mkv", 4000);
    fs::create_dir_all(root.join("c")).unwrap();
    fs::write(root.join("c/anderes.mkv"), vec![1u8; 4000]).unwrap();
    put(&root, "c/allein.mkv", 123);
    let mut w = open(cx, tmp.path());
    w.read(&root);
    w.press(Role::Button, "Mit Unterordnern");
    w.press(Role::Button, "Doppelte finden");
    for _ in 0..200 {
        w.cx.run_until_parked();
        w.draw();
        if w.tree().find(Role::Button, "Kopien auswählen").is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.starts_with("2 Kopien in 1 Gruppe"))), "{:?}", w.tree().nodes.iter().filter_map(|n| n.label.clone()).collect::<Vec<_>>());
    w.press(Role::Button, "Gruppen zeigen");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.contains("Byte für Byte gleich"))));
    w.press(Role::Button, "Kopien auswählen");
    assert!(w.tree().nodes.iter().any(|n| n.label.as_ref().is_some_and(|l| l.as_ref() == "2 Dateien ausgewählt")));
    // Nothing was deleted by this.
    assert_eq!(fs::read_dir(root.join("a")).unwrap().count(), 2);
    w.press(Role::Button, "Schliessen");
    assert!(w.tree().find(Role::Button, "Kopien auswählen").is_none());
}
