//! The default output device, with a [`Mixer`] on it.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::mixer::{Mixer, Shared};

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    /// No sound card: the player keeps its own time.
    #[error("Auf diesem Gerät gibt es keinen Ton-Ausgang.")]
    NoDevice,
    #[error("Der Ton-Ausgang liess sich nicht öffnen: {0}")]
    Open(String),
}

/// A stream to the default output device. Dropping it stops the sound.
pub struct AudioOut {
    shared: Shared,
    _stream: cpal::Stream,
}

impl AudioOut {
    /// Opens the default device at its own rate and channel count (the decoder is told to produce that, so
    /// nothing is resampled twice), with room for about `seconds` of sound in the queue.
    pub fn open(seconds: f32) -> Result<AudioOut, AudioError> {
        let host = cpal::default_host();
        let device = host.default_output_device().ok_or(AudioError::NoDevice)?;
        let config = device.default_output_config().map_err(|e| AudioError::Open(e.to_string()))?;
        let shared = Shared::new(config.sample_rate(), config.channels() as usize, seconds);
        let mut mixer = Mixer::new(shared.clone());
        let stream_config: cpal::StreamConfig = config.clone().into();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                stream_config,
                move |out: &mut [f32], _| {
                    mixer.fill(out);
                },
                |e| eprintln!("Ton: {e}"),
                None,
            ),
            other => return Err(AudioError::Open(format!("Das Format {other:?} wird noch nicht gespielt."))),
        }
        .map_err(|e| AudioError::Open(e.to_string()))?;
        stream.play().map_err(|e| AudioError::Open(e.to_string()))?;
        Ok(AudioOut { shared, _stream: stream })
    }

    /// The queue to put decoded samples in, and the clock to read.
    pub fn shared(&self) -> Shared {
        self.shared.clone()
    }
}
