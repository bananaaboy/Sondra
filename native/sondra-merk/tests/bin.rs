//! Sondra's own bin inside a chosen folder: files go in, say where they lay, come back without
//! overwriting anything, and only an explicit erase deletes for good.

use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use sondra_merk::bin::*;
use sondra_merk::folder::FolderFile;
use sondra_merk::scan::scan_dir;

fn put(root: &Path, path: &str, content: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, content).unwrap();
}

fn files(root: &Path) -> Vec<FolderFile> {
    scan_dir(root, &AtomicBool::new(false), |_| {}).unwrap().files
}

fn pick(all: &[FolderFile], paths: &[&str]) -> Vec<FolderFile> {
    paths.iter().map(|p| all.iter().find(|f| f.path == *p).unwrap_or_else(|| panic!("{p}")).clone()).collect()
}

#[test]
fn files_go_into_the_bin_and_the_scan_does_not_see_the_bin() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    put(root, "Frieren/Folge 1.mkv", "eins");
    put(root, "Frieren/Folge 2.mkv", "zwei");
    put(root, "Musik/Folge 1.mkv", "ganz andere");
    put(root, "film.mp4", "film");
    let all = files(root);
    let (binned, failed) = bin_files(root, &pick(&all, &["Frieren/Folge 1.mkv", "Musik/Folge 1.mkv", "film.mp4"])).unwrap();
    assert!(failed.is_empty());
    assert_eq!(binned.len(), 3);
    // Two files of one name: the second one gets a number, nothing is overwritten.
    let names: Vec<&str> = binned.iter().map(|b| b.bin_name.as_str()).collect();
    assert_eq!(names, ["Folge 1.mkv", "Folge 1 (2).mkv", "film.mp4"]);
    assert!(!root.join("film.mp4").exists());
    assert_eq!(fs::read_to_string(root.join(BIN_NAME).join("Folge 1 (2).mkv")).unwrap(), "ganz andere");
    // The scan leaves the bin out, so what lies there does not turn up in the list.
    let left: Vec<String> = files(root).into_iter().map(|f| f.path).collect();
    assert_eq!(left, ["Frieren/Folge 2.mkv"]);
    assert_eq!(count_bin(root), 3, "the note beside them is no file in the bin");
}

#[test]
fn the_bin_lists_what_it_holds_where_it_lay_and_in_which_order() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    put(root, "A/ein.mkv", "1");
    put(root, "B/zwei.mkv", "22");
    let all = files(root);
    bin_files(root, &pick(&all, &["A/ein.mkv"])).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    bin_files(root, &pick(&all, &["B/zwei.mkv"])).unwrap();
    // A file somebody put there by hand has no note.
    fs::write(root.join(BIN_NAME).join("von-hand.txt"), "x").unwrap();
    let list = list_bin(root);
    assert_eq!(list.len(), 3);
    let by_name = |n: &str| list.iter().find(|i| i.name == n).unwrap();
    assert_eq!(by_name("ein.mkv").from.as_deref(), Some("A/ein.mkv"));
    assert_eq!(by_name("zwei.mkv").from.as_deref(), Some("B/zwei.mkv"));
    assert_eq!(by_name("zwei.mkv").size, 2);
    assert!(by_name("von-hand.txt").at.is_none() && by_name("von-hand.txt").from.is_none());
    // The last thrown away comes first (a file with no note counts by its date, which is just now).
    let order: Vec<&str> = list.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(order.iter().position(|n| *n == "zwei.mkv") < order.iter().position(|n| *n == "ein.mkv"), true);
    assert_eq!(count_bin(&tmp.path().join("gibt-es-nicht")), 0);
    assert!(list_bin(&tmp.path().join("gibt-es-nicht")).is_empty());
}

#[test]
fn an_undo_puts_files_back_where_they_lay_and_never_overwrites_what_took_their_place() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    put(root, "Frieren/Folge 1.mkv", "alt");
    put(root, "film.mp4", "film");
    let all = files(root);
    let (binned, _) = bin_files(root, &pick(&all, &["Frieren/Folge 1.mkv", "film.mp4"])).unwrap();
    // Meanwhile something new took the name.
    put(root, "Frieren/Folge 1.mkv", "neu");
    let (restored, failed) = restore_binned(root, &binned);
    assert_eq!(restored.len(), 2);
    assert!(failed.is_empty());
    assert_eq!(fs::read_to_string(root.join("Frieren/Folge 1.mkv")).unwrap(), "neu", "what is there is left alone");
    assert_eq!(fs::read_to_string(root.join("Frieren/Folge 1 (2).mkv")).unwrap(), "alt");
    assert_eq!(fs::read_to_string(root.join("film.mp4")).unwrap(), "film");
    assert_eq!(count_bin(root), 0);
    assert!(!root.join(BIN_NAME).join(".sondra-papierkorb.json").exists(), "the note goes with the last file");
}

#[test]
fn a_folder_that_is_gone_is_made_again_and_the_bin_can_be_emptied_for_good() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    put(root, "Serie/Staffel 1/E1.mkv", "e1");
    put(root, "Serie/Staffel 1/E2.mkv", "e2");
    let all = files(root);
    bin_files(root, &pick(&all, &["Serie/Staffel 1/E1.mkv", "Serie/Staffel 1/E2.mkv"])).unwrap();
    fs::remove_dir_all(root.join("Serie")).unwrap();
    let list = list_bin(root);
    let e1 = list.iter().find(|i| i.name == "E1.mkv").unwrap().clone();
    let e2 = list.iter().find(|i| i.name == "E2.mkv").unwrap().clone();
    let (done, failed) = restore_from_bin(root, &[e1]);
    assert_eq!((done.len(), failed.len()), (1, 0));
    assert_eq!(fs::read_to_string(root.join("Serie/Staffel 1/E1.mkv")).unwrap(), "e1", "the folder was made again");
    let (gone, failed) = erase_from_bin(root, &[e2]);
    assert_eq!((gone.len(), failed.len()), (1, 0));
    assert_eq!(count_bin(root), 0);
    assert!(!root.join(BIN_NAME).join("E2.mkv").exists());
}

#[test]
fn a_note_that_points_out_of_the_folder_is_never_followed() {
    let tmp = tempfile::tempdir().unwrap();
    let outer = tmp.path();
    let root = outer.join("Ordner");
    fs::create_dir_all(root.join(BIN_NAME)).unwrap();
    fs::write(root.join(BIN_NAME).join("falle.mkv"), "x").unwrap();
    fs::write(
        root.join(BIN_NAME).join(".sondra-papierkorb.json"),
        r#"{"falle.mkv":{"path":"../../aussen/x/../Wichtig.mkv","at":5},"kaputt.mkv":{"path":3,"at":"nie"}}"#,
    )
    .unwrap();
    let list = list_bin(&root);
    assert_eq!(list.len(), 1);
    let (done, failed) = restore_from_bin(&root, &list);
    assert_eq!((done.len(), failed.len()), (1, 0));
    // `..` is skipped part by part: the file ends up inside the folder, under the name the note gave.
    assert!(root.join("aussen/x/Wichtig.mkv").exists(), "{:?}", fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>());
    assert!(!outer.join("aussen").exists());
    // A bin that is gone says so for every file.
    let (done, failed) = restore_from_bin(&tmp.path().join("kein-ordner"), &list);
    assert!(done.is_empty());
    assert_eq!(failed[0].reason, "Der Ordner „Sondra-Papierkorb“ ist nicht mehr da.");
    let (done, failed) = erase_from_bin(&tmp.path().join("kein-ordner"), &list);
    assert!(done.is_empty() && failed.len() == 1);
}

#[test]
fn a_name_that_points_out_of_the_bin_is_not_erased() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Ordner");
    fs::create_dir_all(root.join(BIN_NAME)).unwrap();
    fs::write(tmp.path().join("Ordner").join("wichtig.mkv"), "bleibt").unwrap();
    let evil = BinItem { name: "../wichtig.mkv".into(), size: 0, modified: 0, at: None, from: None };
    let (done, failed) = erase_from_bin(&root, &[evil]);
    assert!(done.is_empty());
    assert_eq!(failed.len(), 1);
    assert!(root.join("wichtig.mkv").exists());
}

#[test]
fn files_can_be_deleted_for_good_only_inside_the_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("Ordner");
    put(&root, "a/weg.mkv", "x");
    put(tmp.path(), "aussen.mkv", "bleibt");
    let all = files(&root);
    let mut evil = all[0].clone();
    evil.path = "../aussen.mkv".into();
    let (done, failed) = erase_files(&root, &[all[0].clone(), evil]);
    assert_eq!(done.len(), 1);
    assert_eq!(failed.len(), 1);
    assert!(!root.join("a/weg.mkv").exists());
    assert!(tmp.path().join("aussen.mkv").exists(), "a path out of the folder is refused");
    let (done, failed) = erase_files(&root, &all);
    assert!(done.is_empty());
    assert_eq!(failed.len(), 1, "a file that is gone is said, not hidden");
}
