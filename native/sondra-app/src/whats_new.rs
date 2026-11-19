//! „Was ist neu“: what each version brought, from `src/changelog.json` — the one list the website, the
//! apps and the GitHub release notes all read (`WhatsNew.tsx`). Opened from the version beside the name; after
//! an update a line under the header says „Neu in 1.2.4 …“ once — a first visit does not get it, someone new
//! has no earlier version to compare with.

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_ui::{NoticeKind, Ui};

use crate::shell::Shell;

const CHANGELOG: &str = include_str!("../../../src/changelog.json");
const PACKAGE: &str = include_str!("../../../package.json");

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub date: String,
    pub items: Vec<String>,
}

/// The versions, newest first.
pub fn releases() -> Vec<Release> {
    let value: serde_json::Value = serde_json::from_str(CHANGELOG).unwrap_or_default();
    value["versions"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|v| {
                    Some(Release {
                        version: v["version"].as_str()?.to_owned(),
                        date: v["date"].as_str()?.to_owned(),
                        items: v["items"].as_array()?.iter().filter_map(|i| i.as_str().map(str::to_owned)).collect(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The version of Sondra: the website's, which the app shares (one list, one number).
pub fn app_version() -> String {
    serde_json::from_str::<serde_json::Value>(PACKAGE).ok().and_then(|v| v["version"].as_str().map(str::to_owned)).unwrap_or_default()
}

/// „28. Okt. 2026“
pub fn date_label(day: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];
    let mut parts = day.split('-').filter_map(|p| p.parse::<usize>().ok());
    match (parts.next(), parts.next(), parts.next()) {
        (Some(y), Some(m), Some(d)) if (1..=12).contains(&m) => format!("{d}. {} {y}", MONTHS[m - 1]),
        _ => day.to_owned(),
    }
}

const SEEN_KEY: &str = "gesehene-version";

impl Shell {
    /// Gives the shell the small file that remembers which version was seen last, and decides whether the
    /// line „Neu in …“ is due.
    pub fn open_whats_new_memory(&mut self, mut store: crate::store::FileStore, cx: &mut Context<Self>) {
        use sondra_merk::folder_memory::Store;
        let now = app_version();
        match store.get_item(SEEN_KEY) {
            // A first visit: no earlier version to compare with, so nothing is said.
            None => {}
            Some(before) if before != now => self.news = Some(now.clone()),
            Some(_) => {}
        }
        store.set_item(SEEN_KEY, now);
        cx.notify();
    }

    /// Opens the window with the list of what is new (and the line about updates).
    pub fn open_whats_new(&mut self, cx: &mut Context<Self>) {
        self.whats_new_open = true;
        cx.notify();
    }

    /// For tests: whether the line „Neu in …“ stands under the header.
    pub fn news_line(&self) -> Option<String> {
        self.news.clone()
    }

    pub(crate) fn news_banner(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let version = self.news.as_ref()?;
        let (open, away) = (cx.entity(), cx.entity());
        let first = releases().into_iter().find(|r| &r.version == version).and_then(|r| r.items.first().cloned());
        let mut line = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.notice(NoticeKind::Info, format!("Neu in {version}{}", first.map(|f| format!(" — {}", f.chars().take(90).collect::<String>().trim_end().to_owned() + if f.chars().count() > 90 { " …" } else { "" })).unwrap_or_default())));
        line = line
            .child(ui.button("neu-lesen", "Was ist neu").small().on_click(move |_, app| open.update(app, |shell, cx| {
                shell.news = None;
                shell.whats_new_open = true;
                cx.notify();
            })))
            .child(ui.button("neu-schliessen", "Schliessen").small().ghost().on_click(move |_, app| away.update(app, |shell, cx| {
                shell.news = None;
                cx.notify();
            })));
        Some(line.into_any_element())
    }

    pub(crate) fn whats_new_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.whats_new_open {
            return None;
        }
        let c = ui.c;
        let now = app_version();
        let mut list = div().flex().flex_col();
        if let Some(section) = self.update_section(&ui, cx) {
            list = list.child(section);
        }
        for (n, release) in releases().into_iter().enumerate() {
            let mut head = div().flex().flex_wrap().items_baseline().gap(px(10.)).child(ui.value(release.version.clone())).child(ui.hint(date_label(&release.date)));
            if release.version == now {
                head = head.child(ui.hint("Diese Fassung"));
            }
            let mut items = div().flex().flex_col().gap(px(6.));
            for item in &release.items {
                items = items.child(ui.prose(format!("• {item}")));
            }
            let mut block = div().flex().flex_col().gap(px(8.)).py(px(16.)).child(head).child(items);
            if n > 0 {
                block = block.border_t_1().border_color(c.line);
            }
            list = list.child(block);
        }
        let (close, away) = (cx.entity(), cx.entity());
        Some(
            ui.dialog("was-ist-neu", "Was ist neu")
                .width(640.)
                .child(list)
                .action(ui.button("lizenzen-oeffnen", "Lizenzen").on_click({
                    let me = cx.entity();
                    move |_, app| me.update(app, |shell, cx| {
                        shell.licenses_open = true;
                        cx.notify();
                    })
                }))
                .action(ui.button("neu-fenster-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.whats_new_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.whats_new_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}
