//! Neue Folgen melden: a minute after the start and then every three hours, each series „Am Schauen“ with
//! an AniWorld address is looked at online, one after another with a pause between; when the newest episode
//! is later than at the last look, a card says so (`floating`), and „Ansehen“ opens the series. The twin of
//! `src/lib/newEpisodes.ts`.
//!
//! * the first look at a series only notes where it stands — otherwise every series one is behind on would
//!   announce itself at once;
//! * each episode is announced once (`gemeldet`, kept in `NeueFolgen.json`);
//! * a look is not a change: the list entry's `updated_at` stays, only `online_available` moves (a look
//!   that counted as a change made the older copy on this computer win the sync over episodes seen elsewhere);
//! * off with the switch under „Mehr“ in the Merkliste (`an`).
//!
//! What this does not do yet is the notice of the system when Sondra is behind other windows or minimised:
//! the card is in Sondra's own window.

use std::collections::BTreeMap;
use std::time::Duration;

use gpui::Context;
use sondra_extract::aniworld::{check_online_updates, is_aniworld_url};
use sondra_merk::folder_memory::Store;
use sondra_merk::model::{Item, Online, Status};

use crate::shell::Shell;

const FIRST: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(3 * 60 * 60);
/// Between two series: a person browsing, not a crawler.
const PAUSE: Duration = Duration::from_secs(2);
const FILE: &str = "NeueFolgen.json";

/// One card: an episode that appeared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub id: String,
    pub title: String,
    pub season: i64,
    pub episode: i64,
}

pub struct NewEpisodes {
    pub on: bool,
    pub running: bool,
    /// Series id → the episode last announced (`SxE`).
    pub told: BTreeMap<String, String>,
    pub notes: Vec<Announcement>,
    /// Between two series; a test sets it to nothing.
    pub pause: Duration,
}

impl Default for NewEpisodes {
    fn default() -> Self {
        let store = crate::store::FileStore::at_default(FILE);
        let on = store.as_ref().is_none_or(|s| s.get_item("an").as_deref() != Some("aus"));
        let told = store.and_then(|s| s.get_item("gemeldet")).and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
        NewEpisodes { on, running: false, told, notes: Vec::new(), pause: PAUSE }
    }
}

/// True when `next` names a later episode than `before`.
pub fn later_release(before: Option<&Online>, next: &Online) -> bool {
    before.is_some_and(|b| (next.max_season, next.max_episode) > (b.max_season, b.max_episode))
}

/// The series worth looking at: being watched, with an AniWorld address.
pub fn watched_on_aniworld(items: &[Item]) -> Vec<(String, String)> {
    items.iter().filter(|i| i.status == Status::Watching && !i.url.is_empty() && is_aniworld_url(&i.url)).map(|i| (i.id.clone(), i.url.clone())).collect()
}

fn key_of(online: &Online) -> String {
    format!("{}x{}", online.max_season, online.max_episode)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Shell {
    /// Starts the rounds: the first after a minute, then every three hours.
    pub(crate) fn start_new_episode_rounds(window: &mut gpui::Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(FIRST).await;
            loop {
                if this.update(cx, |shell, cx| shell.new_episodes_round(cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(EVERY).await;
            }
        })
        .detach();
    }

    /// One round over the list. Returns at once; the answers come back one series at a time.
    pub fn new_episodes_round(&mut self, cx: &mut Context<Self>) {
        if !self.news_rounds.on || self.news_rounds.running {
            return;
        }
        let series = watched_on_aniworld(&self.merk.items);
        if series.is_empty() {
            return;
        }
        self.news_rounds.running = true;
        let (factory, pause) = (self.download.fetch.clone(), self.news_rounds.pause);
        Self::in_background(
            cx,
            move || {
                let mut looked = Vec::new();
                for (n, (id, url)) in series.into_iter().enumerate() {
                    if n > 0 {
                        std::thread::sleep(pause);
                    }
                    let now = now_ms();
                    let online = check_online_updates(factory().as_ref(), &url, false, now).map(|info| Online { max_season: i64::from(info.max_season), max_episode: i64::from(info.max_episode), checked_at: now, has_new: None });
                    looked.push((id, online));
                }
                looked
            },
            |shell, looked, cx| {
                shell.news_rounds.running = false;
                shell.apply_looks(looked);
                cx.notify();
            },
        );
    }

    /// What a round found: the entries learn how far the series is, and what is new is announced once.
    pub(crate) fn apply_looks(&mut self, looked: Vec<(String, Option<Online>)>) {
        let mut changed = false;
        for (id, online) in looked {
            let Some(online) = online else { continue };
            // The entry as it stands now — a sync may have changed it meanwhile.
            let Some(item) = self.merk.items.iter_mut().find(|i| i.id == id) else { continue };
            let before = item.online_available.clone();
            // Whether there is something the list does not know yet — the series page offers it.
            let online = Online { has_new: Some(sondra_merk::progress::online_news(item, Some(&online)).is_some()), ..online };
            let key = key_of(&online);
            let announce = before.is_some() && later_release(before.as_ref(), &online) && self.news_rounds.told.get(&id) != Some(&key);
            if before.is_none() || announce {
                self.news_rounds.told.insert(id.clone(), key);
            }
            if announce {
                self.news_rounds.notes.retain(|n| n.id != id);
                self.news_rounds.notes.push(Announcement { id: id.clone(), title: item.title.clone(), season: online.max_season, episode: online.max_episode });
            }
            if before.as_ref().is_none_or(|b| (b.max_season, b.max_episode, b.has_new) != (online.max_season, online.max_episode, online.has_new)) {
                item.online_available = Some(online);
                changed = true;
            }
        }
        if changed {
            self.merk.save();
        }
        self.remember_told();
    }

    fn remember_told(&self) {
        if let Some(mut store) = crate::store::FileStore::at_default(FILE) {
            store.set_item("gemeldet", serde_json::to_string(&self.news_rounds.told).unwrap_or_default());
        }
    }

    pub(crate) fn set_new_episodes(&mut self, on: bool, cx: &mut Context<Self>) {
        self.news_rounds.on = on;
        if let Some(mut store) = crate::store::FileStore::at_default(FILE) {
            store.set_item("an", if on { "an" } else { "aus" }.to_string());
        }
        cx.notify();
    }

    /// „Ansehen“ on a card: the series opens in the Merkliste.
    pub(crate) fn open_announced(&mut self, id: &str, cx: &mut Context<Self>) {
        self.news_rounds.notes.retain(|n| n.id != id);
        self.merk.open = Some(id.to_string());
        self.go(crate::nav::Panel::Merkliste, cx);
    }

    /// For tests: no waiting between two series, and no look at the files of this computer.
    pub fn new_episodes_for_test(&mut self, on: bool) {
        self.news_rounds = NewEpisodes { on, running: false, told: BTreeMap::new(), notes: Vec::new(), pause: Duration::ZERO };
    }

    /// For tests: whether a round is under way.
    pub fn new_episodes_running(&self) -> bool {
        self.news_rounds.running
    }

    /// For tests: what the cards say.
    pub fn announcements(&self) -> Vec<Announcement> {
        self.news_rounds.notes.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn online(season: i64, episode: i64) -> Online {
        Online { max_season: season, max_episode: episode, checked_at: 0, has_new: None }
    }

    #[test]
    fn only_a_later_episode_is_news() {
        assert!(later_release(Some(&online(1, 12)), &online(1, 13)));
        assert!(later_release(Some(&online(1, 12)), &online(2, 1)));
        assert!(!later_release(Some(&online(1, 12)), &online(1, 12)));
        assert!(!later_release(Some(&online(2, 1)), &online(1, 30)));
        assert!(!later_release(None, &online(1, 1)), "the first look only notes where it stands");
    }
}
