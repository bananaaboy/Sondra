//! Running the real FFmpeg: finding it, progress, cancelling, probing.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MediaError {
    #[error("FFmpeg wurde nicht gefunden.")]
    NotFound,
    #[error("Abgebrochen.")]
    Cancelled,
    /// FFmpeg sagte nichts mehr, obwohl es noch lief.
    #[error("FFmpeg hat sich länger als {0} Sekunden nicht gerührt.")]
    Stalled(u64),
    /// FFmpeg ended with an error; `tail` is what it printed last.
    #[error("FFmpeg ist mit Fehler {code:?} beendet.")]
    Failed { code: Option<i32>, tail: String },
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for MediaError {
    fn from(e: std::io::Error) -> Self {
        MediaError::Io(e.to_string())
    }
}

/// Stops a running job from another thread.
#[derive(Debug, Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// How far a job is.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Progress {
    /// Seconds of the output made so far.
    pub seconds: f64,
    /// 0 to 1, when the length is known.
    pub fraction: Option<f64>,
    /// Encoding speed relative to real time (`1.5` is one and a half times as fast).
    pub speed: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    /// Its number in the file, as `-map 0:n` names it.
    pub index: u32,
    pub kind: String,
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    /// Frames a second of a picture stream (the average, or the nominal rate when that is not given).
    pub fps: Option<f64>,
    /// The language tag the file gives it („ger“, „jpn“), and its title.
    pub language: Option<String>,
    pub title: Option<String>,
    /// The one the file itself marks as the one to play.
    pub default: bool,
    /// A cover picture or thumbnail stored as a stream: not a film.
    pub attached_picture: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub duration: Option<f64>,
    pub format: String,
    pub streams: Vec<Stream>,
}

/// „30000/1001“ or „25/1“ as 29.97 or 25; „0/0“ is no rate at all.
fn frame_rate(value: &Value) -> Option<f64> {
    let text = value.as_str()?;
    let (n, d) = text.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (n > 0.0 && d > 0.0).then_some(n / d)
}

impl Probe {
    pub fn has(&self, kind: &str) -> bool {
        self.streams.iter().any(|s| s.kind == kind)
    }
}

pub struct Ffmpeg {
    program: PathBuf,
    probe: PathBuf,
    /// How long FFmpeg may say nothing before it counts as hung (it reports twice a second).
    pub stall: Duration,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn runs(program: &Path) -> bool {
    Command::new(program)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

impl Ffmpeg {
    /// FFmpeg and FFprobe at these paths.
    pub fn at(program: impl Into<PathBuf>, probe: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            probe: probe.into(),
            stall: Duration::from_secs(90),
        }
    }

    /// Where FFmpeg is: `SONDRA_FFMPEG` (a folder with both programs), next to this program, then the
    /// path.
    pub fn locate() -> Option<Self> {
        let mut folders: Vec<PathBuf> = Vec::new();
        if let Some(dir) = std::env::var_os("SONDRA_FFMPEG") {
            folders.push(dir.into());
        }
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
        {
            folders.push(dir);
        }
        for folder in folders {
            let (a, b) = (folder.join(exe("ffmpeg")), folder.join(exe("ffprobe")));
            if a.is_file() && b.is_file() {
                return Some(Self::at(a, b));
            }
        }
        let on_path = Self::at(exe("ffmpeg"), exe("ffprobe"));
        runs(&on_path.program).then_some(on_path)
    }

    /// The FFmpeg program, for callers that run it themselves (a player keeps two of them running).
    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn version(&self) -> Result<String, MediaError> {
        let out = Command::new(&self.program)
            .arg("-version")
            .output()
            .map_err(|e| not_found_or(e))?;
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .to_owned())
    }

    /// What is in a file.
    pub fn probe(&self, path: &Path) -> Result<Probe, MediaError> {
        let out = Command::new(&self.probe)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .output()
            .map_err(not_found_or)?;
        if !out.status.success() {
            return Err(MediaError::Failed {
                code: out.status.code(),
                tail: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
            });
        }
        let json: Value =
            serde_json::from_slice(&out.stdout).map_err(|e| MediaError::Io(e.to_string()))?;
        let number = |v: &Value| {
            v.as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| v.as_f64())
        };
        let streams = json["streams"]
            .as_array()
            .map(|all| {
                all.iter()
                    .enumerate()
                    .map(|(at, s)| Stream {
                        index: s["index"].as_u64().map_or(at as u32, |v| v as u32),
                        kind: s["codec_type"].as_str().unwrap_or("").to_owned(),
                        codec: s["codec_name"].as_str().unwrap_or("").to_owned(),
                        width: s["width"].as_u64().map(|v| v as u32),
                        height: s["height"].as_u64().map(|v| v as u32),
                        sample_rate: number(&s["sample_rate"]).map(|v| v as u32),
                        channels: s["channels"].as_u64().map(|v| v as u32),
                        fps: frame_rate(&s["avg_frame_rate"]).or_else(|| frame_rate(&s["r_frame_rate"])),
                        language: s["tags"]["language"].as_str().filter(|l| *l != "und").map(str::to_owned),
                        title: s["tags"]["title"].as_str().map(str::to_owned),
                        default: s["disposition"]["default"].as_u64() == Some(1),
                        attached_picture: s["disposition"]["attached_pic"].as_u64() == Some(1),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Probe {
            duration: number(&json["format"]["duration"]),
            format: json["format"]["format_name"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            streams,
        })
    }

    /// Runs FFmpeg with `args` (the ones of [`crate::convert::build_args`] and the like), reporting
    /// progress about twice a second. `length` is the length of what comes out, for the fraction.
    pub fn run(
        &self,
        args: &[String],
        length: Option<f64>,
        cancel: &Cancel,
        on_progress: &mut dyn FnMut(Progress),
    ) -> Result<(), MediaError> {
        let mut child = Command::new(&self.program)
            .args([
                "-hide_banner",
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-progress",
                "pipe:1",
                "-nostats",
            ])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(not_found_or)?;

        // What FFmpeg complains about, last lines only.
        let stderr = child.stderr.take().expect("piped");
        let tail_thread = std::thread::spawn(move || {
            let mut tail: VecDeque<String> = VecDeque::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tail.len() == 30 {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });

        let stdout = child.stdout.take().expect("piped");
        let (lines, heard) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    break;
                }
            }
        });

        let mut last_heard = Instant::now();
        let mut seconds = 0.0;
        let mut speed = None;
        let outcome = loop {
            if cancel.is_cancelled() {
                break Err(MediaError::Cancelled);
            }
            match heard.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    last_heard = Instant::now();
                    if let Some((key, value)) = line.split_once('=') {
                        match key {
                            "out_time_us" | "out_time_ms" => {
                                if let Ok(us) = value.trim().parse::<f64>() {
                                    seconds = (us / 1_000_000.0).max(0.0);
                                }
                            }
                            "speed" => {
                                speed = value.trim().trim_end_matches('x').parse::<f64>().ok()
                            }
                            "progress" => {
                                let fraction = length
                                    .filter(|l| *l > 0.0)
                                    .map(|l| (seconds / l).clamp(0.0, 1.0));
                                on_progress(Progress {
                                    seconds,
                                    fraction: if value.trim() == "end" {
                                        fraction.map(|_| 1.0)
                                    } else {
                                        fraction
                                    },
                                    speed,
                                });
                                if value.trim() == "end" {
                                    break Ok(());
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if last_heard.elapsed() > self.stall {
                        break Err(MediaError::Stalled(self.stall.as_secs()));
                    }
                }
                // FFmpeg closed its end: it is done or gone.
                Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(()),
            }
        };

        if outcome.is_err() {
            let _ = child.kill();
        }
        let status = child.wait()?;
        let tail = tail_thread.join().unwrap_or_default();
        match outcome {
            Err(e) => Err(e),
            Ok(()) if status.success() => Ok(()),
            Ok(()) => Err(MediaError::Failed {
                code: status.code(),
                tail,
            }),
        }
    }
}

fn not_found_or(e: std::io::Error) -> MediaError {
    if e.kind() == std::io::ErrorKind::NotFound {
        MediaError::NotFound
    } else {
        MediaError::Io(e.to_string())
    }
}
