//! One Sondra at a time: the second start hands over what it was given and ends; only whoever can read
//! the secret in the data folder is heard.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use sondra_app::instance::{claim, Claim};

#[test]
fn a_second_start_hands_its_files_to_the_first_and_a_stranger_is_not_heard() {
    let dir = tempfile::tempdir().unwrap();
    let Claim::First(first) = claim(dir.path(), &[]) else { panic!("nobody runs yet: this is the first") };

    // The second start, with a file and a folder.
    let given = vec![PathBuf::from("C:\\Filme\\Frieren S01E02.mkv"), PathBuf::from("/tmp/Ordner")];
    assert!(matches!(claim(dir.path(), &given), Claim::Handed));
    assert_eq!(first.paths.recv_timeout(Duration::from_secs(3)).unwrap(), given);

    // A start with nothing still comes through (the window is to come forward).
    assert!(matches!(claim(dir.path(), &[]), Claim::Handed));
    assert!(first.paths.recv_timeout(Duration::from_secs(3)).unwrap().is_empty());

    // Someone who does not know the secret — a web page sending text to the port — gets nothing opened.
    let port = serde_json::from_slice::<serde_json::Value>(&std::fs::read(dir.path().join("Instanz.json")).unwrap()).unwrap()["port"].as_u64().unwrap();
    let mut stranger = std::net::TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    stranger.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    stranger.write_all(b"{\"token\":\"geraten\",\"paths\":[\"/etc/passwd\"]}\n").unwrap();
    let mut answer = Vec::new();
    let _ = stranger.read_to_end(&mut answer);
    assert!(answer.is_empty(), "no answer for a wrong secret");
    let mut http = std::net::TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    http.write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    assert!(first.paths.recv_timeout(Duration::from_millis(400)).is_err(), "nothing arrived from them");
}

#[test]
fn a_file_left_by_a_closed_sondra_does_not_keep_a_new_one_out() {
    let dir = tempfile::tempdir().unwrap();
    // The port in the file belongs to nobody any more.
    let gone = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = gone.local_addr().unwrap().port();
    drop(gone);
    std::fs::write(dir.path().join("Instanz.json"), format!("{{\"port\":{port},\"token\":\"alt\"}}")).unwrap();
    assert!(matches!(claim(dir.path(), &[]), Claim::First(_)), "the old file is only a note, not a lock");
}
