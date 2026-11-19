//! Media work, with the real FFmpeg as a program instead of the WebAssembly build.
//!
//! * [`convert`] — the output formats and the exact FFmpeg arguments behind them: a port of
//!   `src/lib/convert.ts`, checked against a table the web app itself writes
//!   (`npm run native:golden`), so the command is the same one.
//! * [`presets`] — the templates of the converter (`src/lib/convertPresets.ts`).
//! * [`ffmpeg`] — running FFmpeg: locating it, progress, cancelling, probing.
//! * [`duck`] — voice over music with the music stepping back (`duck.ts`).
//! * [`fft`] — FFT and short-time transform (`src/lib/fft.ts`), the front end of the spectral tools.
//! * [`audio`] — the planar float audio the tools hold.
//! * [`onsets`], [`tempo`] — spectral-flux onsets, tempo by autocorrelation, beat grids (`onsets.ts`, `tempo.ts`).
//! * [`chop`] — where to cut a sound: hits, grid, equal parts, silence (`chop.ts`).
//! * [`chroma`], [`key`], [`pitch`], [`midi`] — pitch classes, key and chords, YIN notes, the MIDI file.
//! * [`intro`] — the opening of a series, found by ear (`introPrint.ts`).
//! * [`loudness`] — EBU R128 / BS.1770: measuring and moving to a target (`src/lib/loudness.ts`).
//! * [`image_ops`] — pictures: turn, crop, scale, colour, write as WebP, JPEG or PNG (`image.ts`).
//! * [`video_ops`] — the video editor's one FFmpeg invocation (`src/lib/video.ts`).
//! * [`run`] — a whole conversion: a file in, a file out (`src/lib/convertRun.ts`).
//!
//! What changes from the browser: no memory limit (a file is read from where it lies), no crash of
//! the whole tab (an encoder that fails is a process that fails), and no workarounds for the
//! WebAssembly build's encoder crashes are *needed* — but the arguments keep their limits (libopus at
//! complexity 4, WebM as VP8), because the files must stay the same ones the web app makes.

pub mod audio;
pub mod capture;
pub mod chop;
pub mod chroma;
pub mod convert;
pub mod cue;
pub mod duck;
pub mod edit;
pub mod editor;
pub mod effects;
pub mod ffmpeg;
pub mod fft;
pub mod image_ops;
pub mod intro;
pub mod key;
pub mod loudness;
pub mod midi;
pub mod mic;
pub mod onsets;
pub mod pattern;
pub mod roll;
pub mod pitch;
pub mod presets;
pub mod run;
pub mod separation;
pub mod tempo;
pub mod crop_drag;
pub mod declick;
pub mod thumbnail;
pub mod timestretch;
pub mod video_ops;
pub mod zip;

pub use ffmpeg::{Cancel, Ffmpeg, MediaError, Probe, Progress, Stream};
