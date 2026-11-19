//! Discord's side of the pipe, played by a test: the handshake, READY, one activity per change, no answer to
//! Discord's answers, a frame in pieces, switching off, and looking again after the pipe broke.

#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sondra_discord::*;

/// What the fake Discord has received, frame by frame.
fn read_some(peer: &mut UnixStream, within: Duration) -> Vec<(i32, Value)> {
    peer.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    let until = Instant::now() + within;
    let mut data = Vec::new();
    while Instant::now() < until {
        let mut buf = [0u8; 4096];
        match peer.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
            Err(_) => {}
        }
    }
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= data.len() {
        let op = i32::from_le_bytes(data[at..at + 4].try_into().unwrap());
        let len = i32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap()) as usize;
        out.push((op, serde_json::from_slice(&data[at + 8..at + 8 + len]).unwrap()));
        at += 8 + len;
    }
    out
}

fn ready_frame() -> Vec<u8> {
    encode_frame(1, &json!({ "cmd": "DISPATCH", "evt": "READY", "data": { "v": 1 } }).to_string())
}

fn presence(peers: Arc<Mutex<Vec<UnixStream>>>, calls: Arc<AtomicUsize>, retry: Duration) -> Presence {
    let connector: Box<dyn FnMut() -> Option<Box<dyn Pipe>> + Send> = Box::new(move || {
        calls.fetch_add(1, Ordering::SeqCst);
        let (mine, theirs) = UnixStream::pair().ok()?;
        mine.set_read_timeout(Some(Duration::from_millis(30))).ok()?;
        peers.lock().unwrap().push(theirs);
        Some(Box::new(mine))
    });
    Presence::start(connector, "1234", retry)
}

fn wait_peer(peers: &Arc<Mutex<Vec<UnixStream>>>, n: usize) -> UnixStream {
    for _ in 0..100 {
        if peers.lock().unwrap().len() >= n {
            return peers.lock().unwrap()[n - 1].try_clone().unwrap();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("no connection");
}

#[test]
fn nothing_is_opened_or_sent_until_the_person_turns_it_on() {
    let peers = Arc::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let p = presence(peers, calls.clone(), Duration::from_secs(30));
    p.set_activity(Some(json!({ "details": "Frieren" })));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_handshake_comes_first_the_activity_after_ready_and_once_per_change() {
    let peers: Arc<Mutex<Vec<UnixStream>>> = Arc::default();
    let p = presence(peers.clone(), Arc::default(), Duration::from_secs(30));
    p.set_activity(Some(json!({ "details": "Frieren", "state": "Folge 4" })));
    p.set_enabled(true);
    let mut peer = wait_peer(&peers, 1);
    let got = read_some(&mut peer, Duration::from_millis(400));
    assert_eq!(got.len(), 1, "only the handshake: {got:?}");
    assert_eq!((got[0].0, &got[0].1), (0, &json!({ "v": 1, "client_id": "1234" })));
    // READY, in two pieces: the activity that waited goes out.
    let frame = ready_frame();
    peer.write_all(&frame[..5]).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    peer.write_all(&frame[5..]).unwrap();
    let got = read_some(&mut peer, Duration::from_millis(500));
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].0, 1);
    assert_eq!(got[0].1["cmd"], "SET_ACTIVITY");
    assert_eq!(got[0].1["args"]["activity"]["details"], "Frieren");
    assert!(got[0].1["args"]["pid"].as_u64().unwrap() > 0);
    // Discord answers, again and again: nothing goes back.
    for _ in 0..5 {
        peer.write_all(&encode_frame(1, &json!({ "cmd": "SET_ACTIVITY", "evt": null }).to_string())).unwrap();
    }
    assert!(read_some(&mut peer, Duration::from_millis(300)).is_empty(), "no answer to answers");
    // A change goes out once.
    p.set_activity(Some(json!({ "details": "Dark" })));
    let got = read_some(&mut peer, Duration::from_millis(400));
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1["args"]["activity"]["details"], "Dark");
}

#[test]
fn switching_it_off_clears_the_status_and_closes_the_pipe() {
    let peers: Arc<Mutex<Vec<UnixStream>>> = Arc::default();
    let p = presence(peers.clone(), Arc::default(), Duration::from_secs(30));
    p.set_activity(Some(json!({ "details": "Frieren" })));
    p.set_enabled(true);
    let mut peer = wait_peer(&peers, 1);
    read_some(&mut peer, Duration::from_millis(300));
    peer.write_all(&ready_frame()).unwrap();
    read_some(&mut peer, Duration::from_millis(300));
    p.set_enabled(false);
    let got = read_some(&mut peer, Duration::from_millis(600));
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(got[0].1["args"]["activity"].is_null(), "the status is cleared");
    // And the pipe is shut: the peer reads the end.
    peer.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
    let mut buf = [0u8; 16];
    assert_eq!(peer.read(&mut buf).unwrap_or(0), 0);
}

#[test]
fn when_the_pipe_breaks_discord_is_looked_for_again() {
    let peers: Arc<Mutex<Vec<UnixStream>>> = Arc::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let p = presence(peers.clone(), calls.clone(), Duration::from_millis(200));
    p.set_activity(Some(json!({ "details": "Frieren" })));
    p.set_enabled(true);
    let mut peer = wait_peer(&peers, 1);
    read_some(&mut peer, Duration::from_millis(200));
    peer.write_all(&ready_frame()).unwrap();
    read_some(&mut peer, Duration::from_millis(200));
    drop(peer);
    peers.lock().unwrap().clear();
    let mut second = wait_peer(&peers, 1);
    assert!(calls.load(Ordering::SeqCst) >= 2);
    let got = read_some(&mut second, Duration::from_millis(300));
    assert_eq!(got[0].0, 0, "a new handshake");
    second.write_all(&ready_frame()).unwrap();
    let got = read_some(&mut second, Duration::from_millis(400));
    assert_eq!(got[0].1["args"]["activity"]["details"], "Frieren", "what is on is shown again");
}

#[test]
fn frames_are_read_whole_and_a_part_waits() {
    let mut data = encode_frame(1, "{\"a\":1}");
    data.extend(encode_frame(1, "nicht json"));
    let whole = encode_frame(1, "{\"b\":2}");
    data.extend(&whole[..whole.len() - 2]);
    let (frames, rest) = read_frames(&data);
    assert_eq!(frames, vec![Some(json!({ "a": 1 })), None]);
    assert_eq!(rest.len(), whole.len() - 2);
}
