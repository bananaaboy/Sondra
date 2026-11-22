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

/// The output the person chose (headphones, say); `None` is the system's default. Every output opened after
/// it is set goes there — the Mikrofon page sets it, and the before-and-after then plays where the person
/// listens.
static CHOSEN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn set_output_device(name: Option<String>) {
    *CHOSEN.lock().unwrap_or_else(|e| e.into_inner()) = name;
}

pub fn chosen_output_device() -> Option<String> {
    CHOSEN.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The names of the output devices, the system's default first.
pub fn output_devices() -> Vec<String> {
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.description().ok()).map(|d| d.name().to_owned());
    let mut names: Vec<String> = host.output_devices().map(|list| list.filter_map(|d| d.description().ok().map(|d| d.name().to_owned())).collect()).unwrap_or_default();
    names.dedup();
    if let Some(default) = default {
        if let Some(at) = names.iter().position(|n| *n == default) {
            names.swap(0, at);
        }
    }
    names
}

/// A stream to the chosen (else the default) output device. Dropping it stops the sound.
pub struct AudioOut {
    shared: Shared,
    _stream: cpal::Stream,
}

impl AudioOut {
    /// Opens the default device at its own rate and channel count (the decoder is told to produce that, so
    /// nothing is resampled twice), with room for about `seconds` of sound in the queue.
    pub fn open(seconds: f32) -> Result<AudioOut, AudioError> {
        let host = cpal::default_host();
        // A chosen device that is gone (unplugged headphones) falls back to the default.
        let chosen = chosen_output_device().and_then(|wanted| host.output_devices().ok().and_then(|mut list| list.find(|d| d.description().ok().is_some_and(|d| d.name() == wanted))));
        let device = chosen.or_else(|| host.default_output_device()).ok_or(AudioError::NoDevice)?;
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

/// An output that plays to nobody, at the speed of a real one: a thread takes the sound the way a sound
/// card would and drops it. A film on a machine without a sound card still has its clock, and the picture
/// still waits for it.
pub struct SilentOut {
    shared: Shared,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl SilentOut {
    pub fn new(rate: u32, channels: usize, seconds: f32) -> SilentOut {
        let shared = Shared::new(rate, channels, seconds);
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (mut mixer, flag, channels) = (Mixer::new(shared.clone()), stop.clone(), channels.max(1));
        std::thread::spawn(move || {
            let mut last = std::time::Instant::now();
            let mut owed = 0.0f64;
            let mut buffer = Vec::new();
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(5));
                let now = std::time::Instant::now();
                owed += now.duration_since(last).as_secs_f64() * rate as f64;
                last = now;
                let frames = owed.floor() as usize;
                owed -= frames as f64;
                buffer.resize(frames * channels, 0.0);
                mixer.fill(&mut buffer);
            }
        });
        SilentOut { shared, stop }
    }

    pub fn shared(&self) -> Shared {
        self.shared.clone()
    }
}

impl Drop for SilentOut {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// A sound card when there is one, else the silent stand-in; and which it was.
pub enum Output {
    Device(AudioOut),
    Silent(SilentOut),
}

impl Output {
    pub fn open(seconds: f32) -> Output {
        match AudioOut::open(seconds) {
            Ok(out) => Output::Device(out),
            Err(_) => Output::Silent(SilentOut::new(48_000, 2, seconds)),
        }
    }

    pub fn shared(&self) -> Shared {
        match self {
            Output::Device(d) => d.shared(),
            Output::Silent(s) => s.shared(),
        }
    }

    /// Whether anyone can hear it.
    pub fn is_audible(&self) -> bool {
        matches!(self, Output::Device(_))
    }
}
