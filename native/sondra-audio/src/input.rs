//! Sound in: a microphone, as one stream of mono samples and a level to watch. The tools that listen —
//! the microphone check, later the recorder — need nothing else of it.
//!
//! Like [`crate::AudioOut`], the stream belongs to the thread that opened it: keep a [`Mic`] where it was
//! made. Where there is no input device, opening says so with [`AudioError::NoDevice`].

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::AudioError;

/// What a tool needs of a microphone; a test brings its own.
pub trait Capture {
    /// The name the person knows it by.
    fn name(&self) -> String;
    fn rate(&self) -> u32;
    /// The peak of the sound since the last look, 0 to 1.
    fn level(&mut self) -> f32;
    /// Everything captured since the last call (or since opening), mono.
    fn take(&mut self) -> Vec<f32>;
}

/// The names of the input devices, the system's default first.
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.description().ok()).map(|d| d.name().to_owned());
    let mut names: Vec<String> = host.input_devices().map(|list| list.filter_map(|d| d.description().ok().map(|d| d.name().to_owned())).collect()).unwrap_or_default();
    names.dedup();
    if let Some(default) = default {
        if let Some(at) = names.iter().position(|n| *n == default) {
            names.swap(0, at);
        }
    }
    names
}

pub struct Mic {
    name: String,
    rate: u32,
    level: Arc<AtomicU32>,
    buffer: Arc<Mutex<Vec<f32>>>,
    _stream: cpal::Stream,
}

/// Opens the named device, or the default, and starts capturing at once.
pub fn open_input(name: Option<&str>) -> Result<Mic, AudioError> {
    let host = cpal::default_host();
    let device = match name {
        Some(wanted) => host.input_devices().ok().and_then(|mut list| list.find(|d| d.description().ok().is_some_and(|d| d.name() == wanted))),
        None => host.default_input_device(),
    }
    .ok_or(AudioError::NoDevice)?;
    let shown = device.description().map(|d| d.name().to_owned()).unwrap_or_default();
    let config = device.default_input_config().map_err(|e| AudioError::Open(e.to_string()))?;
    let (rate, channels) = (config.sample_rate(), config.channels() as usize);
    let level = Arc::new(AtomicU32::new(0));
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::default();
    let (l, b) = (level.clone(), buffer.clone());
    let push = move |mono: Vec<f32>| {
        let peak = mono.iter().fold(0f32, |p, v| p.max(v.abs()));
        // The loudest since the last look: a short click must not be missed between two looks.
        let _ = l.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |old| Some(f32::from_bits(old).max(peak).to_bits()));
        b.lock().unwrap().extend(mono);
    };
    let stream_config: cpal::StreamConfig = config.clone().into();
    let fail = |e| eprintln!("Mikrofon: {e}");
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(stream_config, move |data: &[f32], _| push(mono_of(data.iter().copied(), channels)), fail, None),
        cpal::SampleFormat::I16 => device.build_input_stream(stream_config, move |data: &[i16], _| push(mono_of(data.iter().map(|v| f32::from(*v) / 32768.0), channels)), fail, None),
        other => return Err(AudioError::Open(format!("Das Format {other:?} wird noch nicht aufgenommen."))),
    }
    .map_err(|e| AudioError::Open(e.to_string()))?;
    stream.play().map_err(|e| AudioError::Open(e.to_string()))?;
    Ok(Mic { name: shown, rate, level, buffer, _stream: stream })
}

/// The channels of each frame averaged into one.
fn mono_of(samples: impl Iterator<Item = f32>, channels: usize) -> Vec<f32> {
    let all: Vec<f32> = samples.collect();
    if channels <= 1 {
        return all;
    }
    all.chunks(channels).map(|frame| frame.iter().sum::<f32>() / frame.len() as f32).collect()
}

impl Capture for Mic {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn rate(&self) -> u32 {
        self.rate
    }
    fn level(&mut self) -> f32 {
        f32::from_bits(self.level.swap(0, Ordering::Relaxed))
    }
    fn take(&mut self) -> Vec<f32> {
        std::mem::take(&mut *self.buffer.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::mono_of;

    #[test]
    fn channels_are_averaged_frame_by_frame() {
        assert_eq!(mono_of([0.5f32, 1.0, -1.0, 1.0].into_iter(), 2), [0.75, 0.0]);
        assert_eq!(mono_of([0.5f32, 0.25].into_iter(), 1), [0.5, 0.25]);
    }
}
