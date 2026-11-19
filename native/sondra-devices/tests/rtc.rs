//! A real WebRTC connection between two peers in this process (loopback), and the transfer over it.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sondra_devices::rtc::{Config, Initiator, Responder};
use sondra_devices::transfer::*;

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

fn outgoing(name: &str, bytes: Vec<u8>) -> OutgoingFile {
    let info = FileInfo { name: name.into(), size: bytes.len() as u64, mime: "application/octet-stream".into(), path: None };
    OutgoingFile { info, read: Box::new(move |a, b| Ok(bytes[a as usize..b as usize].to_vec())) }
}

fn bytes(size: usize) -> Vec<u8> {
    let mut seed = 7u64;
    (0..size)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 24) as u8
        })
        .collect()
}

fn config() -> Config {
    Config { servers: vec![], loopback: true }
}

/// Two connected lines: what the offer and the answer carry through Drive, here passed by hand.
fn connected() -> (sondra_devices::rtc::RtcWire, sondra_devices::rtc::RtcWire) {
    let (initiator, offer) = Initiator::offer(&config()).unwrap();
    let (responder, answer) = Responder::accept(&offer, &config()).unwrap();
    let receiver = std::thread::spawn(move || {
        let r = responder.connect(Duration::from_secs(20));
        r.unwrap()
    });
    let sender = initiator.connect(&answer, Duration::from_secs(20));
    let sender = sender.unwrap();
    (sender, receiver.join().unwrap())
}

#[test]
fn a_file_goes_over_a_real_data_channel_whole_and_in_order() {
    let film = bytes(12 * 1024 * 1024 + 77);
    let (mut s, mut r) = connected();
    let store: Store = Arc::default();
    let st = store.clone();
    let receiver = std::thread::spawn(move || {
        let mut make = move |file: &FileInfo, _i: usize, _p: Option<&Piece>| -> io::Result<Box<dyn Sink>> {
            st.lock().unwrap().insert(file.name.clone(), Vec::new());
            Ok(Box::new(MapSink { name: file.name.clone(), store: st.clone() }))
        };
        let out = receive_over(&mut r, &mut make, &mut |_| {}, None, None, Options::default());
        out
    });
    let mut files = vec![outgoing("Film.mp4", film.clone()), outgoing("Notiz.txt", b"Hallo".to_vec()), outgoing("leer.bin", vec![])];
    let places = send_over(&mut s, &mut files, Options::default());
    let places = places.unwrap();
    assert_eq!(places, ["Downloads/Film.mp4", "Downloads/Notiz.txt", "Downloads/leer.bin"]);
    assert_eq!(receiver.join().unwrap().unwrap(), places);
    let store = store.lock().unwrap();
    assert!(store["Film.mp4"] == film, "byte for byte");
    assert_eq!(store["Notiz.txt"], b"Hallo");
}

#[test]
fn a_sender_that_stops_midway_ends_the_receiver_without_success() {
    let film = bytes(40 * 1024 * 1024);
    let (mut s, mut r) = connected();
    let store: Store = Arc::default();
    let st = store.clone();
    let receiver = std::thread::spawn(move || {
        let mut make = move |file: &FileInfo, _i: usize, _p: Option<&Piece>| -> io::Result<Box<dyn Sink>> {
            st.lock().unwrap().insert(file.name.clone(), Vec::new());
            Ok(Box::new(MapSink { name: file.name.clone(), store: st.clone() }))
        };
        receive_over(&mut r, &mut make, &mut |_| {}, None, None, Options::default())
    });
    let cut = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let c = cut.clone();
    let mut progress = move |p: Progress| {
        if p.done > 3 * 1024 * 1024 {
            c.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    };
    let mut files = vec![outgoing("Film.mp4", film)];
    // The sender's side is stopped from outside once some of it has gone.
    let result = send_over(&mut s, &mut files, Options { on_progress: Some(&mut progress), cancel: Some(cut) });
    assert!(result.is_err());
    let got = receiver.join().unwrap();
    assert!(got.is_err(), "the receiver does not report success for half a file");
}
