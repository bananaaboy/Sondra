//! Speech to text on this computer. `cues` shapes timed segments into the formats people use (the web app's
//! `transcribe.ts`, character for character); `windows` cuts a long recording where it is quietest; `model`
//! fetches and keeps the Whisper model (only the model, only on the person's say-so, never the sound);
//! `engine` runs Whisper.

pub mod cues;
pub mod engine;
pub mod model;
pub mod windows;

/// One stretch of speech, in seconds from the start.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
}
