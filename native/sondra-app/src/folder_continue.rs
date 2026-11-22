//! „Weiterschauen“ on the Ordner page (`ContinueRow` in `FolderPanel.tsx`): the series of the Merkliste that
//! have episodes in this folder, each with the one to watch next — where the list stands, else the first unseen
//! — and one button that plays it and the unseen ones after it. What is next, and the queue, is
//! `sondra_merk::folder::folder_series`, checked against the website.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::folder::{folder_series, FolderSeries};
use sondra_ui::{radius, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// How many series are offered at once (as on the website).
const SHOWN: usize = 6;
/// The width of one card; three stand in a row on a laptop.
const CARD_W: f32 = 300.0;

impl Shell {
    pub(crate) fn continue_here(&self) -> Vec<FolderSeries> {
        let Some(scan) = &self.folder.scan else { return Vec::new() };
        let mut series = folder_series(&scan.files, &self.merk.items);
        series.truncate(SHOWN);
        series
    }

    /// Plays the episode the list stands at and the unseen ones after it that lie in the folder.
    pub(crate) fn continue_play(&mut self, item_id: &str, cx: &mut Context<Self>) {
        let Some(series) = self.continue_here().into_iter().find(|s| s.item == item_id) else { return };
        // Episodes in Drive play from Drive where they lie; those on this computer from the folder.
        let in_drive: Vec<sondra_devices::engine::PlayItem> = series
            .queue
            .iter()
            .filter_map(|e| e.file.drive.as_ref().map(|d| sondra_devices::engine::PlayItem { id: d.id.clone(), name: e.file.name.clone(), size: e.file.size, mime: d.mime.clone() }))
            .collect();
        if !in_drive.is_empty() {
            self.play_drive_films(in_drive, cx);
            return;
        }
        let Some(root) = self.folder.root.clone() else { return };
        let files = series.queue.iter().map(|e| root.join(e.file.path.replace('/', std::path::MAIN_SEPARATOR_STR))).collect::<Vec<_>>();
        if files.is_empty() {
            return;
        }
        self.go(Panel::Player, cx);
        self.play_files(files, cx);
    }

    pub(crate) fn continue_section(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        // Only at the top of the folder, and not while a search narrows the view.
        if !self.folder.dir.is_empty() || !self.folder.search.read(cx).text().trim().is_empty() {
            return None;
        }
        let series = self.continue_here();
        if series.is_empty() {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut cards = div().flex().flex_wrap().gap(px(10.));
        for (n, s) in series.iter().enumerate() {
            let Some(item) = self.merk.items.iter().find(|i| i.id == s.item) else { continue };
            let (play, open) = (me.clone(), me.clone());
            let (id_play, id_open) = (s.item.clone(), s.item.clone());
            let total = sondra_merk::progress::seasons_of(item).into_iter().find(|x| x.number == s.next.season).and_then(|x| x.episodes);
            let place = if s.next.season == 0 {
                format!("Film {}", s.next.episode)
            } else {
                format!("Staffel {} · Folge {}{}", s.next.season, s.next.episode, total.map(|t| format!(" von {t}")).unwrap_or_default())
            };
            let more = s.queue.len().saturating_sub(1);
            let file = s.queue.first().map(|e| e.file.name.clone()).unwrap_or_default();
            cards = cards.child(
                div()
                    .w(px(CARD_W))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(14.))
                    .rounded(px(radius::CARD))
                    .bg(c.panel_soft)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w(px(0.))
                            .child(ui.button(format!("weiter-serie-{n}"), item.title.clone()).ghost().accessible_name(format!("„{}“ in der Merkliste öffnen", item.title)).on_click(move |_, app| {
                                let id = id_open.clone();
                                open.update(app, |shell, cx| {
                                    shell.merk.open = Some(id);
                                    shell.go(Panel::Merkliste, cx);
                                })
                            }))
                            .child(ui.prose(place.clone()))
                            .child(div().w(px(CARD_W - 28.)).truncate().child(ui.value(file))),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(12.))
                            .child(ui.button(format!("weiter-abspielen-{n}"), "Abspielen").small().primary().accessible_name(format!("{}: {place} abspielen", item.title)).on_click(move |_, app| {
                                let id = id_play.clone();
                                play.update(app, |shell, cx| shell.continue_play(&id, cx))
                            }))
                            .child(ui.hint(if more > 0 { format!("danach {more} weitere aus dem Ordner") } else { "die letzte ungesehene hier".to_string() })),
                    ),
            );
        }
        let section = div().flex().flex_col().gap(px(10.)).child(ui.subheading("Weiterschauen")).child(cards);
        Some(section.into_any_element())
    }
}

/// „Staffel 1: 1–3, 5 · Filme: 1“: which episodes of a series lie in the folder, in runs (`folderSummary`).
pub fn folder_summary(episodes: &[(i64, i64)]) -> String {
    let mut seasons: Vec<(i64, Vec<i64>)> = Vec::new();
    for (season, episode) in episodes {
        match seasons.iter_mut().find(|(s, _)| s == season) {
            Some((_, list)) => list.push(*episode),
            None => seasons.push((*season, vec![*episode])),
        }
    }
    seasons
        .into_iter()
        .map(|(season, mut numbers)| {
            numbers.sort_unstable();
            numbers.dedup();
            let mut runs: Vec<String> = Vec::new();
            let mut start = numbers[0];
            for i in 1..=numbers.len() {
                if i < numbers.len() && numbers[i] == numbers[i - 1] + 1 {
                    continue;
                }
                let end = numbers[i - 1];
                runs.push(if end == start { start.to_string() } else { format!("{start}–{end}") });
                if i < numbers.len() {
                    start = numbers[i];
                }
            }
            format!("{}: {}", if season == 0 { "Filme".to_string() } else { format!("Staffel {season}") }, runs.join(", "))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

impl Shell {
    /// The folder the Ordner page read and the episodes of this series in it, in words.
    pub(crate) fn merk_in_folder(&self, item_id: &str) -> Option<(String, String)> {
        let scan = self.folder.scan.as_ref()?;
        let (_, episodes) = sondra_merk::folder::folder_episodes(&scan.files, &self.merk.items).into_iter().find(|(id, _)| id == item_id)?;
        if episodes.is_empty() {
            return None;
        }
        let pairs: Vec<(i64, i64)> = episodes.iter().map(|e| (e.season, e.episode)).collect();
        Some((if scan.drive { "Google Drive".to_string() } else { scan.name.clone() }, folder_summary(&pairs)))
    }
}

#[cfg(test)]
mod summary_tests {
    #[test]
    fn episodes_are_said_in_runs_per_season() {
        assert_eq!(super::folder_summary(&[(1, 1), (1, 2), (1, 3), (1, 5), (2, 1), (0, 1)]), "Staffel 1: 1–3, 5 · Staffel 2: 1 · Filme: 1");
    }
}
