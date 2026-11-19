//! Playing a film or a song. FFmpeg decodes, in two child programs: one hands over the pictures as raw
//! frames, one the sound as raw samples. The sound goes to the speakers (or to a silent stand-in that keeps
//! the same time), and **what has been heard is the clock**: a picture is shown when the clock has reached
//! its moment, and dropped when the clock has passed it. The ear forgives a dropped frame and nothing else.
//!
//! A jump, a change of speed or of the sound track starts the two children again at the new place — FFmpeg
//! finds a place in a file in a moment. Each run has its own stop flag and its own queue of pictures, so
//! nothing the old children still say is ever shown.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub mod analyser;
pub use analyser::Spectrum;

use sondra_audio::{Output, Shared};
use sondra_media::{Ffmpeg, MediaError, Probe, Stream};

/// A picture, as the window takes it: BGRA, one byte each, rows from the top.
#[derive(Debug, Clone)]
pub struct Frame {
    /// The moment it belongs to, in seconds of the file.
    pub pts: f64,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlaybackError {
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error("In der Datei ist nichts zum Abspielen.")]
    Nothing,
    #[error("Die Datei liess sich nicht abspielen: {0}")]
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Playing,
    Paused,
    /// Everything has been played.
    Ended,
}

/// How big a picture is asked for: the file's own, up to this width (a 4K film is shown smaller than it is;
/// the window is not bigger and every pixel passes through the pipe).
pub const MAX_WIDTH: u32 = 1920;

/// How much sound waits in the queue, in seconds.
const AUDIO_AHEAD: f32 = 1.0;
/// How many pictures the decoder may run ahead.
const FRAMES_AHEAD: usize = 6;

/// A short queue of pictures between the decoder thread and the window. Closing it frees a waiting decoder.
struct Frames {
    queue: Mutex<(VecDeque<Frame>, bool)>,
    changed: Condvar,
}

impl Frames {
    fn new() -> Frames {
        Frames { queue: Mutex::new((VecDeque::new(), false)), changed: Condvar::new() }
    }

    /// Puts a picture in line; waits while the line is full. `false` when the queue was closed.
    fn push(&self, frame: Frame) -> bool {
        let mut guard = self.queue.lock().expect("lock");
        while guard.0.len() >= FRAMES_AHEAD && !guard.1 {
            guard = self.changed.wait_timeout(guard, Duration::from_millis(50)).expect("lock").0;
        }
        if guard.1 {
            return false;
        }
        guard.0.push_back(frame);
        true
    }

    fn close(&self) {
        let mut guard = self.queue.lock().expect("lock");
        guard.1 = true;
        guard.0.clear();
        self.changed.notify_all();
    }

    /// The newest picture whose moment has come, older ones dropped; `None` when none is due yet.
    fn due(&self, clock: f64) -> Option<Frame> {
        let mut guard = self.queue.lock().expect("lock");
        let mut found = None;
        while guard.0.front().is_some_and(|f| f.pts <= clock + 1e-6) {
            found = guard.0.pop_front();
        }
        if found.is_some() {
            self.changed.notify_all();
        }
        found
    }

    fn is_empty(&self) -> bool {
        self.queue.lock().expect("lock").0.is_empty()
    }
}

/// What one run of the two children needs to be told apart from the next.
struct Run {
    children: Vec<Child>,
    frames: Arc<Frames>,
    /// Raised by the decoder threads when their stream has ended.
    video_done: Arc<AtomicBool>,
    audio_done: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

impl Run {
    fn end(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.frames.close();
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct Settings {
    rate: f64,
    volume: f32,
    muted: bool,
    audio_track: usize,
    boost: f32,
    night: bool,
    karaoke: bool,
    equalizer: Equalizer,
    picture: Picture,
}

/// How the picture is dressed on its way to the window. The numbers are the ones of the web player's
/// CSS filter: 1 is as the film is, brightness and saturation multiply, contrast turns around mid grey.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Picture {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub mirror: bool,
}

impl Default for Picture {
    fn default() -> Self {
        Picture { brightness: 1.0, contrast: 1.0, saturation: 1.0, mirror: false }
    }
}

/// The FFmpeg filters for the picture, after the scaling (empty when it is as it is).
pub fn picture_filters(picture: &Picture) -> Vec<String> {
    let mut filters = Vec::new();
    let near = |a: f64| (a - 1.0).abs() < 1e-9;
    if !near(picture.brightness) {
        let b = picture.brightness.clamp(0.0, 3.0);
        filters.push(format!("lutrgb=r=val*{b}:g=val*{b}:b=val*{b}"));
    }
    if !near(picture.contrast) || !near(picture.saturation) {
        filters.push(format!("eq=contrast={}:saturation={}", picture.contrast.clamp(0.0, 3.0), picture.saturation.clamp(0.0, 3.0)));
    }
    if picture.mirror {
        filters.push("hflip".to_string());
    }
    filters
}

/// The five-band equalizer of the web player (`lib/audio/equalizer.ts`): a low shelf at 80 Hz, peaks at 300 Hz, 1 kHz
/// and 3.5 kHz (Q 1), a high shelf at 10 kHz, then a soft limiter so boosted bands do not clip. Gains in dB,
/// −12 to +12.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Equalizer {
    pub on: bool,
    pub gains: [f64; 5],
}

impl Default for Equalizer {
    fn default() -> Self {
        Equalizer { on: false, gains: [0.0; 5] }
    }
}

/// The bands: name, centre in Hz.
pub const EQ_BANDS: [(&str, f64); 5] = [("Bässe", 80.0), ("Tiefmitten", 300.0), ("Mitten", 1000.0), ("Präsenz", 3500.0), ("Höhen", 10000.0)];

/// The presets of the web player's equalizer: name and the five gains.
pub const EQ_PRESETS: [(&str, [f64; 5]); 5] = [
    ("Flat", [0.0, 0.0, 0.0, 0.0, 0.0]),
    ("Bass Boost", [6.0, 3.0, 0.0, 1.0, 2.0]),
    ("Vocal Clarity", [-2.0, -1.0, 2.5, 4.5, 2.0]),
    ("Elektronisch", [5.0, 2.0, -1.5, 2.0, 4.5]),
    ("Höhen-Boost", [-1.0, 0.0, 1.0, 3.5, 6.0]),
];

/// The FFmpeg filters for the equalizer: nothing while it is off or every band is flat.
pub fn equalizer_filters(eq: &Equalizer) -> Vec<String> {
    let g = eq.gains.map(|v| v.clamp(-12.0, 12.0));
    if !eq.on || g.iter().all(|v| v.abs() < 1e-9) {
        return Vec::new();
    }
    let mut filters = Vec::new();
    let mut add = |gain: f64, filter: String| {
        if gain.abs() > 1e-9 {
            filters.push(filter);
        }
    };
    add(g[0], format!("bass=f=80:g={}", g[0]));
    add(g[1], format!("equalizer=f=300:t=q:w=1:g={}", g[1]));
    add(g[2], format!("equalizer=f=1000:t=q:w=1:g={}", g[2]));
    add(g[3], format!("equalizer=f=3500:t=q:w=1:g={}", g[3]));
    add(g[4], format!("treble=f=10000:g={}", g[4]));
    // Master limiter: −0.5 dBFS, fast attack (3 ms), release 100 ms.
    filters.push("alimiter=limit=0.944:attack=3:release=100:level=0".to_string());
    filters
}

/// The voice remover of the web player (`lib/audioKaraoke.ts`): what lies in the middle of the picture of the sound is
/// taken out between 130 Hz and 7.5 kHz (left minus right, 0.8), the bass below and the air above stay as they are.
/// A sound of one channel has no middle to take out and is left alone, as the web player leaves it.
pub fn karaoke_filter(channels: u32) -> Option<String> {
    if channels < 2 {
        return None;
    }
    Some(
        "pan=stereo|c0=c0|c1=c1,asplit=3[lo][hi][mid];[lo]lowpass=f=130:t=q:w=0.707[bass];[hi]highpass=f=7500:t=q:w=0.707[air];\
         [mid]highpass=f=130:t=q:w=1,lowpass=f=7500:t=q:w=1,pan=stereo|c0=0.8*c0-0.8*c1|c1=0.8*c0-0.8*c1[voice];\
         [bass][air][voice]amix=inputs=3:normalize=0"
            .to_string(),
    )
}

/// The sound the night mode asks for: quiet passages up, loud ones down. The numbers are the web player's
/// compressor (threshold −32 dB, knee, ratio 5, attack 10 ms, release 350 ms) with a make-up so that the
/// quiet part really does come up.
pub const NIGHT_FILTER: &str = "acompressor=threshold=0.0251:ratio=5:attack=10:release=350:knee=4:makeup=4";

pub struct Playback {
    ffmpeg: Ffmpeg,
    path: PathBuf,
    probe: Probe,
    video: Option<Stream>,
    audio: Vec<Stream>,
    output: Output,
    shared: Shared,
    size: (u32, u32),
    /// The tallest the picture is made, or `None` for the film's own.
    quality: Option<u32>,
    settings: Settings,
    run: Run,
    /// Where in the file this run started, in seconds.
    started_at: f64,
    /// The clock when there is no sound to hold to: time since the run started, without the pauses.
    timer: Timer,
    state: State,
    /// The last picture handed out, so the window can keep showing it.
    last: Option<Frame>,
    reader: analyser::Reader,
}

#[derive(Default)]
struct Timer {
    elapsed: Duration,
    since: Option<Instant>,
}

impl Timer {
    fn seconds(&self) -> f64 {
        (self.elapsed + self.since.map_or(Duration::ZERO, |s| s.elapsed())).as_secs_f64()
    }
    fn start(&mut self) {
        if self.since.is_none() {
            self.since = Some(Instant::now());
        }
    }
    fn stop(&mut self) {
        if let Some(since) = self.since.take() {
            self.elapsed += since.elapsed();
        }
    }
    fn reset(&mut self) {
        *self = Timer::default();
    }
}

impl Playback {
    /// Opens a file and starts playing it from the beginning (or at `from`).
    pub fn open(ffmpeg: Ffmpeg, path: &Path, from: f64) -> Result<Playback, PlaybackError> {
        let probe = ffmpeg.probe(path)?;
        let video = probe.streams.iter().find(|s| s.kind == "video" && !s.attached_picture && s.width.is_some()).cloned();
        let audio: Vec<Stream> = probe.streams.iter().filter(|s| s.kind == "audio").cloned().collect();
        if video.is_none() && audio.is_empty() {
            return Err(PlaybackError::Nothing);
        }
        let output = Output::open(AUDIO_AHEAD);
        let shared = output.shared();
        let size = video.as_ref().map_or((0, 0), |v| fit(v.width.unwrap_or(0), v.height.unwrap_or(0)));
        let mut playback = Playback {
            ffmpeg,
            path: path.to_path_buf(),
            probe,
            video,
            audio,
            output,
            shared,
            size,
            quality: None,
            settings: Settings { rate: 1.0, volume: 1.0, muted: false, audio_track: 0, boost: 1.0, night: false, karaoke: false, equalizer: Equalizer::default(), picture: Picture::default() },
            run: Run { children: Vec::new(), frames: Arc::new(Frames::new()), video_done: Arc::default(), audio_done: Arc::default(), stop: Arc::default() },
            started_at: 0.0,
            timer: Timer::default(),
            state: State::Playing,
            last: None,
            reader: analyser::Reader::new(),
        };
        playback.restart(from.max(0.0))?;
        Ok(playback)
    }

    pub fn probe(&self) -> &Probe {
        &self.probe
    }

    pub fn duration(&self) -> Option<f64> {
        self.probe.duration
    }

    /// The size of the pictures that come, or `None` for a song.
    pub fn picture_size(&self) -> Option<(u32, u32)> {
        self.video.as_ref().map(|_| self.size)
    }

    pub fn audio_tracks(&self) -> &[Stream] {
        &self.audio
    }

    /// Whether anyone can hear the sound (a sound card is there).
    pub fn is_audible(&self) -> bool {
        self.output.is_audible()
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// Where the film is: what has been heard (or, with no sound, the time that has passed).
    pub fn position(&self) -> f64 {
        let seconds = if self.audio.is_empty() { self.timer.seconds() } else { self.shared.heard() };
        let at = self.started_at + seconds * self.settings.rate;
        match self.probe.duration {
            Some(d) => at.min(d),
            None => at,
        }
    }

    fn restart(&mut self, at: f64) -> Result<(), PlaybackError> {
        self.run.end();
        self.shared.clear();
        let stop = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(Frames::new());
        let (video_done, audio_done) = (Arc::new(AtomicBool::new(self.video.is_none())), Arc::new(AtomicBool::new(self.audio.is_empty())));
        let mut children = Vec::new();

        if let Some(video) = &self.video {
            let fps = video.fps.unwrap_or(25.0).clamp(1.0, 120.0);
            let (w, h) = self.size;
            let mut chain = vec![format!("scale={w}:{h}:flags=bilinear"), format!("fps={fps}")];
            chain.extend(picture_filters(&self.settings.picture));
            let vf = chain.join(",");
            let mut child = Command::new(self.ffmpeg.program())
                .args(["-v", "error", "-nostdin", "-ss", &seconds_arg(at), "-i"])
                .arg(&self.path)
                .args(["-map", &format!("0:{}", video.index), "-an", "-sn", "-vf", &vf, "-pix_fmt", "bgra", "-f", "rawvideo", "-"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .map_err(|e| PlaybackError::Failed(e.to_string()))?;
            let out = child.stdout.take().expect("a pipe");
            children.push(child);
            let (frames, stop, done) = (frames.clone(), stop.clone(), video_done.clone());
            std::thread::spawn(move || read_frames(out, w, h, fps, at, &frames, &stop, &done));
        }
        if let Some(track) = self.audio.get(self.settings.audio_track).or_else(|| self.audio.first()) {
            let (rate, channels) = (self.shared.rate(), self.shared.channels());
            let mut filters = Vec::new();
            let tempo = self.settings.rate;
            if (tempo - 1.0).abs() > 1e-9 {
                // `atempo` takes 0.5 to 2 in one step; two steps reach 0.25 and 4.
                let mut left = tempo;
                while left < 0.5 {
                    filters.push("atempo=0.5".to_string());
                    left /= 0.5;
                }
                while left > 2.0 {
                    filters.push("atempo=2.0".to_string());
                    left /= 2.0;
                }
                filters.push(format!("atempo={left}"));
            }
            if self.settings.karaoke {
                filters.extend(karaoke_filter(track.channels.unwrap_or(2)));
            }
            filters.extend(equalizer_filters(&self.settings.equalizer));
            if self.settings.night {
                filters.push(NIGHT_FILTER.to_string());
            }
            let mut command = Command::new(self.ffmpeg.program());
            command.args(["-v", "error", "-nostdin", "-ss", &seconds_arg(at), "-i"]).arg(&self.path).args(["-map", &format!("0:{}", track.index), "-vn", "-sn"]);
            if !filters.is_empty() {
                command.args(["-af", &filters.join(",")]);
            }
            let mut child = command
                .args(["-f", "f32le", "-ac", &channels.to_string(), "-ar", &rate.to_string(), "-"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .stdin(Stdio::null())
                .spawn()
                .map_err(|e| PlaybackError::Failed(e.to_string()))?;
            let out = child.stdout.take().expect("a pipe");
            children.push(child);
            let (shared, stop, done) = (self.shared.clone(), stop.clone(), audio_done.clone());
            std::thread::spawn(move || read_sound(out, &shared, &stop, &done));
        }
        self.run = Run { children, frames, video_done, audio_done, stop };
        self.started_at = at;
        self.timer.reset();
        self.last = None;
        self.apply_volume();
        if self.state == State::Ended {
            self.state = State::Playing;
        }
        match self.state {
            State::Playing => {
                self.shared.set_paused(false);
                self.timer.start();
            }
            _ => self.shared.set_paused(true),
        }
        Ok(())
    }

    fn apply_volume(&self) {
        self.shared.set_volume(if self.settings.muted { 0.0 } else { self.settings.volume * self.settings.boost });
    }

    pub fn play(&mut self) {
        if self.state == State::Ended {
            let _ = self.restart(0.0);
        }
        self.state = State::Playing;
        self.shared.set_paused(false);
        self.timer.start();
    }

    pub fn pause(&mut self) {
        if self.state == State::Playing {
            self.state = State::Paused;
        }
        self.shared.set_paused(true);
        self.timer.stop();
    }

    pub fn toggle(&mut self) {
        if self.state == State::Playing {
            self.pause();
        } else {
            self.play();
        }
    }

    /// Jumps to a place; what was waiting is thrown away and the picture of that place comes at once.
    pub fn seek(&mut self, to: f64) -> Result<(), PlaybackError> {
        let end = self.probe.duration.unwrap_or(f64::MAX);
        self.restart(to.clamp(0.0, (end - 0.1).max(0.0)))
    }

    /// A speed from 0.25 to 4 times: the sound is stretched without changing its pitch, the clock runs at it.
    pub fn set_rate(&mut self, rate: f64) -> Result<(), PlaybackError> {
        let at = self.position();
        self.settings.rate = rate.clamp(0.25, 4.0);
        self.restart(at)
    }

    /// Gain above 100 %: 1.0 to 3.0, on top of the volume.
    pub fn set_boost(&mut self, boost: f32) {
        self.settings.boost = boost.clamp(1.0, 3.0);
        self.apply_volume();
    }

    /// The night mode needs the sound made again, from where it is.
    pub fn set_night(&mut self, on: bool) -> Result<(), PlaybackError> {
        if self.settings.night == on {
            return Ok(());
        }
        let at = self.position();
        self.settings.night = on;
        self.restart(at)
    }

    /// A look at the sound being heard now, for the visualizer: silent while it is paused or nothing plays.
    pub fn spectrum(&self) -> Spectrum {
        if self.state != State::Playing || self.audio.is_empty() {
            self.reader.reset();
            return Spectrum::silent();
        }
        self.reader.read(&self.shared.recent())
    }

    /// The heights a film can be watched at below its own, as the web player offers them.
    pub fn quality_steps(&self) -> Vec<u32> {
        let tall = self.video.as_ref().and_then(|v| v.height).unwrap_or(0);
        QUALITY_STEPS.iter().copied().filter(|h| *h + 40 < tall).collect()
    }

    pub fn quality(&self) -> Option<u32> {
        self.quality
    }

    /// Makes the picture smaller (or, with `None`, as the film is): cheaper to carry to the window on a slow
    /// computer, and the film goes on from where it is.
    pub fn set_quality(&mut self, height: Option<u32>) -> Result<(), PlaybackError> {
        let Some(video) = &self.video else { return Ok(()) };
        let (w, h) = (video.width.unwrap_or(0), video.height.unwrap_or(0));
        let size = match height {
            Some(tall) if h > tall && h > 0 => fit((w as u64 * tall as u64 / h as u64) as u32, tall),
            _ => fit(w, h),
        };
        self.quality = height.filter(|_| size != fit(w, h));
        if size == self.size {
            return Ok(());
        }
        let at = self.position();
        self.size = size;
        self.restart(at)
    }

    /// The voice remover needs the sound made again, from where it is.
    pub fn set_karaoke(&mut self, on: bool) -> Result<(), PlaybackError> {
        if self.settings.karaoke == on {
            return Ok(());
        }
        let at = self.position();
        self.settings.karaoke = on;
        self.restart(at)
    }

    /// The equalizer needs the sound made again, from where it is.
    pub fn set_equalizer(&mut self, eq: Equalizer) -> Result<(), PlaybackError> {
        let (before, after) = (equalizer_filters(&self.settings.equalizer), equalizer_filters(&eq));
        self.settings.equalizer = eq;
        if before == after {
            return Ok(());
        }
        let at = self.position();
        self.restart(at)
    }

    /// Dresses the picture anew, from where it is.
    pub fn set_picture(&mut self, picture: Picture) -> Result<(), PlaybackError> {
        if self.settings.picture == picture {
            return Ok(());
        }
        let at = self.position();
        self.settings.picture = picture;
        self.restart(at)
    }

    pub fn rate(&self) -> f64 {
        self.settings.rate
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.settings.volume = volume.clamp(0.0, 4.0);
        self.apply_volume();
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.settings.muted = muted;
        self.apply_volume();
    }

    /// Plays another sound track from where the film is now.
    pub fn set_audio_track(&mut self, track: usize) -> Result<(), PlaybackError> {
        let at = self.position();
        self.settings.audio_track = track.min(self.audio.len().saturating_sub(1));
        self.restart(at)
    }

    /// The picture that is due now, if it is a new one; `None` when the window already shows it (or none
    /// is due). Also notices the end.
    pub fn next_frame(&mut self) -> Option<Frame> {
        let clock = self.position();
        let frame = self.run.frames.due(clock);
        if let Some(frame) = &frame {
            self.last = Some(frame.clone());
        }
        // The end: the sound and the pictures are used up, and the clock has come to the length of the file.
        let finished = self.run.video_done.load(Ordering::Relaxed) && self.run.audio_done.load(Ordering::Relaxed);
        if finished && self.run.frames.is_empty() && self.shared.buffered() <= 0.0 && self.state == State::Playing {
            self.state = State::Ended;
            self.shared.set_paused(true);
            self.timer.stop();
        }
        frame
    }

    /// The last picture shown, for a window that draws again without a new one.
    pub fn current_frame(&self) -> Option<&Frame> {
        self.last.as_ref()
    }
}

impl Drop for Playback {
    fn drop(&mut self) {
        self.run.end();
    }
}

/// The heights a film can be watched at below its own (`QUALITY_STEPS` of the web player).
pub const QUALITY_STEPS: [u32; 6] = [2160, 1440, 1080, 720, 480, 360];

/// The size of the pictures asked of FFmpeg: the file's own, at most `MAX_WIDTH` wide, both even (some
/// scalers insist) — and never zero.
pub fn fit(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (2, 2);
    }
    let (w, h) = if width > MAX_WIDTH { (MAX_WIDTH, (height as u64 * MAX_WIDTH as u64 / width as u64) as u32) } else { (width, height) };
    ((w & !1).max(2), (h & !1).max(2))
}

fn seconds_arg(at: f64) -> String {
    format!("{:.3}", at.max(0.0))
}

fn read_frames(mut out: impl Read, width: u32, height: u32, fps: f64, start: f64, frames: &Frames, stop: &AtomicBool, done: &AtomicBool) {
    let bytes = (width * height * 4) as usize;
    let mut index = 0u64;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut bgra = vec![0u8; bytes];
        if out.read_exact(&mut bgra).is_err() {
            break;
        }
        let pts = start + index as f64 / fps;
        index += 1;
        if !frames.push(Frame { pts, width, height, bgra }) {
            break;
        }
    }
    done.store(true, Ordering::Relaxed);
}

fn read_sound(mut out: impl Read, shared: &Shared, stop: &AtomicBool, done: &AtomicBool) {
    let mut bytes = vec![0u8; 16 * 1024];
    // A sample is four bytes; a read may end in the middle of one.
    let mut carry: Vec<u8> = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        let n = match out.read(&mut bytes) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        carry.extend_from_slice(&bytes[..n]);
        let whole = carry.len() - carry.len() % 4;
        let samples: Vec<f32> = carry[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        carry.drain(..whole);
        if !shared.push(&samples, stop) {
            break;
        }
    }
    done.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pts: f64) -> Frame {
        Frame { pts, width: 2, height: 2, bgra: vec![0; 16] }
    }

    #[test]
    fn the_pictures_of_a_size_are_even_never_wider_than_the_limit_and_never_zero() {
        assert_eq!(fit(1280, 720), (1280, 720));
        assert_eq!(fit(1281, 721), (1280, 720));
        assert_eq!(fit(3840, 2160), (1920, 1080));
        assert_eq!(fit(4096, 1716), (1920, 804));
        assert_eq!(fit(0, 0), (2, 2));
        assert_eq!(fit(1, 1), (2, 2));
    }

    #[test]
    fn the_newest_picture_that_is_due_is_shown_and_older_ones_are_dropped() {
        let frames = Frames::new();
        for pts in [0.0, 0.04, 0.08, 0.12] {
            assert!(frames.push(frame(pts)));
        }
        assert!(frames.due(-0.5).is_none(), "nothing before its time");
        assert_eq!(frames.due(0.0).unwrap().pts, 0.0);
        assert!(frames.due(0.03).is_none(), "the next is not due");
        assert_eq!(frames.due(0.09).unwrap().pts, 0.08, "the clock ran past one: it is dropped, the later one shown");
        assert!(!frames.is_empty());
        frames.close();
        assert!(frames.is_empty() && !frames.push(frame(1.0)), "a closed queue takes nothing");
    }

    #[test]
    fn a_full_queue_waits_for_the_window() {
        let frames = Arc::new(Frames::new());
        for i in 0..FRAMES_AHEAD {
            assert!(frames.push(frame(i as f64)));
        }
        let pusher = {
            let frames = frames.clone();
            std::thread::spawn(move || frames.push(frame(99.0)))
        };
        std::thread::sleep(Duration::from_millis(120));
        assert!(!pusher.is_finished(), "the decoder waits");
        assert_eq!(frames.due(2.0).unwrap().pts, 2.0);
        assert!(pusher.join().unwrap());
    }
}
