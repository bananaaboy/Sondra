//! A round played through with fakes for everything outside.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

use sondra_core::config::{Config, Window};
use sondra_core::merkliste::{read_shared, Item, Online, Shared};
use sondra_core::plan::Want;
use sondra_core::schedule::{Conditions, Wait};
use sondra_core::state::{Fetched, State};
use sondra_daemon::ports::{Checker, FetchedFile, Fetcher, Host, Library, Trash};
use sondra_daemon::round::{run_round, Ports, Report};

const JSON: &[u8] = include_bytes!("../../sondra-core/tests/fixtures/merkliste.json");

fn shared() -> Shared {
    read_shared(JSON).unwrap()
}

struct FakeLibrary(Result<Shared, String>);
impl Library for FakeLibrary {
    fn read(&self) -> Result<Shared, String> {
        self.0.clone()
    }
}

#[derive(Default)]
struct FakeChecker {
    found: BTreeMap<String, Result<Option<Online>, String>>,
}
impl Checker for FakeChecker {
    fn latest(&self, item: &Item) -> Result<Option<Online>, String> {
        self.found.get(&item.id).cloned().unwrap_or(Ok(None))
    }
}

struct FakeHost {
    hour: Cell<u8>,
    on_ac: Cell<bool>,
}
impl Host for FakeHost {
    fn now_ms(&self) -> i64 {
        42
    }
    fn conditions(&self) -> Conditions {
        Conditions {
            hour: self.hour.get(),
            on_ac: self.on_ac.get(),
            metered: false,
        }
    }
}

struct FakeFetcher<'a> {
    host: &'a FakeHost,
    fail_series: BTreeSet<String>,
    /// Fail a series only after this many successes of it.
    fail_after: Option<(String, usize)>,
    /// After the first success, the clock moves to this hour.
    clock_to: Option<u8>,
    calls: RefCell<Vec<(String, u32, u32)>>,
    seen_bandwidth: RefCell<Vec<Option<u32>>>,
}
impl<'a> FakeFetcher<'a> {
    fn new(host: &'a FakeHost) -> Self {
        FakeFetcher {
            host,
            fail_series: BTreeSet::new(),
            fail_after: None,
            clock_to: None,
            calls: RefCell::default(),
            seen_bandwidth: RefCell::default(),
        }
    }
}
impl Fetcher for FakeFetcher<'_> {
    fn fetch(&self, want: &Want, bandwidth_kib: Option<u32>) -> Result<FetchedFile, String> {
        self.seen_bandwidth.borrow_mut().push(bandwidth_kib);
        let done = self
            .calls
            .borrow()
            .iter()
            .filter(|c| c.0 == want.series_id)
            .count();
        if self.fail_series.contains(&want.series_id)
            || self
                .fail_after
                .as_ref()
                .is_some_and(|(id, n)| *id == want.series_id && done >= *n)
        {
            return Err("die Seite lehnt ab".into());
        }
        self.calls
            .borrow_mut()
            .push((want.series_id.clone(), want.season, want.episode));
        if let Some(hour) = self.clock_to {
            self.host.hour.set(hour);
        }
        Ok(FetchedFile {
            path: PathBuf::from(format!(
                "{}-s{}e{}.mkv",
                want.series_id, want.season, want.episode
            )),
            size: 1000,
        })
    }
}

#[derive(Default)]
struct FakeTrash {
    trashed: RefCell<Vec<PathBuf>>,
    already_gone: BTreeSet<PathBuf>,
    denied: BTreeSet<PathBuf>,
}
impl Trash for FakeTrash {
    fn trash(&self, path: &Path) -> io::Result<()> {
        if self.already_gone.contains(path) {
            return Err(io::ErrorKind::NotFound.into());
        }
        if self.denied.contains(path) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        self.trashed.borrow_mut().push(path.to_owned());
        Ok(())
    }
}

fn host() -> FakeHost {
    FakeHost {
        hour: Cell::new(12),
        on_ac: Cell::new(true),
    }
}

fn auto(ids: &[&str]) -> Config {
    Config {
        auto_series: ids.iter().map(|s| s.to_string()).collect(),
        ..Config::default()
    }
}

struct Run {
    report: Report,
    state: State,
    state_path: PathBuf,
    _dir: tempfile::TempDir,
}

fn run(
    config: &Config,
    state: State,
    library: &Result<Shared, String>,
    checker: &FakeChecker,
    fetcher: &FakeFetcher,
    trash: &FakeTrash,
) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("zustand.json");
    let mut state = state;
    let report = run_round(
        config,
        &mut state,
        &state_path,
        &Ports {
            library: &FakeLibrary(library.clone()),
            checker,
            fetcher,
            trash,
            host: fetcher.host,
        },
    );
    Run {
        report,
        state,
        state_path,
        _dir: dir,
    }
}

fn ids(calls: &RefCell<Vec<(String, u32, u32)>>) -> Vec<(String, u32, u32)> {
    calls.borrow().clone()
}

#[test]
fn fetches_what_is_wanted_and_remembers_it_on_disk() {
    let host = host();
    let fetcher = FakeFetcher::new(&host);
    let config = Config {
        bandwidth_kib: Some(500),
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );

    assert_eq!(
        ids(&fetcher.calls),
        [
            ("frieren".into(), 1, 11),
            ("frieren".into(), 1, 12),
            ("frieren".into(), 1, 13)
        ]
    );
    assert_eq!(r.report.fetched.len(), 3);
    assert!(r.report.done, "three are ready, nothing is left to do");
    assert_eq!(State::load(&r.state_path).unwrap(), r.state);
    assert_eq!(r.state.fetched.len(), 3);
    assert_eq!(
        *fetcher.seen_bandwidth.borrow(),
        [Some(500); 3],
        "the limit reaches the fetcher"
    );
}

#[test]
fn a_second_round_fetches_nothing_new() {
    let host = host();
    let fetcher = FakeFetcher::new(&host);
    let first = run(
        &auto(&["frieren"]),
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    let again = FakeFetcher::new(&host);
    let second = run(
        &auto(&["frieren"]),
        first.state,
        &Ok(shared()),
        &FakeChecker::default(),
        &again,
        &FakeTrash::default(),
    );
    assert!(again.calls.borrow().is_empty());
    assert!(second.report.done);
}

#[test]
fn outside_the_window_nothing_is_fetched() {
    let host = host();
    host.hour.set(14);
    let fetcher = FakeFetcher::new(&host);
    let config = Config {
        window: Some(Window { from: 22, to: 6 }),
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    assert_eq!(r.report.waited, Some(Wait::OutsideWindow));
    assert!(fetcher.calls.borrow().is_empty());
    assert!(!r.report.done);
}

#[test]
fn a_window_that_ends_in_the_middle_of_a_run_stops_it() {
    let host = host();
    host.hour.set(11);
    let mut fetcher = FakeFetcher::new(&host);
    fetcher.clock_to = Some(12);
    let config = Config {
        window: Some(Window { from: 8, to: 12 }),
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    assert_eq!(fetcher.calls.borrow().len(), 1);
    assert_eq!(r.report.waited, Some(Wait::OutsideWindow));
    assert_eq!(r.state.fetched.len(), 1, "what was fetched is kept");
}

#[test]
fn on_battery_waits_when_chosen() {
    let host = host();
    host.on_ac.set(false);
    let fetcher = FakeFetcher::new(&host);
    let config = Config {
        only_on_ac: true,
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    assert_eq!(r.report.waited, Some(Wait::OnBattery));
}

#[test]
fn a_site_that_refuses_is_not_asked_again_and_does_not_block_the_others() {
    let host = host();
    let mut fetcher = FakeFetcher::new(&host);
    fetcher.fail_series.insert("frieren".into());
    let r = run(
        &auto(&["frieren", "rezero"]),
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    assert_eq!(r.report.fetch_failed.len(), 1, "one refusal, not three");
    assert_eq!(r.report.fetched.len(), 3);
    assert!(r.report.fetched.iter().all(|w| w.series_id == "rezero"));
    assert!(!r.report.done);
}

#[test]
fn what_was_fetched_before_a_failure_is_already_on_disk() {
    let host = host();
    let mut fetcher = FakeFetcher::new(&host);
    fetcher.fail_after = Some(("frieren".into(), 1));
    let r = run(
        &auto(&["frieren"]),
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    let on_disk = State::load(&r.state_path).unwrap();
    assert_eq!(on_disk.fetched.len(), 1);
    assert_eq!(r.report.fetch_failed.len(), 1);
}

#[test]
fn a_newer_episode_online_is_announced_once() {
    let host = host();
    let mut checker = FakeChecker::default();
    checker.found.insert(
        "frieren".into(),
        Ok(Some(Online {
            max_season: 1,
            max_episode: 15,
            checked_at: 1,
        })),
    );
    let config = Config {
        ahead: 0,
        ..auto(&["frieren"])
    };
    let first = run(
        &config,
        State::default(),
        &Ok(shared()),
        &checker,
        &FakeFetcher::new(&host),
        &FakeTrash::default(),
    );
    assert_eq!(first.report.announced, [("frieren".to_string(), 1, 15)]);
    assert_eq!(first.state.online["frieren"].max_episode, 15);
    let second = run(
        &config,
        first.state,
        &Ok(shared()),
        &checker,
        &FakeFetcher::new(&host),
        &FakeTrash::default(),
    );
    assert!(
        second.report.announced.is_empty(),
        "the same episode is not announced twice"
    );
}

#[test]
fn the_first_look_at_a_series_only_notes_where_it_stands() {
    let host = host();
    let mut list = shared();
    list.items[0].online_available = None;
    let mut checker = FakeChecker::default();
    checker.found.insert(
        "frieren".into(),
        Ok(Some(Online {
            max_season: 1,
            max_episode: 14,
            checked_at: 1,
        })),
    );
    let config = Config {
        ahead: 0,
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        State::default(),
        &Ok(list),
        &checker,
        &FakeFetcher::new(&host),
        &FakeTrash::default(),
    );
    assert!(r.report.announced.is_empty());
    assert_eq!(r.state.online["frieren"].max_episode, 14);
}

#[test]
fn an_older_find_never_takes_news_away() {
    let host = host();
    let mut checker = FakeChecker::default();
    checker.found.insert(
        "frieren".into(),
        Ok(Some(Online {
            max_season: 1,
            max_episode: 5,
            checked_at: 1,
        })),
    );
    let r = run(
        &auto(&["frieren"]),
        State::default(),
        &Ok(shared()),
        &checker,
        &FakeFetcher::new(&host),
        &FakeTrash::default(),
    );
    assert!(r.report.announced.is_empty());
    assert!(!r.state.online.contains_key("frieren"));
}

#[test]
fn a_failed_look_is_reported_but_fetching_goes_on() {
    let host = host();
    let mut checker = FakeChecker::default();
    checker
        .found
        .insert("frieren".into(), Err("keine Verbindung".into()));
    let fetcher = FakeFetcher::new(&host);
    let r = run(
        &auto(&["frieren"]),
        State::default(),
        &Ok(shared()),
        &checker,
        &fetcher,
        &FakeTrash::default(),
    );
    assert_eq!(r.report.check_failed.len(), 1);
    assert_eq!(
        fetcher.calls.borrow().len(),
        3,
        "what the list already knows is still fetched"
    );
    assert!(!r.report.done);
}

fn fetched(series: &str, episode: u32, size: u64, at: i64) -> Fetched {
    Fetched {
        series_id: series.into(),
        season: 1,
        episode,
        path: PathBuf::from(format!("{series}-s1e{episode}.mkv")),
        size,
        fetched_at: at,
    }
}

fn over_the_limit() -> State {
    let mut state = State::default();
    // 1.8 GB of seen episodes, one of them the oldest.
    state.record(fetched("frieren", 2, 600_000_000, 20));
    state.record(fetched("frieren", 1, 600_000_000, 10));
    state.record(fetched("frieren", 3, 600_000_000, 30));
    state
}

#[test]
fn tidies_up_the_oldest_seen_files_into_the_recycle_bin() {
    let host = host();
    let trash = FakeTrash::default();
    let config = Config {
        storage_limit_gb: Some(1),
        ahead: 0,
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        over_the_limit(),
        &Ok(shared()),
        &FakeChecker::default(),
        &FakeFetcher::new(&host),
        &trash,
    );
    assert_eq!(
        *trash.trashed.borrow(),
        [
            PathBuf::from("frieren-s1e1.mkv"),
            PathBuf::from("frieren-s1e2.mkv")
        ]
    );
    assert_eq!(r.report.deleted.len(), 2);
    assert_eq!(r.state.fetched.len(), 1);
    assert_eq!(State::load(&r.state_path).unwrap(), r.state);
}

#[test]
fn a_file_that_is_gone_already_is_forgotten() {
    let host = host();
    let mut trash = FakeTrash::default();
    trash.already_gone.insert(PathBuf::from("frieren-s1e1.mkv"));
    let config = Config {
        storage_limit_gb: Some(1),
        ahead: 0,
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        over_the_limit(),
        &Ok(shared()),
        &FakeChecker::default(),
        &FakeFetcher::new(&host),
        &trash,
    );
    assert!(!r.state.fetched.iter().any(|f| f.episode == 1));
    assert!(r.report.delete_failed.is_empty());
}

#[test]
fn a_file_that_cannot_be_moved_stays_on_the_books() {
    let host = host();
    let mut trash = FakeTrash::default();
    trash.denied.insert(PathBuf::from("frieren-s1e1.mkv"));
    let config = Config {
        storage_limit_gb: Some(1),
        ahead: 0,
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        over_the_limit(),
        &Ok(shared()),
        &FakeChecker::default(),
        &FakeFetcher::new(&host),
        &trash,
    );
    assert_eq!(r.report.delete_failed.len(), 1);
    assert!(
        r.state.fetched.iter().any(|f| f.episode == 1),
        "still there, so still counted"
    );
}

#[test]
fn nothing_is_deleted_without_a_limit() {
    let host = host();
    let trash = FakeTrash::default();
    let config = Config {
        ahead: 0,
        ..auto(&["frieren"])
    };
    run(
        &config,
        over_the_limit(),
        &Ok(shared()),
        &FakeChecker::default(),
        &FakeFetcher::new(&host),
        &trash,
    );
    assert!(trash.trashed.borrow().is_empty());
}

#[test]
fn an_unreadable_list_changes_nothing() {
    let host = host();
    let fetcher = FakeFetcher::new(&host);
    let trash = FakeTrash::default();
    let config = Config {
        storage_limit_gb: Some(1),
        ..auto(&["frieren"])
    };
    let r = run(
        &config,
        over_the_limit(),
        &Err("Drive nicht erreichbar".into()),
        &FakeChecker::default(),
        &fetcher,
        &trash,
    );
    assert_eq!(
        r.report.library_error.as_deref(),
        Some("Drive nicht erreichbar")
    );
    assert!(fetcher.calls.borrow().is_empty());
    assert!(trash.trashed.borrow().is_empty());
    assert_eq!(r.state.fetched.len(), 3);
}

#[test]
fn nothing_chosen_means_nothing_happens() {
    let host = host();
    let fetcher = FakeFetcher::new(&host);
    let r = run(
        &Config::default(),
        State::default(),
        &Ok(shared()),
        &FakeChecker::default(),
        &fetcher,
        &FakeTrash::default(),
    );
    assert!(fetcher.calls.borrow().is_empty());
    assert!(r.report.done);
}
