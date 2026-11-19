//! A look at the sound that is being heard, for the visualizer of a song: the spectrum and the wave as bytes,
//! the way the browser's `AnalyserNode` hands them out (`getByteFrequencyData`, `getByteTimeDomainData`):
//! 2048 frames, a Blackman window, the magnitudes smoothed with 0.8 over the readings, −100 to −30 dB
//! stretched to 0–255.

use std::sync::Mutex;

use sondra_media::fft::Fft;

/// Frames in a reading and bins in the spectrum.
pub const FFT_SIZE: usize = 2048;
pub const BINS: usize = FFT_SIZE / 2;

const SMOOTHING: f64 = 0.8;
const MIN_DB: f64 = -100.0;
const MAX_DB: f64 = -30.0;

/// What a reading says: how loud each frequency is, and how the wave looks, both as bytes (the wave around 128).
#[derive(Debug, Clone, PartialEq)]
pub struct Spectrum {
    pub frequency: Vec<u8>,
    pub wave: Vec<u8>,
}

impl Spectrum {
    /// Nothing heard: the floor of the spectrum and a wave that lies flat.
    pub fn silent() -> Spectrum {
        Spectrum { frequency: vec![0; BINS], wave: vec![128; BINS] }
    }
}

pub struct Analyser {
    fft: Fft,
    window: Vec<f64>,
    smooth: Vec<f64>,
}

impl Analyser {
    pub fn new() -> Analyser {
        let n = FFT_SIZE as f64;
        // Blackman, alpha 0.16, as the Web Audio specification has it.
        let window = (0..FFT_SIZE)
            .map(|i| {
                let x = i as f64 / n;
                0.42 - 0.5 * (2.0 * std::f64::consts::PI * x).cos() + 0.08 * (4.0 * std::f64::consts::PI * x).cos()
            })
            .collect();
        Analyser { fft: Fft::new(FFT_SIZE).expect("a power of two"), window, smooth: vec![0.0; BINS] }
    }

    /// Takes the last frames heard (the newest last; fewer than `FFT_SIZE` are put after silence) and reads them.
    pub fn read(&mut self, heard: &[f32]) -> Spectrum {
        let mut frames = vec![0.0f64; FFT_SIZE];
        let start = FFT_SIZE.saturating_sub(heard.len());
        let skip = heard.len().saturating_sub(FFT_SIZE);
        for (slot, sample) in frames[start..].iter_mut().zip(&heard[skip..]) {
            *slot = f64::from(*sample);
        }
        let wave: Vec<u8> = frames[FFT_SIZE - BINS..].iter().map(|v| (128.0 + 128.0 * v).round().clamp(0.0, 255.0) as u8).collect();
        let mut real: Vec<f64> = frames.iter().zip(&self.window).map(|(v, w)| v * w).collect();
        let mut imag = vec![0.0f64; FFT_SIZE];
        self.fft.forward(&mut real, &mut imag);
        let frequency = (0..BINS)
            .map(|k| {
                let magnitude = (real[k] * real[k] + imag[k] * imag[k]).sqrt() / FFT_SIZE as f64;
                self.smooth[k] = SMOOTHING * self.smooth[k] + (1.0 - SMOOTHING) * magnitude;
                let db = if self.smooth[k] > 0.0 { 20.0 * self.smooth[k].log10() } else { MIN_DB };
                (255.0 * (db - MIN_DB) / (MAX_DB - MIN_DB)).round().clamp(0.0, 255.0) as u8
            })
            .collect();
        Spectrum { frequency, wave }
    }

    /// Starts the smoothing over (another title, or a jump).
    pub fn reset(&mut self) {
        self.smooth.fill(0.0);
    }
}

impl Default for Analyser {
    fn default() -> Self {
        Analyser::new()
    }
}

/// The analyser behind a lock, so a window that only holds a shared reference can ask for a reading.
pub struct Reader(Mutex<Analyser>);

impl Reader {
    pub fn new() -> Reader {
        Reader(Mutex::new(Analyser::new()))
    }
    pub fn read(&self, heard: &[f32]) -> Spectrum {
        self.0.lock().expect("lock").read(heard)
    }
    pub fn reset(&self) {
        self.0.lock().expect("lock").reset();
    }
}

impl Default for Reader {
    fn default() -> Self {
        Reader::new()
    }
}
