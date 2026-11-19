//! Pictures and sound out of the streams a phone sends, with the real FFmpeg: the picture at its size, a new
//! size in the middle (the phone was turned), Opus packets taken out of an Ogg file and put back into one.

use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::Duration;

use sondra_mirror::decode::{AudioDecoder, VideoDecoder};
use sondra_mirror::stream::Packet;

fn ffmpeg() -> Option<std::path::PathBuf> {
    let program = std::env::var_os("SONDRA_FFMPEG").map(|d| std::path::PathBuf::from(d).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })).unwrap_or_else(|| "ffmpeg".into());
    Command::new(&program).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| program)
}

fn make(program: &std::path::Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new(program).args(["-v", "error"]).args(args).args(["-"]).stderr(Stdio::inherit()).output().expect("ffmpeg runs");
    assert!(out.status.success());
    out.stdout
}

fn video(program: &std::path::Path, size: &str, frames: &str) -> Vec<u8> {
    make(program, &["-f", "lavfi", "-i", &format!("testsrc=size={size}:rate=10"), "-frames:v", frames, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-f", "h264"])
}

/// Where the first picture's slice begins (its start code): what lies before is the parameter sets.
fn first_slice(stream: &[u8]) -> usize {
    (0..stream.len() - 4).find(|&i| stream[i..i + 3] == [0, 0, 1] && matches!(stream[i + 3] & 0x1f, 1 | 5)).map(|i| if i > 0 && stream[i - 1] == 0 { i - 1 } else { i }).expect("a slice")
}

#[test]
fn the_picture_comes_at_its_size_and_a_turned_phone_gives_the_new_size() {
    let Some(program) = ffmpeg() else { return };
    let (tx, rx) = channel();
    let mut decoder = VideoDecoder::new(&program, tx);
    // Before any configuration nothing is decoded and nothing breaks.
    decoder.push(&Packet::Data { keyframe: false, pts: 0, data: vec![1, 2, 3] }).unwrap();

    let upright = video(&program, "180x320", "6");
    // The stream goes in as the phone sends it: the parameter sets first, then the rest, in pieces.
    let split = first_slice(&upright);
    decoder.push(&Packet::Configuration(upright[..split].to_vec())).unwrap();
    for piece in upright[split..].chunks(900) {
        decoder.push(&Packet::Data { keyframe: false, pts: 0, data: piece.to_vec() }).unwrap();
    }
    let first = rx.recv_timeout(Duration::from_secs(10)).expect("a picture");
    assert_eq!((first.width, first.height), (180, 320));
    assert_eq!(first.rgba.len(), 180 * 320 * 4);
    assert!(first.rgba.chunks(4).any(|p| p[0] > 100 || p[1] > 100 || p[2] > 100), "it is a picture, not black");
    assert_eq!(decoder.size(), Some((180, 320)));

    // The phone is turned: the encoder starts again, wider than high.
    let turned = video(&program, "320x180", "6");
    let split = first_slice(&turned);
    decoder.push(&Packet::Configuration(turned[..split].to_vec())).unwrap();
    assert_eq!(decoder.size(), Some((320, 180)));
    for piece in turned[split..].chunks(900) {
        decoder.push(&Packet::Data { keyframe: false, pts: 0, data: piece.to_vec() }).unwrap();
    }
    let wide = loop {
        let frame = rx.recv_timeout(Duration::from_secs(10)).expect("a picture after the turn");
        if frame.width == 320 {
            break frame;
        }
    };
    assert_eq!((wide.width, wide.height), (320, 180));
    assert_eq!(wide.rgba.len(), 320 * 180 * 4);
}

/// The packets in an Ogg file, by its lacing.
fn ogg_packets(file: &[u8]) -> Vec<Vec<u8>> {
    let mut packets = Vec::new();
    let mut at = 0;
    let mut carry: Vec<u8> = Vec::new();
    while at + 27 <= file.len() && &file[at..at + 4] == b"OggS" {
        let segments = file[at + 26] as usize;
        let lacing = &file[at + 27..at + 27 + segments];
        let mut body = at + 27 + segments;
        for &len in lacing {
            carry.extend(&file[body..body + len as usize]);
            body += len as usize;
            if len < 255 {
                packets.push(std::mem::take(&mut carry));
            }
        }
        at = body;
    }
    packets
}

#[test]
fn opus_packets_become_samples() {
    let Some(program) = ffmpeg() else { return };
    let file = make(&program, &["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-c:a", "libopus", "-b:a", "64k", "-frame_duration", "20", "-f", "ogg"]);
    let packets: Vec<Vec<u8>> = ogg_packets(&file).into_iter().skip(2).collect(); // without OpusHead and OpusTags
    assert!(packets.len() >= 40, "{} packets", packets.len());
    assert_eq!(sondra_mirror::ogg::opus_packet_samples(&packets[3]), 960, "20 ms");

    let (tx, rx) = channel();
    let mut decoder = AudioDecoder::new(&program, tx).unwrap();
    for packet in &packets {
        decoder.push(packet).unwrap();
    }
    let mut blocks = Vec::new();
    while let Ok(block) = rx.recv_timeout(Duration::from_secs(3)) {
        blocks.push(block);
        if blocks.len() >= 40 {
            break;
        }
    }
    assert!(blocks.len() >= 30, "{} blocks of 20 ms", blocks.len());
    let loud = blocks.iter().flatten().fold(0f32, |m, s| m.max(s.abs()));
    assert!(loud > 0.05 && loud <= 1.0, "a tone: {loud}");
    assert_eq!(blocks[5].len(), 960 * 2);
}
