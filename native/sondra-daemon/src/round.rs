//! One round: look, tidy, fetch.

use std::collections::BTreeSet;
use std::io;
use std::path::Path;

use sondra_core::cleanup::{plan_cleanup, Deletion};
use sondra_core::config::Config;
use sondra_core::merkliste::Status;
use sondra_core::plan::{latest_online, wanted, Want};
use sondra_core::schedule::{allowed, Wait};
use sondra_core::state::{Fetched, State};

use crate::ports::{Checker, Fetcher, Host, Library, Trash};

/// What a round did, for the log and for the notices.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// The list could not be read; nothing else happened.
    pub library_error: Option<String>,
    /// New episodes found online that were not known before: series and episode.
    pub announced: Vec<(String, u32, u32)>,
    pub check_failed: Vec<(String, String)>,
    pub deleted: Vec<Deletion>,
    /// A file that could not be moved to the Recycle Bin.
    pub delete_failed: Vec<(Deletion, String)>,
    /// Over the limit with only unseen episodes left to delete.
    pub still_over: bool,
    /// Fetching had to wait, and why.
    pub waited: Option<Wait>,
    pub fetched: Vec<Want>,
    pub fetch_failed: Vec<(Want, String)>,
    /// Nothing is left to fetch and nothing went wrong: the moment for
    /// "shut down when done", if that was chosen.
    pub done: bool,
    /// The state could not be saved.
    pub save_error: Option<String>,
}

pub struct Ports<'a> {
    pub library: &'a dyn Library,
    pub checker: &'a dyn Checker,
    pub fetcher: &'a dyn Fetcher,
    pub trash: &'a dyn Trash,
    pub host: &'a dyn Host,
}

/// Runs one round and keeps `state_path` current after every step that
/// changed something, so that a crash or a shutdown loses at most the file
/// that was being fetched.
pub fn run_round(config: &Config, state: &mut State, state_path: &Path, ports: &Ports) -> Report {
    let mut report = Report::default();
    let shared = match ports.library.read() {
        Ok(shared) => shared,
        Err(error) => {
            report.library_error = Some(error);
            return report;
        }
    };

    // 1. Look for new episodes, in the series chosen for fetching only.
    let mut changed = false;
    for item in shared.alive() {
        if item.status != Status::Watching
            || item.url.is_empty()
            || !config.auto_series.contains(&item.id)
        {
            continue;
        }
        match ports.checker.latest(item) {
            Ok(Some(found)) => {
                let before = latest_online(item, state);
                let newer = |a: &sondra_core::merkliste::Online| (a.max_season, a.max_episode);
                if before.is_some_and(|b| newer(&found) > newer(&b)) {
                    report
                        .announced
                        .push((item.id.clone(), found.max_season, found.max_episode));
                }
                if before.is_none_or(|b| newer(&found) > newer(&b)) {
                    state.online.insert(item.id.clone(), found);
                    changed = true;
                }
            }
            Ok(None) => {}
            Err(error) => report.check_failed.push((item.id.clone(), error)),
        }
    }
    if changed {
        save(state, state_path, &mut report);
    }

    // 2. Tidy up before fetching, so that room is made first.
    let plan = plan_cleanup(state, &shared, config.storage_limit_bytes());
    report.still_over = plan.still_over;
    for deletion in plan.delete {
        match ports.trash.trash(&deletion.path) {
            Ok(()) => {}
            // Gone already: nothing to keep a record of.
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => {
                report.delete_failed.push((deletion, e.to_string()));
                continue;
            }
        }
        state.forget(&deletion.path);
        save(state, state_path, &mut report);
        report.deleted.push(deletion);
    }

    // 3. Fetch, as long as it is allowed — judged again before every file,
    // because a window can end in the middle of a long run.
    let mut blocked: BTreeSet<String> = BTreeSet::new();
    for want in wanted(&shared, state, config) {
        if blocked.contains(&want.series_id) {
            continue;
        }
        if let Err(wait) = allowed(config, ports.host.conditions()) {
            report.waited = Some(wait);
            break;
        }
        match ports.fetcher.fetch(&want, config.bandwidth_kib) {
            Ok(file) => {
                state.record(Fetched {
                    series_id: want.series_id.clone(),
                    season: want.season,
                    episode: want.episode,
                    path: file.path,
                    size: file.size,
                    fetched_at: ports.host.now_ms(),
                });
                save(state, state_path, &mut report);
                report.fetched.push(want);
            }
            Err(error) => {
                // A site that refuses once is not asked again this round.
                blocked.insert(want.series_id.clone());
                report.fetch_failed.push((want, error));
            }
        }
    }

    report.done = report.waited.is_none()
        && report.fetch_failed.is_empty()
        && report.check_failed.is_empty()
        && wanted(&shared, state, config).is_empty();
    report
}

fn save(state: &State, path: &Path, report: &mut Report) {
    if let Err(error) = state.save(path) {
        report.save_error = Some(error.to_string());
    }
}
