//! Two native devices of one account on the stand-in for Drive and a real loopback WebRTC line:
//! they find each other, one asks, the other answers, the files arrive; a no is a no; a text arrives
//! as a note and a link stays a link nobody opens.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sondra_devices::engine::{Engine, SinkMaker, State, Status, Timing};
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
        Config { servers: vec![], live: None, loopback: true },
        Timing { poll: Duration::from_millis(100), busy: Duration::from_millis(100), list: Duration::from_millis(150) },
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
fn a_rename_is_unique_and_reaches_the_other_device() {
    let (_drive, a, b, _ida, _idb) = pair();
    b.rename("Laptop");
    wait("B's name is unique", 20, || b.snapshot().name == "Laptop 2");
    wait("A sees the new name", 20, || a.snapshot().devices.iter().any(|d| d["name"] == "Laptop 2"));
}
