//! The loop around a round: what was chosen, what is told, when it stops.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use sondra_core::config::Config;
use sondra_core::merkliste::{read_shared, Item, Online, Shared};
use sondra_core::plan::Want;
use sondra_core::schedule::{Conditions, Wait};
use sondra_daemon::ports::{Checker, FetchedFile, Fetcher, Host, Library, Trash};
use sondra_daemon::round::{Ports, Report};
use sondra_download::Cancel;
use sondra_service::runner::*;
use sondra_service::InstanceLock;

const JSON: &[u8] = include_bytes!("../../sondra-core/tests/fixtures/merkliste.json");

#[test]
fn the_log_has_the_time_in_a_form_that_never_lies() {
    assert_eq!(timestamp(0), "1970-01-01 00:00:00 UTC");
    assert_eq!(timestamp(1_763_509_509_000), "2025-11-18 23:45:09 UTC");
    assert_eq!(
        timestamp(1_709_164_800_000),
        "2024-02-29 00:00:00 UTC",
        "a leap day"
    );
    assert_eq!(
        timestamp(951_782_400_000),
        "2000-02-29 00:00:00 UTC",
        "the century that is one"
    );
    assert_eq!(timestamp(-1000), "1969-12-31 23:59:59 UTC");
}

#[test]
fn what_was_chosen_is_read_back_and_a_broken_file_is_told() {
    let dir = tempfile::tempdir().unwrap();
    // Nothing chosen yet: everything off.
    assert_eq!(load_config(dir.path()).unwrap(), Config::default());
    let mut config = Config::default();
    config.auto_series.insert("frieren".into());
    config.storage_limit_gb = Some(50);
    config.folder = Some(r"D:\Serien".into());
    config.language = "ger_sub".into();
    save_config(dir.path(), &config).unwrap();
    assert_eq!(load_config(dir.path()).unwrap(), config);
    // A file with a typo is an error, not a silent return to the defaults.
    std::fs::write(config_path(dir.path()), b"{ \"ahead\": ").unwrap();
    let err = load_config(dir.path()).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(err.to_string().contains("einstellungen.json"));
    // Fields that are not there are the defaults (an older file stays valid).
    std::fs::write(config_path(dir.path()), br#"{ "ahead": 5 }"#).unwrap();
    let older = load_config(dir.path()).unwrap();
    assert_eq!(
        (older.ahead, older.storage_limit_gb, older.folder),
        (5, None, None)
    );
}

#[test]
fn a_round_is_told_in_words_and_a_quiet_one_in_none() {
    let titles: BTreeMap<String, String> = [("frieren".to_owned(), "Frieren".to_owned())].into();
    assert!(describe(&Report::default(), &titles).is_empty());

    let report = Report {
        announced: vec![("frieren".into(), 1, 29)],
        waited: Some(Wait::OnBattery),
        still_over: true,
        fetched: vec![Want {
            series_id: "frieren".into(),
            title: "Frieren".into(),
            url: String::new(),
            season: 1,
            episode: 12,
        }],
        fetch_failed: vec![(
            Want {
                series_id: "x".into(),
                title: "Naruto".into(),
                url: String::new(),
                season: 2,
                episode: 3,
            },
            "VOE: Server antwortete mit 404.".into(),
        )],
        ..Report::default()
    };
    let lines = describe(&report, &titles);
    assert_eq!(lines[0], "Neu online: Frieren · Staffel 1, Folge 29");
    assert!(lines.iter().any(|l| l.contains("läuft auf Akku")));
    assert!(
        lines.iter().any(|l| l.contains("nichts gelöscht")),
        "the promise is said when it was kept"
    );
    assert!(lines.contains(&"Geladen: Frieren · Staffel 1, Folge 12".to_owned()));
    assert!(lines.contains(
        &"Nicht geladen: Naruto · Staffel 2, Folge 3 — VOE: Server antwortete mit 404.".to_owned()
    ));

    // An unreadable list ends the story there.
    let broken = Report {
        library_error: Some("Bei Google Drive ist niemand angemeldet.".into()),
        ..Report::default()
    };
    assert_eq!(
        describe(&broken, &titles),
        ["Die Merkliste konnte nicht gelesen werden: Bei Google Drive ist niemand angemeldet."]
    );
}

#[test]
fn the_log_is_kept_small() {
    let dir = tempfile::tempdir().unwrap();
    log(dir.path(), 0, "erste Zeile");
    assert_eq!(
        std::fs::read_to_string(log_path(dir.path())).unwrap(),
        "1970-01-01 00:00:00 UTC erste Zeile\n"
    );
    std::fs::write(log_path(dir.path()), vec![b'x'; 1_100_000]).unwrap();
    log(dir.path(), 1000, "neue Zeile");
    let now = std::fs::read_to_string(log_path(dir.path())).unwrap();
    assert_eq!(now, "1970-01-01 00:00:01 UTC neue Zeile\n");
    assert!(
        log_path(dir.path()).with_extension("log.alt").exists(),
        "the old half is kept once"
    );
}

/* A whole loop with fakes -------------------------------------------------------------------- */

struct Lib(Shared);
impl Library for Lib {
    fn read(&self) -> Result<Shared, String> {
        Ok(self.0.clone())
    }
}
struct Nothing;
impl Checker for Nothing {
    fn latest(&self, _: &Item) -> Result<Option<Online>, String> {
        Ok(None)
    }
}
struct Fetch<'a>(&'a AtomicUsize, &'a Path);
impl Fetcher for Fetch<'_> {
    fn fetch(&self, want: &Want, _: Option<u32>) -> Result<FetchedFile, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let path = self.1.join(format!(
            "{}-{}-{}.mp4",
            want.series_id, want.season, want.episode
        ));
        std::fs::write(&path, b"x".repeat(2048)).map_err(|e| e.to_string())?;
        Ok(FetchedFile { path, size: 2048 })
    }
}
struct NoTrash;
impl Trash for NoTrash {
    fn trash(&self, _: &Path) -> io::Result<()> {
        Ok(())
    }
}
struct Clock(Cell<i64>);
impl Host for Clock {
    fn now_ms(&self) -> i64 {
        self.0.get()
    }
    fn conditions(&self) -> Conditions {
        Conditions {
            hour: 12,
            on_ac: true,
            metered: false,
        }
    }
}

#[test]
fn a_loop_runs_a_round_logs_it_and_stops_when_told() {
    let dir = tempfile::tempdir().unwrap();
    let media = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.auto_series.insert("frieren".into());
    config.ahead = 2;
    config.check_every_minutes = 60;
    save_config(dir.path(), &config).unwrap();

    let library = RecordingLibrary::new(Lib(read_shared(JSON).unwrap()));
    // The list has to have been read for titles to exist.
    assert!(library.titles().is_empty());
    let fetched = AtomicUsize::new(0);
    let fetcher = Fetch(&fetched, media.path());
    let host = Clock(Cell::new(1_763_509_509_000));
    let ports = Ports {
        library: &library,
        checker: &Nothing,
        fetcher: &fetcher,
        trash: &NoTrash,
        host: &host,
    };

    // Stop from another thread once the first round is done.
    let stop = Cancel::new();
    let titles = || library.titles();
    std::thread::scope(|s| {
        let stop2 = stop.clone();
        let log = log_path(dir.path());
        s.spawn(move || {
            for _ in 0..200 {
                if std::fs::read_to_string(&log).is_ok_and(|t| t.contains("Geladen: Frieren")) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            stop2.cancel();
        });
        run_loop(dir.path(), &ports, &titles, &stop, &|| {
            panic!("shutdown was not chosen")
        });
    });

    assert_eq!(fetched.load(Ordering::SeqCst), 2, "two ahead, as chosen");
    let text = std::fs::read_to_string(log_path(dir.path())).unwrap();
    assert!(
        text.starts_with("2025-11-18 23:45:09 UTC Dienst gestartet."),
        "{text}"
    );
    assert!(
        text.contains("Geladen: Frieren · Staffel 1, Folge 11"),
        "{text}"
    );
    assert!(
        text.contains("Geladen: Frieren · Staffel 1, Folge 12"),
        "{text}"
    );
    assert!(text.trim_end().ends_with("Dienst beendet."), "{text}");
    // What was fetched is remembered across runs.
    let state = sondra_core::state::State::load(&state_path(dir.path())).unwrap();
    assert_eq!(state.fetched.len(), 2);
}

#[test]
fn shutting_down_when_done_happens_once_and_only_when_chosen() {
    let dir = tempfile::tempdir().unwrap();
    let media = tempfile::tempdir().unwrap();
    // Nothing chosen for fetching: a round is "done" at once.
    let mut config = Config::default();
    config.shutdown_when_done = true;
    config.check_every_minutes = 1;
    save_config(dir.path(), &config).unwrap();
    let library = RecordingLibrary::new(Lib(read_shared(JSON).unwrap()));
    let fetched = AtomicUsize::new(0);
    let fetcher = Fetch(&fetched, media.path());
    let host = Clock(Cell::new(0));
    let ports = Ports {
        library: &library,
        checker: &Nothing,
        fetcher: &fetcher,
        trash: &NoTrash,
        host: &host,
    };
    let stop = Cancel::new();
    let calls = AtomicUsize::new(0);
    let titles = || library.titles();
    run_loop(dir.path(), &ports, &titles, &stop, &|| {
        calls.fetch_add(1, Ordering::SeqCst);
        stop.cancel();
    });
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fetched.load(Ordering::SeqCst), 0);
    assert!(std::fs::read_to_string(log_path(dir.path()))
        .unwrap()
        .contains("heruntergefahren"));
}

#[test]
fn only_one_service_runs_per_folder() {
    let dir = tempfile::tempdir().unwrap();
    let first = InstanceLock::acquire(dir.path())
        .unwrap()
        .expect("the first gets it");
    assert!(
        InstanceLock::acquire(dir.path()).unwrap().is_none(),
        "the second is told"
    );
    drop(first);
    assert!(
        InstanceLock::acquire(dir.path()).unwrap().is_some(),
        "given back with the process"
    );
    // Another folder is another service.
    let other = tempfile::tempdir().unwrap();
    let _a = InstanceLock::acquire(dir.path()).unwrap().unwrap();
    assert!(InstanceLock::acquire(other.path()).unwrap().is_some());
}
