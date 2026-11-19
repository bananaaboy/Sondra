//! Two native devices of one account on the stand-in for Drive and a real loopback WebRTC line:
//! they find each other, one asks, the other answers, the files arrive; a no is a no; a text arrives
//! as a note and a link stays a link nobody opens.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sondra_devices::engine::{Engine, PlayItem, SinkMaker, State, Status, Timing};
use sondra_devices::registry::Hardware;
use sondra_devices::rtc::Config;
use sondra_devices::transfer::{FileInfo, OutgoingFile, Piece, Sink};
use sondra_devices::DeviceKeys;
use sondra_drive::fake::FakeDrive;

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

struct MapSink {
    name: String,
    store: Store,
}

impl Sink for MapSink {
    fn write(&mut self, chunk: &[u8]) -> io::Result<()> {
        self.store.lock().unwrap().get_mut(&self.name).unwrap().extend_from_slice(chunk);
        Ok(())
    }
    fn close(&mut self) -> io::Result<String> {
        Ok(format!("Downloads/{}", self.name))
    }
    fn abort(&mut self) {
        self.store.lock().unwrap().remove(&self.name);
    }
}

fn sinks(store: Store) -> SinkMaker {
    Arc::new(move |file: &FileInfo, _i: usize, _p: Option<&Piece>| -> io::Result<Box<dyn Sink>> {
        let name = file.path.clone().unwrap_or_else(|| file.name.clone());
        store.lock().unwrap().insert(name.clone(), Vec::new());
        Ok(Box::new(MapSink { name, store: store.clone() }))
    })
}

fn outgoing(name: &str, path: Option<&str>, bytes: Vec<u8>) -> OutgoingFile {
    let info = FileInfo { name: name.into(), size: bytes.len() as u64, mime: "application/octet-stream".into(), path: path.map(str::to_owned) };
    OutgoingFile { info, read: Box::new(move |a, b| Ok(bytes[a as usize..b as usize].to_vec())) }
}

fn device(drive: &FakeDrive, name: &str, created: f64) -> Engine {
    Engine::start(
        drive.client(),
        DeviceKeys::generate(),
        name,
        created,
        Hardware { kind: "windows".into(), platform: "Windows-App".into(), caps: vec!["folder".into(), "text".into()] },
        Config { servers: vec![], live: None, loopback: true, deaf: false },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150), ..Timing::default() },
        false,
        None,
    )
}

fn wait(what: &str, secs: u64, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("gave up waiting: {what}");
}

fn bytes(size: usize) -> Vec<u8> {
    (0..size).map(|i| ((i * 7 + i / 13) % 251) as u8).collect()
}

fn pair() -> (FakeDrive, Engine, Engine, String, String) {
    let drive = FakeDrive::start();
    let now = sondra_devices::engine::now_ms();
    let a = device(&drive, "Laptop", now - 5.0 * 86_400_000.0);
    let b = device(&drive, "Handy", now - 86_400_000.0);
    wait("A and B find each other", 20, || a.snapshot().devices.len() == 1 && b.snapshot().devices.len() == 1);
    let id_of = |e: &Engine| e.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned();
    let (ida, idb) = (id_of(&a), id_of(&b));
    (drive, a, b, ida, idb)
}

#[test]
fn a_file_offered_is_asked_about_then_arrives_and_both_say_done() {
    let (_drive, a, b, ida, idb) = pair();
    assert_eq!(a.snapshot().status, Status::Ready);
    let film = bytes(3 * 1024 * 1024 + 5);
    a.send(&idb, vec![outgoing("Film.mp4", None, film.clone()), outgoing("Folge 1.mkv", Some("Anime/Staffel 1/Folge 1.mkv"), b"zwei".to_vec())]);
    wait("B is asked", 20, || b.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    let asked = b.snapshot().transfers[0].clone();
    assert_eq!((asked.peer.as_str(), asked.peer_name.as_str()), (ida.as_str(), "Laptop"));
    assert_eq!(asked.files.len(), 2);
    assert_eq!(asked.files[1].path.as_deref(), Some("Anime/Staffel 1/Folge 1.mkv"));
    assert_eq!(a.snapshot().transfers[0].state, State::Offering);

    let store: Store = Arc::default();
    b.accept(&asked.id, sinks(store.clone()));
    wait("both done", 40, || a.snapshot().transfers[0].state == State::Done && b.snapshot().transfers[0].state == State::Done);
    let got = store.lock().unwrap();
    assert!(got["Film.mp4"] == film);
    assert_eq!(got["Anime/Staffel 1/Folge 1.mkv"], b"zwei");
    drop(got);
    assert_eq!(b.snapshot().transfers[0].places, ["Downloads/Film.mp4", "Downloads/Anime/Staffel 1/Folge 1.mkv"]);
    assert_eq!(a.snapshot().transfers[0].places.len(), 2, "the sender hears where it went");
}

#[test]
fn a_no_is_a_no_and_a_cancel_before_the_answer_stops_the_offer() {
    let (_drive, a, b, _ida, idb) = pair();
    a.send(&idb, vec![outgoing("a.bin", None, bytes(1000))]);
    wait("B is asked", 20, || b.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    b.decline(&b.snapshot().transfers[0].id);
    wait("A hears the no", 20, || a.snapshot().transfers[0].state == State::Declined);
    assert_eq!(b.snapshot().transfers[0].state, State::Declined);
    assert!(b.snapshot().transfers[0].dismissed);

    a.send(&idb, vec![outgoing("b.bin", None, bytes(1000))]);
    wait("B is asked again", 20, || b.snapshot().transfers.iter().filter(|t| t.state == State::Asking).count() == 1);
    let id = a.snapshot().transfers[0].id.clone();
    a.cancel(&id);
    wait("B hears it was cancelled", 20, || b.snapshot().transfers.iter().any(|t| t.id == id && t.state == State::Cancelled));
    assert_eq!(a.snapshot().transfers[0].state, State::Cancelled);
}

#[test]
fn a_text_arrives_as_a_note_and_a_link_is_only_marked() {
    let (_drive, a, b, _ida, idb) = pair();
    a.send_text(&idb, "https://example.org/serie?x=1");
    a.send_text(&idb, "Bis später, dann gucken wir weiter");
    wait("two notes", 20, || b.snapshot().notes.len() == 2);
    let notes = b.snapshot().notes;
    let link = notes.iter().find(|n| n.text.starts_with("https")).unwrap();
    assert_eq!(link.link.as_deref(), Some("https://example.org/serie?x=1"));
    assert!(notes.iter().find(|n| n.text.starts_with("Bis")).unwrap().link.is_none());
    assert_eq!(link.peer_name, "Laptop");
    b.dismiss_note(&link.id);
    wait("the note is gone", 5, || b.snapshot().notes.len() == 1);
}

#[test]
fn films_in_drive_are_asked_to_be_played_by_name_and_id_only() {
    let (_drive, a, b, _ida, idb) = pair();
    let item = |id: &str, name: &str, mime: &str| PlayItem { id: id.into(), name: name.into(), size: 1234, mime: mime.into() };
    a.play_on(&idb, vec![item("1AbC-dEf_9xYz", "Folge 1.mkv", "video/x-matroska"), item("2AbC-dEf_9xYz", "Notiz.txt", "text/plain"), item("3AbC-dEf_9xYz", "Folge 2.mkv", "")]);
    wait("a request", 20, || !b.snapshot().notes.is_empty());
    let note = b.snapshot().notes.remove(0);
    // Only what plays is kept; the text file is dropped, the film without a type is known by its name.
    assert_eq!(note.play.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Folge 1.mkv", "Folge 2.mkv"]);
    assert_eq!(note.text, "„Folge 1.mkv“ und 1 weitere");
    assert_eq!(note.peer_name, "Laptop");
    assert!(note.link.is_none());
    // Nothing that cannot play, and no Drive id that is none, goes anywhere.
    a.play_on(&idb, vec![item("4AbC-dEf_9xYz", "Notiz.txt", "text/plain")]);
    a.play_on(&idb, vec![item("../../etc", "Film.mp4", "video/mp4")]);
    a.send_text(&idb, "danach");
    wait("the text", 20, || b.snapshot().notes.iter().any(|n| n.text == "danach"));
    assert_eq!(b.snapshot().notes.len(), 2, "{:?}", b.snapshot().notes.iter().map(|n| &n.text).collect::<Vec<_>>());
}

#[test]
fn one_film_goes_across_to_be_played_not_kept() {
    let (_drive, a, b, _ida, idb) = pair();
    let film = bytes(30_000);
    a.send_to_play(&idb, outgoing("Film.mp4", None, film.clone()));
    wait("B is asked", 20, || b.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    let asked = b.snapshot().transfers[0].clone();
    assert!(asked.play, "the other side sees it is to be played");
    assert!(a.snapshot().transfers[0].play);
    let store: Store = Arc::default();
    b.accept(&asked.id, sinks(store.clone()));
    wait("both done", 40, || a.snapshot().transfers[0].state == State::Done && b.snapshot().transfers[0].state == State::Done);
    assert!(store.lock().unwrap()["Film.mp4"] == film);
    // Two files are never „to be played“, whatever the offer says.
    a.send(&idb, vec![outgoing("a.mp4", None, bytes(100)), outgoing("b.mp4", None, bytes(100))]);
    wait("asked again", 20, || b.snapshot().transfers.iter().filter(|t| t.state == State::Asking).count() == 1);
    assert!(!b.snapshot().transfers.iter().find(|t| t.state == State::Asking).unwrap().play);
}

#[test]
fn a_rename_is_unique_and_reaches_the_other_device() {
    let (_drive, a, b, _ida, _idb) = pair();
    b.rename("Laptop");
    wait("B's name is unique", 20, || b.snapshot().name == "Laptop 2");
    wait("A sees the new name", 20, || a.snapshot().devices.iter().any(|d| d["name"] == "Laptop 2"));
}

/// A device whose line can never open (no address to be found at) and which calls that „no direct way“ quickly.
fn walled(drive: &FakeDrive, name: &str, created: f64) -> Engine {
    Engine::start(
        drive.client(),
        DeviceKeys::generate(),
        name,
        created,
        Hardware { kind: "windows".into(), platform: "Windows-App".into(), caps: vec!["folder".into(), "text".into()] },
        Config { servers: vec![], live: None, loopback: true, deaf: true },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150), no_direct_sender: Duration::from_millis(400), no_direct_receiver: Duration::from_millis(600) },
        false,
        None,
    )
}

#[test]
fn when_no_line_opens_the_files_go_through_drive_and_are_gone_from_it_afterwards() {
    let drive = FakeDrive::start();
    let now = sondra_devices::engine::now_ms();
    let a = walled(&drive, "Laptop", now - 5.0 * 86_400_000.0);
    let b = walled(&drive, "Handy", now - 86_400_000.0);
    wait("A and B find each other", 20, || a.snapshot().devices.len() == 1 && b.snapshot().devices.len() == 1);
    let idb = b.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned();
    // One file over five megabytes (resumable upload) and one small, in a folder, with two of one name.
    let film = bytes(6 * 1024 * 1024 + 11);
    a.send(&idb, vec![outgoing("Film.mp4", None, film.clone()), outgoing("Folge.mkv", Some("Anime/Staffel 1/Folge.mkv"), b"eins".to_vec()), outgoing("Folge.mkv", Some("Anime/Staffel 2/Folge.mkv"), b"zwei".to_vec())]);
    wait("B is asked", 20, || b.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    let id = b.snapshot().transfers[0].id.clone();
    let store: Store = Arc::default();
    b.accept(&id, sinks(store.clone()));
    // The line does not come: both say so, and nothing goes through Drive by itself.
    wait("both call it no direct way", 20, || a.snapshot().transfers[0].no_direct && b.snapshot().transfers[0].no_direct);
    assert_eq!(a.snapshot().transfers[0].state, State::Connecting);
    assert!(drive.files_named("000-Film.mp4").is_empty(), "nothing is put into Drive before the sender says so");

    a.send_via_drive(&id);
    wait("both done", 60, || a.snapshot().transfers[0].state == State::Done && b.snapshot().transfers[0].state == State::Done);
    let got = store.lock().unwrap();
    assert!(got["Film.mp4"] == film);
    assert_eq!(got["Anime/Staffel 1/Folge.mkv"], b"eins");
    assert_eq!(got["Anime/Staffel 2/Folge.mkv"], b"zwei", "two files of one name are two files");
    drop(got);
    let (sent, received) = (a.snapshot().transfers[0].clone(), b.snapshot().transfers[0].clone());
    assert_eq!(sent.route, sondra_devices::engine::Route::Drive);
    assert_eq!(received.route, sondra_devices::engine::Route::Drive);
    assert!(!sent.no_direct && !received.no_direct);
    assert_eq!(received.places.len(), 3);
    assert_eq!(sent.places, received.places, "the sender hears where it went");
    // What was put there is taken away again.
    for name in ["000-Film.mp4", "001-Folge.mkv", "002-Folge.mkv"] {
        assert!(drive.files_named(name).is_empty(), "{name} is gone from Drive");
    }
}

#[test]
fn the_way_through_drive_waits_for_the_yes_and_a_cancel_in_drive_ends_it() {
    let drive = FakeDrive::start();
    let now = sondra_devices::engine::now_ms();
    let a = walled(&drive, "Laptop", now - 5.0 * 86_400_000.0);
    let b = walled(&drive, "Handy", now - 86_400_000.0);
    wait("A and B find each other", 20, || a.snapshot().devices.len() == 1 && b.snapshot().devices.len() == 1);
    let idb = b.snapshot().me.unwrap()["id"].as_str().unwrap().to_owned();
    // A big file, so that the hand-over takes a moment to cancel.
    a.send(&idb, vec![outgoing("Gross.bin", None, bytes(12 * 1024 * 1024))]);
    wait("B is asked", 20, || b.snapshot().transfers.iter().any(|t| t.state == State::Asking));
    let id = b.snapshot().transfers[0].id.clone();
    // Nothing to go through Drive with before the line was tried: the sender may only when it is „Connecting“.
    a.send_via_drive(&id);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(a.snapshot().transfers[0].state, State::Offering, "not before the other said yes");
    let store: Store = Arc::default();
    b.accept(&id, sinks(store.clone()));
    wait("no direct way", 20, || a.snapshot().transfers[0].no_direct);
    a.send_via_drive(&id);
    wait("the hand-over is under way", 20, || a.snapshot().transfers[0].state == State::ViaDrive);
    a.cancel(&id);
    wait("cancelled on both sides", 30, || a.snapshot().transfers[0].state == State::Cancelled && b.snapshot().transfers[0].state == State::Cancelled);
}
