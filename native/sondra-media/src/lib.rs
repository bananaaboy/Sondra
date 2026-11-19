//! Media work, with the real FFmpeg as a program instead of the WebAssembly build.
//!
//! * [`convert`] — the output formats and the exact FFmpeg arguments behind them: a port of
//!   `src/lib/convert.ts`, checked against a table the web app itself writes
//!   (`npm run native:golden`), so the command is the same one.
//! * [`presets`] — the templates of the converter (`src/lib/convertPresets.ts`).
//! * [`ffmpeg`] — running FFmpeg: locating it, progress, cancelling, probing.
//! * [`fft`] — FFT and short-time transform (`src/lib/fft.ts`), the front end of the spectral tools.
//! * [`audio`] — the planar float audio the tools hold.
//! * [`onsets`], [`tempo`] — spectral-flux onsets, tempo by autocorrelation, beat grids (`onsets.ts`, `tempo.ts`).
//! * [`chroma`], [`key`], [`pitch`], [`midi`] — pitch classes, key and chords, YIN notes, the MIDI file.
//! * [`loudness`] — EBU R128 / BS.1770: measuring and moving to a target (`src/lib/loudness.ts`).
//! * [`run`] — a whole conversion: a file in, a file out (`src/lib/convertRun.ts`).
//!
//! What changes from the browser: no memory limit (a file is read from where it lies), no crash of
//! the whole tab (an encoder that fails is a process that fails), and no workarounds for the
//! WebAssembly build's encoder crashes are *needed* — but the arguments keep their limits (libopus at
//! complexity 4, WebM as VP8), because the files must stay the same ones the web app makes.

pub mod audio;
pub mod chroma;
pub mod convert;
pub mod ffmpeg;
pub mod fft;
pub mod key;
pub mod loudness;
pub mod midi;
pub mod onsets;
pub mod pitch;
pub mod presets;
pub mod run;
pub mod tempo;

pub use ffmpeg::{Cancel, Ffmpeg, MediaError, Probe};
