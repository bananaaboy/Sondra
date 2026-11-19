//! A mirroring session: the server put on the phone and started, its three sockets (picture, sound, control)
//! opened, the picture and sound decoded and handed on, and what the person does — clicks, wheel, keys — sent
//! back (`startMirror` of the web app).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::adb::{Adb, Handshake, Link, Stream};
use crate::control::{self, KeyAction, Place, TouchAction};
use crate::decode::{AudioDecoder, Frame, VideoDecoder};
use crate::hid::{HidKeyboard, HID_KEYBOARD_ID, KEYBOARD_REPORT_DESCRIPTOR};
use crate::key::AdbKey;
use crate::options::{server_command, Quality, SERVER_PATH, SOCKET};
use crate::stream::{parse_video_head, Packet, PacketReader, AUDIO_DISABLED, AUDIO_ERRORED, AUDIO_OPUS, CODEC_H264, VIDEO_HEAD_LEN};
use crate::MirrorError;

/// The steps the page shows while it connects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Connect,
    /// The phone asks the person: „Zulassen“.
    Allow,
    Push,
    Start,
}

pub struct Options {
    pub quality: Quality,
    pub sound: bool,
    pub ffmpeg: PathBuf,
    /// The scrcpy server file, as shipped (checked by the caller against `SERVER_SHA256`).
    pub server: Vec<u8>,
    /// How long the person has to tap „Zulassen“.
    pub allow_within: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyboardMode {
    /// A virtual USB keyboard on the phone (`--keyboard=uhid`).
    Uhid,
    /// Text and key codes, where the phone refuses a virtual keyboard.
    Sdk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioState {
    On,
    Off,
    /// Android before 11 has no sound to give.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhoneKey {
    Back,
    Home,
    Recents,
    VolumeUp,
    VolumeDown,
    Power,
}

struct State {
    size: (u32, u32),
    closed: Option<String>,
    keyboard: KeyboardMode,
    audio: AudioState,
}

struct Shared {
    state: Mutex<State>,
    control: Mutex<Stream>,
    hid: Mutex<HidKeyboard>,
}

pub struct Session {
    adb: Adb,
    shared: Arc<Shared>,
    pub device_name: String,
    /// Where the phone's own name and model are, for the page.
    pub model: String,
}

fn finish(shared: &Shared, reason: &str) {
    let mut state = shared.state.lock().expect("lock");
    if state.closed.is_none() {
        state.closed = Some(reason.to_owned());
    }
}

impl Session {
    pub fn start(link: Arc<dyn Link>, key: &AdbKey, options: Options, on_step: &mut dyn FnMut(Step), frames: Sender<Frame>, samples: Sender<Vec<f32>>) -> Result<Session, MirrorError> {
        on_step(Step::Connect);
        // The phone may ask the person; the page is told at once, while it waits.
        let adb = {
            let mut on_allow = || on_step(Step::Allow);
            let handshake = Handshake { key, name: "Sondra", on_allow: &mut on_allow, allow_within: options.allow_within };
            Adb::connect(link, handshake)?
        };

        on_step(Step::Push);
        adb.push_file(SERVER_PATH, 0o100644, &options.server)?;

        on_step(Step::Start);
        let mut server = adb.open(&format!("shell:{}", server_command(options.quality, options.sound)))?;
        // The server's own words: a refused virtual keyboard is named there.
        let uhid_refused = Arc::new(Mutex::new(false));
        let words = uhid_refused.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = server.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                text.push_str(&String::from_utf8_lossy(&chunk[..n]));
                for line in text.lines() {
                    let lower = line.to_lowercase();
                    if lower.contains("uhid") && ["fail", "error", "could not", "exception", "denied", "permission"].iter().any(|w| lower.contains(w)) {
                        *words.lock().expect("lock") = true;
                    }
                }
                if text.len() > 16 * 1024 {
                    text.drain(..text.len() - 8 * 1024);
                }
            }
        });

        // The sockets, in the order the server accepts them: picture, sound, control. The server may still be
        // starting: refused, they are tried again.
        let connect = |first: bool| -> Result<Stream, MirrorError> {
            let mut last = MirrorError::Disconnected;
            for _ in 0..100 {
                match adb.open(SOCKET) {
                    Ok(mut s) => {
                        if first {
                            // The server's dummy byte: the connection is truly there.
                            let mut dummy = [0u8; 1];
                            match s.read_exact(&mut dummy) {
                                Ok(()) => return Ok(s),
                                Err(_) => {
                                    last = MirrorError::Disconnected;
                                    std::thread::sleep(Duration::from_millis(100));
                                    continue;
                                }
                            }
                        }
                        return Ok(s);
                    }
                    Err(e @ MirrorError::Refused(_)) => {
                        last = e;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => return Err(e),
                }
            }
            Err(last)
        };
        let mut video = connect(true)?;
        let audio_stream = if options.sound { Some(connect(false)?) } else { None };
        let control_stream = connect(false)?;

        let mut head = vec![0u8; VIDEO_HEAD_LEN];
        video.read_exact(&mut head).map_err(|_| MirrorError::Disconnected)?;
        let head = parse_video_head(&head).ok_or(MirrorError::Disconnected)?;
        if head.codec != CODEC_H264 {
            return Err(MirrorError::Protocol("Das Handy schickt das Bild in einem Format, das Sondra nicht liest.".into()));
        }

        let shared = Arc::new(Shared {
            state: Mutex::new(State { size: (head.width, head.height), closed: None, keyboard: KeyboardMode::Uhid, audio: if options.sound { AudioState::On } else { AudioState::Off } }),
            control: Mutex::new(control_stream),
            hid: Mutex::new(HidKeyboard::new()),
        });

        // The picture.
        {
            let shared = shared.clone();
            let mut decoder = VideoDecoder::new(&options.ffmpeg, frames);
            std::thread::spawn(move || {
                let mut reader = PacketReader::new();
                let mut buffer = vec![0u8; 64 * 1024];
                loop {
                    match video.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => match reader.push(&buffer[..n]) {
                            Ok(packets) => {
                                for packet in packets {
                                    if decoder.push(&packet).is_err() {
                                        finish(&shared, "Das Bild des Handys liess sich nicht mehr entschlüsseln.");
                                        return;
                                    }
                                    if let Packet::Configuration(_) = packet {
                                        if let Some(size) = decoder.size() {
                                            shared.state.lock().expect("lock").size = size;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                finish(&shared, &e.to_string());
                                return;
                            }
                        },
                    }
                }
                finish(&shared, "Das Handy hat die Übertragung beendet.");
            });
        }

        // The sound: Android 11 and newer give it; older ones answer that there is none.
        if let Some(mut stream) = audio_stream {
            let shared = shared.clone();
            let ffmpeg = options.ffmpeg.clone();
            std::thread::spawn(move || {
                let mut marker = [0u8; 4];
                if stream.read_exact(&mut marker).is_err() {
                    shared.state.lock().expect("lock").audio = AudioState::Unavailable;
                    return;
                }
                match u32::from_be_bytes(marker) {
                    AUDIO_DISABLED => shared.state.lock().expect("lock").audio = AudioState::Off,
                    AUDIO_ERRORED => shared.state.lock().expect("lock").audio = AudioState::Unavailable,
                    AUDIO_OPUS => {
                        let Ok(mut decoder) = AudioDecoder::new(&ffmpeg, samples) else {
                            shared.state.lock().expect("lock").audio = AudioState::Unavailable;
                            return;
                        };
                        let mut reader = PacketReader::new();
                        let mut buffer = vec![0u8; 16 * 1024];
                        while let Ok(n) = stream.read(&mut buffer) {
                            if n == 0 {
                                break;
                            }
                            let Ok(packets) = reader.push(&buffer[..n]) else { break };
                            for packet in packets {
                                let (Packet::Data { data, .. } | Packet::Configuration(data)) = packet;
                                // A configuration packet of Opus is its header, which the container has.
                                if !data.starts_with(b"OpusHead") && decoder.push(&data).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    _ => shared.state.lock().expect("lock").audio = AudioState::Unavailable,
                }
            });
        }

        let model = adb.banner.model();
        let session = Session { adb, shared, device_name: head.device_name, model };

        // `--keyboard=uhid`: a virtual USB keyboard on the phone, made once when the picture starts; if the
        // phone refuses (the server says so), keys fall back to text and key codes.
        let made = session.send(&control::uhid_create(HID_KEYBOARD_ID, 0, 0, "Sondra Tastatur", &KEYBOARD_REPORT_DESCRIPTOR));
        if made.is_err() {
            session.shared.state.lock().expect("lock").keyboard = KeyboardMode::Sdk;
        }
        let watch = session.shared.clone();
        std::thread::spawn(move || {
            // The word of refusal comes soon after the keyboard is asked for, or not at all.
            for _ in 0..30 {
                std::thread::sleep(Duration::from_millis(100));
                if *uhid_refused.lock().expect("lock") {
                    watch.state.lock().expect("lock").keyboard = KeyboardMode::Sdk;
                    return;
                }
                if watch.state.lock().expect("lock").closed.is_some() {
                    return;
                }
            }
        });
        Ok(session)
    }

    fn send(&self, message: &[u8]) -> Result<(), MirrorError> {
        self.shared.control.lock().expect("lock").write_all(message).map_err(|_| MirrorError::Disconnected)
    }

    /// The size of the picture now (it changes when the phone is turned).
    pub fn size(&self) -> (u32, u32) {
        self.shared.state.lock().expect("lock").size
    }

    /// Why the session ended, once it has.
    pub fn closed(&self) -> Option<String> {
        let mut state = self.shared.state.lock().expect("lock");
        if state.closed.is_none() && self.adb.is_down() {
            state.closed = Some("Das Handy wurde getrennt.".into());
        }
        state.closed.clone()
    }

    pub fn keyboard(&self) -> KeyboardMode {
        self.shared.state.lock().expect("lock").keyboard
    }

    pub fn audio(&self) -> AudioState {
        self.shared.state.lock().expect("lock").audio
    }

    /// A finger: `x` and `y` are the pointer's place on the picture, from 0 to 1.
    pub fn touch(&self, action: TouchAction, x: f64, y: f64) -> Result<(), MirrorError> {
        let (w, h) = self.size();
        let pressure = if action == TouchAction::Up { 0.0 } else { 1.0 };
        self.send(&control::inject_touch(action, Place::at(w, h, x, y), pressure))
    }

    pub fn scroll(&self, x: f64, y: f64, delta_x: f64, delta_y: f64) -> Result<(), MirrorError> {
        let (w, h) = self.size();
        self.send(&control::inject_scroll(Place::at(w, h, x, y), delta_x, delta_y))
    }

    fn press(&self, code: u32) -> Result<(), MirrorError> {
        self.send(&control::inject_key(KeyAction::Down, code))?;
        self.send(&control::inject_key(KeyAction::Up, code))
    }

    /// One of the phone's own keys.
    pub fn key(&self, key: PhoneKey) -> Result<(), MirrorError> {
        match key {
            PhoneKey::Back => {
                self.send(&control::back_or_screen_on(KeyAction::Down))?;
                self.send(&control::back_or_screen_on(KeyAction::Up))
            }
            PhoneKey::Home => self.press(control::key_code::HOME),
            PhoneKey::Recents => self.press(control::key_code::APP_SWITCH),
            PhoneKey::VolumeUp => self.press(control::key_code::VOLUME_UP),
            PhoneKey::VolumeDown => self.press(control::key_code::VOLUME_DOWN),
            PhoneKey::Power => self.press(control::key_code::POWER),
        }
    }

    pub fn open_notifications(&self) -> Result<(), MirrorError> {
        self.send(&control::expand_notification_panel())
    }

    /// A key of this computer's keyboard (`code` is its place on the keyboard, `key` what it types).
    pub fn send_key(&self, code: &str, key: &str, down: bool, ctrl: bool, alt: bool, meta: bool) -> Result<(), MirrorError> {
        if self.keyboard() == KeyboardMode::Uhid {
            let report = {
                let mut hid = self.shared.hid.lock().expect("lock");
                if down { hid.down(code) } else { hid.up(code) }
            };
            if let Some(report) = report {
                self.send(&control::uhid_input(HID_KEYBOARD_ID, &report))?;
            }
            return Ok(());
        }
        // Without a virtual keyboard: only what a key press can mean — a named key, or the character itself.
        if !down {
            return Ok(());
        }
        use control::key_code as k;
        let named = match code {
            "Enter" | "NumpadEnter" => Some(k::ENTER),
            "Backspace" => Some(k::DEL),
            "Delete" => Some(k::FORWARD_DEL),
            "Tab" => Some(k::TAB),
            "Escape" => Some(k::ESCAPE),
            "ArrowUp" => Some(k::DPAD_UP),
            "ArrowDown" => Some(k::DPAD_DOWN),
            "ArrowLeft" => Some(k::DPAD_LEFT),
            "ArrowRight" => Some(k::DPAD_RIGHT),
            "PageUp" => Some(k::PAGE_UP),
            "PageDown" => Some(k::PAGE_DOWN),
            "Home" => Some(k::MOVE_HOME),
            "End" => Some(k::MOVE_END),
            _ => None,
        };
        match named {
            Some(code) => self.press(code),
            None if key.chars().count() == 1 && !ctrl && !alt && !meta => self.send(&control::inject_text(key)),
            None => Ok(()),
        }
    }

    /// Every key let go (when the window loses the focus a held key would stay held on the phone).
    pub fn release_keys(&self) -> Result<(), MirrorError> {
        let report = self.shared.hid.lock().expect("lock").reset();
        match report {
            Some(report) if self.keyboard() == KeyboardMode::Uhid => self.send(&control::uhid_input(HID_KEYBOARD_ID, &report)),
            _ => Ok(()),
        }
    }

    /// Ends the session: the virtual keyboard is taken away, the server's sockets and the phone let go.
    pub fn stop(&self) {
        if self.keyboard() == KeyboardMode::Uhid {
            let _ = self.send(&control::uhid_destroy(HID_KEYBOARD_ID));
        }
        finish(&self.shared, "Beendet.");
        self.adb.close();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.adb.close();
    }
}
