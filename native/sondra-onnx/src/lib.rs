//! Neural stem separation with a model the person points at — `src/lib/onnx.ts` of the website, strategy for strategy.
//! Sondra ships no weights: a Demucs or Spleeter export is tens to hundreds of megabytes. The runner adapts to the
//! model: it reads the input and output rank from the model and feeds it as a waveform (rank 3, `[batch, channels,
//! samples]`, overlapped Hann windows) or as spectrogram magnitudes (rank 4, `[batch, channels, bins, frames]`, masks
//! out, the phase of the original kept). Everything runs on this computer.

use ort::session::Session;
use ort::value::{Tensor, ValueType};
use sondra_media::audio::AudioData;
use sondra_media::fft::{apply_mask, istft, magnitude_of, stft};
use sondra_media::separation::STEM_IDS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// `[batch, channels, samples]` in, `[batch, stems, channels, samples]` out.
    Waveform,
    /// `[batch, channels, bins, frames]` magnitudes in, `[batch, stems, channels, bins, frames]` masks out.
    SpectrogramMask,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub input_name: String,
    pub output_name: String,
    /// `-1` for an axis the model leaves open.
    pub input_shape: Vec<i64>,
    pub output_shape: Vec<i64>,
    pub strategy: Strategy,
    /// The stems the output carries, read from its shape (1 to 8), else four.
    pub stem_count: usize,
}

impl ModelInfo {
    /// What the page says about a loaded model, in a line.
    pub fn describe(&self) -> String {
        let how = match self.strategy {
            Strategy::Waveform => "Wellenform",
            Strategy::SpectrogramMask => "Spektrogramm-Masken",
        };
        format!("{how}, {} Stimmen", self.stem_count.min(STEM_IDS.len()))
    }
}

pub struct Model {
    session: Session,
    pub info: ModelInfo,
}

/// The runtime allows one environment in a process; it is made once, when the first model is opened.
fn environment() -> Result<&'static ort::environment::Environment, String> {
    static ENV: std::sync::OnceLock<Result<ort::environment::Environment, String>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| ort::init().build().map_err(|e| format!("Die ONNX-Laufzeit ließ sich nicht starten: {e}"))).as_ref().map_err(Clone::clone)
}

fn tensor_shape(ty: &ValueType) -> Vec<i64> {
    match ty {
        ValueType::Tensor { shape, .. } => shape.iter().copied().collect(),
        _ => Vec::new(),
    }
}

impl Model {
    /// Opens a model file. The strategy follows from the input: rank 4 and more is a mask model, else a waveform model.
    pub fn open(path: &std::path::Path) -> Result<Model, String> {
        let env = environment()?;
        let session = Session::builder(env)
            .and_then(|mut b| b.commit_from_file(path))
            .map_err(|e| format!("Das Modell ließ sich nicht laden: {e}"))?;
        let (input, output) = (session.inputs().first().ok_or("Das Modell hat keinen Eingang.")?, session.outputs().first().ok_or("Das Modell hat keinen Ausgang.")?);
        let (input_shape, output_shape) = (tensor_shape(input.dtype()), tensor_shape(output.dtype()));
        let strategy = if input_shape.len() >= 4 { Strategy::SpectrogramMask } else { Strategy::Waveform };
        // Stems live in the second axis of the output.
        let stem_count = output_shape.get(1).copied().filter(|d| (1..=8).contains(d)).map_or(4, |d| d as usize);
        let info = ModelInfo { input_name: input.name().to_string(), output_name: output.name().to_string(), input_shape, output_shape, strategy, stem_count };
        Ok(Model { session, info })
    }

    /// Splits `audio` into the stems of the model, in the order of `STEM_IDS` (Gesang, Schlagzeug, Bass, Übriges); a model
    /// with fewer stems leaves the rest silent. `progress` hears the fraction done and a note.
    pub fn separate(&mut self, audio: &AudioData, progress: &mut dyn FnMut(f64, &str)) -> Result<[AudioData; 4], String> {
        match self.info.strategy {
            Strategy::Waveform => self.waveform(audio, progress),
            Strategy::SpectrogramMask => self.spectrogram_mask(audio, progress),
        }
    }

    fn run(&mut self, shape: Vec<i64>, data: Vec<f32>) -> Result<Vec<f32>, String> {
        let tensor = Tensor::from_array((shape, data)).map_err(|e| e.to_string())?;
        let name = self.info.input_name.clone();
        let outputs = self.session.run(vec![(std::borrow::Cow::from(name), ort::session::SessionInputValue::from(tensor))]).map_err(|e| format!("Das Modell lief nicht: {e}"))?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        Ok(data.to_vec())
    }

    /// A waveform model over the signal in overlapping windows, Hann-weighted and added with the sum of the weights
    /// divided out, which removes the seams a plain concatenation leaves at every window edge.
    fn waveform(&mut self, audio: &AudioData, progress: &mut dyn FnMut(f64, &str)) -> Result<[AudioData; 4], String> {
        let rate = audio.sample_rate;
        let frames = audio.frames();
        let want_channels = self.info.input_shape.get(1).copied().filter(|c| *c > 0).map_or(2, |c| c as usize);
        let input = conform_channels(audio, want_channels);
        let segment = match self.info.input_shape.last() {
            Some(last) if *last > 1024 => *last as usize,
            // A dynamic axis: Demucs is trained on windows of about 7.8 s.
            _ => (f64::from(rate) * 7.8).round() as usize,
        };
        let hop = segment / 2;
        let windows = 1.max((frames.saturating_sub(segment)).div_ceil(hop.max(1)) + 1);
        let mut stems = empty_stems(audio.channels.len(), frames, rate);
        let mut weight = vec![0.0f32; frames];
        let fade: Vec<f32> = (0..segment).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / segment as f64).cos()) as f32).collect();
        let stem_count = self.info.stem_count.min(STEM_IDS.len());
        for w in 0..windows {
            let start = (w * hop).min(frames.saturating_sub(segment));
            let mut buffer = vec![0.0f32; want_channels * segment];
            for (c, channel) in input.iter().enumerate() {
                for i in 0..segment {
                    buffer[c * segment + i] = channel.get(start + i).copied().unwrap_or(0.0);
                }
            }
            let data = self.run(vec![1, want_channels as i64, segment as i64], buffer)?;
            for (s, stem) in stems.iter_mut().enumerate().take(stem_count) {
                for (c, target) in stem.channels.iter_mut().enumerate() {
                    let offset = (s * want_channels + c.min(want_channels - 1)) * segment;
                    for i in 0..segment {
                        let at = start + i;
                        if at >= frames {
                            break;
                        }
                        target[at] += data.get(offset + i).copied().unwrap_or(0.0) * fade[i];
                    }
                }
            }
            for (i, f) in fade.iter().enumerate() {
                if let Some(slot) = weight.get_mut(start + i) {
                    *slot += f;
                }
            }
            progress((w + 1) as f64 / windows as f64, &format!("Fenster {} von {windows}", w + 1));
        }
        for stem in &mut stems {
            for channel in &mut stem.channels {
                for (v, w) in channel.iter_mut().zip(&weight) {
                    if *w > 1e-6 {
                        *v /= w;
                    }
                }
            }
        }
        Ok(stems)
    }

    /// A mask model: magnitudes in, a mask for each stem out, the phase taken from the original.
    fn spectrogram_mask(&mut self, audio: &AudioData, progress: &mut dyn FnMut(f64, &str)) -> Result<[AudioData; 4], String> {
        let (fft_size, hop_size) = (4096, 1024);
        let specs: Vec<_> = audio.channels.iter().map(|c| stft(c, fft_size, hop_size)).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let (bins, frames, channels) = (specs[0].bins, specs[0].frames, specs.len());
        let mut magnitude = vec![0.0f32; channels * bins * frames];
        for (c, spec) in specs.iter().enumerate() {
            let mag = magnitude_of(spec);
            // Models of this family expect [channel][frequency][time].
            for f in 0..frames {
                for b in 0..bins {
                    magnitude[c * bins * frames + b * frames + f] = mag[f * bins + b];
                }
            }
        }
        progress(0.35, "Modell wird ausgeführt");
        let data = self.run(vec![1, channels as i64, bins as i64, frames as i64], magnitude)?;
        progress(0.75, "Masken werden angewendet");
        let mut stems = empty_stems(channels, audio.frames(), audio.sample_rate);
        let stem_count = self.info.stem_count.min(STEM_IDS.len());
        let stride = channels * bins * frames;
        for (s, stem) in stems.iter_mut().enumerate().take(stem_count) {
            for (c, spec) in specs.iter().enumerate() {
                let mut mask = vec![0.0f32; frames * bins];
                for f in 0..frames {
                    for b in 0..bins {
                        mask[f * bins + b] = data.get(s * stride + c * bins * frames + b * frames + f).copied().unwrap_or(0.0);
                    }
                }
                stem.channels[c] = istft(&apply_mask(spec, &mask)).map_err(|e| e.to_string())?;
            }
            progress(0.75 + 0.25 * (s + 1) as f64 / stem_count as f64, "");
        }
        Ok(stems)
    }
}

/// The channel count a model expects, up- or down-mixed as needed (`conformChannels`).
fn conform_channels(audio: &AudioData, want: usize) -> Vec<Vec<f32>> {
    let have = audio.channels.len();
    if have == want {
        return audio.channels.clone();
    }
    if have == 1 {
        return vec![audio.channels[0].clone(); want];
    }
    if want == 1 {
        let frames = audio.frames();
        let mut mono = vec![0.0f32; frames];
        for channel in &audio.channels {
            for i in 0..frames {
                mono[i] += channel[i] / have as f32;
            }
        }
        return vec![mono];
    }
    (0..want).map(|i| audio.channels[i.min(have - 1)].clone()).collect()
}

fn empty_stems(channels: usize, frames: usize, rate: u32) -> [AudioData; 4] {
    std::array::from_fn(|_| AudioData { channels: vec![vec![0.0f32; frames]; channels], sample_rate: rate })
}
