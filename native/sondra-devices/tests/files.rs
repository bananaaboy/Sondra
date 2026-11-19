use sondra_devices::files::folder_sinks;
use sondra_devices::transfer::FileInfo;

fn info(name: &str, path: Option<&str>) -> FileInfo {
    FileInfo { name: name.into(), size: 3, mime: String::new(), path: path.map(str::to_owned) }
}

#[test]
fn files_land_whole_under_their_folders_and_never_replace_one_that_is_there() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Sondra");
    let make = folder_sinks(root.clone());
    let mut a = make(&info("Film.mp4", None), 0, None).unwrap();
    a.write(b"abc").unwrap();
    assert!(!root.join("Film.mp4").exists(), "a half file has no real name yet");
    assert_eq!(a.close().unwrap(), "Sondra/Film.mp4");
    assert_eq!(std::fs::read(root.join("Film.mp4")).unwrap(), b"abc");
    // The same name again: a number, nothing is replaced.
    let mut b = make(&info("Film.mp4", None), 0, None).unwrap();
    b.write(b"xyz").unwrap();
    assert_eq!(b.close().unwrap(), "Sondra/Film (2).mp4");
    assert_eq!(std::fs::read(root.join("Film.mp4")).unwrap(), b"abc");
    // A sent folder keeps its shape.
    let mut c = make(&info("Folge 1.mkv", Some("Anime/Staffel 1/Folge 1.mkv")), 1, None).unwrap();
    c.write(b"1").unwrap();
    assert_eq!(c.close().unwrap(), "Sondra/Anime/Staffel 1/Folge 1.mkv");
    assert!(root.join("Anime").join("Staffel 1").join("Folge 1.mkv").is_file());
    // A way out of the folder is not one.
    let mut d = make(&info("x", Some("../../x")), 2, None).unwrap();
    d.write(b"z").unwrap();
    d.close().unwrap();
    assert!(!dir.path().join("x").exists());
    // Aborted: nothing is left.
    let mut e = make(&info("weg.bin", None), 3, None).unwrap();
    e.write(b"q").unwrap();
    e.abort();
    assert!(!root.join("weg.bin").exists());
    let left: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(left.iter().all(|n| !n.ends_with(".sondra-teil")), "{left:?}");
}

#[test]
fn files_and_folders_to_send_carry_their_names_sizes_and_way() {
    use sondra_devices::files::{files_to_send, folder_to_send};
    let dir = tempfile::tempdir().unwrap();
    let anime = dir.path().join("Anime");
    std::fs::create_dir_all(anime.join("Staffel 1")).unwrap();
    std::fs::write(anime.join("Staffel 1").join("Folge 1.mkv"), b"123456").unwrap();
    std::fs::write(anime.join("Notiz.txt"), b"hi").unwrap();
    let mut files = folder_to_send(&anime, 300).unwrap();
    let ways: Vec<_> = files.iter().map(|f| f.info.path.clone().unwrap()).collect();
    assert_eq!(ways, ["Anime/Notiz.txt", "Anime/Staffel 1/Folge 1.mkv"]);
    assert_eq!((files[1].info.size, files[1].info.mime.as_str()), (6, "video/x-matroska"));
    assert_eq!((files[1].read)(2, 5).unwrap(), b"345");
    assert_eq!(folder_to_send(&anime, 1).unwrap().len(), 1, "the limit leaves the rest out");
    let one = files_to_send(&[anime.join("Notiz.txt"), anime.join("fehlt.bin")]).unwrap();
    assert_eq!(one.len(), 1, "what is not a file is left out");
    assert!(one[0].info.path.is_none());
}
