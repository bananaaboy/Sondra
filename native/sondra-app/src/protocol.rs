//! „Protokoll“: what Sondra did, in short lines, to read up on (the website's `log`, „Unter der Haube“). The last
//! 250 lines of this run, kept in memory only — nothing is written to disk or sent; „Leeren“ empties it.

use std::collections::VecDeque;
use std::sync::Mutex;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_ui::Ui;

use crate::shell::Shell;

const KEPT: usize = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub at: chrono::DateTime<chrono::Local>,
    pub level: Level,
    /// Which part of Sondra: „sitzung“, „drive“, „geraete“ …
    pub scope: &'static str,
    pub message: String,
}

static LINES: Mutex<VecDeque<Entry>> = Mutex::new(VecDeque::new());

fn push(level: Level, scope: &'static str, message: String) {
    let mut lines = LINES.lock().unwrap_or_else(|e| e.into_inner());
    lines.push_back(Entry { at: chrono::Local::now(), level, scope, message });
    while lines.len() > KEPT {
        lines.pop_front();
    }
}

/// A line of what was done.
pub fn note(scope: &'static str, message: impl Into<String>) {
    push(Level::Info, scope, message.into());
}

/// A line of what did not work.
pub fn warn(scope: &'static str, message: impl Into<String>) {
    push(Level::Warn, scope, message.into());
}

/// The lines, oldest first.
pub fn lines() -> Vec<Entry> {
    LINES.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
}

pub fn clear() {
    LINES.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

impl Shell {
    pub(crate) fn protocol_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.protocol_open {
            return None;
        }
        let c = ui.c;
        let entries = lines();
        let mut list = div().flex().flex_col().gap(px(6.));
        if entries.is_empty() {
            list = list.child(ui.hint("Noch keine Einträge."));
        }
        // The newest first, as on the website.
        for entry in entries.iter().rev() {
            let mark = if entry.level == Level::Warn { "!" } else { "·" };
            list = list.child(
                div()
                    .flex()
                    .gap(px(10.))
                    .py(px(2.))
                    .border_b_1()
                    .border_color(c.line)
                    .child(div().flex_none().w(px(64.)).child(ui.value(entry.at.format("%H:%M:%S").to_string())))
                    .child(div().flex_none().w(px(90.)).child(ui.hint(format!("{mark} {}", entry.scope))))
                    .child(div().w(px(420.)).child(ui.prose(entry.message.clone()))),
            );
        }
        let (empty, close, away) = (cx.entity(), cx.entity(), cx.entity());
        Some(
            ui.dialog("protokoll", "Protokoll")
                .width(680.)
                .child(div().flex().flex_col().gap(px(10.)).child(ui.hint("Was Sondra in dieser Sitzung getan hat — nur hier im Speicher, nichts davon wird gesendet oder gespeichert.")).child(list))
                .action(ui.button("protokoll-leeren", "Leeren").disabled(entries.is_empty()).on_click(move |_, app| empty.update(app, |_, cx| {
                    clear();
                    cx.notify();
                })))
                .action(ui.button("protokoll-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.protocol_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.protocol_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_last_lines_are_kept_newest_last_and_clear_empties_them() {
        super::clear();
        for i in 0..300 {
            super::note("test", format!("Zeile {i}"));
        }
        super::warn("test", "Fehler");
        let lines = super::lines();
        assert_eq!(lines.len(), 250);
        assert_eq!(lines.last().unwrap().message, "Fehler");
        assert_eq!(lines.first().unwrap().message, "Zeile 51");
        super::clear();
        assert!(super::lines().is_empty());
    }
}
