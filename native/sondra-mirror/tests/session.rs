//! A whole session against the stand-in phone with real FFmpeg: the server put on the phone and started, the
//! picture and the sound coming through, and clicks, the wheel and keys going back as the bytes the web app sends.

use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use sondra_mirror::control::{self, KeyAction, Place, TouchAction};
use sondra_mirror::fake::{start, FakeConfig, PhoneHandle};
use sondra_mirror::hid::{HID_KEYBOARD_ID, KEYBOARD_REPORT_DESCRIPTOR};
use sondra_mirror::key::AdbKey;
use sondra_mirror::options::{server_command, Quality, SERVER_PATH};
use sondra_mirror::session::{AudioState, KeyboardMode, Options, PhoneKey, Session, Step};
use sondra_mirror::MirrorError;

fn ffmpeg() -> Option<std::path::PathBuf> {
    let program = std::env::var_os("SONDRA_FFMPEG").map(|d| std::path::PathBuf::from(d).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })).unwrap_or_else(|| "ffmpeg".into());
    Command::new(&program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| program)
}

fn make(program: &std::path::Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new(program).args(["-v", "error"]).args(args).args(["-"]).stderr(Stdio::inherit()).output().expect("ffmpeg runs");
    assert!(out.status.success());
    out.stdout
}

fn video(program: &std::path::Path) -> Vec<u8> {
    make(program, &["-f", "lavfi", "-i", "testsrc=size=180x320:rate=10", "-frames:v", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-f", "h264"])
}

fn opus_packets(program: &std::path::Path) -> Vec<Vec<u8>> {
    let file = make(program, &["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-c:a", "libopus", "-frame_duration", "20", "-f", "ogg"]);
    let mut packets = Vec::new();
    let (mut at, mut carry) = (0, Vec::new());
    while at + 27 <= file.len() && &file[at..at + 4] == b"OggS" {
        let segments = file[at + 26] as usize;
        let mut body = at + 27 + segments;
        for &len in &file[at + 27..at + 27 + segments] {
            carry.extend(&file[body..body + len as usize]);
            body += len as usize;
            if len < 255 {
                packets.push(std::mem::take(&mut carry));
            }
        }
        at = body;
    }
    packets.into_iter().skip(2).collect()
}

fn key() -> AdbKey {
    AdbKey::from_pkcs8(include_bytes!("fixtures/adb-test-key.der")).unwrap()
}

fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < until {
        if ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("waited for {what}");
}

fn options(ffmpeg: &std::path::Path, sound: bool) -> Options {
    Options { quality: Quality::Smooth, sound, ffmpeg: ffmpeg.to_path_buf(), server: b"not a real server".to_vec(), allow_within: Duration::from_secs(5) }
}

struct Running {
    session: Session,
    phone: PhoneHandle,
    frames: std::sync::mpsc::Receiver<sondra_mirror::decode::Frame>,
    samples: std::sync::mpsc::Receiver<Vec<f32>>,
    steps: Vec<Step>,
    _fake: sondra_mirror::fake::FakePhone,
}

fn run(program: &std::path::Path, sound: bool, config: FakeConfig) -> Running {
    let (link, phone, fake) = start(FakeConfig { video: video(program), width: 180, height: 320, ..config });
    let (frames_tx, frames) = channel();
    let (samples_tx, samples) = channel();
    let mut steps = Vec::new();
    let session = Session::start(link, &key(), options(program, sound), &mut |s| steps.push(s), frames_tx, samples_tx).expect("the session starts");
    Running { session, phone, frames, samples, steps, _fake: fake }
}

#[test]
fn the_picture_comes_and_the_server_is_put_on_the_phone_and_started_as_the_web_app_does() {
    let Some(program) = ffmpeg() else { return };
    let r = run(&program, false, FakeConfig::default());
    // (The stand-in does not know this computer yet, so it asks — and allows at once.)
    assert_eq!(r.steps, vec![Step::Connect, Step::Allow, Step::Push, Step::Start]);
    assert_eq!(r.phone.pushed().get(SERVER_PATH).map(Vec::as_slice), Some(&b"not a real server"[..]));
    assert_eq!(r.phone.commands(), vec![server_command(Quality::Smooth, false)]);
    assert_eq!(r.session.device_name, "Fake Phone");
    assert_eq!(r.session.size(), (180, 320));
    let frame = r.frames.recv_timeout(Duration::from_secs(10)).expect("a picture");
    assert_eq!((frame.width, frame.height), (180, 320));
    assert!(frame.rgba.chunks(4).any(|p| p[0] > 100));
    assert_eq!(r.session.audio(), AudioState::Off, "asked for no sound");
}

#[test]
fn clicks_the_wheel_and_the_phones_own_keys_go_back_as_the_bytes_the_web_app_sends() {
    let Some(program) = ffmpeg() else { return };
    let r = run(&program, false, FakeConfig::default());
    let start = control::uhid_create(HID_KEYBOARD_ID, 0, 0, "Sondra Tastatur", &KEYBOARD_REPORT_DESCRIPTOR);
    wait_for("the virtual keyboard", || r.phone.control().len() >= start.len());
    assert_eq!(&r.phone.control()[..start.len()], &start[..], "the virtual keyboard is made first");

    let mark = r.phone.control().len();
    r.session.touch(TouchAction::Down, 0.5, 0.25).unwrap();
    r.session.touch(TouchAction::Up, 0.5, 0.25).unwrap();
    r.session.scroll(0.5, 0.5, 0.0, -1.0).unwrap();
    r.session.key(PhoneKey::Back).unwrap();
    r.session.key(PhoneKey::Home).unwrap();
    r.session.open_notifications().unwrap();
    let place = Place::at(180, 320, 0.5, 0.25);
    let mut want = Vec::new();
    want.extend(control::inject_touch(TouchAction::Down, place, 1.0));
    want.extend(control::inject_touch(TouchAction::Up, place, 0.0));
    want.extend(control::inject_scroll(Place::at(180, 320, 0.5, 0.5), 0.0, -1.0));
    want.extend(control::back_or_screen_on(KeyAction::Down));
    want.extend(control::back_or_screen_on(KeyAction::Up));
    want.extend(control::inject_key(KeyAction::Down, control::key_code::HOME));
    want.extend(control::inject_key(KeyAction::Up, control::key_code::HOME));
    want.extend(control::expand_notification_panel());
    wait_for("the messages", || r.phone.control().len() >= mark + want.len());
    assert_eq!(&r.phone.control()[mark..], &want[..]);
}

#[test]
fn keys_go_to_the_virtual_keyboard_and_let_go_when_the_window_does() {
    let Some(program) = ffmpeg() else { return };
    let r = run(&program, false, FakeConfig::default());
    wait_for("the virtual keyboard", || !r.phone.control().is_empty());
    assert_eq!(r.session.keyboard(), KeyboardMode::Uhid);
    let mark = r.phone.control().len();
    r.session.send_key("ShiftLeft", "Shift", true, false, false, false).unwrap();
    r.session.send_key("KeyA", "A", true, false, false, false).unwrap();
    r.session.send_key("KeyA", "A", true, false, false, false).unwrap(); // the repeat of a held key: nothing new
    r.session.release_keys().unwrap();
    r.session.release_keys().unwrap(); // nothing is held any more
    let mut want = Vec::new();
    want.extend(control::uhid_input(HID_KEYBOARD_ID, &[0x02, 0, 0, 0, 0, 0, 0, 0]));
    want.extend(control::uhid_input(HID_KEYBOARD_ID, &[0x02, 0, 4, 0, 0, 0, 0, 0]));
    want.extend(control::uhid_input(HID_KEYBOARD_ID, &[0, 0, 0, 0, 0, 0, 0, 0]));
    wait_for("the reports", || r.phone.control().len() >= mark + want.len());
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(&r.phone.control()[mark..], &want[..]);
}

#[test]
fn a_phone_that_refuses_the_virtual_keyboard_gets_text_and_key_codes_instead() {
    let Some(program) = ffmpeg() else { return };
    let r = run(&program, false, FakeConfig { refuse_uhid: true, ..FakeConfig::default() });
    wait_for("the fall back", || r.session.keyboard() == KeyboardMode::Sdk);
    let mark = r.phone.control().len();
    r.session.send_key("KeyA", "a", true, false, false, false).unwrap();
    r.session.send_key("KeyA", "a", false, false, false, false).unwrap(); // letting go says nothing
    r.session.send_key("Enter", "Enter", true, false, false, false).unwrap();
    r.session.send_key("KeyC", "c", true, true, false, false).unwrap(); // Ctrl+C is no text
    let mut want = control::inject_text("a");
    want.extend(control::inject_key(KeyAction::Down, control::key_code::ENTER));
    want.extend(control::inject_key(KeyAction::Up, control::key_code::ENTER));
    wait_for("the text and the key", || r.phone.control().len() >= mark + want.len());
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(&r.phone.control()[mark..], &want[..]);
}

#[test]
fn the_sound_of_the_phone_comes_when_it_has_one_and_is_said_to_be_missing_when_not() {
    let Some(program) = ffmpeg() else { return };
    let with = run(&program, true, FakeConfig { audio: opus_packets(&program), ..FakeConfig::default() });
    let block = with.samples.recv_timeout(Duration::from_secs(10)).expect("sound");
    assert_eq!(block.len(), 960 * 2);
    assert_eq!(with.session.audio(), AudioState::On);
    assert!(with.phone.commands()[0].ends_with("video_bit_rate=6000000"), "{:?}", with.phone.commands());

    let without = run(&program, true, FakeConfig::default());
    wait_for("the answer that there is none", || without.session.audio() == AudioState::Unavailable);
}

#[test]
fn a_phone_that_asks_is_waited_for_and_one_that_is_pulled_out_ends_the_session() {
    let Some(program) = ffmpeg() else { return };
    let (link, phone, _fake) = start(FakeConfig { allow_new_keys: false, video: video(&program), width: 180, height: 320, ..FakeConfig::default() });
    let (frames_tx, _frames) = channel();
    let (samples_tx, _samples) = channel();
    let tapper = phone.clone();
    let started = std::thread::spawn(move || {
        let mut steps = Vec::new();
        let session = Session::start(link, &key(), options(&program, false), &mut |s| steps.push(s), frames_tx, samples_tx);
        (session, steps)
    });
    wait_for("the dialog on the phone", || phone.asked_to_allow());
    tapper.allow();
    let (session, steps) = started.join().unwrap();
    let session = session.expect("allowed");
    assert_eq!(steps, vec![Step::Connect, Step::Allow, Step::Push, Step::Start], "the page is told that the phone asks");
    assert!(session.closed().is_none());
    phone.unplug();
    wait_for("the end", || session.closed().is_some());
    assert!(session.closed().unwrap().contains("getrennt") || session.closed().unwrap().contains("beendet"), "{:?}", session.closed());

    // And a phone that never allows says so.
    let (link, _phone, _fake) = start(FakeConfig { allow_new_keys: false, ..FakeConfig::default() });
    let (frames_tx, _frames) = channel();
    let (samples_tx, _samples) = channel();
    let mut o = options(std::path::Path::new("ffmpeg"), false);
    o.allow_within = Duration::from_millis(300);
    let error = Session::start(link, &key(), o, &mut |_| {}, frames_tx, samples_tx).err().expect("no session");
    assert!(matches!(error, MirrorError::NotAllowed));
}
