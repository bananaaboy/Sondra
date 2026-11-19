//! Media work, with the real FFmpeg as a program instead of the WebAssembly build.
//!
//! * [`convert`] — the output formats and the exact FFmpeg arguments behind them: a port of
//!   `src/lib/convert.ts`, checked against a table the web app itself writes
//!   (`npm run native:golden`), so the command is the same one.
//! * [`presets`] — the templates of the converter (`src/lib/convertPresets.ts`).
//! * [`ffmpeg`] — running FFmpeg: locating it, progress, cancelling, probing.
//! * [`loudness`] — EBU R128 / BS.1770: measuring and moving to a target (`src/lib/loudness.ts`).
//! * [`run`] — a whole conversion: a file in, a file out (`src/lib/convertRun.ts`).
//!
//! What changes from the browser: no memory limit (a file is read from where it lies), no crash of
//! the whole tab (an encoder that fails is a process that fails), and no workarounds for the
//! WebAssembly build's encoder crashes are *needed* — but the arguments keep their limits (libopus at
//! complexity 4, WebM as VP8), because the files must stay the same ones the web app makes.

pub mod convert;
pub mod ffmpeg;
pub mod loudness;
pub mod presets;
pub mod run;

pub use ffmpeg::{Cancel, Ffmpeg, MediaError, Probe};
