//! Recording the screen or a window into a video file (`src/lib/screenRecord.ts`). The picture is FFmpeg's
//! own screen grabber (Windows: `gdigrab`), the sound — the computer's and the microphone's — is taken by the
//! app and joined to it when the recording ends: a track as it is, or two mixed into one.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::audio::{write_wav_f32, AudioData};
use crate::ffmpeg::Ffmpeg;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// The whole screen (the main one).
    Screen,
    /// A window, by its title.
    Window(String),
    /// A window of the X display, by its id (Linux).
    X11Window(u32),
}

/// The arguments that tell FFmpeg what to grab, for this computer.
pub fn input_args(source: &Source, fps: u32) -> Vec<String> {
    let fps = fps.to_string();
    if cfg!(windows) {
        let target = match source {
            Source::Screen | Source::X11Window(_) => "desktop".to_owned(),
            Source::Window(title) => format!("title={title}"),
        };
        ["-f", "gdigrab", "-framerate", &fps, "-draw_mouse", "1", "-i", &target].iter().map(|s| (*s).to_owned()).collect()
    } else {
        // Where there is no Windows: the X display, whole, or one window of it (`-window_id`).
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".into());
        let mut args: Vec<String> = ["-f", "x11grab", "-framerate", &fps, "-draw_mouse", "1"].iter().map(|s| (*s).to_owned()).collect();
        if let Source::X11Window(id) = source {
            args.extend(["-window_id".to_owned(), format!("0x{id:x}")]);
        }
        args.extend(["-i".to_owned(), display]);
        args
    }
}

/// A recording that is going on.
pub struct Recorder {
    child: Child,
    video: PathBuf,
    dir: PathBuf,
    started: Instant,
}

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("FFmpeg liess sich nicht starten: {0}")]
    Start(String),
    #[error("Die Aufnahme hat nichts aufgezeichnet.")]
    Empty,
    #[error("Die Aufnahme liess sich nicht abschliessen: {0}")]
    Finish(String),
}

impl Recorder {
    /// Starts grabbing with `input` (see [`input_args`]; a test brings its own source) into a file in `dir`.
    pub fn start(ffmpeg: &Ffmpeg, input: &[String], fps: u32, dir: &Path) -> Result<Recorder, CaptureError> {
        std::fs::create_dir_all(dir).map_err(|e| CaptureError::Start(e.to_string()))?;
        let video = dir.join("bild.mkv");
        let child = Command::new(ffmpeg.program())
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(input)
            // Even sides (H.264 wants them), fast to encode (a screen at 30 frames must not fall behind).
            .args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-r"])
            .arg(fps.to_string())
            .arg(&video)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| CaptureError::Start(e.to_string()))?;
        Ok(Recorder { child, video, dir: dir.to_path_buf(), started: Instant::now() })
    }

    /// How long it has been recording.
    pub fn seconds(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    /// Whether FFmpeg has ended by itself (the window it grabbed was closed, or it could not grab at all).
    pub fn ended(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_some()
    }

    /// Ends the recording: asks FFmpeg to finish the picture, joins the sound tracks (each mono samples at its
    /// own rate; none, one, or two to mix) and writes `out` (an MP4). The temporary files go.
    pub fn finish(mut self, ffmpeg: &Ffmpeg, tracks: &[(Vec<f32>, u32)], out: &Path) -> Result<(), CaptureError> {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"q");
        }
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
        let result = (|| {
            if std::fs::metadata(&self.video).map_or(0, |m| m.len()) == 0 {
                return Err(CaptureError::Empty);
            }
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir).map_err(|e| CaptureError::Finish(e.to_string()))?;
            }
            let mut command = Command::new(ffmpeg.program());
            command.args(["-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(&self.video);
            let mut wavs = Vec::new();
            for (n, (samples, rate)) in tracks.iter().enumerate() {
                let path = self.dir.join(format!("ton{n}.wav"));
                write_wav_f32(&path, &AudioData { channels: vec![samples.clone()], sample_rate: *rate }).map_err(|e| CaptureError::Finish(e.to_string()))?;
                command.arg("-i").arg(&path);
                wavs.push(path);
            }
            match wavs.len() {
                0 => {
                    command.args(["-c", "copy"]);
                }
                1 => {
                    command.args(["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]);
                }
                _ => {
                    command.args(["-filter_complex", "[1:a][2:a]amix=inputs=2:duration=longest,volume=2[a]", "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k"]);
                }
            }
            let output = command.args(["-movflags", "+faststart"]).arg(out).stdin(Stdio::null()).output().map_err(|e| CaptureError::Finish(e.to_string()))?;
            if !output.status.success() {
                return Err(CaptureError::Finish(String::from_utf8_lossy(&output.stderr).trim().to_owned()));
            }
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&self.dir);
        result
    }

    /// Gives the recording up: nothing is kept.
    pub fn discard(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
