//! „Eine Serie erkannt“ on the Ordner page (`NewSeriesOffer` in `FolderPanel.tsx`): the series that lie in the
//! folder and are not on the Merkliste — one click puts them there, so nobody has to type a name, a season or a
//! count. Two episodes make a series (one „Ocean's 11“ is a film). A „no“ is kept by title, and what was just
//! added says so, with the way to it. Which series, and what they become, is `sondra_merk::folder`.

use std::collections::HashSet;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::folder::{find_new_series, series_to_merk_item, FoundSeries};
use sondra_merk::folder_memory::Store;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_ui::{radius, Ui};

use crate::merkliste::MerkState;
use crate::nav::Panel;
use crate::shell::Shell;

const IGNORED_KEY: &str = "sondra:ordner:ignoriert";

/// What the page keeps of the offer.
#[derive(Default)]
pub struct Offer {
    /// Titles (as keys) not to be asked about again; read from the memory when the first offer is made.
    pub ignored: Option<HashSet<String>>,
    /// What was just added: id and title.
    pub added: Vec<(String, String)>,
}

impl MerkState {
    /// Puts series the folder holds on the list, from their first episode there, the length not known.
    pub fn add_found_series(&mut self, list: &[FoundSeries]) -> Vec<(String, String)> {
        let mut ids = Ids::system();
        let made: Vec<_> = list.iter().map(|s| normalize(&series_to_merk_item(s), &mut ids)).collect();
        let named: Vec<(String, String)> = made.iter().map(|i| (i.id.clone(), i.title.clone())).collect();
        for item in made.into_iter().rev() {
            self.items.insert(0, item);
        }
        self.save();
        named
    }
}

fn describe(series: &FoundSeries) -> String {
    let episodes: usize = series.seasons.iter().map(|(_, e)| e.len()).sum();
    let seasons = if series.seasons.len() > 1 { format!(", {} Staffeln", series.seasons.len()) } else { String::new() };
    format!("{episodes} {}{seasons}", if episodes == 1 { "Folge" } else { "Folgen" })
}

impl Shell {
    /// The titles not to be asked about: what was said this visit, else what the memory holds.
    fn ignored_series(&self) -> HashSet<String> {
        if let Some(now) = &self.folder.offer.ignored {
            return now.clone();
        }
        let stored = self.folder.memory.as_ref().and_then(|m| m.get_item(IGNORED_KEY)).and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok()).unwrap_or_default();
        stored.into_iter().collect()
    }

    pub(crate) fn offer_found(&self) -> Vec<FoundSeries> {
        let Some(scan) = &self.folder.scan else { return Vec::new() };
        find_new_series(&scan.files, &self.merk.items, &self.ignored_series())
    }

    pub(crate) fn offer_add(&mut self, keys: Option<&str>, cx: &mut Context<Self>) {
        let found = self.offer_found();
        let chosen: Vec<FoundSeries> = found.into_iter().filter(|s| keys.is_none_or(|k| s.key == k)).collect();
        if chosen.is_empty() {
            return;
        }
        self.folder.offer.added = self.merk.add_found_series(&chosen);
        cx.notify();
    }

    pub(crate) fn offer_ignore(&mut self, key: &str, cx: &mut Context<Self>) {
        let mut ignored = self.ignored_series();
        ignored.insert(key.to_owned());
        if let Some(memory) = self.folder.memory.as_mut() {
            let mut all: Vec<&String> = ignored.iter().collect();
            all.sort();
            memory.set_item(IGNORED_KEY, serde_json::to_string(&all).unwrap_or_default());
        }
        self.folder.offer.ignored = Some(ignored);
        cx.notify();
    }

    pub(crate) fn offer_section(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let found = self.offer_found();
        let added = self.folder.offer.added.clone();
        if found.is_empty() && added.is_empty() {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut section = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        if !found.is_empty() {
            let head = div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(ui.subheading(if found.len() == 1 { "Eine Serie erkannt".to_string() } else { format!("{} Serien erkannt", found.len()) }));
            let head = if found.len() > 1 {
                let me = me.clone();
                head.child(ui.button("alle-auf-merkliste", "Alle auf die Merkliste").small().primary().on_click(move |_, app| me.update(app, |shell, cx| shell.offer_add(None, cx))))
            } else {
                head
            };
            section = section.child(head).child(ui.prose("An den Dateinamen erkannt. Auf der Merkliste weiss Sondra, wie weit Sie sind, und spielt die nächste Folge."));
            let many = found.len() > 1;
            for (n, series) in found.iter().enumerate() {
                let (add, ignore) = (me.clone(), me.clone());
                let (key_add, key_ignore) = (series.key.clone(), series.key.clone());
                section = section.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap(px(12.))
                        .py(px(8.))
                        .when(n > 0, |d| d.border_t_1().border_color(c.line))
                        .child(div().flex().flex_col().min_w(px(0.)).child(div().truncate().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).child(series.title.clone())).child(ui.hint(describe(series))))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(12.))
                                .child(ui.button(format!("nicht-fragen-{n}"), "Nicht fragen").small().ghost().accessible_name(format!("{} nicht mehr fragen", series.title)).on_click(move |_, app| {
                                    let key = key_ignore.clone();
                                    ignore.update(app, |shell, cx| shell.offer_ignore(&key, cx))
                                }))
                                .child({
                                    let button = ui.button(format!("auf-merkliste-{n}"), "Auf die Merkliste").small().accessible_name(format!("{} auf die Merkliste", series.title));
                                    (if many { button } else { button.primary() }).on_click(move |_, app| {
                                        let key = key_add.clone();
                                        add.update(app, |shell, cx| shell.offer_add(Some(&key), cx))
                                    })
                                }),
                        ),
                );
            }
        }
        if !added.is_empty() {
            let go = me.clone();
            let id = (added.len() == 1).then(|| added[0].0.clone());
            section = section.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .child(ui.prose(if added.len() == 1 { format!("„{}“ steht jetzt auf der Merkliste.", added[0].1) } else { format!("{} Serien stehen jetzt auf der Merkliste.", added.len()) }))
                    .child(ui.button("neu-ansehen", "Ansehen").small().on_click(move |_, app| {
                        let id = id.clone();
                        go.update(app, |shell, cx| {
                            shell.merk.open = id;
                            shell.go(Panel::Merkliste, cx);
                        })
                    })),
            );
        }
        Some(section.into_any_element())
    }
}
