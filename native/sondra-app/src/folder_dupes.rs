//! „Doppelte finden“ on the Ordner page (`DuplicatesSection` in `FolderPanel.tsx`): files of the same size are
//! compared — whole up to 32 MB, at 32 places above — and the copies are chosen, never deleted by themselves.
//! The finding is `sondra_merk::duplicates`, checked against the website; this file runs it away from the
//! window and shows how far it is and what it found.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::duplicates::{content_key, copies_of, find_duplicates, DuplicateReport};
use sondra_merk::format::format_bytes;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::shell::Shell;

#[derive(Default)]
pub struct Dupes {
    /// Compared so far and in all, while it runs.
    pub done: Arc<AtomicUsize>,
    pub total: Arc<AtomicUsize>,
    pub cancel: Arc<AtomicBool>,
    pub running: bool,
    pub report: Option<DuplicateReport>,
    pub error: Option<String>,
    pub groups_open: bool,
    /// The section is shown.
    pub open: bool,
}

impl Shell {
    pub(crate) fn dupes_run(&mut self, cx: &mut Context<Self>) {
        let (Some(scan), Some(root)) = (&self.folder.scan, self.folder.root.clone()) else { return };
        if self.folder.dupes.running {
            return;
        }
        let files: Vec<_> = scan.files.iter().filter(|f| f.drive.is_none()).cloned().collect();
        let d = &mut self.folder.dupes;
        *d = Dupes { open: true, running: true, ..Dupes::default() };
        let (done, total, cancel) = (d.done.clone(), d.total.clone(), d.cancel.clone());
        Self::in_background(
            cx,
            move || {
                find_duplicates(
                    &files,
                    |file| {
                        let path = root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
                        content_key(&mut std::fs::File::open(path)?)
                    },
                    |n, all| {
                        done.store(n, Ordering::Relaxed);
                        total.store(all, Ordering::Relaxed);
                        !cancel.load(Ordering::Relaxed)
                    },
                )
            },
            |shell, report, cx| {
                let d = &mut shell.folder.dupes;
                d.running = false;
                match report {
                    Some(report) => d.report = Some(report),
                    // Stopped: nothing to show.
                    None => d.open = false,
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The copies — all but the one kept of each group — become the selection.
    pub(crate) fn dupes_select(&mut self, cx: &mut Context<Self>) {
        let Some(report) = &self.folder.dupes.report else { return };
        let copies = copies_of(report);
        let f = &mut self.folder;
        f.selected = copies.iter().map(|c| c.path.clone()).collect();
        f.anchor = copies.first().map(|c| c.path.clone());
        cx.notify();
    }

    pub(crate) fn dupes_section(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let d = &self.folder.dupes;
        if !d.open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut section = div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft).child(ui.subheading("Doppelte Dateien"));
        if d.running {
            let (done, total) = (d.done.load(Ordering::Relaxed), d.total.load(Ordering::Relaxed));
            let cancel = d.cancel.clone();
            section = section.child(div().flex().flex_wrap().items_center().gap(px(14.)).child(ui.prose(format!("Vergleicht {done} von {total} Dateien gleicher Grösse …"))).child(ui.button("doppelte-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.store(true, Ordering::Relaxed))));
        } else if let Some(error) = &d.error {
            section = section.child(ui.notice(NoticeKind::Warning, error.clone()));
        } else if let Some(report) = &d.report {
            if report.groups.is_empty() {
                section = section.child(ui.prose(format!("Keine doppelten Dateien{}.", if report.read > 0 { format!(" — {} Dateien gleicher Grösse verglichen, alle verschieden", report.read) } else { String::new() })));
            } else {
                let copies = copies_of(report).len();
                section = section.child(ui.prose(format!(
                    "{copies} {} in {} {}, zusammen {}. Behalten wird je Gruppe die Datei ohne „(1)“ oder „Kopie“ im Namen, sonst die älteste.",
                    if copies == 1 { "Kopie" } else { "Kopien" },
                    report.groups.len(),
                    if report.groups.len() == 1 { "Gruppe" } else { "Gruppen" },
                    format_bytes(report.spare as f64, 1)
                )));
                let (select, toggle) = (me.clone(), me.clone());
                section = section.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(10.))
                        .child(ui.button("kopien-auswaehlen", "Kopien auswählen").small().primary().on_click(move |_, app| select.update(app, |shell, cx| shell.dupes_select(cx))))
                        .child(ui.button("gruppen-zeigen", if d.groups_open { "Gruppen verbergen" } else { "Gruppen zeigen" }).small().on_click(move |_, app| toggle.update(app, |shell, cx| {
                            shell.folder.dupes.groups_open = !shell.folder.dupes.groups_open;
                            cx.notify();
                        }))),
                );
                if d.groups_open {
                    let mut list = div().flex().flex_col();
                    for (n, group) in report.groups.iter().enumerate() {
                        let mut entry = div().flex().flex_col().gap(px(2.)).py(px(8.)).when(n > 0, |e| e.border_t_1().border_color(c.line)).child(ui.hint(format!("{} · {}", format_bytes(group.size as f64, 1), if group.whole { "Byte für Byte gleich" } else { "an 32 Stellen gleich" })));
                        for (index, file) in group.files.iter().enumerate() {
                            entry = entry.child(div().flex().items_baseline().gap(px(8.)).child(div().flex_none().text_size(px(sondra_ui::size::MICRO)).text_color(if index == 0 { c.ink } else { c.prose }).child(if index == 0 { "Behalten" } else { "Kopie" })).child(div().min_w(px(0.)).truncate().font_family(sondra_ui::family::VALUE).text_color(if index == 0 { c.ink } else { c.prose }).child(file.path.clone())));
                        }
                        list = list.child(entry);
                    }
                    section = section.child(list);
                }
            }
        }
        if !d.running {
            let close = me.clone();
            section = section.child(div().flex().child(ui.button("doppelte-schliessen", "Schliessen").small().ghost().on_click(move |_, app| close.update(app, |shell, cx| {
                shell.folder.dupes.open = false;
                cx.notify();
            }))));
        }
        Some(section.into_any_element())
    }
}
