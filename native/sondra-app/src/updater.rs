//! Keeping the installed program current. The twin of `desktop/updater.mjs`, without Electron: a newer version is
//! looked for in `latest-nativ.yml` beside the releases (the same flat YAML electron-builder writes), loaded in the
//! background, checked against the SHA-512 in that file, and installed on a click — the setup runs silently (Windows
//! asks for permission as it did the first time) and Sondra opens again. Left alone, nothing is installed.
//!
//! * the first look comes twenty seconds after the start, then every six hours;
//! * a file whose sum does not match is thrown away and never run;
//! * nothing is looked for unless this is the installed program (`Deinstallieren.exe` beside it) or a feed is
//!   named (`SONDRA_UPDATE_FEED`) — a build under test or on a developer's machine never updates itself;
//! * the address is the release page of Sondra, and TLS is always verified.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use sha2::{Digest, Sha512};

pub const FEED: &str = "https://github.com/bananaaboy/Sondra/releases/latest/download";
pub const FILE: &str = "latest-nativ.yml";
pub const FIRST: Duration = Duration::from_secs(20);
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// A file the update is offered as: where, its SHA-512 (base64, as electron-builder writes it) and its size.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateFile {
    pub url: String,
    pub sha512: String,
    pub size: u64,
}

/// What `latest-nativ.yml` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Latest {
    pub version: String,
    pub files: Vec<UpdateFile>,
}

/// Where the update stands, for the card and the „Was ist neu“ window.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Not looked for (not the installed program).
    Off,
    Idle,
    Checking,
    /// Looked, nothing newer.
    Current,
    /// A newer version is being loaded; the fraction so far, when the size is known.
    Downloading { version: String, fraction: Option<f32> },
    /// Loaded and checked: waits for the click.
    Ready { version: String, file: PathBuf },
    Failed(String),
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches(|c| c == '\'' || c == '"').to_string()
}

/// The version, and the files, out of the flat YAML. Anything it does not know is passed over.
pub fn parse_latest(text: &str) -> Result<Latest, String> {
    let mut version = None;
    let mut files: Vec<UpdateFile> = Vec::new();
    let (mut path, mut sum) = (None, None);
    let mut in_files = false;
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('-');
        if !indented {
            in_files = line.trim_end() == "files:";
            if let Some(v) = line.strip_prefix("version:") {
                version = Some(unquote(v));
            } else if let Some(v) = line.strip_prefix("path:") {
                path = Some(unquote(v));
            } else if let Some(v) = line.strip_prefix("sha512:") {
                sum = Some(unquote(v));
            }
            continue;
        }
        if !in_files {
            continue;
        }
        let trimmed = line.trim_start().trim_start_matches('-').trim_start();
        if let Some(v) = trimmed.strip_prefix("url:") {
            files.push(UpdateFile { url: unquote(v), sha512: String::new(), size: 0 });
        } else if let (Some(v), Some(file)) = (trimmed.strip_prefix("sha512:"), files.last_mut()) {
            file.sha512 = unquote(v);
        } else if let (Some(v), Some(file)) = (trimmed.strip_prefix("size:"), files.last_mut()) {
            file.size = unquote(v).parse().unwrap_or(0);
        }
    }
    let version = version.filter(|v| !v.is_empty()).ok_or("latest-nativ.yml nennt keine Version")?;
    if files.is_empty() {
        // The old shape: one file at the top.
        if let (Some(url), Some(sha512)) = (path, sum) {
            files.push(UpdateFile { url, sha512, size: 0 });
        }
    }
    files.retain(|f| !f.url.is_empty() && !f.sha512.is_empty());
    if files.is_empty() {
        return Err("latest-nativ.yml nennt keine Datei mit Prüfsumme".into());
    }
    Ok(Latest { version, files })
}

/// True when version `a` (x.y.z) is later than `b`.
pub fn later(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.split('.').map(|p| p.trim().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (x, y) = (parts(a), parts(b));
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if p != q {
            return p > q;
        }
    }
    false
}

/// The file made for this computer: one whose name carries its processor (`arm64`), else the first that does not
/// name another (so the x64 setup stays first and an arm64 one is added behind it).
pub fn pick<'a>(files: &'a [UpdateFile], arm: bool) -> Option<&'a UpdateFile> {
    let tag = |f: &UpdateFile| f.url.to_ascii_lowercase().contains("arm64");
    files.iter().find(|f| tag(f) == arm).or_else(|| files.first())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(30))).http_status_as_error(false).build().into()
}

/// Looks at the feed: `Some` when a version later than `current` is offered.
pub fn check(feed: &str, current: &str) -> Result<Option<Latest>, String> {
    let url = format!("{}/{FILE}", feed.trim_end_matches('/'));
    let mut response = agent().get(&url).header("Cache-Control", "no-cache").call().map_err(|e| format!("{FILE}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{FILE}: HTTP {}", response.status().as_u16()));
    }
    let text = response.body_mut().with_config().limit(64 * 1024).read_to_string().map_err(|e| format!("{FILE}: {e}"))?;
    let latest = parse_latest(&text)?;
    Ok(later(&latest.version, current).then_some(latest))
}

/// Loads `file` into `dir`, checks the SHA-512 and the size, and returns where it lies. A file that does not match is
/// removed. `progress` gets (loaded, total).
pub fn download(feed: &str, file: &UpdateFile, dir: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf, String> {
    let url = if file.url.starts_with("http://") || file.url.starts_with("https://") { file.url.clone() } else { format!("{}/{}", feed.trim_end_matches('/'), file.url.trim_start_matches('/')) };
    // Only the name of the file counts: whatever path the YAML names stays out of the folder's way.
    let name = Path::new(file.url.rsplit('/').next().unwrap_or("Sondra-Nativ-Setup.exe")).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Sondra-Nativ-Setup.exe".into());
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (part, done) = (dir.join(format!("{name}.part")), dir.join(&name));
    let mut response = agent().get(&url).call().map_err(|e| format!("{name}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("{name}: HTTP {}", response.status().as_u16()));
    }
    let total = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).or((file.size > 0).then_some(file.size));
    let mut reader = response.body_mut().as_reader();
    let mut out = std::fs::File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
    let mut hash = Sha512::new();
    let (mut loaded, mut buffer) = (0u64, vec![0u8; 64 * 1024]);
    let failed = |part: &Path, text: String| {
        let _ = std::fs::remove_file(part);
        text
    };
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(failed(&part, "Abgebrochen.".into()));
        }
        let n = reader.read(&mut buffer).map_err(|e| failed(&part, format!("{name}: {e}")))?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        out.write_all(&buffer[..n]).map_err(|e| failed(&part, format!("{}: {e}", part.display())))?;
        loaded += n as u64;
        progress(loaded, total);
    }
    drop(out);
    let sum = base64::engine::general_purpose::STANDARD.encode(hash.finalize());
    if sum != file.sha512 || (file.size > 0 && loaded != file.size) {
        return Err(failed(&part, "Die geladene Datei stimmt nicht mit der Prüfsumme überein und wird nicht benutzt.".into()));
    }
    std::fs::rename(&part, &done).map_err(|e| format!("{}: {e}", done.display()))?;
    Ok(done)
}

/// Runs the setup silently and asks it to start Sondra again afterwards; the caller then ends Sondra. The setup
/// asks Windows for permission itself.
pub fn start_setup(file: &Path) -> Result<(), String> {
    std::process::Command::new(file).args(["/S", "/relaunch"]).spawn().map(|_| ()).map_err(|e| format!("{}: {e}", file.display()))
}

/// Is this the installed program (the setup's uninstaller lies beside it)?
pub fn is_installed() -> bool {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("Deinstallieren.exe").exists())).unwrap_or(false)
}

/// The feed to look at: the one named in `SONDRA_UPDATE_FEED`, else the release page; `None` when this program is
/// not to look (not installed and no feed named).
pub fn feed() -> Option<String> {
    match std::env::var("SONDRA_UPDATE_FEED") {
        Ok(feed) if !feed.trim().is_empty() => Some(feed),
        _ => (is_installed() && !crate::store::is_portable()).then(|| FEED.to_string()),
    }
}

/// Where loaded setups are kept: beside the other data of the program, in `Aktualisierung`.
pub fn folder() -> PathBuf {
    crate::store::data_dir().unwrap_or_else(std::env::temp_dir).join("Aktualisierung")
}

#[cfg(test)]
mod tests {
    use super::*;

    const YAML: &str = "version: 1.2.4\nfiles:\n  - url: Sondra-Nativ-Setup-1.2.4.exe\n    sha512: AAA=\n    size: 100\n  - url: Sondra-Nativ-Setup-arm64-1.2.4.exe\n    sha512: BBB=\n    size: 200\npath: Sondra-Nativ-Setup-1.2.4.exe\nsha512: AAA=\nreleaseDate: '2026-11-19T10:00:00.000Z'\n";

    #[test]
    fn the_yaml_electron_builder_writes_is_read() {
        let l = parse_latest(YAML).unwrap();
        assert_eq!(l.version, "1.2.4");
        assert_eq!(l.files.len(), 2);
        assert_eq!(l.files[1], UpdateFile { url: "Sondra-Nativ-Setup-arm64-1.2.4.exe".into(), sha512: "BBB=".into(), size: 200 });
        // The old shape: one file at the top.
        let old = parse_latest("version: '1.0.0'\npath: a.exe\nsha512: CCC=\n").unwrap();
        assert_eq!(old.files, [UpdateFile { url: "a.exe".into(), sha512: "CCC=".into(), size: 0 }]);
        assert!(parse_latest("files:\n  - url: a.exe\n    sha512: X=\n").is_err(), "no version");
        assert!(parse_latest("version: 1.0.0\n").is_err(), "no file");
        assert!(parse_latest("version: 1.0.0\nfiles:\n  - url: a.exe\n").is_err(), "no sum");
    }

    #[test]
    fn a_later_version_is_later_by_numbers_not_by_letters() {
        assert!(later("1.2.4", "1.2.3"));
        assert!(later("1.10.0", "1.9.9"));
        assert!(later("2.0", "1.99.99"));
        assert!(!later("1.2.3", "1.2.3"));
        assert!(!later("1.2.2", "1.2.3"));
    }

    #[test]
    fn the_file_for_this_processor_is_taken_and_the_first_when_none_names_it() {
        let l = parse_latest(YAML).unwrap();
        assert!(pick(&l.files, true).unwrap().url.contains("arm64"));
        assert!(!pick(&l.files, false).unwrap().url.contains("arm64"));
        assert_eq!(pick(&l.files[..1], true).unwrap().url, l.files[0].url, "the first when nothing names it");
        assert!(pick(&[], false).is_none());
    }
}
