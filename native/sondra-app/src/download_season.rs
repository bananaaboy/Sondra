//! The episode chooser of „Herunterladen“ (the website's season page handling): a series or season page on
//! AniWorld/SerienStream is no episode to load but a list of them. It shows its episodes; „Die ganze Staffel laden“
//! puts them all in the list, a chip chooses one — „Folge n laden“ or „Ab Folge n laden“ (a place in the list) —, and
//! the seasons and films of the series stand as pills to go to.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_extract::aniworld::{check_online_updates, extract_season, is_aniworld_season_url, SeasonPage};
use sondra_extract::fetch::Fetch;
use sondra_ui::Ui;

use crate::shell::Shell;

/// A season page that was found, and what the series has besides.
#[derive(Debug, Clone)]
pub struct SeasonChoice {
    pub address: String,
    pub page: SeasonPage,
    /// How many seasons the series has, and whether it has films.
    pub seasons: u32,
    pub films: bool,
    /// The episode chosen in the list (its index), for „Folge n“ / „Ab Folge n“.
    pub pick: Option<usize>,
}

/// The series' own address without season or episode: `…/anime/stream/frieren`.
pub fn series_base(address: &str) -> String {
    let lower = address.to_ascii_lowercase();
    let Some(at) = lower.find("/stream/") else { return address.trim_end_matches('/').to_string() };
    let rest = &address[at + "/stream/".len()..];
    let slug = rest.split('/').next().unwrap_or(rest);
    address[..at + "/stream/".len() + slug.len()].to_string()
}

/// A season or series page, looked at: its episodes and the seasons around it. `None` when it is no such page or
/// holds no episodes.
pub fn look_at_season(fetch: &dyn Fetch, address: &str) -> Option<SeasonChoice> {
    if !is_aniworld_season_url(address) {
        return None;
    }
    let page = extract_season(fetch, address)?;
    if page.items.is_empty() {
        return None;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let online = check_online_updates(fetch, address, false, now);
    let seasons = online.as_ref().map_or(page.season_number.max(1), |o| o.max_season.max(1));
    let films = online.as_ref().is_some_and(|o| o.has_movies) || page.season_number == 0;
    Some(SeasonChoice { address: address.to_string(), page, seasons, films, pick: None })
}

impl Shell {
    /// Goes to the addresses given as a list (the multi-address lookup, then „Alle laden“).
    fn season_take(&mut self, addresses: Vec<String>, cx: &mut Context<Self>) {
        if addresses.is_empty() {
            return;
        }
        self.download.season = None;
        self.download_set_input(&addresses.join(", "), cx);
        self.find_address(cx);
    }

    /// For tests: the season page that was found, if one was.
    pub fn download_season_now(&self) -> Option<(String, usize, u32, bool)> {
        self.download.season.as_ref().map(|s| (s.page.series_title.clone(), s.page.items.len(), s.seasons, s.films))
    }

    /// The card of a season page.
    pub(crate) fn season_card(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = self.download.season.as_ref()?;
        let c = ui.c;
        let me = cx.entity();
        let what = if s.page.season_number == 0 { "Filme".to_string() } else { format!("Staffel {}", s.page.season_number) };
        let unit = if s.page.season_number == 0 { "Film" } else { "Folge" };
        let mut card = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .p(px(16.))
            .rounded(px(sondra_ui::radius::CARD))
            .bg(c.panel_soft)
            .child(ui.subheading(format!("{} · {what}", if s.page.series_title.is_empty() { s.page.title.clone() } else { s.page.series_title.clone() })))
            .child(ui.prose(format!("{} {} auf dieser Seite. Wählen Sie eine, ab einer, oder alle.", s.page.items.len(), if s.page.items.len() == 1 { unit.to_string() } else { format!("{unit}n").replace("Filmn", "Filme") })));

        // The seasons and films of the series.
        if s.seasons > 1 || s.films {
            let base = series_base(&s.address);
            let mut pills = div().flex().flex_wrap().gap(px(6.));
            let mut places: Vec<(u32, String, String)> = (1..=s.seasons).map(|n| (n, format!("Staffel {n}"), format!("{base}/staffel-{n}"))).collect();
            if s.films {
                places.push((0, "Filme".to_string(), format!("{base}/filme")));
            }
            // A season the Merkliste has seen to the end is marked („Ganz gesehen“).
            let on_list = self.merk.items.iter().find(|i| !i.url.trim().is_empty() && series_base(&i.url).eq_ignore_ascii_case(&base));
            let done = |n: u32| on_list.is_some_and(|item| sondra_merk::progress::seasons_of(item).iter().any(|x| x.number == i64::from(n) && sondra_merk::progress::season_progress(x).complete));
            for (n, label, address) in places {
                let me = me.clone();
                let (shown, name) = if done(n) { (format!("{label} ✓"), format!("{label}, ganz gesehen")) } else { (label.clone(), label) };
                pills = pills.child(ui.chip(format!("staffelwahl-{n}"), shown, n == s.page.season_number).accessible_name(name).on_click(move |_, app| {
                    let address = address.clone();
                    me.update(app, |shell, cx| {
                        shell.download.season = None;
                        shell.download_set_input(&address, cx);
                        shell.find_address(cx);
                    })
                }));
            }
            card = card.child(pills);
        }

        // The episodes: a chip chooses one.
        let mut grid = div().flex().flex_wrap().gap(px(6.));
        for (i, ep) in s.page.items.iter().enumerate() {
            let me = me.clone();
            let label = ep.episode_number.to_string();
            let name = format!("{unit} {}", ep.episode_number);
            grid = grid.child(ui.chip(format!("folgenwahl-{i}"), label, s.pick == Some(i)).accessible_name(format!("{name} wählen")).on_click(move |_, app| me.update(app, |shell, cx| {
                if let Some(s) = shell.download.season.as_mut() {
                    s.pick = if s.pick == Some(i) { None } else { Some(i) };
                }
                cx.notify();
            })));
        }
        card = card.child(grid);

        let mut actions = div().flex().flex_wrap().gap(px(8.));
        {
            let me = me.clone();
            let all: Vec<String> = s.page.items.iter().map(|e| e.url.clone()).collect();
            let label = if s.page.season_number == 0 { "Alle Filme laden".to_string() } else { "Die ganze Staffel laden".to_string() };
            actions = actions.child(ui.button("ganze-staffel", label).primary().on_click(move |_, app| {
                let all = all.clone();
                me.update(app, |shell, cx| shell.season_take(all, cx))
            }));
        }
        if let Some(i) = s.pick {
            let n = s.page.items[i].episode_number;
            let (one, me1) = (vec![s.page.items[i].url.clone()], me.clone());
            actions = actions.child(ui.button("eine-folge", format!("{unit} {n} laden")).on_click(move |_, app| {
                let one = one.clone();
                me1.update(app, |shell, cx| shell.season_take(one, cx))
            }));
            if i + 1 < s.page.items.len() {
                let rest: Vec<String> = s.page.items[i..].iter().map(|e| e.url.clone()).collect();
                let me2 = me.clone();
                actions = actions.child(ui.button("ab-folge", format!("Ab {unit} {n} laden ({})", rest.len())).on_click(move |_, app| {
                    let rest = rest.clone();
                    me2.update(app, |shell, cx| shell.season_take(rest, cx))
                }));
            }
        } else {
            actions = actions.child(ui.hint("Eine Nummer wählen: diese oder ab ihr laden."));
        }
        Some(card.child(actions).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_series_address_is_found_under_any_season_or_episode() {
        assert_eq!(series_base("https://aniworld.to/anime/stream/frieren/staffel-2/episode-3"), "https://aniworld.to/anime/stream/frieren");
        assert_eq!(series_base("https://aniworld.to/anime/stream/frieren/"), "https://aniworld.to/anime/stream/frieren");
    }
}
