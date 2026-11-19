//! One side of a transfer to or from the web app's own code, for `scripts/verify-native-rtc.mts`: the
//! offer and the answer travel as files in a directory (where the apps use Drive), and the bytes are a
//! pattern both sides can check.
//!
//!   rtc_peer <dir> send    — makes the offer, sends 20 MB and 64 KiB pieces to whoever answers
//!   rtc_peer <dir> receive — waits for the offer, answers, checks what arrives

use std::io;
use std::path::PathBuf;
use std::time::Duration;

use sondra_devices::rtc::{Config, Initiator, Responder};
use sondra_devices::transfer::*;

const SIZE: u64 = 20 * 1024 * 1024 + 321;

fn pattern(at: u64) -> u8 {
    ((at * 31 + at / 251) % 253) as u8
}

struct Check {
    at: u64,
    wrong: u64,
}

impl Sink for Check {
    fn write(&mut self, chunk: &[u8]) -> io::Result<()> {
        for (i, b) in chunk.iter().enumerate() {
            if *b != pattern(self.at + i as u64) {
                self.wrong += 1;
            }
        }
        self.at += chunk.len() as u64;
        Ok(())
    }
    fn close(&mut self) -> io::Result<String> {
        println!("received {} bytes, {} wrong", self.at, self.wrong);
        if self.wrong > 0 || self.at != SIZE {
            std::process::exit(3);
        }
        Ok("Pruefung".into())
    }
    fn abort(&mut self) {}
}

fn wait_for(path: &PathBuf) -> String {
    for _ in 0..600 {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.is_empty() {
                return text;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("nothing came in {path:?}");
    std::process::exit(2);
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("a directory"));
    let mode = std::env::args().nth(2).expect("send or receive");
    // Chromium run by the script hides nothing; the loopback address is for two programs on one computer.
    let config = Config { servers: vec![], live: None, loopback: true };
    if mode == "send" {
        let (initiator, offer) = Initiator::offer(&config).expect("an offer");
        std::fs::write(dir.join("offer.sdp"), offer).unwrap();
        println!("offer written");
        let answer = wait_for(&dir.join("answer.sdp"));
        let mut wire = initiator.connect(&answer, Duration::from_secs(30)).expect("a connection");
        println!("channel open");
        let info = FileInfo { name: "Muster.bin".into(), size: SIZE, mime: "application/octet-stream".into(), path: None };
        let read = Box::new(move |a: u64, b: u64| Ok((a..b).map(pattern).collect::<Vec<u8>>()));
        let mut files = vec![OutgoingFile { info, read }];
        match send_over(&mut wire, &mut files, Options::default()) {
            Ok(places) => println!("sent, the other side says {places:?}"),
            Err(e) => {
                println!("send failed: {e:?}");
                std::process::exit(1);
            }
        }
    } else {
        let offer = wait_for(&dir.join("offer.sdp"));
        let (responder, answer) = Responder::accept(&offer, &config).expect("an answer");
        std::fs::write(dir.join("answer.sdp"), answer).unwrap();
        println!("answer written");
        let mut wire = responder.connect(Duration::from_secs(30)).expect("a connection");
        println!("channel open");
        let mut make = |_: &FileInfo, _: usize, _: Option<&Piece>| -> io::Result<Box<dyn Sink>> { Ok(Box::new(Check { at: 0, wrong: 0 })) };
        match receive_over(&mut wire, &mut make, &mut |_| {}, None, None, Options::default()) {
            Ok(places) => println!("received, saved as {places:?}"),
            Err(e) => {
                println!("receive failed: {e:?}");
                std::process::exit(1);
            }
        }
    }
}
