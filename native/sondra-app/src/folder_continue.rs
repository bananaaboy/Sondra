//! „Weiterschauen“ on the Ordner page (`ContinueRow` in `FolderPanel.tsx`): the series of the Merkliste that
//! have episodes in this folder, each with the one to watch next — where the list stands, else the first unseen
//! — and one button that plays it and the unseen ones after it. What is next, and the queue, is
//! `sondra_merk::folder::folder_series`, checked against the website.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::folder::{folder_series, FolderSeries};
use sondra_ui::{radius, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// How many series are offered at once.
const SHOWN: usize = 3;

impl Shell {
    pub(crate) fn continue_here(&self) -> Vec<FolderSeries> {
        let Some(scan) = &self.folder.scan else { return Vec::new() };
        let mut series = folder_series(&scan.files, &self.merk.items);
        series.truncate(SHOWN);
        series
    }

    /// Plays the episode the list stands at and the unseen ones after it that lie in the folder.
    pub(crate) fn continue_play(&mut self, item_id: &str, cx: &mut Context<Self>) {
        let Some(root) = self.folder.root.clone() else { return };
        let Some(series) = self.continue_here().into_iter().find(|s| s.item == item_id) else { return };
        let files = series.queue.iter().filter(|e| e.file.drive.is_none()).map(|e| root.join(e.file.path.replace('/', std::path::MAIN_SEPARATOR_STR))).collect::<Vec<_>>();
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
        let mut section = div().flex().flex_col().gap(px(4.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.subheading("Weiterschauen"));
        for (n, s) in series.iter().enumerate() {
            let Some(item) = self.merk.items.iter().find(|i| i.id == s.item) else { continue };
            let (play, open) = (me.clone(), me.clone());
            let (id_play, id_open) = (s.item.clone(), s.item.clone());
            let place = if s.next.season == 0 { format!("Film {}", s.next.episode) } else { format!("Staffel {} · Folge {}", s.next.season, s.next.episode) };
            let here = s.episodes.iter().filter(|e| !e.seen).count();
            section = section.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .py(px(8.))
                    .when(n > 0, |d| d.border_t_1().border_color(c.line))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_w(px(0.))
                            .child(ui.button(format!("weiter-serie-{n}"), item.title.clone()).ghost().accessible_name(format!("{} in der Merkliste öffnen", item.title)).on_click(move |_, app| {
                                let id = id_open.clone();
                                open.update(app, |shell, cx| {
                                    shell.merk.open = Some(id);
                                    shell.go(Panel::Merkliste, cx);
                                })
                            }))
                            .child(ui.hint(format!("{place} · {here} {} hier ungesehen", if here == 1 { "Folge" } else { "Folgen" }))),
                    )
                    .child(ui.button(format!("weiter-abspielen-{n}"), "Abspielen").small().primary().accessible_name(format!("{}: {place} abspielen", item.title)).on_click(move |_, app| {
                        let id = id_play.clone();
                        play.update(app, |shell, cx| shell.continue_play(&id, cx))
                    })),
            );
        }
        Some(section.into_any_element())
    }
}
