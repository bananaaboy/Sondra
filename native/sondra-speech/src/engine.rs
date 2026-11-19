//! Whisper on this computer (whisper.cpp through `whisper-rs`): the model loaded once, the sound given in
//! windows of about half a minute, every window reporting its progress and open to being stopped between two.

use std::path::Path;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::windows::{windows, RATE};
use crate::Segment;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpeechError {
    #[error("Das Sprachmodell liess sich nicht öffnen: {0}")]
    Load(String),
    #[error("Die Spracherkennung ist gescheitert: {0}")]
    Run(String),
    #[error("Abgebrochen")]
    Cancelled,
}

pub struct Recognizer {
    context: WhisperContext,
}

impl Recognizer {
    pub fn load(model: &Path) -> Result<Recognizer, SpeechError> {
        let path = model.to_str().ok_or_else(|| SpeechError::Load("Der Pfad ist kein Text.".into()))?;
        let context = WhisperContext::new_with_params(path, WhisperContextParameters::default()).map_err(|e| SpeechError::Load(e.to_string()))?;
        Ok(Recognizer { context })
    }

    /// The speech in `samples` (16 kHz, mono). `language` is a code like `de`, or `auto`. `progress` hears
    /// the share done and the seconds done; `partial` the segments so far; `cancel` is asked between windows.
    pub fn transcribe(&self, samples: &[f32], language: &str, cancel: &dyn Fn() -> bool, progress: &mut dyn FnMut(f64, f64), partial: &mut dyn FnMut(&[Segment])) -> Result<Vec<Segment>, SpeechError> {
        let mut state = self.context.create_state().map_err(|e| SpeechError::Run(e.to_string()))?;
        let parts = windows(samples);
        let mut segments: Vec<Segment> = Vec::new();
        for (index, (from, to)) in parts.iter().enumerate() {
            if cancel() {
                return Err(SpeechError::Cancelled);
            }
            progress(index as f64 / parts.len() as f64, *from as f64 / RATE as f64);
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(if language == "auto" { None } else { Some(language) });
            params.set_translate(false);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            params.set_suppress_blank(true);
            params.set_no_context(true);
            // A window of silence says nothing rather than something made up.
            params.set_no_speech_thold(0.6);
            state.full(params, &samples[*from..*to]).map_err(|e| SpeechError::Run(e.to_string()))?;
            let offset = *from as f64 / RATE as f64;
            let length = (*to - *from) as f64 / RATE as f64;
            let count = state.full_n_segments().map_err(|e| SpeechError::Run(e.to_string()))?;
            for i in 0..count {
                let text = state.full_get_segment_text(i).map_err(|e| SpeechError::Run(e.to_string()))?;
                let text = text.trim().to_owned();
                if text.is_empty() {
                    continue;
                }
                // Whisper counts in hundredths of a second.
                let start = state.full_get_segment_t0(i).map_err(|e| SpeechError::Run(e.to_string()))? as f64 / 100.0;
                let end = state.full_get_segment_t1(i).map_err(|e| SpeechError::Run(e.to_string()))? as f64 / 100.0;
                segments.push(Segment { start: offset + start, end: offset + end.min(length), text });
            }
            partial(&segments);
        }
        progress(1.0, samples.len() as f64 / RATE as f64);
        Ok(segments)
    }
}
