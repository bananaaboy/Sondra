//! The ADB wire protocol, as a phone speaks it over USB: packets of a 24-byte header and a payload, a
//! handshake with a signature (and, the first time, the person's „Zulassen“ on the phone), and streams opened to
//! services — a shell, the file sync, the socket of the scrcpy server. The cable itself is behind [`Link`], so
//! the same code runs against a real phone and against the stand-in the tests use.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::key::AdbKey;
use crate::MirrorError;

pub const A_CNXN: u32 = 0x4e58_4e43;
pub const A_AUTH: u32 = 0x4854_5541;
pub const A_OPEN: u32 = 0x4e45_504f;
pub const A_OKAY: u32 = 0x5941_4b4f;
pub const A_CLSE: u32 = 0x4553_4c43;
pub const A_WRTE: u32 = 0x4554_5257;

pub const AUTH_TOKEN: u32 = 1;
pub const AUTH_SIGNATURE: u32 = 2;
pub const AUTH_PUBLIC_KEY: u32 = 3;

/// What this side speaks: version 1.0.0.1 (no checksum needed) and the biggest payload it takes.
const VERSION: u32 = 0x0100_0001;
const MAX_PAYLOAD: u32 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub command: u32,
    pub arg0: u32,
    pub arg1: u32,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn new(command: u32, arg0: u32, arg1: u32, payload: Vec<u8>) -> Packet {
        Packet { command, arg0, arg1, payload }
    }

    /// The 24 bytes in front of the payload.
    pub fn header(&self) -> [u8; 24] {
        let mut h = [0u8; 24];
        h[0..4].copy_from_slice(&self.command.to_le_bytes());
        h[4..8].copy_from_slice(&self.arg0.to_le_bytes());
        h[8..12].copy_from_slice(&self.arg1.to_le_bytes());
        h[12..16].copy_from_slice(&(self.payload.len() as u32).to_le_bytes());
        let checksum: u32 = self.payload.iter().fold(0u32, |sum, b| sum.wrapping_add(u32::from(*b)));
        h[16..20].copy_from_slice(&checksum.to_le_bytes());
        h[20..24].copy_from_slice(&(!self.command).to_le_bytes());
        h
    }

    /// A header read back: the packet without its payload, and how long the payload is.
    pub fn from_header(h: &[u8; 24]) -> Result<(Packet, usize), MirrorError> {
        let word = |at: usize| u32::from_le_bytes([h[at], h[at + 1], h[at + 2], h[at + 3]]);
        let command = word(0);
        if word(20) != !command {
            return Err(MirrorError::Protocol("Ein Paket vom Handy hatte keine gültige Kennung.".into()));
        }
        let len = word(12) as usize;
        if len > 16 * 1024 * 1024 {
            return Err(MirrorError::Protocol("Ein Paket vom Handy war unmöglich gross.".into()));
        }
        Ok((Packet { command, arg0: word(4), arg1: word(8), payload: Vec::new() }, len))
    }
}

/// The cable, or whatever stands in for it: whole packets in and out. `recv` waits; `send` may be called from
/// several threads (the implementation keeps them apart); a closed link makes `recv` fail.
pub trait Link: Send + Sync + 'static {
    fn send(&self, packet: &Packet) -> io::Result<()>;
    fn recv(&self) -> io::Result<Packet>;
    /// Like `recv`, but gives up after `wait` (and returns `None`). A link that cannot wait for a time
    /// waits for ever.
    fn recv_timeout(&self, wait: Duration) -> io::Result<Option<Packet>> {
        let _ = wait;
        self.recv().map(Some)
    }
    /// Lets the cable go: whoever waits in `recv` is woken with an error.
    fn close(&self) {}
}

/// What the handshake says about the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Banner {
    pub text: String,
    pub max_payload: usize,
}

impl Banner {
    /// The value of `ro.product.model` (or the product name) in `device::ro.product.model=…;…`.
    pub fn model(&self) -> String {
        let find = |key: &str| self.text.split(';').find_map(|p| p.strip_prefix(key)).map(str::to_owned);
        find("ro.product.model=").or_else(|| find("ro.product.name=")).or_else(|| find("device::ro.product.model=")).unwrap_or_else(|| "Android-Handy".into())
    }
}

/// How the person's „Zulassen“ is waited for, and what is said meanwhile.
pub struct Handshake<'a> {
    pub key: &'a AdbKey,
    pub name: &'a str,
    /// Called when the phone asks the person to allow this computer.
    pub on_allow: &'a mut dyn FnMut(),
    /// How long the person has for it.
    pub allow_within: Duration,
}

enum Event {
    Data(Vec<u8>),
    Closed,
}

struct Slot {
    events: Sender<Event>,
    acks: Sender<Result<u32, ()>>,
}

struct Inner {
    link: Arc<dyn Link>,
    streams: Mutex<HashMap<u32, Slot>>,
    next_id: AtomicU32,
    max_payload: usize,
    down: AtomicBool,
}

/// A connection to a phone.
pub struct Adb {
    inner: Arc<Inner>,
    pub banner: Banner,
}

impl Adb {
    /// Connects: says who this is, signs what the phone asks to be signed and, if the phone does not know this
    /// computer yet, offers the key and waits for the person to allow it.
    pub fn connect(link: Arc<dyn Link>, handshake: Handshake<'_>) -> Result<Adb, MirrorError> {
        link.send(&Packet::new(A_CNXN, VERSION, MAX_PAYLOAD, b"host::\0".to_vec())).map_err(MirrorError::link)?;
        let mut signed = false;
        let mut offered = false;
        let mut deadline: Option<std::time::Instant> = None;
        loop {
            // Before the person is asked, the phone answers at once; after, it answers when they have.
            let wait = deadline.map_or(Duration::from_secs(10), |d| d.saturating_duration_since(std::time::Instant::now()));
            let Some(packet) = link.recv_timeout(wait).map_err(MirrorError::link)? else {
                return Err(if deadline.is_some() { MirrorError::NotAllowed } else { MirrorError::Disconnected });
            };
            match packet.command {
                A_CNXN => {
                    let text = String::from_utf8_lossy(&packet.payload).trim_end_matches('\0').to_owned();
                    let max_payload = (packet.arg1 as usize).clamp(4096, MAX_PAYLOAD as usize);
                    let inner = Arc::new(Inner { link: link.clone(), streams: Mutex::new(HashMap::new()), next_id: AtomicU32::new(1), max_payload, down: AtomicBool::new(false) });
                    let reader = inner.clone();
                    std::thread::spawn(move || reader.read_loop());
                    return Ok(Adb { inner, banner: Banner { text, max_payload } });
                }
                A_AUTH if packet.arg0 == AUTH_TOKEN => {
                    if let Some(limit) = deadline {
                        if std::time::Instant::now() > limit {
                            return Err(MirrorError::NotAllowed);
                        }
                    }
                    if !signed {
                        // The first answer: a signature, which a phone that knows this computer takes at once.
                        signed = true;
                        link.send(&Packet::new(A_AUTH, AUTH_SIGNATURE, 0, handshake.key.sign(&packet.payload))).map_err(MirrorError::link)?;
                    } else if !offered {
                        // It did not: the key itself, and the person is asked on the phone.
                        offered = true;
                        deadline = Some(std::time::Instant::now() + handshake.allow_within);
                        (handshake.on_allow)();
                        link.send(&Packet::new(A_AUTH, AUTH_PUBLIC_KEY, 0, handshake.key.public_key(handshake.name))).map_err(MirrorError::link)?;
                    } else {
                        return Err(MirrorError::NotAllowed);
                    }
                }
                A_AUTH => return Err(MirrorError::Protocol("Das Handy hat die Anmeldung unerwartet beantwortet.".into())),
                _ => {}
            }
        }
    }

    /// Opens a stream to a service (`shell:…`, `sync:`, `localabstract:…`).
    pub fn open(&self, service: &str) -> Result<Stream, MirrorError> {
        let inner = &self.inner;
        let local = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let (events, event_rx) = channel();
        let (acks, ack_rx) = channel();
        inner.streams.lock().expect("lock").insert(local, Slot { events, acks });
        let mut payload = service.as_bytes().to_vec();
        payload.push(0);
        if inner.link.send(&Packet::new(A_OPEN, local, 0, payload)).is_err() {
            inner.streams.lock().expect("lock").remove(&local);
            return Err(MirrorError::Disconnected);
        }
        match ack_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(remote)) => Ok(Stream { inner: inner.clone(), local, remote, events: event_rx, acks: ack_rx, pending: Vec::new(), ended: false }),
            Ok(Err(())) => {
                inner.streams.lock().expect("lock").remove(&local);
                Err(MirrorError::Refused(service.to_owned()))
            }
            Err(_) => {
                inner.streams.lock().expect("lock").remove(&local);
                Err(MirrorError::Disconnected)
            }
        }
    }

    /// Lets go of the phone: every stream ends.
    pub fn close(&self) {
        self.inner.link.close();
    }

    /// Whether the phone has gone.
    pub fn is_down(&self) -> bool {
        self.inner.down.load(Ordering::SeqCst)
    }

    /// Runs a command in the phone's shell and returns what it printed, once it is done.
    pub fn shell_output(&self, command: &str) -> Result<String, MirrorError> {
        let mut stream = self.open(&format!("shell:{command}"))?;
        let mut out = Vec::new();
        stream.read_to_end(&mut out).map_err(|_| MirrorError::Disconnected)?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    /// Puts a file on the phone (the sync service, `SEND`): `mode` is the file's mode, such as `0o100644`.
    pub fn push_file(&self, remote_path: &str, mode: u32, bytes: &[u8]) -> Result<(), MirrorError> {
        let mut sync = self.open("sync:")?;
        let target = format!("{remote_path},{mode}");
        let mut frame = b"SEND".to_vec();
        frame.extend((target.len() as u32).to_le_bytes());
        frame.extend(target.as_bytes());
        sync.write_all(&frame).map_err(|_| MirrorError::Disconnected)?;
        for chunk in bytes.chunks(64 * 1024) {
            let mut data = b"DATA".to_vec();
            data.extend((chunk.len() as u32).to_le_bytes());
            data.extend(chunk);
            sync.write_all(&data).map_err(|_| MirrorError::Disconnected)?;
        }
        let mtime = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as u32);
        let mut done = b"DONE".to_vec();
        done.extend(mtime.to_le_bytes());
        sync.write_all(&done).map_err(|_| MirrorError::Disconnected)?;
        let mut answer = [0u8; 8];
        sync.read_exact(&mut answer).map_err(|_| MirrorError::Disconnected)?;
        match &answer[..4] {
            b"OKAY" => {
                let _ = sync.write_all(b"QUIT\0\0\0\0");
                Ok(())
            }
            b"FAIL" => {
                let len = u32::from_le_bytes([answer[4], answer[5], answer[6], answer[7]]) as usize;
                let mut why = vec![0u8; len.min(4096)];
                let _ = sync.read_exact(&mut why);
                Err(MirrorError::Protocol(format!("Das Handy hat die Datei nicht angenommen: {}", String::from_utf8_lossy(&why))))
            }
            _ => Err(MirrorError::Protocol("Unerwartete Antwort des Handys beim Aufspielen.".into())),
        }
    }
}

impl Inner {
    fn read_loop(self: Arc<Inner>) {
        while let Ok(packet) = self.link.recv() {
            match packet.command {
                A_OKAY => {
                    if let Some(slot) = self.streams.lock().expect("lock").get(&packet.arg1) {
                        let _ = slot.acks.send(Ok(packet.arg0));
                    }
                }
                A_WRTE => {
                    let (remote, local) = (packet.arg0, packet.arg1);
                    let delivered = self.streams.lock().expect("lock").get(&local).map(|slot| slot.events.send(Event::Data(packet.payload)).is_ok());
                    if delivered == Some(true) {
                        let _ = self.link.send(&Packet::new(A_OKAY, local, remote, Vec::new()));
                    }
                }
                A_CLSE => {
                    let local = packet.arg1;
                    let slot = if local == 0 {
                        // A refusal of an OPEN names only the local id the phone was given, in arg1 = 0? It names ours in arg1.
                        None
                    } else {
                        self.streams.lock().expect("lock").remove(&local)
                    };
                    if let Some(slot) = slot {
                        // If the stream never got its OKAY, this is a refusal.
                        let _ = slot.acks.send(Err(()));
                        let _ = slot.events.send(Event::Closed);
                        let _ = self.link.send(&Packet::new(A_CLSE, local, packet.arg0, Vec::new()));
                    }
                }
                _ => {}
            }
        }
        self.down.store(true, Ordering::SeqCst);
        for (_, slot) in self.streams.lock().expect("lock").drain() {
            let _ = slot.events.send(Event::Closed);
            let _ = slot.acks.send(Err(()));
        }
    }
}

/// A stream to one service: read what the phone sends, write what it is to get.
pub struct Stream {
    inner: Arc<Inner>,
    local: u32,
    remote: u32,
    events: Receiver<Event>,
    acks: Receiver<Result<u32, ()>>,
    pending: Vec<u8>,
    ended: bool,
}

impl Stream {
    /// The next piece the phone sent, waiting up to `wait`; `None` at the end of the stream.
    pub fn recv_timeout(&mut self, wait: Duration) -> io::Result<Option<Vec<u8>>> {
        if !self.pending.is_empty() {
            return Ok(Some(std::mem::take(&mut self.pending)));
        }
        if self.ended {
            return Ok(None);
        }
        match self.events.recv_timeout(wait) {
            Ok(Event::Data(bytes)) => Ok(Some(bytes)),
            Ok(Event::Closed) | Err(RecvTimeoutError::Disconnected) => {
                self.ended = true;
                Ok(None)
            }
            Err(RecvTimeoutError::Timeout) => Err(io::Error::new(io::ErrorKind::TimedOut, "keine Daten")),
        }
    }

    pub fn close(&mut self) {
        if !self.ended {
            self.ended = true;
            if self.inner.streams.lock().expect("lock").remove(&self.local).is_some() {
                let _ = self.inner.link.send(&Packet::new(A_CLSE, self.local, self.remote, Vec::new()));
            }
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if !self.pending.is_empty() {
                let n = buf.len().min(self.pending.len());
                buf[..n].copy_from_slice(&self.pending[..n]);
                self.pending.drain(..n);
                return Ok(n);
            }
            if self.ended {
                return Ok(0);
            }
            match self.events.recv() {
                Ok(Event::Data(bytes)) => self.pending = bytes,
                Ok(Event::Closed) | Err(_) => self.ended = true,
            }
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut sent = 0;
        for chunk in buf.chunks(self.inner.max_payload) {
            if self.ended {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "der Strom ist zu Ende"));
            }
            self.inner.link.send(&Packet::new(A_WRTE, self.local, self.remote, chunk.to_vec()))?;
            // One piece at a time: the next goes when the phone has said it took this one.
            match self.acks.recv_timeout(Duration::from_secs(30)) {
                Ok(Ok(_)) => {}
                _ => return Err(io::Error::new(io::ErrorKind::BrokenPipe, "das Handy hat nicht geantwortet")),
            }
            sent += chunk.len();
        }
        Ok(sent)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.close();
    }
}
