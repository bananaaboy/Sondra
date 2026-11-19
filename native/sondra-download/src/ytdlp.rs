//! yt-dlp for the portals Sondra has no extractor of its own for — the Rust side of the yt-dlp part of
//! `desktop/downloader.mjs`.
//!
//! * the program is looked for where it usually is (Sondra's own copy, WinGet, the path); it is
//!   fetched **only when the person says so**, from yt-dlp's own releases, and only if it matches the
//!   published SHA-256 — and not at all when `fetches` is off (the Store build may not load program
//!   code it did not ship);
//! * a download runs it with a progress template Sondra can read, and stopping it kills the process;
//! * what it complains about is turned into a sentence the page can say; its own last error line is
//!   kept for the person who wants it;
//! * TLS is never switched off: the website's bridge passes `--no-check-certificates`, this does not.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sha2::Digest;
use sondra_daemon::ports::FetchedFile;

use crate::{Cancel, Progress};

/// yt-dlp's own releases; a test points this at a server of its own.
pub const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
/// The own copy is brought up to date after this long.
pub const UPDATE_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The program's file on this system, as the release names it.
pub const fn asset_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp_linux"
    }
}

/// What the own copy is called on disk.
pub const fn own_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// What went wrong, as the page can explain it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum YtdlpError {
    #[error("Übertragung abgebrochen.")]
    Cancelled,
    #[error("yt-dlp ist nicht installiert.")]
    Missing,
    #[error("Mit dieser Adresse kann yt-dlp nichts anfangen.")]
    Unsupported,
    #[error("Das Video ist privat oder nur für Mitglieder.")]
    Private,
    #[error("Das Video ist nicht mehr verfügbar.")]
    Unavailable,
    #[error("Dafür verlangt die Seite eine Anmeldung. Sondra meldet sich nirgends an.")]
    SignIn,
    #[error("Das Video ist ab 18 und verlangt eine Anmeldung.")]
    Age,
    #[error("Das Video ist in diesem Land nicht verfügbar.")]
    Region,
    #[error("Die Seite bremst gerade: zu viele Anfragen. Bitte später noch einmal.")]
    RateLimited,
    #[error("Die Seite hat sich geändert, und diese yt-dlp-Fassung kennt das noch nicht. Ein Update hilft meist.")]
    Outdated,
    #[error("yt-dlp konnte nicht geladen werden: {0}")]
    Install(String),
    #[error("yt-dlp meldet: {0}")]
    Failed(String),
    #[error("Datei nicht schreibbar: {0}")]
    Io(String),
}

impl YtdlpError {
    /// Whether a newer yt-dlp may well fix it.
    pub fn outdated(&self) -> bool {
        matches!(self, YtdlpError::Outdated)
    }
}

/// The error a stderr text means, in the order the website's service reads it.
pub fn error_of(stderr: &str) -> YtdlpError {
    let text = stderr.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&["nsig extraction failed", "signature extraction failed", "please update", "latest version", "unable to extract player", "unable to extract initial player", "requested format is not available"]) {
        return YtdlpError::Outdated;
    }
    if has(&["429", "too many requests", "rate-limit", "rate limit", "temporarily blocked", "quota exceeded"]) {
        return YtdlpError::RateLimited;
    }
    if has(&["confirm your age", "age-restricted", "age gate", "requires age verification"]) {
        return YtdlpError::Age;
    }
    if has(&["not available in your country", "geo-block", "geoblock", "geo restrict", "geo-restrict", "restricted in your country", "restricted in your region", "not available in your region", "georestricted"]) {
        return YtdlpError::Region;
    }
    // Before the sign-in check: "Private video. Sign in if you have been granted access" is a private
    // video, not a login problem — no login of Sondra's would open it.
    if has(&["private video", "members-only"]) {
        return YtdlpError::Private;
    }
    if has(&["not a bot", "sign in to confirm", "login required", "sign in if you have been granted access"]) {
        return YtdlpError::SignIn;
    }
    if has(&["unsupported url", "is not a valid url"]) {
        return YtdlpError::Unsupported;
    }
    if has(&["video unavailable", "has been removed", "this video has been deleted"]) {
        return YtdlpError::Unavailable;
    }
    if has(&["no video formats", "unable to extract"]) {
        return YtdlpError::Unsupported;
    }
    YtdlpError::Failed(detail_of(stderr))
}

/// yt-dlp's last line that names an error, without its prefix and the "see …" tail.
pub fn detail_of(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.trim().lines().collect();
    let not_trace = |l: &&&str| {
        let l = l.to_lowercase();
        l.contains("error") && !l.contains("traceback") && !l.contains("file \"") && !l.contains("downloaderror:")
    };
    let line = lines.iter().rfind(not_trace).copied().or_else(|| lines.iter().rfind(|l| l.to_lowercase().contains("error")).copied()).or_else(|| lines.last().copied()).unwrap_or("");
    let mut line = line.trim().to_string();
    if let Some(rest) = line.strip_prefix("ERROR:") {
        line = rest.trim().to_string();
        // "[youtube] abc: " names the extractor, not the problem.
        if line.starts_with('[') {
            if let Some(end) = line.find(']') {
                line = line[end + 1..].trim().to_string();
            }
        }
    }
    for marker in ["See http", "Also see http", "see http"] {
        if let Some(at) = line.find(marker) {
            line.truncate(at);
        }
    }
    line.trim().chars().take(240).collect()
}

/// A yt-dlp that runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tool {
    pub bin: PathBuf,
    pub version: String,
}

/// Where yt-dlp is looked for, in order: Sondra's own copy, WinGet's, the path.
pub fn candidates(data_dir: &Path, system: bool) -> Vec<PathBuf> {
    let mut list = vec![data_dir.join(own_name())];
    if cfg!(windows) && system {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            list.push(local.join("Microsoft").join("WinGet").join("Links").join("yt-dlp.exe"));
            list.push(local.join("Microsoft").join("WinGet").join("Packages").join("yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe").join("yt-dlp.exe"));
            list.push(local.join("Microsoft").join("WindowsApps").join("yt-dlp.exe"));
        }
    }
    let mut list: Vec<PathBuf> = list.into_iter().filter(|p| p.exists()).collect();
    if system {
        list.push(PathBuf::from("yt-dlp"));
    }
    list
}

/// `SONDRA_YTDLP` names a program outright (a test's, or a person's own build). `system: false` looks
/// only at Sondra's own copy — for tests that must not depend on what is installed on the machine.
pub fn locate(data_dir: &Path, system: bool) -> Option<Tool> {
    let mut list = Vec::new();
    if let Some(own) = std::env::var_os("SONDRA_YTDLP").map(PathBuf::from) {
        list.push(own);
    }
    list.extend(candidates(data_dir, system));
    list.into_iter().find_map(|bin| {
        let out = Command::new(&bin).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| Tool { version: String::from_utf8_lossy(&out.stdout).trim().to_string(), bin })
    })
}

/// Whether the own copy is old enough to be brought up to date.
pub fn is_stale(data_dir: &Path) -> bool {
    fs::metadata(data_dir.join(own_name())).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age >= UPDATE_AFTER)
}

/// Fetches yt-dlp into `data_dir` — **only called when the person agreed** — and checks it against the
/// checksum the release publishes. `releases` ends in a slash. Nothing is written when the sums differ.
pub fn install(data_dir: &Path, releases: &str, cancel: &Cancel) -> Result<PathBuf, YtdlpError> {
    let fail = |m: String| YtdlpError::Install(m);
    let agent = crate::http::agent(Duration::from_secs(60));
    let asset = asset_name();

    let mut sums = String::new();
    agent.get(&format!("{releases}SHA2-256SUMS")).call().map_err(|e| fail(format!("Prüfsummen nicht erreichbar ({e})")))?.into_body().into_reader().take(1 << 20).read_to_string(&mut sums).map_err(|e| fail(e.to_string()))?;
    let expected = sums
        .lines()
        .find(|l| l.trim().ends_with(&format!(" {asset}")) || l.trim().ends_with(&format!("*{asset}")))
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_lowercase)
        .ok_or_else(|| fail(format!("Keine Prüfsumme für {asset}")))?;

    fs::create_dir_all(data_dir).map_err(|e| YtdlpError::Io(e.to_string()))?;
    let partial = data_dir.join(format!("{}.partial", own_name()));
    let result = (|| {
        let mut body = agent.get(&format!("{releases}{asset}")).call().map_err(|e| fail(format!("yt-dlp nicht erreichbar ({e})")))?.into_body().into_reader();
        let mut file = fs::File::create(&partial).map_err(|e| YtdlpError::Io(e.to_string()))?;
        let mut hasher = sha2::Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if cancel.is_cancelled() {
                return Err(YtdlpError::Cancelled);
            }
            let n = body.read(&mut buf).map_err(|e| fail(e.to_string()))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| YtdlpError::Io(e.to_string()))?;
        }
        drop(file);
        if hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>() != expected {
            return Err(fail("Die geladene Datei passt nicht zur veröffentlichten Prüfsumme.".into()));
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&partial);
        return Err(e);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&partial, fs::Permissions::from_mode(0o755));
    }
    let own = data_dir.join(own_name());
    fs::rename(&partial, &own).map_err(|e| YtdlpError::Io(e.to_string()))?;
    Ok(own)
}

/// The numbers a progress line carries: `SONDRA <downloaded> <total> <estimate>`, each `NA` when unknown.
pub fn parse_progress(line: &str) -> Option<Progress> {
    let rest = line.trim().strip_prefix("SONDRA ")?;
    let mut parts = rest.split_whitespace().map(|p| p.parse::<f64>().ok());
    let loaded = parts.next()??;
    let total = parts.next().flatten().or_else(|| parts.next().flatten());
    Some(Progress { loaded: loaded as u64, total: total.filter(|t| *t > 0.0).map(|t| t as u64) })
}

/// The marker with which Sondra has yt-dlp print the finished file's path.
const PATH_MARK: &str = "SONDRAFILE ";

/// The arguments of one download, besides the address.
pub fn download_args(dir: &Path, ffmpeg: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = [
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--no-simulate",
        "--windows-filenames",
        "--socket-timeout",
        "20",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--progress",
        "--progress-template",
        "download:SONDRA %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--print",
        "after_move:SONDRAFILE %(filepath)s",
        "-o",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    args.push(dir.join("%(title).150B.%(ext)s").to_string_lossy().into_owned());
    if let Some(ffmpeg) = ffmpeg {
        args.push("--ffmpeg-location".into());
        args.push(ffmpeg.to_string_lossy().into_owned());
    }
    args
}

/// Loads `address` with yt-dlp into `dir`. `progress` hears how far it is; `cancel` kills the process.
pub fn download(tool: &Tool, address: &str, dir: &Path, ffmpeg: Option<&Path>, cancel: &Cancel, progress: &mut dyn FnMut(Progress)) -> Result<FetchedFile, YtdlpError> {
    fs::create_dir_all(dir).map_err(|e| YtdlpError::Io(e.to_string()))?;
    let mut command = Command::new(&tool.bin);
    command.args(download_args(dir, ffmpeg)).arg("--").arg(address).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { YtdlpError::Missing } else { YtdlpError::Io(e.to_string()) })?;

    // stderr is read on the side, so a full pipe never holds yt-dlp up.
    let errors = Arc::new(Mutex::new(String::new()));
    let stderr = child.stderr.take();
    let reader = {
        let errors = errors.clone();
        std::thread::spawn(move || {
            if let Some(stderr) = stderr {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let mut all = errors.lock().expect("lock");
                    all.push_str(&line);
                    all.push('\n');
                }
            }
        })
    };

    // A killer that watches for cancel while this thread reads yt-dlp's lines.
    let pid_done = Arc::new(Mutex::new(false));
    let killer = {
        let (cancel, done) = (cancel.clone(), pid_done.clone());
        let handle = child.id();
        std::thread::spawn(move || loop {
            if *done.lock().expect("lock") {
                return;
            }
            if cancel.is_cancelled() {
                kill(handle);
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        })
    };

    let mut finished: Option<PathBuf> = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(p) = parse_progress(&line) {
                progress(p);
            } else if let Some(path) = line.strip_prefix(PATH_MARK) {
                finished = Some(PathBuf::from(path.trim()));
            }
        }
    }
    let status = child.wait();
    *pid_done.lock().expect("lock") = true;
    let _ = killer.join();
    let _ = reader.join();

    if cancel.is_cancelled() {
        sweep_partials(dir);
        return Err(YtdlpError::Cancelled);
    }
    let errors = errors.lock().expect("lock").clone();
    if !status.map(|s| s.success()).unwrap_or(false) {
        return Err(error_of(&errors));
    }
    let path = finished.filter(|p| p.exists()).ok_or_else(|| YtdlpError::Failed("yt-dlp hat keine Datei gemeldet.".into()))?;
    let size = fs::metadata(&path).map_err(|e| YtdlpError::Io(e.to_string()))?.len();
    Ok(FetchedFile { path, size })
}

/// A cancelled load leaves yt-dlp's `.part` files; they are of no use to anyone.
fn sweep_partials(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".part") || name.ends_with(".ytdl") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

fn kill(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut c);
        let _ = c.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
    }
}

fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Whether an address looks like a list of videos (a playlist, a set, an album) rather than one.
pub fn is_playlist_address(address: &str) -> bool {
    let a = address.to_lowercase();
    let playlist_page = a.find("/playlist").is_some_and(|at| a[at + 9..].chars().next().is_none_or(|c| !c.is_alphanumeric() && c != '_'));
    a.contains("?list=") || a.contains("&list=") || playlist_page || a.contains("/sets/") || a.contains("/album/")
}

/// One video of a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub title: String,
    pub url: String,
}

/// The videos behind a list address (`--flat-playlist`: nothing is loaded, only named). Empty when the
/// address is not a list after all.
pub fn playlist(tool: &Tool, address: &str) -> Result<(String, Vec<Entry>), YtdlpError> {
    let mut command = Command::new(&tool.bin);
    command.args(["--flat-playlist", "-J", "--no-warnings", "--socket-timeout", "20", "--"]).arg(address).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);
    let out = command.output().map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { YtdlpError::Missing } else { YtdlpError::Io(e.to_string()) })?;
    if !out.status.success() {
        return Err(error_of(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(parse_playlist(&String::from_utf8_lossy(&out.stdout)))
}

/// The title and the videos of yt-dlp's `-J` answer for a list.
pub fn parse_playlist(json: &str) -> (String, Vec<Entry>) {
    let Ok(info) = serde_json::from_str::<serde_json::Value>(json) else { return (String::new(), Vec::new()) };
    let text = |v: &serde_json::Value, key: &str| v[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    let title = text(&info, "title").unwrap_or_else(|| "Playlist".into());
    let entries = info["entries"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|e| {
                    let url = text(e, "url").or_else(|| text(e, "id").map(|id| format!("https://www.youtube.com/watch?v={id}")))?;
                    Some(Entry { title: text(e, "title").unwrap_or_else(|| "Video".into()), url })
                })
                .collect()
        })
        .unwrap_or_default();
    (title, entries)
}

/// Brings the own copy up to date (`yt-dlp -U`); true when its version changed.
pub fn update(data_dir: &Path) -> bool {
    let own = data_dir.join(own_name());
    if !own.exists() {
        return false;
    }
    let before = locate_at(&own);
    let mut c = Command::new(&own);
    c.arg("-U").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut c);
    if !c.status().map(|s| s.success()).unwrap_or(false) {
        return false;
    }
    let now = std::time::SystemTime::now();
    let _ = fs::File::options().write(true).open(&own).and_then(|f| f.set_modified(now));
    locate_at(&own) != before
}

fn locate_at(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_are_read() {
        assert_eq!(parse_progress("SONDRA 1000 4000 NA"), Some(Progress { loaded: 1000, total: Some(4000) }));
        assert_eq!(parse_progress("SONDRA 1000 NA 5000"), Some(Progress { loaded: 1000, total: Some(5000) }));
        assert_eq!(parse_progress("SONDRA 1000 NA NA"), Some(Progress { loaded: 1000, total: None }));
        assert_eq!(parse_progress("[download] 12%"), None);
    }

    #[test]
    fn lists_are_told_from_single_videos() {
        assert!(is_playlist_address("https://www.youtube.com/watch?v=a&list=PL1"));
        assert!(is_playlist_address("https://www.youtube.com/playlist?list=PL1"));
        assert!(is_playlist_address("https://soundcloud.com/x/sets/y"));
        assert!(is_playlist_address("https://x.example/album/1"));
        assert!(!is_playlist_address("https://www.youtube.com/watch?v=a"));
        assert!(!is_playlist_address("https://x.example/playlists-of-the-year"));
    }

    #[test]
    fn a_list_answer_gives_its_title_and_videos() {
        let json = r#"{"title":"Meine Liste","entries":[{"title":"Eins","url":"https://x.example/1"},{"id":"abc"},{"title":"ohne"}]}"#;
        let (title, entries) = parse_playlist(json);
        assert_eq!(title, "Meine Liste");
        assert_eq!(entries, [Entry { title: "Eins".into(), url: "https://x.example/1".into() }, Entry { title: "Video".into(), url: "https://www.youtube.com/watch?v=abc".into() }]);
        assert_eq!(parse_playlist("kein json"), (String::new(), Vec::new()));
    }

    #[test]
    fn a_private_video_is_not_a_sign_in_problem() {
        let said = "ERROR: [youtube] abc: Private video. Sign in if you have been granted access to this video";
        assert_eq!(error_of(said), YtdlpError::Private);
        assert_eq!(error_of("ERROR: [youtube] abc: Sign in to confirm you're not a bot"), YtdlpError::SignIn);
        assert_eq!(error_of("ERROR: Unsupported URL: https://x.example/"), YtdlpError::Unsupported);
        assert_eq!(error_of("ERROR: HTTP Error 429: Too Many Requests"), YtdlpError::RateLimited);
    }

    #[test]
    fn what_is_unknown_keeps_yt_dlps_own_line() {
        let said = "WARNING: x\nERROR: [site] id: Something odd happened. See https://example.com/help for more";
        assert_eq!(error_of(said), YtdlpError::Failed("id: Something odd happened.".into()));
    }
}
