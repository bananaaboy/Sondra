//! Discord Rich Presence: a port of `desktop/discord.mjs`. Discord listens on a local pipe
//! (Windows `\\?\pipe\discord-ipc-N`, elsewhere `/tmp/discord-ipc-N`); what goes over it are frames — an opcode
//! and a length as two little-endian 32-bit numbers, then JSON. The way it is spoken:
//!
//! * the handshake (opcode 0, `{"v":1,"client_id":…}`) first; Discord answers with `READY`;
//! * only after `READY` does an activity go out (opcode 1, `SET_ACTIVITY`), and then once per change —
//!   answering every answer of Discord's with a new frame made a loop of some 50 000 frames a second;
//! * a frame that a pipe delivers in pieces is collected until it is whole;
//! * switching it off closes the pipe, and Discord takes the status away itself.

use std::io::{self, Read, Write};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};

/// The application registered for Sondra.
pub const DEFAULT_CLIENT_ID: &str = "1342898716254507008";

/// One frame: opcode and JSON text.
pub fn encode_frame(opcode: i32, json: &str) -> Vec<u8> {
    let body = json.as_bytes();
    let mut out = Vec::with_capacity(8 + body.len());
    out.extend_from_slice(&opcode.to_le_bytes());
    out.extend_from_slice(&(body.len() as i32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

/// The whole frames at the start of `data` (a frame that is not JSON is `None`), and what is left of one still
/// arriving.
pub fn read_frames(data: &[u8]) -> (Vec<Option<Value>>, &[u8]) {
    let mut frames = Vec::new();
    let mut at = 0;
    while at + 8 <= data.len() {
        let length = i32::from_le_bytes([data[at + 4], data[at + 5], data[at + 6], data[at + 7]]);
        if length < 0 || at + 8 + length as usize > data.len() {
            break;
        }
        frames.push(serde_json::from_slice(&data[at + 8..at + 8 + length as usize]).ok());
        at += 8 + length as usize;
    }
    (frames, &data[at..])
}

/// A connection to Discord, whatever it runs over.
pub trait Pipe: Read + Write + Send {}
impl<T: Read + Write + Send> Pipe for T {}

/// A Windows pipe that says `WouldBlock` instead of waiting: it asks the pipe how much is there before reading,
/// so that neither a stop nor a close ever has to wait for Discord to speak.
#[cfg(windows)]
struct WinPipe(std::fs::File);

#[cfg(windows)]
impl Read for WinPipe {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::PeekNamedPipe;
        let mut available = 0u32;
        // SAFETY: the handle is the open pipe this struct owns; `available` is a live u32.
        let peeked = unsafe { PeekNamedPipe(HANDLE(self.0.as_raw_handle()), None, 0, None, Some(&mut available), None) };
        match peeked {
            Err(_) => Ok(0),
            Ok(()) if available == 0 => {
                std::thread::sleep(Duration::from_millis(20));
                Err(io::ErrorKind::WouldBlock.into())
            }
            Ok(()) => self.0.read(buf),
        }
    }
}

#[cfg(windows)]
impl Write for WinPipe {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.0.write(data)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// Finds Discord's pipe: the first of `discord-ipc-0` … `-9` that opens.
pub fn connect_local() -> Option<Box<dyn Pipe>> {
    for index in 0..10 {
        #[cfg(windows)]
        {
            let path = format!(r"\\?\pipe\discord-ipc-{index}");
            if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(path) {
                return Some(Box::new(WinPipe(file)));
            }
        }
        #[cfg(unix)]
        {
            let dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
            for base in [dir.as_str(), "/tmp"] {
                if let Ok(s) = std::os::unix::net::UnixStream::connect(format!("{base}/discord-ipc-{index}")) {
                    let _ = s.set_read_timeout(Some(Duration::from_millis(30)));
                    return Some(Box::new(s));
                }
            }
        }
    }
    None
}

enum Command {
    Enable(bool),
    Activity(Option<Value>),
    Stop,
}

/// The status, kept up to date from a thread of its own: connects when asked to, waits for `READY`, sends
/// what is current, and looks for Discord again if the pipe breaks.
pub struct Presence {
    tx: Sender<Command>,
    thread: Option<JoinHandle<()>>,
}

impl Presence {
    /// `connector` finds the pipe (`connect_local` in the app); `retry` is how long to wait before looking
    /// again when Discord is not there or the pipe broke (30 s in the app).
    pub fn start(connector: Box<dyn FnMut() -> Option<Box<dyn Pipe>> + Send>, client_id: &str, retry: Duration) -> Presence {
        let (tx, rx) = channel();
        let client_id = client_id.to_string();
        let thread = std::thread::spawn(move || run(rx, connector, &client_id, retry));
        Presence { tx, thread: Some(thread) }
    }

    /// Off until the person turns it on: nothing is sent, no pipe is opened.
    pub fn set_enabled(&self, on: bool) {
        let _ = self.tx.send(Command::Enable(on));
    }

    /// What is on now (`None` clears it). Kept, and sent when the connection is ready.
    pub fn set_activity(&self, activity: Option<Value>) {
        let _ = self.tx.send(Command::Activity(activity));
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn nonce() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{t:x}")
}

fn send_activity(pipe: &mut dyn Pipe, activity: &Option<Value>) -> io::Result<()> {
    let body = json!({ "cmd": "SET_ACTIVITY", "args": { "pid": std::process::id(), "activity": activity }, "nonce": nonce() });
    pipe.write_all(&encode_frame(1, &body.to_string()))?;
    pipe.flush()
}

fn run(rx: Receiver<Command>, mut connector: Box<dyn FnMut() -> Option<Box<dyn Pipe>> + Send>, client_id: &str, retry: Duration) {
    let (mut enabled, mut activity): (bool, Option<Value>) = (false, None);
    let mut pipe: Option<Box<dyn Pipe>> = None;
    let mut ready = false;
    let mut inbox: Vec<u8> = Vec::new();
    let mut last_try: Option<std::time::Instant> = None;
    loop {
        // Whatever was asked since last time.
        let wait = if pipe.is_some() { Duration::from_millis(30) } else { Duration::from_millis(100) };
        match rx.recv_timeout(wait) {
            Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Command::Enable(on)) => {
                if on && !enabled {
                    last_try = None;
                }
                if !on && enabled {
                    // Clearing first, then closing: Discord takes the status away itself.
                    if let (Some(p), true) = (pipe.as_mut(), ready) {
                        let _ = send_activity(p.as_mut(), &None);
                    }
                    pipe = None;
                    ready = false;
                    inbox.clear();
                    activity = None;
                }
                enabled = on;
            }
            Ok(Command::Activity(a)) => {
                activity = a;
                if enabled && ready {
                    if let Some(p) = pipe.as_mut() {
                        if send_activity(p.as_mut(), &activity).is_err() {
                            pipe = None;
                            ready = false;
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if !enabled {
            continue;
        }
        if pipe.is_none() {
            if last_try.is_some_and(|t| t.elapsed() < retry) {
                continue;
            }
            last_try = Some(std::time::Instant::now());
            if let Some(mut p) = connector() {
                let hello = json!({ "v": 1, "client_id": client_id }).to_string();
                if p.write_all(&encode_frame(0, &hello)).and_then(|_| p.flush()).is_ok() {
                    pipe = Some(p);
                    ready = false;
                    inbox.clear();
                }
            }
            continue;
        }
        // Discord answers every frame; only READY, the answer to the handshake, is the cue to send. What it
        // says after that is read and let go, so that its side of the pipe never fills.
        let Some(p) = pipe.as_mut() else { continue };
        let mut buf = [0u8; 4096];
        match p.read(&mut buf) {
            Ok(0) => {
                pipe = None;
                ready = false;
                last_try = Some(std::time::Instant::now());
            }
            Ok(n) if !ready => {
                inbox.extend_from_slice(&buf[..n]);
                let (frames, rest) = read_frames(&inbox);
                let rest = rest.to_vec();
                let got_ready = frames.iter().flatten().any(|f| f.get("evt").and_then(Value::as_str) == Some("READY"));
                inbox = rest;
                if got_ready {
                    inbox.clear();
                    ready = true;
                    if activity.is_some() && send_activity(p.as_mut(), &activity).is_err() {
                        pipe = None;
                        ready = false;
                    }
                }
            }
            Ok(_) => {}
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(_) => {
                pipe = None;
                ready = false;
                last_try = Some(std::time::Instant::now());
            }
        }
    }
}
