//! The portable build: a `portable.txt` beside the program makes `Sondra-Daten` beside it the data folder; without the
//! mark, nothing changes.

use sondra_app::store::portable_dir;

#[test]
fn the_mark_beside_the_program_puts_the_data_beside_it_and_without_it_nothing_changes() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("sondra.exe");
    std::fs::write(&exe, b"").unwrap();
    assert!(portable_dir(&exe).is_none(), "no mark, no portable folder");
    assert!(!dir.path().join("Sondra-Daten").exists(), "nothing was made");
    std::fs::write(dir.path().join("portable.txt"), b"Sondra portabel").unwrap();
    let data = portable_dir(&exe).expect("marked");
    assert_eq!(data, dir.path().join("Sondra-Daten"));
    assert!(data.is_dir());
    assert!(!data.join(".schreibprobe").exists(), "the test file is gone again");
}

#[cfg(unix)]
#[test]
fn a_folder_that_cannot_be_written_falls_back_to_the_usual_place() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc_geteuid() } == 0 {
        return; // root writes anywhere
    }
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("sondra");
    std::fs::write(dir.path().join("portable.txt"), b"x").unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
    assert!(portable_dir(&exe).is_none());
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}
