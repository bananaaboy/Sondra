//! The core against what the web app really writes.
//!
//! The fixtures come from `npm run native:fixture`, which runs the web app's
//! own serializer — a Rust reader tested only against Rust-written files
//! would prove nothing about the files in Drive.

use std::path::PathBuf;

use sondra_core::cleanup::plan_cleanup;
use sondra_core::config::{Config, KeepAwake, Window};
use sondra_core::merkliste::{read_shared, Online, Shared, Status};
use sondra_core::plan::{episodes_out, wanted};
use sondra_core::schedule::{allowed, keep_awake, Conditions, Wait};
use sondra_core::state::{Fetched, State};

const SQLITE: &[u8] = include_bytes!("fixtures/merkliste.sqlite");
const JSON: &[u8] = include_bytes!("fixtures/merkliste.json");

fn sqlite() -> Shared {
    read_shared(SQLITE).expect("the database written by the web app reads")
}

#[test]
fn reads_the_database_the_web_app_writes() {
    let shared = sqlite();
    let ids: Vec<_> = shared.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["frieren", "naruto", "rezero", "film"]);

    let frieren = &shared.items[0];
    assert_eq!(frieren.title, "Frieren");
    assert_eq!(frieren.status, Status::Watching);
    assert_eq!(frieren.episode, Some(11));
    assert_eq!(frieren.seasons[0].episodes, Some(28));
    assert_eq!(frieren.seasons[0].watched, (1..=10).collect::<Vec<_>>());
    assert_eq!(
        frieren.online_available,
        Some(Online {
            max_season: 1,
            max_episode: 14,
            checked_at: 1_790_000_100_000
        })
    );

    assert_eq!(shared.items[1].status, Status::Done);
    assert_eq!(shared.items[1].episode, None);
    // No status written at all means being watched, as in the web app.
    assert_eq!(shared.items[3].status, Status::Watching);
    assert_eq!(shared.items[3].url, "");
    assert_eq!(shared.removed.get("gone"), Some(&1_792_000_000_000));
}

#[test]
fn json_and_database_agree() {
    let from_json = read_shared(JSON).expect("the older JSON file reads");
    let from_db = sqlite();
    assert_eq!(from_json.removed, from_db.removed);
    assert_eq!(from_json.items.len(), from_db.items.len());
    for (a, b) in from_json.items.iter().zip(&from_db.items) {
        assert_eq!(
            (&a.id, &a.title, a.status, a.season, a.episode),
            (&b.id, &b.title, b.status, b.season, b.episode)
        );
        assert_eq!(a.seasons, b.seasons, "seasons of {}", a.id);
        assert_eq!(a.online_available, b.online_available, "online of {}", a.id);
    }
}

#[test]
fn unknown_fields_survive_in_json() {
    let frieren = &read_shared(JSON).unwrap().items[0];
    assert_eq!(frieren.extra["futureField"]["kept"], true);
    assert!(!frieren.extra.contains_key("status"));
}

#[test]
fn something_else_is_not_a_merkliste() {
    assert!(read_shared(b"{\"hello\": 1}").is_err());
    assert!(read_shared(b"not even json").is_err());
    assert!(read_shared(b"SQLite format 3\0 but broken").is_err());
}

fn auto(ids: &[&str], ahead: u32) -> Config {
    Config {
        auto_series: ids.iter().map(|s| s.to_string()).collect(),
        ahead,
        ..Config::default()
    }
}

#[test]
fn fetches_the_next_unseen_episodes_in_order() {
    let wants = wanted(
        &sqlite(),
        &State::default(),
        &auto(&["frieren", "rezero", "naruto"], 3),
    );
    let got: Vec<_> = wants
        .iter()
        .map(|w| (w.series_id.as_str(), w.season, w.episode))
        .collect();
    // Frieren: 1–10 seen, 14 are out. Re:Zero: season 1 seen, season 2 has 3 and 4
    // left, season 3 is out up to 2. Naruto is finished: never fetched.
    assert_eq!(
        got,
        [
            ("frieren", 1, 11),
            ("frieren", 1, 12),
            ("frieren", 1, 13),
            ("rezero", 2, 3),
            ("rezero", 2, 4),
            ("rezero", 3, 1),
        ]
    );
}

#[test]
fn only_series_chosen_are_fetched() {
    assert!(wanted(&sqlite(), &State::default(), &Config::default()).is_empty());
    let wants = wanted(&sqlite(), &State::default(), &auto(&["frieren"], 1));
    assert_eq!(wants.len(), 1);
    assert_eq!(wants[0].series_id, "frieren");
}

#[test]
fn keeps_a_fixed_number_ready_instead_of_adding_forever() {
    let mut state = State::default();
    state.record(fetched("frieren", 1, 11, 100, 1));
    let wants = wanted(&sqlite(), &state, &auto(&["frieren"], 3));
    let episodes: Vec<_> = wants.iter().map(|w| w.episode).collect();
    assert_eq!(
        episodes,
        [12, 13],
        "one is already here, two more make three"
    );

    state.record(fetched("frieren", 1, 12, 100, 2));
    state.record(fetched("frieren", 1, 13, 100, 3));
    assert!(wanted(&sqlite(), &state, &auto(&["frieren"], 3)).is_empty());
}

#[test]
fn a_newer_find_on_this_computer_wins_over_the_list() {
    let mut state = State::default();
    state.online.insert(
        "frieren".into(),
        Online {
            max_season: 1,
            max_episode: 20,
            checked_at: 1,
        },
    );
    let wants = wanted(&sqlite(), &state, &auto(&["frieren"], 20));
    assert_eq!(wants.last().map(|w| w.episode), Some(20));
    // An older find never takes the list's newer news away.
    state.online.insert(
        "frieren".into(),
        Online {
            max_season: 1,
            max_episode: 5,
            checked_at: 1,
        },
    );
    let wants = wanted(&sqlite(), &state, &auto(&["frieren"], 20));
    assert_eq!(wants.last().map(|w| w.episode), Some(14));
}

#[test]
fn a_season_of_unknown_length_below_the_newest_is_skipped_not_guessed() {
    let mut shared = sqlite();
    shared.items[2].seasons[1].episodes = None;
    let out = episodes_out(
        &shared.items[2],
        Online {
            max_season: 3,
            max_episode: 2,
            checked_at: 0,
        },
    );
    assert!(out.iter().all(|&(season, _)| season != 2));
    assert_eq!(out.last(), Some(&(3, 2)));
}

#[test]
fn a_series_removed_after_its_last_change_is_not_fetched() {
    let mut shared = sqlite();
    shared.removed.insert("frieren".into(), i64::MAX);
    assert!(wanted(&shared, &State::default(), &auto(&["frieren"], 3)).is_empty());
}

fn fetched(series: &str, season: u32, episode: u32, size: u64, at: i64) -> Fetched {
    Fetched {
        series_id: series.into(),
        season,
        episode,
        path: PathBuf::from(format!("{series}-s{season}e{episode}.mkv")),
        size,
        fetched_at: at,
    }
}

#[test]
fn deletes_the_oldest_seen_files_until_the_limit_fits() {
    let shared = sqlite();
    let mut state = State::default();
    // Frieren 1–10 are seen. Fetched out of order on purpose.
    state.record(fetched("frieren", 1, 3, 400, 30));
    state.record(fetched("frieren", 1, 1, 400, 10));
    state.record(fetched("frieren", 1, 2, 400, 20));
    state.record(fetched("frieren", 1, 11, 400, 5)); // unseen: oldest of all, still safe
    let plan = plan_cleanup(&state, &shared, Some(1000));
    let gone: Vec<_> = plan.delete.iter().map(|d| d.episode).collect();
    assert_eq!(
        gone,
        [1, 2],
        "1600 → 800 needs two files, oldest seen first"
    );
    assert!(!plan.still_over);
}

#[test]
fn never_deletes_an_unseen_episode_even_when_over_the_limit() {
    let shared = sqlite();
    let mut state = State::default();
    state.record(fetched("frieren", 1, 11, 900, 1));
    state.record(fetched("frieren", 1, 12, 900, 2));
    let plan = plan_cleanup(&state, &shared, Some(100));
    assert!(plan.delete.is_empty());
    assert!(plan.still_over);
}

#[test]
fn leaves_files_of_series_that_left_the_list_alone() {
    let mut shared = sqlite();
    shared.removed.insert("frieren".into(), i64::MAX);
    let mut state = State::default();
    state.record(fetched("frieren", 1, 1, 900, 1));
    assert!(plan_cleanup(&state, &shared, Some(100)).delete.is_empty());
}

#[test]
fn no_limit_means_nothing_is_ever_deleted() {
    let mut state = State::default();
    state.record(fetched("frieren", 1, 1, u64::MAX / 2, 1));
    assert_eq!(plan_cleanup(&state, &sqlite(), None).delete.len(), 0);
}

fn at(hour: u8, on_ac: bool, metered: bool) -> Conditions {
    Conditions {
        hour,
        on_ac,
        metered,
    }
}

#[test]
fn a_window_may_cross_midnight() {
    let config = Config {
        window: Some(Window { from: 22, to: 6 }),
        ..Config::default()
    };
    assert_eq!(allowed(&config, at(23, true, false)), Ok(()));
    assert_eq!(allowed(&config, at(3, true, false)), Ok(()));
    assert_eq!(
        allowed(&config, at(6, true, false)),
        Err(Wait::OutsideWindow)
    );
    assert_eq!(
        allowed(&config, at(14, true, false)),
        Err(Wait::OutsideWindow)
    );
}

#[test]
fn power_and_connection_conditions() {
    let config = Config {
        only_on_ac: true,
        only_unmetered: true,
        ..Config::default()
    };
    assert_eq!(allowed(&config, at(12, false, false)), Err(Wait::OnBattery));
    assert_eq!(
        allowed(&config, at(12, true, true)),
        Err(Wait::MeteredConnection)
    );
    assert_eq!(allowed(&config, at(12, true, false)), Ok(()));
    assert_eq!(allowed(&Config::default(), at(12, false, true)), Ok(()));
}

#[test]
fn state_survives_a_round_trip_and_a_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("zustand.json");
    assert_eq!(State::load(&path).unwrap(), State::default());

    let mut state = State::default();
    state.record(fetched("frieren", 1, 11, 123, 7));
    state.online.insert(
        "frieren".into(),
        Online {
            max_season: 1,
            max_episode: 14,
            checked_at: 9,
        },
    );
    state.save(&path).unwrap();
    assert_eq!(State::load(&path).unwrap(), state);

    state.forget(&PathBuf::from("frieren-s1e11.mkv"));
    assert_eq!(state.total_size(), 0);

    std::fs::write(&path, b"{ broken").unwrap();
    assert!(State::load(&path).is_err());
}

#[test]
fn config_reads_a_partial_file_with_defaults_for_the_rest() {
    let config: Config =
        serde_json::from_str(r#"{"storageLimitGb": 100, "keepAwake": "whileFetching"}"#).unwrap();
    assert_eq!(config.storage_limit_gb, Some(100));
    assert_eq!(config.ahead, 3);
    assert!(!config.shutdown_when_done);
    assert_eq!(config.storage_limit_bytes(), Some(100 * 1024 * 1024 * 1024));
}

#[test]
fn the_computer_is_kept_awake_only_as_chosen() {
    let with = |keep_awake| Config {
        keep_awake,
        ..Config::default()
    };
    assert!(!keep_awake(&with(KeepAwake::Off), true));
    assert!(keep_awake(&with(KeepAwake::WhileFetching), true));
    assert!(!keep_awake(&with(KeepAwake::WhileFetching), false));
    assert!(keep_awake(&with(KeepAwake::Always), false));
}
