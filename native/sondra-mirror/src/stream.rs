//! Reading what the scrcpy server sends: the video stream (device name, codec and size, then packets), the
//! audio stream (a codec marker, then packets) and the packets themselves (`createMediaStreamTransformer` and
//! the parsers of the web app's library).

/// The H.264 codec id in the video stream's head („h264“).
pub const CODEC_H264: u32 = 0x6832_3634;

/// The codec markers of the audio stream: `disabled` and `errored` are sent even when no codec is.
pub const AUDIO_DISABLED: u32 = 0;
pub const AUDIO_ERRORED: u32 = 1;
pub const AUDIO_OPUS: u32 = 0x6f70_7573;

/// A packet of the media streams: 12 bytes (a time and flags, the size), then the data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Packet {
    /// The codec's setup (SPS/PPS for H.264): sent first, and again when it changes.
    Configuration(Vec<u8>),
    Data { keyframe: bool, pts: u64, data: Vec<u8> },
}

const PTS_CONFIG: u64 = 1 << 63;
const PTS_KEYFRAME: u64 = 1 << 62;

/// A packet is never this big: a size that is, is a stream out of step.
const PACKET_MAX: usize = 32 * 1024 * 1024;

/// The head of the video stream: the phone's name, the codec and the size of the picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoHead {
    pub device_name: String,
    pub codec: u32,
    pub width: u32,
    pub height: u32,
}

/// How long the head of the video stream is: 64 bytes of name, then three numbers.
pub const VIDEO_HEAD_LEN: usize = 64 + 12;

pub fn parse_video_head(bytes: &[u8]) -> Option<VideoHead> {
    if bytes.len() < VIDEO_HEAD_LEN {
        return None;
    }
    let name = &bytes[..64];
    let end = name.iter().position(|b| *b == 0).unwrap_or(64);
    let number = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some(VideoHead { device_name: String::from_utf8_lossy(&name[..end]).into_owned(), codec: number(64), width: number(68), height: number(72) })
}

/// Puts bytes together into packets as they come, in pieces of any size.
#[derive(Debug, Default)]
pub struct PacketReader {
    buffer: Vec<u8>,
}

impl PacketReader {
    pub fn new() -> PacketReader {
        PacketReader::default()
    }

    /// Takes more bytes and returns the packets that are whole now. A size that cannot be right ends the
    /// stream: `Err`, and nothing more is read.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Packet>, StreamOutOfStep> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if self.buffer.len() < 12 {
                break;
            }
            let pts = u64::from_be_bytes(self.buffer[..8].try_into().expect("8 bytes"));
            let size = u32::from_be_bytes(self.buffer[8..12].try_into().expect("4 bytes")) as usize;
            if size > PACKET_MAX {
                self.buffer.clear();
                return Err(StreamOutOfStep);
            }
            if self.buffer.len() < 12 + size {
                break;
            }
            let data = self.buffer[12..12 + size].to_vec();
            self.buffer.drain(..12 + size);
            out.push(if pts & PTS_CONFIG != 0 {
                Packet::Configuration(data)
            } else {
                Packet::Data { keyframe: pts & PTS_KEYFRAME != 0, pts: pts & !PTS_KEYFRAME, data }
            });
        }
        Ok(out)
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Der Strom des Handys ist aus dem Takt geraten.")]
pub struct StreamOutOfStep;
