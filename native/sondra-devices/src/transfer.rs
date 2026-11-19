//! Files from one device to another: the parts of the protocol that are not the connection. A port of the
//! pure parts of `src/lib/deviceTransfer.ts`, with the messages of the wire (`start`, `ready`, `file`, `end`,
//! `done`, `ack`, `saved`, `cancel`, `error`) as one type that reads and writes the same JSON.
//!
//! In order: `start` (what comes), `ready` (the other side has a place for it), then per file `file`, its
//! bytes in 64 KB pieces, `end`; then `done`, and the receiver answers `saved` with where each file went.
//! The receiver says every 4 MB how far it got (`ack`); the sender stays at most 16 MB ahead of that.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The size of one piece of a file on the wire.
pub const CHUNK: usize = 64 * 1024;
/// The receiver says how far it got this often.
pub const ACK_EVERY: u64 = 4 * 1024 * 1024;
/// The sender stays at most this far ahead of the last answer.
pub const AHEAD: u64 = 16 * 1024 * 1024;

/// What is sent about each file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// Where it lay in a folder that was sent, `/`-separated and with the name last; absent for a single file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// The control messages of a transfer, as the other side reads them (`t` names the kind).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Control {
    Start {
        files: Vec<FileInfo>,
    },
    /// `done`: files the receiver has whole; `from`: how far it got with the others (bytes; the keys are the
    /// indexes as JSON writes object keys, as text).
    Ready {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        done: Option<Vec<usize>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<BTreeMap<String, u64>>,
    },
    File {
        i: usize,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<u64>,
    },
    End {
        i: usize,
    },
    Done,
    Ack {
        bytes: u64,
    },
    Saved {
        places: Vec<String>,
    },
    Cancel,
    Error {
        message: String,
    },
}

impl Control {
    /// The text that goes over the wire.
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("a control message is JSON")
    }

    /// A message from the other side; text that is not one is `None`.
    pub fn from_text(text: &str) -> Option<Control> {
        serde_json::from_str(text).ok()
    }
}

/// „Film (2).mp4“ when „Film.mp4“ is taken.
pub fn free_name(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    // `lastIndexOf('.')` counts UTF-16 units, `dot > 0` keeps a name that is only an extension whole.
    let dot = name.rfind('.').filter(|d| *d > 0);
    let (stem, ext) = match dot {
        Some(d) => (&name[..d], &name[d..]),
        None => (name, ""),
    };
    for n in 2..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{stem} ({millis}){ext}")
}

/// A file name as every system takes it: no slashes, no reserved characters, at most 180 characters.
pub fn safe_file_name(name: &str) -> String {
    let replaced: String = name.chars().map(|c| if matches!(c as u32, 0..=0x1f | 0x7f) || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    // `^[.\s]+|[.\s]+$` : dots and whitespace at both ends go.
    let trimmed = replaced.trim_matches(|c: char| c == '.' || c.is_whitespace() || c == '\u{feff}');
    // `slice(0, 180)` counts UTF-16 units.
    let mut units = 0;
    let mut out = String::new();
    for c in trimmed.chars() {
        units += c.len_utf16();
        if units > 180 {
            break;
        }
        out.push(c);
    }
    if out.is_empty() {
        "Datei".into()
    } else {
        out
    }
}

/// Most folder levels a received folder keeps.
const PATH_DEPTH: usize = 8;

/// A path as it came from the other device, made safe to build on disk: each part cleaned like a file name,
/// nothing that climbs out (`..`) or stands for where it is (`.`), no absolute start, at most eight levels.
/// Returns (the folder part, `/`-separated and maybe empty; the file's name).
pub fn split_path(path: Option<&str>, fallback: &str) -> (String, String) {
    let mut parts: Vec<String> = path
        .unwrap_or("")
        .split('/')
        .map(|p| p.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .map(safe_file_name)
        .take(PATH_DEPTH + 1)
        .collect();
    match parts.pop() {
        None => (String::new(), safe_file_name(fallback)),
        Some(name) => (parts.join("/"), name),
    }
}

/* The transfer itself ---------------------------------------------------------------------------- */

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// What goes over a line: a control message as text, or a piece of a file.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Text(String),
    Bytes(Vec<u8>),
}

/// The line is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Closed;

/// The line between two devices, as the transfer needs it: a data channel in practice, two queues in a test.
pub trait Wire: Send {
    fn send(&mut self, frame: Frame) -> Result<(), Closed>;
    /// Bytes handed to the line that it has not sent on yet.
    fn buffered(&self) -> usize {
        0
    }
    /// Waits up to `timeout` for the next frame: `Ok(None)` when none came, `Err(Closed)` once the line is
    /// gone and everything that was sent before it has been read.
    fn recv(&mut self, timeout: Duration) -> Result<Option<Frame>, Closed>;
    fn close(&mut self);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// This side stopped it.
    Cancelled,
    /// The line broke; what was written stays and the sender can go on from it.
    Closed,
    /// The other side stopped it.
    Refused,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransferError {
    pub code: ErrorCode,
    pub message: String,
}

impl std::error::Error for TransferError {}

impl std::fmt::Display for TransferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn err(code: ErrorCode, message: &str) -> TransferError {
    TransferError { code, message: message.into() }
}

fn closed() -> TransferError {
    err(ErrorCode::Closed, "Die Verbindung brach ab.")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Progress {
    pub done: u64,
    pub total: u64,
}

/// A file as the sender reads it.
pub struct OutgoingFile {
    pub info: FileInfo,
    /// Bytes `start..end` of the file.
    pub read: Box<dyn FnMut(u64, u64) -> io::Result<Vec<u8>> + Send>,
}

/// A file kept half: how many bytes lie safely, and what the sink needs to reopen it.
#[derive(Clone)]
pub struct Piece {
    pub bytes: u64,
    pub token: String,
    /// Is it still as it was left? A file the person deleted meanwhile starts over.
    pub intact: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl std::fmt::Debug for Piece {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Piece").field("bytes", &self.bytes).field("token", &self.token).finish()
    }
}

/// What a receiver kept of a transfer that broke: finished files (where each went) and half ones.
#[derive(Debug, Clone, Default)]
pub struct Kept {
    pub places: BTreeMap<usize, String>,
    pub pieces: BTreeMap<usize, Piece>,
}

/// Where one received file goes.
pub trait Sink: Send {
    fn write(&mut self, chunk: &[u8]) -> io::Result<()>;
    /// Says where the file is, in words.
    fn close(&mut self) -> io::Result<String>;
    fn abort(&mut self);
    /// The connection broke: keep what was written and say how far it is. Absent where a half file cannot be
    /// kept, and the file then starts over.
    fn suspend(&mut self) -> Option<Piece> {
        None
    }
}

/// Makes the sink for the file at this index (and, when continuing, the half file it left).
pub type SinkFor<'a> = dyn FnMut(&FileInfo, usize, Option<&Piece>) -> io::Result<Box<dyn Sink>> + 'a;

/// What both ends can be told or asked while they work.
#[derive(Default)]
pub struct Options<'a> {
    pub on_progress: Option<&'a mut dyn FnMut(Progress)>,
    /// Set from outside to stop: the other side is told, the line closed.
    pub cancel: Option<Arc<AtomicBool>>,
}

const POLL: Duration = Duration::from_millis(20);
const BUFFER_HIGH: usize = 4 * 1024 * 1024;

fn cancelled(o: &Options) -> bool {
    o.cancel.as_ref().is_some_and(|c| c.load(Ordering::Relaxed))
}

fn say(wire: &mut dyn Wire, control: &Control) -> Result<(), Closed> {
    wire.send(Frame::Text(control.to_text()))
}

/// Sends the files; returns where the other side put each.
pub fn send_over(wire: &mut dyn Wire, files: &mut [OutgoingFile], mut options: Options) -> Result<Vec<String>, TransferError> {
    let total: u64 = files.iter().map(|f| f.info.size).sum();
    let mut acked: u64 = 0;
    let mut ready = false;
    let mut kept_done: std::collections::BTreeSet<usize> = Default::default();
    let mut kept_from: BTreeMap<usize, u64> = BTreeMap::new();
    let mut saved: Option<Vec<String>> = None;

    // One frame from the other side, acted on. `Err` ends the transfer.
    let mut handle = |frame: Frame, acked: &mut u64, ready: &mut bool, kept_done: &mut std::collections::BTreeSet<usize>, kept_from: &mut BTreeMap<usize, u64>, saved: &mut Option<Vec<String>>, options: &mut Options| -> Result<(), TransferError> {
        let Frame::Text(text) = frame else { return Ok(()) };
        let Some(control) = Control::from_text(&text) else { return Ok(()) };
        match control {
            Control::Ready { done, from } => {
                // A receiver that kept nothing says nothing here, and everything is sent.
                *kept_done = done.unwrap_or_default().into_iter().collect();
                *kept_from = from.unwrap_or_default().into_iter().filter_map(|(k, v)| k.parse().ok().map(|k| (k, v))).collect();
                *ready = true;
            }
            Control::Ack { bytes } => {
                *acked = (*acked).max(bytes);
                if let Some(p) = options.on_progress.as_mut() {
                    p(Progress { done: *acked, total });
                }
            }
            Control::Saved { places } => {
                if let Some(p) = options.on_progress.as_mut() {
                    p(Progress { done: total, total });
                }
                *saved = Some(places);
            }
            Control::Cancel => return Err(err(ErrorCode::Refused, "Auf dem anderen Gerät abgebrochen.")),
            Control::Error { message } => return Err(err(ErrorCode::Failed, &message)),
            _ => {}
        }
        Ok(())
    };

    let stop = |wire: &mut dyn Wire| {
        let _ = say(wire, &Control::Cancel);
        wire.close();
        err(ErrorCode::Cancelled, "cancelled")
    };

    say(wire, &Control::Start { files: files.iter().map(|f| f.info.clone()).collect() }).map_err(|_| closed())?;
    while !ready {
        if cancelled(&options) {
            return Err(stop(wire));
        }
        match wire.recv(POLL) {
            Ok(Some(frame)) => handle(frame, &mut acked, &mut ready, &mut kept_done, &mut kept_from, &mut saved, &mut options)?,
            Ok(None) => {}
            Err(Closed) => return Err(closed()),
        }
    }
    // What the receiver already has counts as sent and acknowledged.
    let start_at: Vec<u64> = files.iter().enumerate().map(|(i, f)| if kept_done.contains(&i) { f.info.size } else { kept_from.get(&i).copied().unwrap_or(0).min(f.info.size) }).collect();
    let mut sent: u64 = start_at.iter().sum();
    acked = acked.max(sent);
    if sent > 0 {
        if let Some(p) = options.on_progress.as_mut() {
            p(Progress { done: sent, total });
        }
    }
    for i in 0..files.len() {
        if kept_done.contains(&i) {
            continue;
        }
        say(wire, &Control::File { i, at: if start_at[i] > 0 { Some(start_at[i]) } else { None } }).map_err(|_| closed())?;
        let size = files[i].info.size;
        let mut at = start_at[i];
        while at < size {
            let end = (at + CHUNK as u64).min(size);
            let piece = (files[i].read)(at, end).map_err(|_| {
                let _ = say(wire, &Control::Error { message: "Datei nicht lesbar".into() });
                err(ErrorCode::Failed, "Datei nicht lesbar")
            })?;
            // The line's own buffer, then the receiver's: neither is allowed to hold the whole film.
            while wire.buffered() > BUFFER_HIGH {
                if cancelled(&options) {
                    return Err(stop(wire));
                }
                match wire.recv(Duration::from_millis(2)) {
                    Ok(Some(frame)) => handle(frame, &mut acked, &mut ready, &mut kept_done, &mut kept_from, &mut saved, &mut options)?,
                    Ok(None) => {}
                    Err(Closed) => return Err(closed()),
                }
            }
            while sent - acked > AHEAD {
                if cancelled(&options) {
                    return Err(stop(wire));
                }
                match wire.recv(POLL) {
                    Ok(Some(frame)) => handle(frame, &mut acked, &mut ready, &mut kept_done, &mut kept_from, &mut saved, &mut options)?,
                    Ok(None) => {}
                    Err(Closed) => return Err(closed()),
                }
            }
            if cancelled(&options) {
                return Err(stop(wire));
            }
            // Whatever the other side has said meanwhile (an answer, a stop) is read before the next piece.
            loop {
                match wire.recv(Duration::ZERO) {
                    Ok(Some(frame)) => handle(frame, &mut acked, &mut ready, &mut kept_done, &mut kept_from, &mut saved, &mut options)?,
                    Ok(None) => break,
                    Err(Closed) => return Err(closed()),
                }
            }
            let len = piece.len() as u64;
            wire.send(Frame::Bytes(piece)).map_err(|_| closed())?;
            sent += len;
            at = end;
        }
        say(wire, &Control::End { i }).map_err(|_| closed())?;
    }
    say(wire, &Control::Done).map_err(|_| closed())?;
    while saved.is_none() {
        if cancelled(&options) {
            return Err(stop(wire));
        }
        match wire.recv(POLL) {
            Ok(Some(frame)) => handle(frame, &mut acked, &mut ready, &mut kept_done, &mut kept_from, &mut saved, &mut options)?,
            Ok(None) => {}
            Err(Closed) => return Err(closed()),
        }
    }
    Ok(saved.unwrap_or_default())
}

/// Takes files as they come. `on_start` hears what is coming before the first byte; returns where each went.
/// `kept` is what an earlier attempt of this transfer left; `on_kept` hears what is kept when the line breaks.
pub fn receive_over(wire: &mut dyn Wire, sink_for: &mut SinkFor, on_start: &mut dyn FnMut(&[FileInfo]), kept: Option<Kept>, on_kept: Option<&mut dyn FnMut(Kept)>, mut options: Options) -> Result<Vec<String>, TransferError> {
    let mut files: Vec<FileInfo> = Vec::new();
    let mut total: u64 = 0;
    let mut written: u64 = 0;
    let mut last_ack: u64 = 0;
    let mut sink: Option<Box<dyn Sink>> = None;
    let mut sink_index: Option<usize> = None;
    let kept = kept.unwrap_or_default();
    let mut places: BTreeMap<usize, String> = kept.places.clone();
    let mut pieces: BTreeMap<usize, Piece> = kept.pieces.clone();
    let mut on_kept = on_kept;

    // The line broke: what is written stays (the sink says how far), and the caller hears what is kept.
    let broke = |sink: &mut Option<Box<dyn Sink>>, sink_index: Option<usize>, places: &BTreeMap<usize, String>, pieces: &BTreeMap<usize, Piece>, on_kept: &mut Option<&mut dyn FnMut(Kept)>| {
        let Some(report) = on_kept.as_mut() else {
            if let Some(mut open) = sink.take() {
                open.abort();
            }
            return;
        };
        let open = sink.take();
        let mut kept_pieces = pieces.clone();
        match open {
            Some(mut open) => match open.suspend() {
                Some(piece) => {
                    if let Some(i) = sink_index {
                        kept_pieces.insert(i, piece);
                    }
                }
                None => {
                    open.abort();
                    if let Some(i) = sink_index {
                        kept_pieces.remove(&i);
                    }
                }
            },
            None => {}
        }
        report(Kept { places: places.clone(), pieces: kept_pieces });
    };

    let fail = |wire: &mut dyn Wire, sink: &mut Option<Box<dyn Sink>>, e: TransferError, tell: bool| -> TransferError {
        if tell {
            let _ = say(wire, &Control::Error { message: format!("Nicht gespeichert: {}", e.message) });
        }
        if let Some(mut open) = sink.take() {
            open.abort();
        }
        e
    };

    loop {
        if cancelled(&options) {
            let _ = say(wire, &Control::Cancel);
            if let Some(mut open) = sink.take() {
                open.abort();
            }
            wire.close();
            return Err(err(ErrorCode::Cancelled, "cancelled"));
        }
        let frame = match wire.recv(POLL) {
            Ok(Some(f)) => f,
            Ok(None) => continue,
            Err(Closed) => {
                broke(&mut sink, sink_index, &places, &pieces, &mut on_kept);
                return Err(closed());
            }
        };
        match frame {
            Frame::Bytes(bytes) => {
                let Some(open) = sink.as_mut() else { return Err(fail(wire, &mut sink, err(ErrorCode::Failed, "Daten ohne Datei"), true)) };
                if let Err(e) = open.write(&bytes) {
                    return Err(fail(wire, &mut sink, err(ErrorCode::Failed, &e.to_string()), true));
                }
                written += bytes.len() as u64;
                if let Some(p) = options.on_progress.as_mut() {
                    p(Progress { done: written, total });
                }
                if written - last_ack >= ACK_EVERY {
                    last_ack = written;
                    let _ = say(wire, &Control::Ack { bytes: written });
                }
            }
            Frame::Text(text) => {
                let Some(control) = Control::from_text(&text) else { continue };
                match control {
                    Control::Start { files: announced } => {
                        files = announced;
                        total = files.iter().map(|f| f.size).sum();
                        on_start(&files);
                        // What an earlier attempt kept counts as received — if it is still as it was left.
                        let mut done: Vec<usize> = Vec::new();
                        let mut from: BTreeMap<String, u64> = BTreeMap::new();
                        written = 0;
                        for (index, place) in &places {
                            if files.get(*index).is_some() && !place.is_empty() {
                                done.push(*index);
                                written += files[*index].size;
                            }
                        }
                        let keys: Vec<usize> = pieces.keys().copied().collect();
                        for index in keys {
                            let piece = pieces[&index].clone();
                            let fine = files.get(index).is_some_and(|file| !done.contains(&index) && piece.bytes > 0 && piece.bytes < file.size) && piece.intact.as_ref().is_none_or(|check| check());
                            if fine {
                                from.insert(index.to_string(), piece.bytes);
                                written += piece.bytes;
                            } else {
                                pieces.remove(&index);
                            }
                        }
                        last_ack = written;
                        if written > 0 {
                            if let Some(p) = options.on_progress.as_mut() {
                                p(Progress { done: written, total });
                            }
                        }
                        let _ = say(wire, &Control::Ready { done: if done.is_empty() { None } else { Some(done) }, from: if from.is_empty() { None } else { Some(from) } });
                    }
                    Control::File { i, at } => {
                        let Some(info) = files.get(i).cloned() else { return Err(fail(wire, &mut sink, err(ErrorCode::Failed, "Unbekannte Datei"), true)) };
                        let at = at.unwrap_or(0);
                        let piece = if at > 0 { pieces.get(&i).cloned() } else { None };
                        if at > 0 && piece.as_ref().is_none_or(|p| p.bytes != at) {
                            return Err(fail(wire, &mut sink, err(ErrorCode::Failed, "Das Fortsetzen ist nicht mehr möglich."), true));
                        }
                        match sink_for(&info, i, piece.as_ref()) {
                            Ok(made) => {
                                sink = Some(made);
                                sink_index = Some(i);
                                pieces.remove(&i);
                            }
                            Err(e) => return Err(fail(wire, &mut sink, err(ErrorCode::Failed, &e.to_string()), true)),
                        }
                    }
                    Control::End { i } => {
                        let Some(mut open) = sink.take() else { return Err(fail(wire, &mut sink, err(ErrorCode::Failed, "Datei ohne Anfang"), true)) };
                        match open.close() {
                            Ok(place) => {
                                places.insert(i, place);
                            }
                            Err(e) => return Err(fail(wire, &mut sink, err(ErrorCode::Failed, &e.to_string()), true)),
                        }
                    }
                    Control::Done => {
                        let _ = say(wire, &Control::Ack { bytes: written });
                        let list: Vec<String> = (0..files.len()).map(|i| places.get(&i).cloned().unwrap_or_default()).collect();
                        let _ = say(wire, &Control::Saved { places: list.clone() });
                        if let Some(p) = options.on_progress.as_mut() {
                            p(Progress { done: total, total });
                        }
                        return Ok(list);
                    }
                    Control::Cancel => return Err(fail(wire, &mut sink, err(ErrorCode::Refused, "Auf dem anderen Gerät abgebrochen."), false)),
                    Control::Error { message } => return Err(fail(wire, &mut sink, err(ErrorCode::Failed, &message), false)),
                    _ => {}
                }
            }
        }
    }
}

/// Two ends of one in-memory line, for tests of anything that speaks the transfer. Closing either end closes
/// both; what was sent before the close is still read.
pub mod memory {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};

    pub struct End {
        tx: Option<Sender<Frame>>,
        rx: Receiver<Frame>,
        closed: Arc<AtomicBool>,
        /// Bytes sent, for tests that watch how far a sender runs ahead.
        pub sent_bytes: Arc<std::sync::atomic::AtomicU64>,
        /// A test can cut the line after this many bytes have been sent.
        pub cut_after: Option<u64>,
    }

    pub fn pair() -> (End, End) {
        let (a_tx, b_rx) = channel();
        let (b_tx, a_rx) = channel();
        let closed = Arc::new(AtomicBool::new(false));
        let make = |tx, rx| End { tx: Some(tx), rx, closed: closed.clone(), sent_bytes: Arc::default(), cut_after: None };
        (make(a_tx, a_rx), make(b_tx, b_rx))
    }

    impl Wire for End {
        fn send(&mut self, frame: Frame) -> Result<(), Closed> {
            if self.closed.load(Ordering::Relaxed) {
                return Err(Closed);
            }
            if let Frame::Bytes(b) = &frame {
                let total = self.sent_bytes.fetch_add(b.len() as u64, Ordering::Relaxed) + b.len() as u64;
                if self.cut_after.is_some_and(|limit| total > limit) {
                    self.close();
                    return Ok(());
                }
            }
            self.tx.as_ref().ok_or(Closed)?.send(frame).map_err(|_| Closed)
        }
        fn recv(&mut self, timeout: Duration) -> Result<Option<Frame>, Closed> {
            let got = if timeout.is_zero() { self.rx.try_recv().map_err(|e| matches!(e, std::sync::mpsc::TryRecvError::Disconnected)) } else { self.rx.recv_timeout(timeout).map_err(|e| matches!(e, RecvTimeoutError::Disconnected)) };
            match got {
                Ok(frame) => Ok(Some(frame)),
                Err(true) => Err(Closed),
                Err(false) => {
                    if self.closed.load(Ordering::Relaxed) {
                        // Nothing more queued and the line is shut.
                        match self.rx.try_recv() {
                            Ok(frame) => Ok(Some(frame)),
                            Err(_) => Err(Closed),
                        }
                    } else {
                        Ok(None)
                    }
                }
            }
        }
        fn close(&mut self) {
            self.closed.store(true, Ordering::Relaxed);
            self.tx = None;
        }
    }
}
