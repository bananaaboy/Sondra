//! Opus packets from the phone are bare; FFmpeg wants a container to decode them. The simplest is Ogg: a page
//! with the `OpusHead`, one with the `OpusTags`, and every packet in a page of its own.

use std::io::Write;

fn crc(data: &[u8]) -> u32 {
    // Ogg's CRC-32: polynomial 0x04c11db7, no reflection, no final xor.
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut r = (i as u32) << 24;
        for _ in 0..8 {
            r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04c1_1db7 } else { r << 1 };
        }
        *slot = r;
    }
    data.iter().fold(0u32, |c, b| (c << 8) ^ table[(((c >> 24) as u8) ^ b) as usize])
}

/// How many samples at 48 kHz an Opus packet carries, from its first byte (and, for a count of its own, its
/// second). Zero for a packet that says nothing.
pub fn opus_packet_samples(packet: &[u8]) -> u64 {
    let Some(&toc) = packet.first() else { return 0 };
    let config = toc >> 3;
    // The length of one frame in units of 2.5 ms… doubled so half-milliseconds stay whole: in samples at 48 kHz.
    let frame: u64 = match config {
        0..=11 => [480, 960, 1920, 2880][usize::from(config % 4)],
        12..=15 => [480, 960][usize::from(config % 2)],
        _ => [120, 240, 480, 960][usize::from(config % 4)],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u64::from(packet.get(1).map_or(0, |b| b & 0x3f)),
    };
    frame * frames
}

/// A stream of Ogg pages for one logical Opus stream.
pub struct OggOpusWriter {
    serial: u32,
    sequence: u32,
    granule: u64,
}

impl OggOpusWriter {
    pub fn new() -> OggOpusWriter {
        OggOpusWriter { serial: 0x534f_4e44, sequence: 0, granule: 0 }
    }

    fn page(&mut self, flags: u8, granule: u64, packet: &[u8]) -> Vec<u8> {
        // A packet of 255 bytes or more is spread over segments of 255 and a rest.
        let mut lacing = Vec::new();
        let mut left = packet.len();
        loop {
            if left >= 255 {
                lacing.push(255u8);
                left -= 255;
            } else {
                lacing.push(left as u8);
                break;
            }
        }
        let mut page = b"OggS".to_vec();
        page.push(0);
        page.push(flags);
        page.extend(granule.to_le_bytes());
        page.extend(self.serial.to_le_bytes());
        page.extend(self.sequence.to_le_bytes());
        page.extend(0u32.to_le_bytes()); // the checksum, filled in below
        page.push(lacing.len() as u8);
        page.extend(&lacing);
        page.extend(packet);
        let sum = crc(&page);
        page[22..26].copy_from_slice(&sum.to_le_bytes());
        self.sequence += 1;
        page
    }

    /// The two pages at the start: `OpusHead` (stereo, 48 kHz) and `OpusTags`.
    pub fn header(&mut self) -> Vec<u8> {
        let mut head = b"OpusHead".to_vec();
        head.extend([1, 2]); // version, channels
        head.extend(0u16.to_le_bytes()); // pre-skip
        head.extend(48_000u32.to_le_bytes());
        head.extend(0u16.to_le_bytes()); // gain
        head.push(0); // channel mapping family
        let mut out = self.page(0x02, 0, &head);
        let mut tags = b"OpusTags".to_vec();
        tags.extend(6u32.to_le_bytes());
        tags.extend(b"Sondra");
        tags.extend(0u32.to_le_bytes());
        out.extend(self.page(0, 0, &tags));
        out
    }

    /// A page with one packet.
    pub fn packet(&mut self, packet: &[u8]) -> Vec<u8> {
        self.granule += opus_packet_samples(packet);
        let granule = self.granule;
        self.page(0, granule, packet)
    }
}

impl Default for OggOpusWriter {
    fn default() -> Self {
        Self::new()
    }
}

/// For the tests: writes pages to anything.
pub fn write_all(out: &mut dyn Write, bytes: &[u8]) -> std::io::Result<()> {
    out.write_all(bytes)
}
