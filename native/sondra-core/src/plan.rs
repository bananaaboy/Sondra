//! What to fetch next.

use crate::config::Config;
use crate::merkliste::{Item, Online, Shared, Status};
use crate::state::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Want {
    pub series_id: String,
    pub title: String,
    pub url: String,
    pub season: u32,
    pub episode: u32,
}

/// The newer of what the list knows and what this computer found.
pub fn latest_online(item: &Item, state: &State) -> Option<Online> {
    let later = |a: Online, b: Online| {
        if (b.max_season, b.max_episode) > (a.max_season, a.max_episode) {
            b
        } else {
            a
        }
    };
    match (item.online_available, state.online.get(&item.id).copied()) {
        (Some(a), Some(b)) => Some(later(a, b)),
        (a, b) => a.or(b),
    }
}

/// Every episode known to be out, in order. A season whose length nobody
/// knows is only counted up to the newest episode found online; one below it
/// with no known length is skipped, never guessed.
pub fn episodes_out(item: &Item, online: Online) -> Vec<(u32, u32)> {
    let mut seasons: Vec<_> = item.seasons.iter().filter(|s| s.number >= 1).collect();
    seasons.sort_by_key(|s| s.number);
    let mut out = Vec::new();
    for season in seasons {
        let last = match season.number.cmp(&online.max_season) {
            std::cmp::Ordering::Less => season.episodes,
            std::cmp::Ordering::Equal => Some(online.max_episode),
            std::cmp::Ordering::Greater => None,
        };
        if let Some(last) = last {
            out.extend((1..=last).map(|episode| (season.number, episode)));
        }
    }
    out
}

/// The next episodes to fetch, series by series: for each series chosen for
/// automatic fetching and still being watched, enough unseen episodes to keep
/// `config.ahead` of them on this computer.
pub fn wanted(shared: &Shared, state: &State, config: &Config) -> Vec<Want> {
    let mut wants = Vec::new();
    for item in shared.alive() {
        if item.status != Status::Watching
            || item.url.is_empty()
            || !config.auto_series.contains(&item.id)
        {
            continue;
        }
        let Some(online) = latest_online(item, state) else {
            continue;
        };
        let unseen: Vec<_> = episodes_out(item, online)
            .into_iter()
            .filter(|&(season, episode)| !item.has_seen(season, episode))
            .collect();
        let ready = unseen
            .iter()
            .filter(|&&(season, episode)| state.has(&item.id, season, episode))
            .count() as u32;
        let missing = config.ahead.saturating_sub(ready) as usize;
        wants.extend(
            unseen
                .into_iter()
                .filter(|&(season, episode)| !state.has(&item.id, season, episode))
                .take(missing)
                .map(|(season, episode)| Want {
                    series_id: item.id.clone(),
                    title: item.title.clone(),
                    url: item.url.clone(),
                    season,
                    episode,
                }),
        );
    }
    wants
}
