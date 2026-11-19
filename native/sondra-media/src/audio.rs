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
