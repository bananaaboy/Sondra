//! The pictures that travel inside a shared list (`src/lib/shareCover.ts`): each cover as a small picture
//! of its own — nothing is fetched from anywhere when the list is opened. What comes out of a link is
//! believed only as far as it is a picture of a known kind and of limited size.
//!
//! The first byte says what it is: `0` six by nine pixels with brightness and colour packed into 33
//! bytes („winzig“; drawn larger and smooth it is a blur of the poster's colours), `1` a WebP, `2` a JPEG.

/// What one picture may weigh, kind byte included: more is not a thumbnail.
pub const THUMB_MAX: usize = 24 * 1024;

pub const KIND_RAW: u8 = 0;
pub const KIND_WEBP: u8 = 1;
pub const KIND_JPEG: u8 = 2;

pub const RAW_W: usize = 6;
pub const RAW_H: usize = 9;
/// Colour is kept for squares of 3 × 3 pixels: the eye takes brightness from the detail and colour from
/// the blur.
const CELL: usize = 3;
const CELLS: usize = (RAW_W / CELL) * (RAW_H / CELL);
/// One kind byte and 4·54 + 4·2·6 = 264 bits.
pub const RAW_BYTES: usize = 1 + (RAW_W * RAW_H * 4 + CELLS * 2 * 4).div_ceil(8);

/// Height over width of a tile: a film poster (2:3) or a manga volume (5:7).
pub fn aspect(manga: bool) -> f64 {
    if manga {
        1.4
    } else {
        1.5
    }
}

/// Whether a picture of this kind is what it says it is — by its first bytes, not by trust.
pub fn valid_thumb(blob: &[u8]) -> bool {
    if blob.len() < 2 || blob.len() > THUMB_MAX {
        return false;
    }
    let body = &blob[1..];
    match blob[0] {
        KIND_RAW => blob.len() == RAW_BYTES,
        KIND_WEBP => body.len() > 12 && body.starts_with(b"RIFF") && body[8..].starts_with(b"WEBP"),
        KIND_JPEG => body.len() > 4 && body.starts_with(&[0xff, 0xd8, 0xff]),
        _ => false,
    }
}

struct Bits {
    bytes: Vec<u8>,
    used: usize,
}

impl Bits {
    fn write(&mut self, value: u32, count: usize) {
        for bit in (0..count).rev() {
            if self.used % 8 == 0 {
                self.bytes.push(0);
            }
            if (value >> bit) & 1 == 1 {
                let last = self.bytes.len() - 1;
                self.bytes[last] |= 0x80 >> (self.used % 8);
            }
            self.used += 1;
        }
    }
}

/// `Math.round`: halves go up.
fn round(f: f64) -> i64 {
    (f + 0.5).floor() as i64
}

/// The six by nine pixels (RGBA, row by row) as the 34 bytes that travel: 4 bits of brightness a pixel, and
/// 4 bits of each colour difference for every 3 × 3 square.
pub fn pack_raw(rgba: &[u8]) -> Option<Vec<u8>> {
    if rgba.len() != RAW_W * RAW_H * 4 {
        return None;
    }
    let mut bits = Bits {
        bytes: Vec::new(),
        used: 0,
    };
    let mut chroma = [(0.0f64, 0.0f64); CELLS];
    for row in 0..RAW_H {
        for col in 0..RAW_W {
            let at = (row * RAW_W + col) * 4;
            let (r, g, b) = (
                f64::from(rgba[at]),
                f64::from(rgba[at + 1]),
                f64::from(rgba[at + 2]),
            );
            bits.write(
                round(((0.299 * r + 0.587 * g + 0.114 * b) / 255.0) * 15.0) as u32,
                4,
            );
            let cell = &mut chroma[(row / CELL) * (RAW_W / CELL) + col / CELL];
            let n = (CELL * CELL) as f64;
            cell.0 += (128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b) / n;
            cell.1 += (128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b) / n;
        }
    }
    for cell in &chroma {
        bits.write(round((cell.0 / 255.0) * 15.0).clamp(0, 15) as u32, 4);
    }
    for cell in &chroma {
        bits.write(round((cell.1 / 255.0) * 15.0).clamp(0, 15) as u32, 4);
    }
    let mut out = vec![KIND_RAW];
    out.extend(bits.bytes);
    Some(out)
}

/// The 34 bytes back to six by nine pixels (RGBA).
pub fn unpack_raw(body: &[u8]) -> Option<Vec<u8>> {
    if body.len() != RAW_BYTES - 1 {
        return None;
    }
    let mut at = 0usize;
    let mut read = |count: usize| -> u32 {
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | u32::from((body[at >> 3] >> (7 - (at & 7))) & 1);
            at += 1;
        }
        value
    };
    let luma: Vec<f64> = (0..RAW_W * RAW_H)
        .map(|_| f64::from(read(4)) / 15.0 * 255.0)
        .collect();
    let cb: Vec<f64> = (0..CELLS)
        .map(|_| f64::from(read(4)) / 15.0 * 255.0)
        .collect();
    let cr: Vec<f64> = (0..CELLS)
        .map(|_| f64::from(read(4)) / 15.0 * 255.0)
        .collect();
    let clamp = |v: f64| round(v).clamp(0, 255) as u8;
    let mut out = Vec::with_capacity(RAW_W * RAW_H * 4);
    for row in 0..RAW_H {
        for col in 0..RAW_W {
            let y = luma[row * RAW_W + col];
            let cell = (row / CELL) * (RAW_W / CELL) + col / CELL;
            let (u, v) = (cb[cell] - 128.0, cr[cell] - 128.0);
            out.extend([
                clamp(y + 1.402 * v),
                clamp(y - 0.344136 * u - 0.714136 * v),
                clamp(y + 1.772 * u),
                255,
            ]);
        }
    }
    Some(out)
}
