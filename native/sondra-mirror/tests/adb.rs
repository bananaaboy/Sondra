//! The ADB protocol against a phone that is none: the signature, the person's „Zulassen“, files put on the
//! phone, a shell, and the packets as they are written.

use std::time::Duration;

use sondra_mirror::adb::{Adb, Handshake, Packet, A_WRTE};
use sondra_mirror::fake::{start, FakeConfig};
use sondra_mirror::key::AdbKey;
use sondra_mirror::MirrorError;

fn key() -> AdbKey {
    AdbKey::from_pkcs8(include_bytes!("fixtures/adb-test-key.der")).unwrap_or_else(|e| panic!("the test key: {e}"))
}

fn connect(link: std::sync::Arc<dyn sondra_mirror::adb::Link>, key: &AdbKey, within: Duration, on_allow: &mut dyn FnMut()) -> Result<Adb, MirrorError> {
    Adb::connect(link, Handshake { key, name: "Sondra", on_allow, allow_within: within })
}

#[test]
fn a_packet_is_written_in_24_bytes_and_its_payload() {
    let p = Packet::new(A_WRTE, 7, 9, b"abc".to_vec());
    let h = p.header();
    assert_eq!(&h[..4], b"WRTE");
    assert_eq!(u32::from_le_bytes(h[4..8].try_into().unwrap()), 7);
    assert_eq!(u32::from_le_bytes(h[8..12].try_into().unwrap()), 9);
    assert_eq!(u32::from_le_bytes(h[12..16].try_into().unwrap()), 3);
    assert_eq!(u32::from_le_bytes(h[16..20].try_into().unwrap()), u32::from(b'a') + u32::from(b'b') + u32::from(b'c'));
    assert_eq!(u32::from_le_bytes(h[20..24].try_into().unwrap()), !A_WRTE);
    let (back, len) = Packet::from_header(&h).unwrap();
    assert_eq!((back.command, back.arg0, back.arg1, len), (A_WRTE, 7, 9, 3));
    // A header whose last word is not the complement of the command is no header.
    let mut bad = h;
    bad[23] ^= 0xff;
    assert!(Packet::from_header(&bad).is_err());
}

#[test]
fn the_public_key_is_in_androids_layout() {
    let blob = key().public_key("Sondra");
    // base64 of 524 bytes (4 + 4 + 256 + 256 + 4), a space, the name, a zero.
    assert_eq!(blob.len(), 524usize.div_ceil(3) * 4 + 1 + "Sondra".len() + 1);
    assert_eq!(*blob.last().unwrap(), 0);
    assert!(blob.ends_with(b" Sondra\0"));
    assert!(sondra_mirror::fake::modulus_of(&blob).is_some(), "the phone can read it");
}

#[test]
fn a_new_computer_is_offered_to_the_person_and_a_known_one_is_let_in_by_its_signature() {
    let key = key();
    // Not known: the key is offered, the phone shows its dialog, the person allows.
    let (link, phone, _fake) = start(FakeConfig { allow_new_keys: false, ..FakeConfig::default() });
    let allowing = phone.clone();
    let mut said = false;
    let adb = connect(link, &key, Duration::from_secs(5), &mut || {
        said = true;
        let allowing = allowing.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            allowing.allow();
        });
    })
    .expect("allowed");
    assert!(said, "the page is told that the phone is asking");
    assert!(phone.asked_to_allow());
    assert_eq!(adb.banner.model(), "Fake Phone");
    assert_eq!(phone.known_keys(), 1);

    // Known already: the signature is enough, nobody is asked.
    let (link, phone, _fake) = start(FakeConfig { trusted: vec![key.public_key("Sondra")], ..FakeConfig::default() });
    let adb = connect(link, &key, Duration::from_secs(5), &mut || panic!("a known computer is not asked again")).expect("let in");
    assert!(!phone.asked_to_allow());
    assert_eq!(adb.banner.model(), "Fake Phone");
}

#[test]
fn a_phone_nobody_taps_allow_on_says_so_and_does_not_hang() {
    let (link, phone, _fake) = start(FakeConfig { allow_new_keys: false, ..FakeConfig::default() });
    let started = std::time::Instant::now();
    let error = connect(link, &key(), Duration::from_millis(400), &mut || {}).err().expect("no connection");
    assert!(matches!(error, MirrorError::NotAllowed), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(phone.asked_to_allow());
}

#[test]
fn a_file_goes_onto_the_phone_whole_and_a_shell_command_is_told() {
    let key = key();
    let (link, phone, _fake) = start(FakeConfig::default());
    let adb = connect(link, &key, Duration::from_secs(5), &mut || {}).unwrap();
    // More than one piece of the sync protocol (64 KiB) and than one packet (256 KiB).
    let bytes: Vec<u8> = (0..700_000u32).map(|i| (i * 31 % 251) as u8).collect();
    adb.push_file("/data/local/tmp/scrcpy-server.jar", 0o100644, &bytes).unwrap();
    assert_eq!(phone.pushed().get("/data/local/tmp/scrcpy-server.jar"), Some(&bytes));
    let out = adb.shell_output("echo hallo").unwrap();
    let _ = out;
    assert_eq!(phone.commands(), vec!["echo hallo".to_string()]);
}

#[test]
fn a_phone_that_is_unplugged_ends_what_was_open() {
    let key = key();
    let (link, phone, _fake) = start(FakeConfig::default());
    let adb = connect(link, &key, Duration::from_secs(5), &mut || {}).unwrap();
    let mut shell = adb.open("shell:sleep 100").unwrap();
    phone.unplug();
    let mut buf = [0u8; 16];
    assert_eq!(std::io::Read::read(&mut shell, &mut buf).unwrap(), 0, "the stream ends");
    for _ in 0..50 {
        if adb.is_down() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(adb.is_down());
    assert!(adb.open("shell:x").is_err());
}
