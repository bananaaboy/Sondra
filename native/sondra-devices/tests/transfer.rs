//! The transfer as the web app's `verify-devices.mts` runs it: whole, held back by a slow receiver, stopped,
//! broken in the middle and continued from where it broke, with a half file that is no longer as it was left.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sondra_devices::transfer::memory::pair;
use sondra_devices::transfer::*;

fn random_bytes(size: usize, mut seed: u64) -> Vec<u8> {
    (0..size)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 24) as u8
        })
        .collect()
}

fn outgoing(name: &str, bytes: Vec<u8>) -> OutgoingFile {
    let info = FileInfo { name: name.into(), size: bytes.len() as u64, mime: "application/octet-stream".into(), path: None };
    OutgoingFile { info, read: Box::new(move |a, b| Ok(bytes[a as usize..b as usize].to_vec())) }
}

type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// A sink that keeps what it gets in a map; with `slow`, every write takes a moment (a slow disk).
struct MapSink {
    name: String,
    store: Store,
    written: Arc<AtomicU64>,
    slow: bool,
    suspendable: bool,
}

impl Sink for MapSink {
    fn write(&mut self, chunk: &[u8]) -> io::Result<()> {
        if self.slow {
            std::thread::sleep(Duration::from_micros(200));
        }
        self.store.lock().unwrap().get_mut(&self.name).unwrap().extend_from_slice(chunk);
        self.written.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        Ok(())
    }
    fn close(&mut self) -> io::Result<String> {
        Ok(format!("Downloads/{}", self.name))
    }
    fn abort(&mut self) {
        self.store.lock().unwrap().remove(&self.name);
    }
    fn suspend(&mut self) -> Option<Piece> {
        if !self.suspendable {
            return None;
        }
        let size = self.store.lock().unwrap().get(&self.name).map_or(0, Vec::len) as u64;
        let store = self.store.clone();
        let name = self.name.clone();
        Some(Piece { bytes: size, token: self.name.clone(), intact: Some(Arc::new(move || store.lock().unwrap().get(&name).is_some_and(|v| !v.is_empty()))) })
    }
}

fn sink_for<'a>(store: Store, written: Arc<AtomicU64>, slow: bool, suspendable: bool, prefix: &'a str) -> impl FnMut(&FileInfo, usize, Option<&Piece>) -> io::Result<Box<dyn Sink>> + 'a {
    move |file, _i, piece| {
        let name = format!("{prefix}{}", file.name);
        let mut map = store.lock().unwrap();
        // Continuing keeps what the half file held; otherwise the file starts empty.
        if piece.is_none() || !map.contains_key(&format!("{}{}", prefix, piece.map(|p| p.token.as_str()).unwrap_or(""))) {
            map.insert(name.clone(), Vec::new());
        }
        drop(map);
        Ok(Box::new(MapSink { name, store: store.clone(), written: written.clone(), slow, suspendable }))
    }
}

#[test]
fn files_arrive_whole_in_order_and_the_sender_is_held_back_by_a_slow_receiver() {
    let film = random_bytes(40 * 1024 * 1024 + 123, 1);
    let note = b"Hallo vom Laptop".to_vec();
    let (mut s, mut r) = pair();
    let sent = s.sent_bytes.clone();
    let store: Store = Arc::default();
    let written = Arc::new(AtomicU64::new(0));
    let max_ahead = Arc::new(AtomicU64::new(0));
    let (st, w) = (store.clone(), written.clone());
    let receiver = std::thread::spawn(move || {
        let mut announced = Vec::new();
        let mut make = sink_for(st, w, true, false, "");
        let places = receive_over(&mut r, &mut make, &mut |files| announced = files.iter().map(|f| f.name.clone()).collect(), None, None, Options::default());
        (announced, places)
    });
    // Watch how far the sender runs ahead of what the disk has written.
    let (ma, sent2, w2) = (max_ahead.clone(), sent.clone(), written.clone());
    let watcher = std::thread::spawn(move || {
        for _ in 0..4000 {
            let ahead = sent2.load(Ordering::Relaxed).saturating_sub(w2.load(Ordering::Relaxed));
            ma.fetch_max(ahead, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    let mut files = vec![outgoing("Film.mp4", film.clone()), outgoing("Notiz.txt", note.clone()), outgoing("leer.bin", Vec::new())];
    let places = send_over(&mut s, &mut files, Options::default()).unwrap();
    let (announced, got) = receiver.join().unwrap();
    assert_eq!(announced, ["Film.mp4", "Notiz.txt", "leer.bin"]);
    assert_eq!(places, ["Downloads/Film.mp4", "Downloads/Notiz.txt", "Downloads/leer.bin"]);
    assert_eq!(got.unwrap(), places);
    let store = store.lock().unwrap();
    assert!(store["Film.mp4"] == film, "the film arrives byte for byte");
    assert_eq!(store["Notiz.txt"], note);
    assert!(store["leer.bin"].is_empty() && store.contains_key("leer.bin"));
    drop(watcher);
    assert!(max_ahead.load(Ordering::Relaxed) <= 16 * 1024 * 1024 + 4 * 1024 * 1024 + 65536, "{} MB ahead", max_ahead.load(Ordering::Relaxed) / 1048576);
}

#[test]
fn a_receiver_that_stops_it_is_known_to_the_sender_and_takes_the_half_file_back() {
    let film = random_bytes(8 * 1024 * 1024, 2);
    let (mut s, mut r) = pair();
    let store: Store = Arc::default();
    let written = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (st, w, stop2) = (store.clone(), written.clone(), stop.clone());
    let receiver = std::thread::spawn(move || {
        let mut make = sink_for(st, w.clone(), false, false, "b-");
        let mut progress = |p: Progress| {
            if p.done > 2 * 1024 * 1024 {
                stop2.store(true, Ordering::Relaxed);
            }
        };
        receive_over(&mut r, &mut make, &mut |_| {}, None, None, Options { on_progress: Some(&mut progress), cancel: Some(stop.clone()) })
    });
    let mut files = vec![outgoing("Film.mp4", film)];
    let sent = send_over(&mut s, &mut files, Options::default());
    let got = receiver.join().unwrap();
    assert!(matches!(sent.as_ref().unwrap_err().code, ErrorCode::Refused | ErrorCode::Closed), "{sent:?}");
    assert_eq!(got.unwrap_err().code, ErrorCode::Cancelled);
    assert!(store.lock().unwrap().is_empty(), "the half file is gone");
}

#[test]
fn a_broken_line_keeps_what_was_written_and_the_next_try_sends_only_the_rest() {
    let a = random_bytes(5 * 1024 * 1024 + 7, 3);
    let b = random_bytes(20 * 1024 * 1024 + 99, 4);
    let c = random_bytes(300_000, 5);
    let sources = || vec![outgoing("a.bin", a.clone()), outgoing("b.bin", b.clone()), outgoing("c.bin", c.clone())];
    let total = (a.len() + b.len() + c.len()) as u64;
    let store: Store = Arc::default();
    let written = Arc::new(AtomicU64::new(0));

    // First attempt: cut the line after ~9 MB (a is whole, b a third in).
    let (mut s1, mut r1) = pair();
    s1.cut_after = Some(9 * 1024 * 1024);
    let kept_cell: Arc<Mutex<Option<Kept>>> = Arc::default();
    let (st, w, kc) = (store.clone(), written.clone(), kept_cell.clone());
    let receiver = std::thread::spawn(move || {
        let mut make = sink_for(st, w, false, true, "");
        let mut on_kept = |k: Kept| *kc.lock().unwrap() = Some(k);
        receive_over(&mut r1, &mut make, &mut |_| {}, None, Some(&mut on_kept), Options::default())
    });
    let mut files = sources();
    let out1 = send_over(&mut s1, &mut files, Options::default());
    let got1 = receiver.join().unwrap();
    assert_eq!(out1.unwrap_err().code, ErrorCode::Closed);
    assert_eq!(got1.unwrap_err().code, ErrorCode::Closed);
    let kept = kept_cell.lock().unwrap().clone().expect("what is kept is reported");
    assert_eq!(kept.places.keys().copied().collect::<Vec<_>>(), [0], "a whole");
    let half = kept.pieces.get(&1).expect("b half").bytes;
    assert!(half > 0 && half < b.len() as u64, "{half}");

    // Second attempt on a new line: only the rest goes.
    let (mut s2, mut r2) = pair();
    let sent = s2.sent_bytes.clone();
    let (st, w) = (store.clone(), written.clone());
    let kept2 = kept.clone();
    let receiver = std::thread::spawn(move || {
        let mut make = sink_for(st, w, false, true, "");
        receive_over(&mut r2, &mut make, &mut |_| {}, Some(kept2), None, Options::default())
    });
    let mut files = sources();
    let places = send_over(&mut s2, &mut files, Options::default()).unwrap();
    receiver.join().unwrap().unwrap();
    let again = sent.load(Ordering::Relaxed);
    assert!(again < total - 5 * 1024 * 1024 && again >= total - half - a.len() as u64 - 1, "{again} of {total}");
    assert_eq!(places, ["Downloads/a.bin", "Downloads/b.bin", "Downloads/c.bin"]);
    assert!(store.lock().unwrap()["b.bin"] == b, "b arrives byte for byte");

    // A half file that is no longer as it was left starts over: nothing wrong is appended.
    let (mut s3, mut r3) = pair();
    let sent3 = s3.sent_bytes.clone();
    let store3: Store = Arc::default();
    let stale = Kept { places: Default::default(), pieces: [(1, Piece { bytes: 3 * 1024 * 1024, token: "weg".into(), intact: Some(Arc::new(|| false)) })].into() };
    let (st, w) = (store3.clone(), Arc::new(AtomicU64::new(0)));
    let receiver = std::thread::spawn(move || {
        let mut make = sink_for(st, w, false, true, "neu-");
        receive_over(&mut r3, &mut make, &mut |_| {}, Some(stale), None, Options::default())
    });
    let mut files = sources();
    send_over(&mut s3, &mut files, Options::default()).unwrap();
    receiver.join().unwrap().unwrap();
    assert_eq!(sent3.load(Ordering::Relaxed), total, "from the start");
    assert!(store3.lock().unwrap()["neu-b.bin"] == b);
}

#[test]
fn a_sender_stopped_from_outside_tells_the_other_side() {
    let (mut s, mut r) = pair();
    let stop = Arc::new(AtomicBool::new(false));
    let store: Store = Arc::default();
    let (st, w) = (store.clone(), Arc::new(AtomicU64::new(0)));
    let receiver = std::thread::spawn(move || {
        let mut make = sink_for(st, w, true, false, "");
        receive_over(&mut r, &mut make, &mut |_| {}, None, None, Options::default())
    });
    let stop2 = stop.clone();
    let mut progress = move |p: Progress| {
        if p.done > 0 {
            stop2.store(true, Ordering::Relaxed);
        }
    };
    let mut files = vec![outgoing("x.bin", random_bytes(30 * 1024 * 1024, 6))];
    let sent = send_over(&mut s, &mut files, Options { on_progress: Some(&mut progress), cancel: Some(stop.clone()) });
    let got = receiver.join().unwrap();
    assert_eq!(sent.unwrap_err().code, ErrorCode::Cancelled);
    assert!(matches!(got.unwrap_err().code, ErrorCode::Refused | ErrorCode::Closed));
}
