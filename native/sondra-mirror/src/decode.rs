//! Turning what the phone sends into pictures and sound: FFmpeg, as a child program that reads the bare H.264
//! (or Opus in Ogg) on its input and writes raw pixels (or float samples) on its output. A new picture size
//! — the phone was turned — starts it again at that size.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;

use crate::h264::announced_size;
use crate::ogg::OggOpusWriter;
use crate::stream::Packet;

/// One picture of the phone's screen, as 8-bit RGBA.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

fn quiet(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]).stderr(Stdio::null());
    command
}

pub struct VideoDecoder {
    program: PathBuf,
    child: Option<(Child, ChildStdin)>,
    size: Option<(u32, u32)>,
    frames: Sender<Frame>,
}

impl VideoDecoder {
    pub fn new(ffmpeg: &Path, frames: Sender<Frame>) -> VideoDecoder {
        VideoDecoder { program: ffmpeg.to_path_buf(), child: None, size: None, frames }
    }

    /// The size of the picture now being decoded.
    pub fn size(&self) -> Option<(u32, u32)> {
        self.size
    }

    fn start(&mut self, size: (u32, u32)) -> std::io::Result<()> {
        self.stop();
        let mut child = quiet(&self.program)
            // Low delay: nothing is held back to see more of the stream. (Not `-fflags nobuffer`: with the raw
            // H.264 reader it holds every picture back until the stream ends.)
            .args(["-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0", "-thread_type", "slice", "-threads", "4"])
            .args(["-f", "h264", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let frames = self.frames.clone();
        let len = size.0 as usize * size.1 as usize * 4;
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; len];
            while stdout.read_exact(&mut buffer).is_ok() {
                if frames.send(Frame { width: size.0, height: size.1, rgba: buffer.clone() }).is_err() {
                    break;
                }
            }
        });
        self.child = Some((child, stdin));
        self.size = Some(size);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some((mut child, stdin)) = self.child.take() {
            drop(stdin);
            let _ = child.kill();
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }

    /// Feeds one packet. A configuration that announces another size starts the decoder anew at it.
    pub fn push(&mut self, packet: &Packet) -> std::io::Result<()> {
        let data = match packet {
            Packet::Configuration(data) => {
                if let Some(size) = announced_size(data) {
                    if self.size != Some(size) || self.child.is_none() {
                        self.start(size)?;
                    }
                }
                data
            }
            Packet::Data { data, .. } => data,
        };
        match &mut self.child {
            Some((_, stdin)) => stdin.write_all(data),
            // Before the first configuration there is nothing to decode with.
            None => Ok(()),
        }
    }
}

impl Drop for VideoDecoder {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Opus packets in, 48 kHz stereo float samples out.
pub struct AudioDecoder {
    child: Child,
    stdin: ChildStdin,
    ogg: OggOpusWriter,
}

impl AudioDecoder {
    pub fn new(ffmpeg: &Path, samples: Sender<Vec<f32>>) -> std::io::Result<AudioDecoder> {
        let mut child = quiet(ffmpeg)
            .args(["-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32", "-analyzeduration", "0"])
            .args(["-f", "ogg", "-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().expect("piped");
        let mut stdout = child.stdout.take().expect("piped");
        let mut ogg = OggOpusWriter::new();
        stdin.write_all(&ogg.header())?;
        std::thread::spawn(move || {
            // 20 ms of stereo at 48 kHz is 960 × 2 samples of 4 bytes.
            let mut buffer = vec![0u8; 960 * 2 * 4];
            while stdout.read_exact(&mut buffer).is_ok() {
                let block: Vec<f32> = buffer.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
                if samples.send(block).is_err() {
                    break;
                }
            }
        });
        Ok(AudioDecoder { child, stdin, ogg })
    }

    pub fn push(&mut self, packet: &[u8]) -> std::io::Result<()> {
        let page = self.ogg.packet(packet);
        self.stdin.write_all(&page)
    }
}

impl Drop for AudioDecoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
