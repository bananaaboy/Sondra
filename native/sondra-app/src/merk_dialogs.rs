//! Two small windows of the Merkliste: „Verlauf“ (the episodes ticked off last, each with „Rückgängig“) and
//! „Was soll ich schauen?“ (a series picked at random from those not yet finished, another one on a click).
//! `MerklisteHistory`/`ShuffleDialog` in `MerklistePanel.tsx`; the pick's pool is `sondra_merk::stats::random_pool`.

use chrono::{Datelike, Local, TimeZone};
use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::importer::all_history;
use sondra_merk::normalize::Context as Ids;
use sondra_merk::progress::{caught_up, item_progress, seasons_of, settle, with_season};
use sondra_merk::rows::stand_label;
use sondra_merk::stats::random_pool;
use sondra_merk::Season;
use sondra_ui::Ui;

use crate::merkliste::MerkState;
use crate::shell::Shell;

const SHOWN: usize = 50;
const MONTHS: [&str; 12] = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];

/// „Heute, 14:05“ or „19. Nov., 14:05“.
fn when(at: i64) -> String {
    let Some(d) = Local.timestamp_millis_opt(at).single() else { return String::new() };
    let time = d.format("%H:%M");
    if d.date_naive() == Local::now().date_naive() {
        format!("Heute, {time}")
    } else {
        format!("{}. {}, {time}", d.day(), MONTHS[d.month0() as usize])
    }
}

impl MerkState {
    /// Takes one ticked-off episode back (`undoWatchHistory`): it is no longer seen, the place settles again
    /// from its season, and its line leaves the history.
    pub fn undo_history(&mut self, item_id: &str, entry_id: &str) {
        let Some(item) = self.items.iter().find(|i| i.id == item_id) else { return };
        let Some(entry) = item.history.iter().flatten().find(|h| h.id == entry_id).cloned() else { return };
        let seasons = with_season(item, entry.season, |s| Some(Season { watched: s.watched.iter().copied().filter(|n| *n != entry.episode).collect(), ..s.clone() }));
        let settled = settle(item, &seasons, entry.season);
        let remaining: Vec<_> = item.history.iter().flatten().filter(|h| h.id != entry_id).cloned().collect();
        let now = Ids::system().now;
        if let Some(item) = self.items.iter_mut().find(|i| i.id == item_id) {
            item.seasons = Some(settled.seasons);
            item.season = settled.season;
            item.episode = settled.episode;
            item.status = settled.status;
            item.history = Some(remaining);
            item.updated_at = now;
        }
        self.save();
    }

    /// Picks another series for „Würfeln“, never the one just shown when another is left.
    pub fn roll(&mut self) {
        let mut ids = Ids::system();
        let luck: u64 = (ids.random)().bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
        let pool = random_pool(&self.items, self.dice_id.as_deref());
        self.dice_id = (!pool.is_empty()).then(|| pool[(luck % pool.len() as u64) as usize].id.clone());
    }
}

impl Shell {
    pub(crate) fn history_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.merk.history_open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let history = all_history(&self.merk.items);
        let mut body = div().flex().flex_col();
        if history.is_empty() {
            body = body.child(ui.prose("Noch keine Folgen im Verlauf erfasst. Sobald Sie Folgen als gesehen markieren, erscheinen sie hier."));
        }
        for (n, (item, entry)) in history.iter().take(SHOWN).enumerate() {
            let (me, item_id, entry_id) = (me.clone(), item.id.clone(), entry.id.clone());
            let where_ = if entry.season == 0 { format!("Film {}", entry.episode) } else { format!("Staffel {}, Folge {}", entry.season, entry.episode) };
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .py(px(8.))
                    .when(n > 0, |d| d.border_t_1().border_color(c.line))
                    .child(div().flex().flex_col().min_w(px(0.)).flex_1().child(div().truncate().font_weight(gpui::FontWeight::SEMIBOLD).text_color(c.ink).child(item.title.clone())).child(ui.hint(format!("{where_} · {}", when(entry.at)))))
                    .child(ui.button(format!("verlauf-zurueck-{n}"), "Rückgängig").small().accessible_name(format!("{} · {where_} als ungesehen markieren", item.title)).on_click(move |_, app| {
                        let (item_id, entry_id) = (item_id.clone(), entry_id.clone());
                        me.update(app, |shell, cx| {
                            shell.merk.undo_history(&item_id, &entry_id);
                            cx.notify();
                        })
                    })),
            );
        }
        let (close, away) = (me.clone(), me.clone());
        Some(
            ui.dialog("verlauf-fenster", "Zuletzt geschaut (Verlauf)")
                .width(560.)
                .child(body)
                .action(ui.button("verlauf-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.merk.history_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.merk.history_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    pub(crate) fn dice_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.merk.dice_open {
            return None;
        }
        let item = self.merk.dice_id.as_ref().and_then(|id| self.merk.items.iter().find(|i| &i.id == id))?;
        let me = cx.entity();
        let progress = item_progress(item);
        let can_advance = !caught_up(&seasons_of(item)) && item.episode.is_some();
        let seen = match progress.total {
            Some(total) => format!("{} von {} gesehen", progress.watched, total),
            None => format!("{} gesehen", progress.watched),
        };
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(ui.heading(item.title.clone()))
            .child(ui.prose(format!("{} · {seen}", stand_label(item))))
            .child(ui.bar("wuerfel-fortschritt", progress.fraction.map(|f| f as f32), format!("{}: gesehen", item.title)));
        if let Some(notes) = item.notes.as_ref().filter(|n| !n.trim().is_empty()) {
            body = body.child(ui.hint(notes.clone()));
        }
        let mut actions = div().flex().flex_wrap().items_center().gap(px(8.));
        {
            let me = me.clone();
            actions = actions.child(ui.button("wuerfel-nochmal", "Anderen Vorschlag würfeln").small().on_click(move |_, app| me.update(app, |shell, cx| {
                shell.merk.roll();
                cx.notify();
            })));
        }
        if can_advance {
            let (me, id) = (me.clone(), item.id.clone());
            let unit = if item.season == 0 { "Film" } else { "Folge" };
            actions = actions.child(ui.button("wuerfel-gesehen", format!("{unit} {} gesehen", item.episode.unwrap_or(0))).small().on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| {
                    shell.merk.advance(&id);
                    cx.notify();
                })
            }));
        }
        {
            let (me, id) = (me.clone(), item.id.clone());
            actions = actions.child(ui.button("wuerfel-oeffnen", "Serie öffnen").small().primary().on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| {
                    shell.merk.dice_open = false;
                    shell.merk.open = Some(id);
                    cx.notify();
                })
            }));
        }
        let away = me.clone();
        Some(
            ui.dialog("wuerfel-fenster", "Was soll ich schauen?")
                .width(520.)
                .child(body)
                .action(actions)
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.merk.dice_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}
