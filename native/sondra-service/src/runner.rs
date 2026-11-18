//! The service's loop: where its files live, reading what was chosen, running rounds, telling in
//! words what a round did.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sondra_core::config::{Config, KeepAwake};
use sondra_core::merkliste::Shared;
use sondra_core::schedule::{keep_awake, Wait};
use sondra_core::state::State;
use sondra_daemon::ports::{Host, Library};
use sondra_daemon::round::{run_round, Ports, Report};
use sondra_download::Cancel;

use crate::AwakeGuard;

/// Where the service keeps its own files: `%APPDATA%\Sondra\Dienst` on Windows. `SONDRA_DIENST_DIR`
/// replaces it (for tests, and for a portable setup).
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SONDRA_DIENST_DIR") {
        return dir.into();
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Sondra").join("Dienst");
        }
    }
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(home).join("sondra-dienst");
    }
    std::env::var_os("HOME")
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
        .join(".local/share/sondra-dienst")
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("einstellungen.json")
}
pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("stand.json")
}
pub fn key_path(dir: &Path) -> PathBuf {
    dir.join("google-schluessel.bin")
}
pub fn log_path(dir: &Path) -> PathBuf {
    dir.join("dienst.log")
}

/// What was chosen. A missing file is the defaults — everything off; a broken one is an error that
/// is told, not silently replaced by defaults that could differ from what the person chose.
pub fn load_config(dir: &Path) -> io::Result<Config> {
    match fs::read(config_path(dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("einstellungen.json: {e}"),
            )
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e),
    }
}

pub fn save_config(dir: &Path, config: &Config) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = config_path(dir);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(config)?)?;
    fs::rename(&temp, &path)
}

/// Remembers the last list it read, so that a report can name series instead of ids.
pub struct RecordingLibrary<L: Library> {
    inner: L,
    last: Mutex<Option<Shared>>,
}

impl<L: Library> RecordingLibrary<L> {
    pub fn new(inner: L) -> Self {
        Self {
            inner,
            last: Mutex::new(None),
        }
    }

    /// Series titles by id, from the last read.
    pub fn titles(&self) -> BTreeMap<String, String> {
        self.last
            .lock()
            .expect("lock")
            .as_ref()
            .map(|s| {
                s.items
                    .iter()
                    .map(|i| (i.id.clone(), i.title.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl<L: Library> Library for RecordingLibrary<L> {
    fn read(&self) -> Result<Shared, String> {
        let shared = self.inner.read()?;
        *self.last.lock().expect("lock") = Some(shared.clone());
        Ok(shared)
    }
}

pub fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0).replace('.', ",")
}

/// What a round did, one line each. Nothing for a quiet round.
pub fn describe(report: &Report, titles: &BTreeMap<String, String>) -> Vec<String> {
    let name = |id: &str| titles.get(id).cloned().unwrap_or_else(|| id.to_owned());
    let mut lines = Vec::new();
    if let Some(error) = &report.library_error {
        lines.push(format!(
            "Die Merkliste konnte nicht gelesen werden: {error}"
        ));
        return lines;
    }
    for (id, season, episode) in &report.announced {
        lines.push(format!(
            "Neu online: {} · Staffel {season}, Folge {episode}",
            name(id)
        ));
    }
    for (id, why) in &report.check_failed {
        lines.push(format!("Suche bei {} nicht möglich: {why}", name(id)));
    }
    for d in &report.deleted {
        lines.push(format!(
            "In den Papierkorb gelegt (gesehen): {} · Staffel {}, Folge {} ({})",
            name(&d.series_id),
            d.season,
            d.episode,
            gb(d.size)
        ));
    }
    for (d, why) in &report.delete_failed {
        lines.push(format!(
            "Konnte nicht in den Papierkorb: {} ({why})",
            d.path.display()
        ));
    }
    if report.still_over {
        lines.push("Die Speichergrenze ist überschritten, aber es liegen nur noch ungesehene Folgen da — es wird nichts gelöscht.".into());
    }
    match report.waited {
        Some(Wait::OutsideWindow) => {
            lines.push("Es wird gewartet: außerhalb des gewählten Zeitfensters.".into())
        }
        Some(Wait::OnBattery) => lines.push("Es wird gewartet: der Rechner läuft auf Akku.".into()),
        Some(Wait::MeteredConnection) => {
            lines.push("Es wird gewartet: die Verbindung ist getaktet.".into())
        }
        None => {}
    }
    for want in &report.fetched {
        lines.push(format!(
            "Geladen: {} · Staffel {}, Folge {}",
            want.title, want.season, want.episode
        ));
    }
    for (want, why) in &report.fetch_failed {
        lines.push(format!(
            "Nicht geladen: {} · Staffel {}, Folge {} — {why}",
            want.title, want.season, want.episode
        ));
    }
    if let Some(error) = &report.save_error {
        lines.push(format!(
            "Der Stand konnte nicht gespeichert werden: {error}"
        ));
    }
    lines
}

/// A line in the log with the time, kept below about a megabyte (the older half goes to `.alt`).
pub fn log(dir: &Path, now_ms: i64, message: &str) {
    let path = log_path(dir);
    let _ = fs::create_dir_all(dir);
    if fs::metadata(&path).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = fs::rename(&path, path.with_extension("log.alt"));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {message}", timestamp(now_ms));
    }
}

/// `2026-11-18 23:45:09` in UTC (the log is for people comparing it to the clock they know, but a
/// zone-free format that never lies about daylight saving is worth more to a log than a pretty one).
pub fn timestamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// One round with the files of `dir`: reads what was chosen, runs it, logs what happened. The
/// computer is kept awake as chosen — for the round only with "while fetching", the loop holds it
/// for "always".
pub fn run_once(
    dir: &Path,
    ports: &Ports,
    titles: &dyn Fn() -> BTreeMap<String, String>,
) -> io::Result<Report> {
    let config = load_config(dir)?;
    let mut state = State::load(&state_path(dir))?;
    let _awake = (keep_awake(&config, true) && config.keep_awake == KeepAwake::WhileFetching)
        .then(AwakeGuard::new);
    let report = run_round(&config, &mut state, &state_path(dir), ports);
    let now = ports.host.now_ms();
    for line in describe(&report, &titles()) {
        log(dir, now, &line);
    }
    Ok(report)
}

/// Runs rounds until `stop`: one now, then one every `check_every_minutes` (read again each time, so
/// a changed setting applies at the next round). When a round has nothing left to fetch and nothing
/// went wrong, `on_done` is called — once per quiet streak — if shutting down when done was chosen.
pub fn run_loop(
    dir: &Path,
    ports: &Ports,
    titles: &dyn Fn() -> BTreeMap<String, String>,
    stop: &Cancel,
    on_done: &dyn Fn(),
) {
    let host: &dyn Host = ports.host;
    log(dir, host.now_ms(), "Dienst gestartet.");
    let mut was_done = false;
    // Held for as long as the loop runs, when that is what was chosen.
    let mut always: Option<AwakeGuard> = None;
    while !stop.is_cancelled() {
        let config = match load_config(dir) {
            Ok(c) => c,
            Err(e) => {
                log(
                    dir,
                    host.now_ms(),
                    &format!("Einstellungen nicht lesbar: {e}"),
                );
                Config::default()
            }
        };
        match (config.keep_awake == KeepAwake::Always, always.is_some()) {
            (true, false) => always = Some(AwakeGuard::new()),
            (false, true) => always = None,
            _ => {}
        }
        match run_once(dir, ports, titles) {
            Ok(report) => {
                if report.done && !was_done && config.shutdown_when_done {
                    log(
                        dir,
                        host.now_ms(),
                        "Alles geladen — der Rechner wird heruntergefahren.",
                    );
                    on_done();
                }
                was_done = report.done;
            }
            Err(e) => log(dir, host.now_ms(), &format!("Runde nicht möglich: {e}")),
        }
        let wait = Duration::from_secs(u64::from(config.check_every_minutes.max(1)) * 60);
        let until = Instant::now() + wait;
        while Instant::now() < until && !stop.is_cancelled() {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    log(dir, host.now_ms(), "Dienst beendet.");
}

/// Only one service per data folder: an exclusive lock on a file, which Windows and Unix both give
/// back when the process ends, however it ends.
pub struct InstanceLock {
    _file: fs::File,
}

impl InstanceLock {
    /// `Ok(None)`: another one is running.
    pub fn acquire(dir: &Path) -> io::Result<Option<InstanceLock>> {
        fs::create_dir_all(dir)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("dienst.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(InstanceLock { _file: file })),
            Err(fs::TryLockError::WouldBlock) => Ok(None),
            Err(fs::TryLockError::Error(e)) => Err(e),
        }
    }
}
