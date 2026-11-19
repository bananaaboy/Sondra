//! Just enough of H.264 to know how big the picture is: the sequence parameter set (SPS) says, and a new one
//! comes when the phone turns (the encoder starts again at the new size). The stream is in Annex B: NAL units
//! behind start codes.

/// The NAL units in a piece of an Annex B stream (without their start codes).
pub fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (n, start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(data.len(), |next| next - 3);
        // A four-byte start code leaves a zero at the end of the unit before it.
        while end > *start && data[end - 1] == 0 {
            end -= 1;
        }
        out.push(&data[*start..end]);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.at / 8)?;
        let bit = (byte >> (7 - self.at % 8)) & 1;
        self.at += 1;
        Some(u32::from(bit))
    }
    fn bits(&mut self, n: u32) -> Option<u32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Some(v)
    }
    /// An unsigned Exp-Golomb code.
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
    /// A signed one.
    fn se(&mut self) -> Option<i32> {
        let k = self.ue()?;
        Some(if k % 2 == 1 { k.div_ceil(2) as i32 } else { -((k / 2) as i32) })
    }
}

/// The RBSP of a NAL unit: what is left when the emulation-prevention bytes (`00 00 03`) are taken out.
fn rbsp(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

fn skip_scaling_list(bits: &mut Bits, size: usize) -> Option<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            next = (last + bits.se()? + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Some(())
}

/// The size of the picture a sequence parameter set (a NAL unit of type 7, header byte first) describes.
pub fn sps_size(nal: &[u8]) -> Option<(u32, u32)> {
    if nal.first().map(|b| b & 0x1f) != Some(7) {
        return None;
    }
    let data = rbsp(&nal[1..]);
    let mut bits = Bits { data: &data, at: 0 };
    let profile = bits.bits(8)?;
    bits.bits(16)?; // constraint flags and the level
    bits.ue()?; // sps id
    let mut chroma = 1;
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
        chroma = bits.ue()?;
        if chroma == 3 {
            bits.bit()?;
        }
        bits.ue()?;
        bits.ue()?;
        bits.bit()?;
        if bits.bit()? == 1 {
            for list in 0..(if chroma != 3 { 8 } else { 12 }) {
                if bits.bit()? == 1 {
                    skip_scaling_list(&mut bits, if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    bits.ue()?; // log2_max_frame_num
    match bits.ue()? {
        0 => {
            bits.ue()?;
        }
        1 => {
            bits.bit()?;
            bits.se()?;
            bits.se()?;
            for _ in 0..bits.ue()? {
                bits.se()?;
            }
        }
        _ => {}
    }
    bits.ue()?; // max_num_ref_frames
    bits.bit()?; // gaps in frame_num
    let width_mbs = bits.ue()? + 1;
    let height_units = bits.ue()? + 1;
    let frame_mbs_only = bits.bit()?;
    if frame_mbs_only == 0 {
        bits.bit()?;
    }
    bits.bit()?; // direct_8x8_inference
    let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
    if bits.bit()? == 1 {
        left = bits.ue()?;
        right = bits.ue()?;
        top = bits.ue()?;
        bottom = bits.ue()?;
    }
    let field = 2 - frame_mbs_only;
    let (unit_x, unit_y) = match chroma {
        0 | 3 => (1, field),
        _ => (2, 2 * field),
    };
    let unit_y = if chroma == 2 { field } else { unit_y };
    let width = width_mbs * 16 - unit_x * (left + right);
    let height = field * height_units * 16 - unit_y * (top + bottom);
    Some((width, height))
}

/// The size a stretch of the stream announces: the picture size of the last sequence parameter set in it.
pub fn announced_size(data: &[u8]) -> Option<(u32, u32)> {
    nal_units(data).into_iter().filter_map(sps_size).last()
}
