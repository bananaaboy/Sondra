//! The computer under the service. The Windows-only parts run on the Windows job of the workflow.

use sondra_daemon::ports::{Host, Trash};
use sondra_service::{autostart, AwakeGuard, SystemHost, SystemTrash};

#[test]
fn the_host_knows_the_time_and_the_cord() {
    let host = SystemHost;
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let now = host.now_ms();
    assert!(now >= before && now - before < 5_000);
    let c = host.conditions();
    assert!(c.hour < 24);
    // Whatever it says, asking twice does not fail or change the type of answer.
    let _ = host.conditions();
}

#[test]
fn a_file_goes_to_the_trash_not_into_thin_air() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Folge 1.mp4");
    std::fs::write(&file, b"x".repeat(2048)).unwrap();
    SystemTrash.trash(&file).expect("moved to the trash");
    assert!(!file.exists());
    // A file that is not there is an error the round can tell, not a crash.
    assert!(SystemTrash.trash(&dir.path().join("gone.mp4")).is_err());
}

#[test]
fn keeping_awake_can_be_taken_and_given_back() {
    {
        let _guard = AwakeGuard::new();
        let _second = AwakeGuard::default();
    }
    // Dropped: nothing to assert but that it did not fail; the Windows call has no way to read it back.
}

#[cfg(windows)]
#[test]
fn autostart_is_one_value_for_this_user_and_can_be_taken_away() {
    let name = format!("SondraTest{}", std::process::id());
    let command = r#""C:\Programme\Sondra\sondra-dienst.exe" --im-hintergrund"#;
    assert!(!autostart::is_enabled(&name));
    autostart::enable(&name, command).expect("written");
    assert!(autostart::is_enabled(&name));
    assert_eq!(autostart::command(&name).as_deref(), Some(command));
    // Changing it replaces it.
    autostart::enable(&name, "other.exe").unwrap();
    assert_eq!(autostart::command(&name).as_deref(), Some("other.exe"));
    autostart::disable(&name).expect("removed");
    assert!(!autostart::is_enabled(&name));
    // Removing what is not there is fine.
    autostart::disable(&name).expect("nothing to remove");
}

#[cfg(not(windows))]
#[test]
fn autostart_is_windows_only_and_says_so() {
    let err = autostart::enable("Sondra", "x").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::Unsupported);
    assert!(!autostart::is_enabled("Sondra"));
}
