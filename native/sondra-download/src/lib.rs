//! Fetching a resolved stream to a file.
//!
//! The Rust side of `fetchMedia` / `fetchHlsStream` / `downloadHls` (`src/lib/download.ts`,
//! `src/lib/studio.ts`) and of the direct-to-disk writing of `desktop/downloader.mjs`:
//!
//! * a direct file is written to disk as it arrives (`<name>.part`, renamed when whole) and resumed
//!   with `Range` when the connection breaks — nothing is held in memory;
//! * an HLS stream's segments come four at a time but are written in order, with a window, so memory
//!   stays at a few segments however long the film is; sound kept apart by the master is fetched
//!   too, and FFmpeg joins them into one MP4 by stream copy;
//! * a bandwidth limit holds for the whole download, whatever the number of connections;
//! * redirects are followed by hand, so a hop into this computer's own network is refused;
//! * an encrypted stream is refused with the same sentence the website uses: Sondra neither fetches
//!   keys nor circumvents copy protection.

mod http;
pub mod name;
mod throttle;

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use sondra_daemon::ports::FetchedFile;
use sondra_extract::hls;
use sondra_extract::stream::StreamInfo;

pub use name::safe_stem;
pub use throttle::Throttle;

/// Fewer bytes than this is not a playable file.
pub const MIN_MEDIA_BYTES: u64 = 1024;
const SEGMENT_RETRIES: u32 = 2;
const DIRECT_RETRIES: u32 = 3;
const WORKERS: usize = 4;
/// Segments fetched ahead of the one being written.
const WINDOW: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DownloadError {
    #[error("Übertragung abgebrochen.")]
    Cancelled,
    #[error("Server antwortete mit {0}.")]
    Status(u16),
    #[error("Der Link ist abgelaufen. Bitte die Adresse noch einmal suchen.")]
    Expired,
    #[error("Keine Verbindung: {0}")]
    Network(String),
    #[error("Von der Quelle kamen nur {0} Bytes — das ist keine abspielbare Datei.")]
    Empty(u64),
    #[error("Dieser Stream ist AES-verschlüsselt. Sondra lädt keine Schlüssel und umgeht keinen Kopierschutz.")]
    Encrypted,
    #[error("Die Playlist enthält keine Segmente.")]
    NoSegments,
    #[error("Die Adresse zeigt in dieses Netzwerk und wird nicht geladen.")]
    PrivateAddress,
    #[error("Zum Zusammensetzen des Streams fehlt FFmpeg.")]
    NeedsFfmpeg,
    #[error("Die Teile des Streams liessen sich nicht zu einer Datei zusammenfügen: {0}")]
    Merge(String),
    #[error("Datei nicht schreibbar: {0}")]
    Io(String),
}

impl From<std::io::Error> for DownloadError {
    fn from(e: std::io::Error) -> Self {
        DownloadError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Progress {
    pub loaded: u64,
    pub total: Option<u64>,
}

/// Stops a running download from another thread.
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
    fn check(&self) -> Result<(), DownloadError> {
        if self.is_cancelled() {
            Err(DownloadError::Cancelled)
        } else {
            Ok(())
        }
    }
}

pub struct Downloader {
    agent: ureq::Agent,
    throttle: Throttle,
    cancel: Cancel,
    /// Where FFmpeg is. `None`: `ffmpeg` on the path.
    pub ffmpeg: Option<PathBuf>,
    /// Lets addresses inside this network through. For tests against a server on this computer; a
    /// real download never sets it.
    pub allow_private: bool,
}

impl Downloader {
    /// `bandwidth_kib`: KiB per second for the whole download, or no limit.
    pub fn new(bandwidth_kib: Option<u32>, cancel: Cancel) -> Self {
        Self {
            agent: http::agent(Duration::from_secs(30)),
            throttle: Throttle::new(bandwidth_kib),
            cancel,
            ffmpeg: None,
            allow_private: false,
        }
    }

    /// How long a connection may say nothing before it counts as broken (30 s by default). Time spent
    /// waiting for the bandwidth limit does not count.
    pub fn with_stall_timeout(mut self, stall: Duration) -> Self {
        self.agent = http::agent(stall);
        self
    }

    /// Fetches the stream into `dir` under a name made from `stem`; returns what was written. An
    /// existing file is never replaced: the new one gets a number.
    pub fn download(
        &self,
        stream: &StreamInfo,
        dir: &Path,
        stem: &str,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<FetchedFile, DownloadError> {
        fs::create_dir_all(dir)?;
        let referer = Some(stream.referer.as_str()).filter(|r| !r.is_empty());
        let loaded = if stream.is_hls || stream.url.contains(".m3u8") {
            self.hls(&stream.url, referer, dir, stem, progress)?
        } else {
            self.direct(&stream.url, referer, dir, stem, progress)?
        };
        Ok(loaded)
    }

    /* A file as it is. */

    fn direct(
        &self,
        url: &str,
        referer: Option<&str>,
        dir: &Path,
        stem: &str,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<FetchedFile, DownloadError> {
        let extension = name::extension_of(url).unwrap_or("mp4");
        let target = name::free_path(dir, stem, extension);
        let part = with_suffix(&target, ".part");
        let mut file = fs::File::create(&part)?;
        let result = self.copy_resuming(url, referer, &mut file, progress);
        drop(file);
        match result {
            Ok(total) => {
                if total < MIN_MEDIA_BYTES {
                    let _ = fs::remove_file(&part);
                    return Err(DownloadError::Empty(total));
                }
                fs::rename(&part, &target)?;
                Ok(FetchedFile {
                    size: total,
                    path: target,
                })
            }
            Err(error) => {
                let _ = fs::remove_file(&part);
                Err(error)
            }
        }
    }

    /// Writes the body of `url` to `out`; after a break it asks for the rest with `Range` (and starts
    /// over when the server hands the whole file again instead).
    fn copy_resuming(
        &self,
        url: &str,
        referer: Option<&str>,
        out: &mut fs::File,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<u64, DownloadError> {
        let mut written: u64 = 0;
        let mut total: Option<u64> = None;
        let mut attempt = 0;
        loop {
            self.cancel.check()?;
            let range = (written > 0).then(|| format!("bytes={written}-"));
            let outcome = self
                .open(url, referer, range.as_deref())
                .and_then(|mut response| {
                    if range.is_some() && response.status != 206 {
                        // The server ignored the range and sends everything again.
                        out.set_len(0)?;
                        std::io::Seek::seek(out, std::io::SeekFrom::Start(0))?;
                        written = 0;
                    }
                    total = response.total_for(written).or(total);
                    self.pump(&mut response.body, out, &mut written, total, progress)
                });
            match outcome {
                Ok(()) => return Ok(written),
                Err(DownloadError::Network(_)) if attempt + 1 < DIRECT_RETRIES => {
                    attempt += 1;
                    self.pause(Duration::from_millis(800 * u64::from(attempt)))?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Reads `body` to its end into `out`, under the bandwidth limit.
    fn pump(
        &self,
        body: &mut dyn Read,
        out: &mut dyn Write,
        written: &mut u64,
        total: Option<u64>,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<(), DownloadError> {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            self.cancel.check()?;
            let n = body
                .read(&mut buffer)
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            if n == 0 {
                return Ok(());
            }
            self.throttle.take(n as u64, &self.cancel)?;
            out.write_all(&buffer[..n])?;
            *written += n as u64;
            progress(Progress {
                loaded: *written,
                total,
            });
        }
    }

    fn open(
        &self,
        url: &str,
        referer: Option<&str>,
        range: Option<&str>,
    ) -> Result<http::Opened, DownloadError> {
        http::open(&self.agent, url, referer, range, self.allow_private)
    }

    fn pause(&self, duration: Duration) -> Result<(), DownloadError> {
        let until = std::time::Instant::now() + duration;
        while std::time::Instant::now() < until {
            self.cancel.check()?;
            std::thread::sleep(Duration::from_millis(50));
        }
        self.cancel.check()
    }

    /* A stream put together from pieces. */

    fn hls(
        &self,
        url: &str,
        referer: Option<&str>,
        dir: &Path,
        stem: &str,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<FetchedFile, DownloadError> {
        let first = self.open(url, referer, None)?;
        let base = first.url.clone();
        let mut bytes = Vec::new();
        {
            // A playlist is small; a file that is not one is not read to the end here.
            let mut body = first.body;
            let mut head = vec![0u8; 64 * 1024];
            let n = body
                .read(&mut head)
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            head.truncate(n);
            if !hls::looks_like_playlist(&head) {
                // The media itself, put together by whatever sent it.
                return self.direct(url, referer, dir, stem, progress);
            }
            bytes.extend_from_slice(&head);
            body.take(2 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|e| DownloadError::Network(e.to_string()))?;
        }
        let top = hls::parse_with(&String::from_utf8_lossy(&bytes), &base, self.allow_private);
        let (media, sound) = if top.is_master {
            let variant = top.variants.first().ok_or(DownloadError::NoSegments)?;
            let media = self.playlist(&variant.url, referer)?;
            let sound = match hls::audio_for(&top, variant) {
                Some(r) => Some(self.playlist(&r.url, referer)?),
                None => None,
            };
            (media, sound)
        } else {
            (top, None)
        };
        for p in std::iter::once(&media).chain(sound.iter()) {
            if p.encrypted {
                return Err(DownloadError::Encrypted);
            }
            if p.segments.is_empty() {
                return Err(DownloadError::NoSegments);
            }
        }

        let work = tempfile::Builder::new()
            .prefix(".sondra-laden-")
            .tempdir_in(dir)?;
        let video_ts = work.path().join("video.ts");
        let audio_ts = work.path().join("audio.ts");
        let mut video_bytes = 0u64;
        self.segments(&media, referer, &video_ts, &mut |loaded| {
            video_bytes = loaded;
            progress(Progress {
                loaded,
                total: None,
            });
        })?;
        if let Some(sound) = &sound {
            self.segments(sound, referer, &audio_ts, &mut |loaded| {
                progress(Progress {
                    loaded: video_bytes + loaded,
                    total: None,
                });
            })?;
        }

        let out = work.path().join("out.mp4");
        self.remux(&video_ts, sound.as_ref().map(|_| audio_ts.as_path()), &out)?;
        let size = fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        if size < MIN_MEDIA_BYTES {
            return Err(DownloadError::Merge(
                "Meist hilft ein erneuter Versuch; bleibt es dabei, ist der Stream in einem Format, das FFmpeg hier nicht kennt.".into(),
            ));
        }
        let target = name::free_path(dir, stem, "mp4");
        if fs::rename(&out, &target).is_err() {
            fs::copy(&out, &target)?;
        }
        Ok(FetchedFile { size, path: target })
    }

    fn playlist(&self, url: &str, referer: Option<&str>) -> Result<hls::Playlist, DownloadError> {
        let opened = self.open(url, referer, None)?;
        let base = opened.url.clone();
        let mut text = Vec::new();
        opened
            .body
            .take(8 * 1024 * 1024)
            .read_to_end(&mut text)
            .map_err(|e| DownloadError::Network(e.to_string()))?;
        Ok(hls::parse_with(
            &String::from_utf8_lossy(&text),
            &base,
            self.allow_private,
        ))
    }

    /// Fetches every segment of `playlist`, a few at a time, and appends them to `file` in order.
    fn segments(
        &self,
        playlist: &hls::Playlist,
        referer: Option<&str>,
        file: &Path,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), DownloadError> {
        struct Shared {
            next: usize,
            written: usize,
            ready: std::collections::BTreeMap<usize, Vec<u8>>,
            error: Option<DownloadError>,
        }
        let total = playlist.segments.len();
        let state = Mutex::new(Shared {
            next: 0,
            written: 0,
            ready: Default::default(),
            error: None,
        });
        let wake = Condvar::new();
        let mut out = fs::File::create(file)?;
        let mut bytes = 0u64;

        let result = std::thread::scope(|scope| {
            for _ in 0..WORKERS.min(total) {
                scope.spawn(|| loop {
                    let index = {
                        let mut s = state.lock().expect("lock");
                        loop {
                            if s.error.is_some() || s.next >= total {
                                return;
                            }
                            if s.next < s.written + WINDOW {
                                break;
                            }
                            s = wake.wait(s).expect("wait");
                        }
                        let i = s.next;
                        s.next += 1;
                        i
                    };
                    let fetched = self.segment(
                        &playlist.segments[index],
                        playlist.ranges.get(index).copied().flatten(),
                        referer,
                        index,
                    );
                    let mut s = state.lock().expect("lock");
                    match fetched {
                        Ok(chunk) => {
                            s.ready.insert(index, chunk);
                        }
                        Err(e) => {
                            s.error.get_or_insert(e);
                        }
                    }
                    wake.notify_all();
                });
            }
            // The writer: in order, as they come.
            let mut outcome = Ok(());
            let mut s = state.lock().expect("lock");
            while s.written < total {
                if let Some(e) = s.error.clone() {
                    outcome = Err(e);
                    break;
                }
                let at = s.written;
                if let Some(chunk) = s.ready.remove(&at) {
                    s.written += 1;
                    wake.notify_all();
                    drop(s);
                    if let Err(e) = out.write_all(&chunk) {
                        outcome = Err(e.into());
                        s = state.lock().expect("lock");
                        s.error.get_or_insert(DownloadError::Io("write".into()));
                        wake.notify_all();
                        break;
                    }
                    bytes += chunk.len() as u64;
                    progress(bytes);
                    s = state.lock().expect("lock");
                } else {
                    s = wake
                        .wait_timeout(s, Duration::from_millis(200))
                        .expect("wait")
                        .0;
                    if self.cancel.is_cancelled() {
                        s.error.get_or_insert(DownloadError::Cancelled);
                    }
                }
            }
            if outcome.is_err() {
                s.error.get_or_insert(DownloadError::Cancelled);
                wake.notify_all();
            }
            outcome
        });
        result?;
        out.flush()?;
        if bytes < MIN_MEDIA_BYTES {
            return Err(DownloadError::Empty(bytes));
        }
        Ok(())
    }

    /// One segment, with a second and third try for a dropped connection or a host that hiccuped.
    fn segment(
        &self,
        url: &str,
        range: Option<hls::ByteRange>,
        referer: Option<&str>,
        index: usize,
    ) -> Result<Vec<u8>, DownloadError> {
        let header = range.map(|r| format!("bytes={}-{}", r.start, r.end));
        let mut attempt = 0;
        loop {
            self.cancel.check()?;
            let result = self
                .open(url, referer, header.as_deref())
                .and_then(|mut opened| {
                    let mut chunk = Vec::new();
                    let mut buffer = vec![0u8; 64 * 1024];
                    loop {
                        self.cancel.check()?;
                        let n = opened
                            .body
                            .read(&mut buffer)
                            .map_err(|e| DownloadError::Network(e.to_string()))?;
                        if n == 0 {
                            break;
                        }
                        self.throttle.take(n as u64, &self.cancel)?;
                        chunk.extend_from_slice(&buffer[..n]);
                    }
                    // A host that ignores Range sends the whole file; the segment is the part asked for.
                    if let Some(r) = range {
                        if opened.status == 200 && (chunk.len() as u64) > r.end {
                            chunk = chunk[r.start as usize..=r.end as usize].to_vec();
                        }
                    }
                    Ok(chunk)
                });
            match result {
                Ok(chunk) => return Ok(chunk),
                Err(DownloadError::Status(code)) if code < 500 => {
                    let _ = index;
                    return Err(DownloadError::Status(code));
                }
                Err(
                    e @ (DownloadError::Cancelled
                    | DownloadError::PrivateAddress
                    | DownloadError::Expired),
                ) => return Err(e),
                Err(e) if attempt >= SEGMENT_RETRIES => return Err(e),
                Err(_) => {
                    attempt += 1;
                    self.pause(Duration::from_millis(400 * u64::from(attempt)))?;
                }
            }
        }
    }

    /// Stream copy of the pieces into one MP4: picture and, where the master kept it apart, sound.
    fn remux(&self, video: &Path, audio: Option<&Path>, out: &Path) -> Result<(), DownloadError> {
        let program = self
            .ffmpeg
            .clone()
            .unwrap_or_else(|| PathBuf::from("ffmpeg"));
        let mut command = std::process::Command::new(&program);
        command
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(video);
        match audio {
            Some(audio) => {
                command
                    .arg("-i")
                    .arg(audio)
                    .args(["-map", "0:v:0?", "-map", "1:a:0"]);
            }
            None => {
                command.args(["-map", "0:v:0?", "-map", "0:a:0?"]);
            }
        }
        command.args(["-c", "copy", "-dn", "-sn"]).arg(out);
        let output = command.output().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                DownloadError::NeedsFfmpeg
            } else {
                DownloadError::Merge(e.to_string())
            }
        })?;
        if !output.status.success() {
            let text = String::from_utf8_lossy(&output.stderr);
            return Err(DownloadError::Merge(
                text.lines().last().unwrap_or("").to_owned(),
            ));
        }
        Ok(())
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}
