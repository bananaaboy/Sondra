//! A phone that is no phone, for tests: it speaks ADB over a pair of channels, asks for the signature and the
//! person's „Zulassen“, takes the server file, „starts“ the scrcpy server when the shell is told to, and then
//! gives the sockets the server would — a video stream made of bytes the test supplies, an audio stream, and
//! a control stream whose bytes it keeps for the test to read.

use std::collections::HashMap;
use std::io;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use rsa::traits::PublicKeyParts;
use rsa::{BigUint, Pkcs1v15Sign, RsaPublicKey};

use crate::adb::*;

/// What the stand-in phone shows and does.
#[derive(Clone)]
pub struct FakeConfig {
    pub model: String,
    /// Whether the phone asks for a signature at all.
    pub require_key: bool,
    /// Whether it allows a key it does not know the moment it is offered (else: `allow()` or never).
    pub allow_new_keys: bool,
    pub device_name: String,
    pub width: u32,
    pub height: u32,
    /// An H.264 stream in Annex B: what the „screen“ shows.
    pub video: Vec<u8>,
    /// Opus packets the „phone“ plays; none: the phone answers that there is no sound to give.
    pub audio: Vec<Vec<u8>>,
    /// Whether the server refuses the virtual keyboard (it says so in its output).
    pub refuse_uhid: bool,
    /// Public keys (as the phone gets them) the phone has allowed before.
    pub trusted: Vec<Vec<u8>>,
}

impl Default for FakeConfig {
    fn default() -> Self {
        FakeConfig { model: "Fake Phone".into(), require_key: true, allow_new_keys: true, device_name: "Fake Phone".into(), width: 320, height: 240, video: Vec::new(), audio: Vec::new(), refuse_uhid: false, trusted: Vec::new() }
    }
}

enum Message {
    FromHost(Packet),
    Allow,
    Stop,
}

/// What the test can look at, and do to the phone.
#[derive(Clone)]
pub struct PhoneHandle {
    shared: Arc<Mutex<Shared>>,
    inbox: Sender<Message>,
}

#[derive(Default)]
struct Shared {
    pushed: HashMap<String, Vec<u8>>,
    commands: Vec<String>,
    control: Vec<u8>,
    known_keys: Vec<Vec<u8>>,
    asked_to_allow: bool,
    open_streams: usize,
}

impl PhoneHandle {
    /// The files put on the phone: path to bytes.
    pub fn pushed(&self) -> HashMap<String, Vec<u8>> {
        self.shared.lock().expect("lock").pushed.clone()
    }
    /// The shell commands, in order.
    pub fn commands(&self) -> Vec<String> {
        self.shared.lock().expect("lock").commands.clone()
    }
    /// Everything the control stream received.
    pub fn control(&self) -> Vec<u8> {
        self.shared.lock().expect("lock").control.clone()
    }
    /// Whether the phone showed the dialog „Diesen Computer zulassen?“.
    pub fn asked_to_allow(&self) -> bool {
        self.shared.lock().expect("lock").asked_to_allow
    }
    /// The person taps „Zulassen“.
    pub fn allow(&self) {
        let _ = self.inbox.send(Message::Allow);
    }
    /// The cable is pulled.
    pub fn unplug(&self) {
        let _ = self.inbox.send(Message::Stop);
    }
    pub fn known_keys(&self) -> usize {
        self.shared.lock().expect("lock").known_keys.len()
    }
}

struct ChannelLink {
    to_phone: Mutex<Sender<Message>>,
    from_phone: Mutex<Receiver<Packet>>,
}

impl Link for ChannelLink {
    fn send(&self, packet: &Packet) -> io::Result<()> {
        self.to_phone.lock().expect("lock").send(Message::FromHost(packet.clone())).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "unplugged"))
    }
    fn recv(&self) -> io::Result<Packet> {
        // The receiver is locked only by the one reader.
        self.from_phone.lock().expect("lock").recv().map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "unplugged"))
    }
    fn recv_timeout(&self, wait: std::time::Duration) -> io::Result<Option<Packet>> {
        match self.from_phone.lock().expect("lock").recv_timeout(wait) {
            Ok(p) => Ok(Some(p)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(_) => Err(io::Error::new(io::ErrorKind::BrokenPipe, "unplugged")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Shell,
    Sync,
    Video,
    Audio,
    Control,
}

struct Open {
    role: Role,
    host_id: u32,
    buffer: Vec<u8>,
    /// The file a sync stream is putting on the phone.
    file: String,
}

pub struct FakePhone {
    thread: Option<JoinHandle<()>>,
    stop: Sender<Message>,
}

impl Drop for FakePhone {
    fn drop(&mut self) {
        // The phone stops whoever still holds the cable (a test that failed ends here, too).
        let _ = self.stop.send(Message::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Starts the stand-in; the link is the cable, the handle is for the test.
pub fn start(config: FakeConfig) -> (Arc<dyn Link>, PhoneHandle, FakePhone) {
    let (to_phone, inbox) = channel::<Message>();
    let (to_host, from_phone) = channel::<Packet>();
    let shared = Arc::new(Mutex::new(Shared { known_keys: config.trusted.clone(), ..Shared::default() }));
    let handle = PhoneHandle { shared: shared.clone(), inbox: to_phone.clone() };
    let to_phone_for_drop = to_phone.clone();
    let thread = std::thread::spawn(move || run(config, inbox, to_host, shared));
    (Arc::new(ChannelLink { to_phone: Mutex::new(to_phone), from_phone: Mutex::new(from_phone) }), handle, FakePhone { thread: Some(thread), stop: to_phone_for_drop })
}

fn public_key_of(blob: &[u8]) -> Option<RsaPublicKey> {
    // base64 up to the first space or zero, then Android's layout: words, n0inv, n (LE), rr, e.
    use base64::Engine;
    let end = blob.iter().position(|b| *b == b' ' || *b == 0).unwrap_or(blob.len());
    let raw = base64::engine::general_purpose::STANDARD.decode(&blob[..end]).ok()?;
    if raw.len() < 8 + 256 + 256 + 4 {
        return None;
    }
    let n = BigUint::from_bytes_le(&raw[8..8 + 256]);
    RsaPublicKey::new(n, BigUint::from(65537u32)).ok()
}

fn run(config: FakeConfig, inbox: Receiver<Message>, to_host: Sender<Packet>, shared: Arc<Mutex<Shared>>) {
    let send = |p: Packet| {
        let _ = to_host.send(p);
    };
    let banner = format!("device::ro.product.name=fake;ro.product.model={};ro.product.device=fake;features=", config.model).into_bytes();
    let mut open: HashMap<u32, Open> = HashMap::new();
    let mut next_id = 100u32;
    let mut token = vec![0u8; 20];
    let mut waiting_for_allow: Option<Vec<u8>> = None;
    let mut server: Option<Vec<String>> = None;
    let mut sockets_given = 0usize;
    let mut authed = !config.require_key;

    let accept_key = |shared: &Arc<Mutex<Shared>>, blob: &[u8]| {
        shared.lock().expect("lock").known_keys.push(blob.to_vec());
    };

    while let Ok(message) = inbox.recv() {
        let packet = match message {
            Message::Stop => break,
            Message::Allow => {
                if let Some(blob) = waiting_for_allow.take() {
                    accept_key(&shared, &blob);
                    authed = true;
                    send(Packet::new(A_CNXN, 0x0100_0001, 256 * 1024, banner.clone()));
                }
                continue;
            }
            Message::FromHost(p) => p,
        };
        match packet.command {
            A_CNXN => {
                if authed {
                    send(Packet::new(A_CNXN, 0x0100_0001, 256 * 1024, banner.clone()));
                } else {
                    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut token);
                    send(Packet::new(A_AUTH, AUTH_TOKEN, 0, token.clone()));
                }
            }
            A_AUTH if packet.arg0 == AUTH_SIGNATURE => {
                let known = shared.lock().expect("lock").known_keys.clone();
                let ok = known.iter().filter_map(|k| public_key_of(k)).any(|k| k.verify(Pkcs1v15Sign::new::<sha1::Sha1>(), &token, &packet.payload).is_ok());
                if ok {
                    authed = true;
                    send(Packet::new(A_CNXN, 0x0100_0001, 256 * 1024, banner.clone()));
                } else {
                    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut token);
                    send(Packet::new(A_AUTH, AUTH_TOKEN, 0, token.clone()));
                }
            }
            A_AUTH if packet.arg0 == AUTH_PUBLIC_KEY => {
                if public_key_of(&packet.payload).is_none() {
                    continue;
                }
                shared.lock().expect("lock").asked_to_allow = true;
                if config.allow_new_keys {
                    accept_key(&shared, &packet.payload);
                    authed = true;
                    send(Packet::new(A_CNXN, 0x0100_0001, 256 * 1024, banner.clone()));
                } else {
                    waiting_for_allow = Some(packet.payload.clone());
                }
            }
            A_OPEN if authed => {
                let service = String::from_utf8_lossy(&packet.payload).trim_end_matches('\0').to_owned();
                let host_id = packet.arg0;
                let phone_id = next_id;
                next_id += 1;
                let role = if service.starts_with("shell:") {
                    shared.lock().expect("lock").commands.push(service["shell:".len()..].to_owned());
                    if service.contains("com.genymobile.scrcpy.Server") {
                        server = Some(service.split(' ').skip(5).map(str::to_owned).collect());
                    }
                    Some(Role::Shell)
                } else if service == "sync:" {
                    Some(Role::Sync)
                } else if service == "localabstract:scrcpy" && server.is_some() {
                    let audio = !server.as_ref().is_some_and(|a| a.iter().any(|x| x == "audio=false"));
                    let role = match (sockets_given, audio) {
                        (0, _) => Role::Video,
                        (1, true) => Role::Audio,
                        _ => Role::Control,
                    };
                    sockets_given += 1;
                    Some(role)
                } else {
                    None
                };
                let Some(role) = role else {
                    send(Packet::new(A_CLSE, 0, host_id, Vec::new()));
                    continue;
                };
                send(Packet::new(A_OKAY, phone_id, host_id, Vec::new()));
                shared.lock().expect("lock").open_streams += 1;
                open.insert(phone_id, Open { role, host_id, buffer: Vec::new(), file: String::new() });
                match role {
                    // A command that is not the server is over at once (it printed nothing).
                    Role::Shell if server.is_none() => {
                        send(Packet::new(A_CLSE, phone_id, host_id, Vec::new()));
                        open.remove(&phone_id);
                        shared.lock().expect("lock").open_streams -= 1;
                    }
                    Role::Video => {
                        // The dummy byte, the head, then the packets in uneven pieces.
                        let mut stream = vec![0u8];
                        let mut name = config.device_name.clone().into_bytes();
                        name.resize(64, 0);
                        stream.extend(name);
                        stream.extend(crate::stream::CODEC_H264.to_be_bytes());
                        stream.extend(config.width.to_be_bytes());
                        stream.extend(config.height.to_be_bytes());
                        let (head, rest) = config.video.split_at(config.video.len().min(48));
                        let mut packets = Vec::new();
                        if !head.is_empty() {
                            packets.extend((1u64 << 63).to_be_bytes());
                            packets.extend((head.len() as u32).to_be_bytes());
                            packets.extend(head);
                        }
                        for (n, chunk) in rest.chunks(1400).enumerate() {
                            let pts: u64 = (n as u64) * 33_000 | if n == 0 { 1 << 62 } else { 0 };
                            packets.extend(pts.to_be_bytes());
                            packets.extend((chunk.len() as u32).to_be_bytes());
                            packets.extend(chunk);
                        }
                        stream.extend(packets);
                        for piece in stream.chunks(997) {
                            send(Packet::new(A_WRTE, phone_id, host_id, piece.to_vec()));
                        }
                    }
                    Role::Audio => {
                        if config.audio.is_empty() {
                            send(Packet::new(A_WRTE, phone_id, host_id, crate::stream::AUDIO_ERRORED.to_be_bytes().to_vec()));
                        } else {
                            let mut stream = crate::stream::AUDIO_OPUS.to_be_bytes().to_vec();
                            for (n, packet) in config.audio.iter().enumerate() {
                                stream.extend((n as u64 * 20_000).to_be_bytes());
                                stream.extend((packet.len() as u32).to_be_bytes());
                                stream.extend(packet);
                            }
                            for piece in stream.chunks(512) {
                                send(Packet::new(A_WRTE, phone_id, host_id, piece.to_vec()));
                            }
                        }
                    }
                    Role::Shell if server.is_some() && config.refuse_uhid => {
                        send(Packet::new(A_WRTE, phone_id, host_id, b"ERROR: Could not create UHID device: permission denied\n".to_vec()));
                    }
                    _ => {}
                }
            }
            A_WRTE => {
                let phone_id = packet.arg1;
                send(Packet::new(A_OKAY, phone_id, packet.arg0, Vec::new()));
                let Some(stream) = open.get_mut(&phone_id) else { continue };
                match stream.role {
                    Role::Control => shared.lock().expect("lock").control.extend(&packet.payload),
                    Role::Sync => {
                        stream.buffer.extend(&packet.payload);
                        // Frames: SEND len "path,mode", DATA len bytes…, DONE mtime, QUIT.
                        loop {
                            let b = &stream.buffer;
                            if b.len() < 8 {
                                break;
                            }
                            let len = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize;
                            match &b[..4] {
                                b"SEND" if b.len() >= 8 + len => {
                                    let target = String::from_utf8_lossy(&b[8..8 + len]).into_owned();
                                    let path = target.rsplit_once(',').map_or(target.clone(), |(p, _)| p.to_owned());
                                    shared.lock().expect("lock").pushed.insert(path.clone(), Vec::new());
                                    stream.buffer.drain(..8 + len);
                                    // Which file the next DATA belongs to.
                                    stream.file = path;
                                }
                                b"DATA" if b.len() >= 8 + len => {
                                    let data = b[8..8 + len].to_vec();
                                    shared.lock().expect("lock").pushed.entry(stream.file.clone()).or_default().extend(&data);
                                    stream.buffer.drain(..8 + len);
                                }
                                b"DONE" => {
                                    stream.buffer.drain(..8);
                                    send(Packet::new(A_WRTE, phone_id, stream.host_id, b"OKAY\0\0\0\0".to_vec()));
                                }
                                b"QUIT" => {
                                    stream.buffer.drain(..8);
                                }
                                _ => break,
                            }
                        }
                    }
                    _ => {}
                }
            }
            A_CLSE => {
                let phone_id = packet.arg1;
                if open.remove(&phone_id).is_some() {
                    shared.lock().expect("lock").open_streams -= 1;
                    send(Packet::new(A_CLSE, phone_id, packet.arg0, Vec::new()));
                }
            }
            _ => {}
        }
    }
}

/// The modulus of a key as the stand-in learned it, to see that the one offered is the one that was kept.
pub fn modulus_of(blob: &[u8]) -> Option<BigUint> {
    public_key_of(blob).map(|k| k.n().clone())
}
