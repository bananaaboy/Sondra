//! The audio the tools hold: planar float channels, and the small operations everything shares.

/// One vector per channel, each `length` frames long.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioData {
    pub channels: Vec<Vec<f32>>,
    pub sample_rate: u32,
}

impl AudioData {
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / f64::from(self.sample_rate)
    }
}

/// Sums every channel down to one, at equal weight (`mixToMono` in `src/lib/wav.ts`; the division is
/// done per sample, in the order of the channels, as there).
pub fn mix_to_mono(audio: &AudioData) -> Vec<f32> {
    if audio.channels.len() == 1 {
        return audio.channels[0].clone();
    }
    let frames = audio.frames();
    let n = audio.channels.len() as f32;
    let mut mono = vec![0.0f32; frames];
    for channel in &audio.channels {
        for i in 0..frames {
            mono[i] += channel[i] / n;
        }
    }
    mono
}

/// Reads a sound file into planar floats, at its own rate and channels (or at `rate`), through FFmpeg:
/// the whole file at once, as the tools that measure or change a sound need it.
pub fn decode_file(ffmpeg: &crate::ffmpeg::Ffmpeg, path: &std::path::Path, rate: Option<u32>) -> Result<AudioData, crate::ffmpeg::MediaError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let probe = ffmpeg.probe(path)?;
    let stream = probe.streams.iter().find(|s| s.kind == "audio").ok_or_else(|| crate::ffmpeg::MediaError::Failed { code: None, tail: "Die Datei hat keine Tonspur.".into() })?;
    let channels = stream.channels.unwrap_or(2).clamp(1, 8) as usize;
    let sample_rate = rate.or(stream.sample_rate).unwrap_or(44_100);
    let mut child = Command::new(ffmpeg.program())
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args(["-map", &format!("0:{}", stream.index), "-vn", "-sn", "-f", "f32le", "-ac", &channels.to_string(), "-ar", &sample_rate.to_string(), "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| crate::ffmpeg::MediaError::Io(e.to_string()))?;
    let mut bytes = Vec::new();
    child.stdout.take().expect("a pipe").read_to_end(&mut bytes).map_err(|e| crate::ffmpeg::MediaError::Io(e.to_string()))?;
    let status = child.wait().map_err(|e| crate::ffmpeg::MediaError::Io(e.to_string()))?;
    if !status.success() || bytes.len() < 4 * channels {
        return Err(crate::ffmpeg::MediaError::Failed { code: status.code(), tail: "Der Ton liess sich nicht lesen.".into() });
    }
    let frames = bytes.len() / (4 * channels);
    let mut planar = vec![Vec::with_capacity(frames); channels];
    for frame in bytes.chunks_exact(4 * channels).take(frames) {
        for (c, sample) in frame.chunks_exact(4).enumerate() {
            planar[c].push(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]));
        }
    }
    Ok(AudioData { channels: planar, sample_rate })
}

/// A WAV file of 32-bit floats: what the tools hand to FFmpeg to encode in whatever format was asked.
pub fn write_wav_f32(path: &std::path::Path, audio: &AudioData) -> std::io::Result<()> {
    use std::io::Write;
    let channels = audio.channels.len() as u16;
    let frames = audio.frames() as u32;
    let data_len = frames * u32::from(channels) * 4;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_len).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&3u16.to_le_bytes())?; // IEEE float
    out.write_all(&channels.to_le_bytes())?;
    out.write_all(&audio.sample_rate.to_le_bytes())?;
    out.write_all(&(audio.sample_rate * u32::from(channels) * 4).to_le_bytes())?;
    out.write_all(&(channels * 4).to_le_bytes())?;
    out.write_all(&32u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data_len.to_le_bytes())?;
    for i in 0..audio.frames() {
        for c in &audio.channels {
            out.write_all(&c[i].to_le_bytes())?;
        }
    }
    out.flush()
}
