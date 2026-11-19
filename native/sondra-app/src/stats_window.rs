//! „Statistik und Rückblick“ of the Merkliste (`MerklisteRecap.tsx`): the list in numbers — series by stand,
//! episodes seen, time, seasons, films, ratings — and a year looked back on from the dates every ticked
//! episode carries: episodes and time, the busiest month, the longest run of days, the five most watched.
//! The sums are `sondra_merk::stats` and `recap`, checked against the web app's.

use chrono::{Local, TimeZone};
use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::recap::{recap_years, recorded_since, year_recap};
use sondra_merk::stats::{calculate_stats, format_watch_minutes};
use sondra_ui::{size, Ui};

use crate::shell::Shell;

const MONTHS: [&str; 12] = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];

impl Shell {
    pub(crate) fn stats_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.merk.stats_open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let items = &self.merk.items;
        let s = calculate_stats(items);
        let row = |label: &str, value: String| div().flex().justify_between().gap(px(12.)).py(px(5.)).border_t_1().border_color(c.line).child(div().child(label.to_string())).child(ui.value(value));
        let mut body = div().flex().flex_col().gap(px(14.));
        let mut numbers = div().flex().flex_col();
        numbers = numbers
            .child(row("Serien", format!("{} (Am Schauen {}, Später {}, Pausiert {}, Fertig {}, Abgebrochen {})", s.total_series, s.watching_count, s.later_count, s.paused_count, s.done_count, s.dropped_count)))
            .child(row("Folgen gesehen", s.seen_total.to_string()))
            .child(row("Schauzeit", s.watch_time.long.clone()));
        if let Some(p) = s.overall_progress_percent {
            numbers = numbers.child(row("Fortschritt", format!("{p} % ({} von {} bekannten Folgen)", s.known_watched_episodes, s.known_total_episodes)));
        }
        numbers = numbers.child(row("Staffeln", format!("{} abgeschlossen von {}", s.completed_seasons, s.total_seasons)));
        if s.film_count > 0 {
            numbers = numbers.child(row("Filme", format!("{} gesehen von {}", s.films_seen, s.film_count)));
        }
        if let Some(avg) = &s.avg_rating {
            numbers = numbers.child(row("Bewertung", format!("{} von 5 bei {} bewerteten", avg.replace('.', ","), s.rated_count)));
        }
        body = body.child(numbers);

        // The year.
        let tz = Local::now().timezone();
        let years = recap_years(&tz, items);
        if let Some(first) = years.first().copied() {
            let year = self.merk.recap_year.filter(|y| years.contains(y)).unwrap_or(first);
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            for y in &years {
                let (me, y) = (me.clone(), *y);
                chips = chips.child(ui.chip(format!("rueckblick-{y}"), y.to_string(), y == year).accessible_name(format!("Rückblick {y}")).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.merk.recap_year = Some(y);
                    cx.notify();
                })));
            }
            let r = year_recap(&tz, items, year);
            let mut recap = div().flex().flex_col().gap(px(8.)).child(ui.subheading(format!("Rückblick {year}"))).child(chips);
            recap = recap.child(ui.prose(format!("{} Folgen, {}.", r.episodes, format_watch_minutes(r.minutes).long)));
            if let Some((month, n)) = r.busiest_month {
                recap = recap.child(ui.prose(format!("Stärkster Monat: {} mit {} Folgen.", MONTHS[month], n)));
            }
            if r.streak > 1 {
                recap = recap.child(ui.prose(format!("Längste Serie: {} Tage hintereinander.", r.streak)));
            }
            if r.finished > 0 {
                recap = recap.child(ui.prose(format!("Fertig geschaut: {}.", r.finished)));
            }
            // Twelve bars.
            let peak = r.by_month.iter().copied().max().unwrap_or(0).max(1);
            let mut bars = div().h(px(60.)).flex().items_end().gap(px(4.));
            for (m, n) in r.by_month.iter().enumerate() {
                bars = bars.child(div().flex_1().flex().flex_col().items_center().gap(px(2.)).child(div().w_full().h(px((*n as f32 / peak as f32 * 44.).max(if *n > 0 { 2.0 } else { 0.0 }))).bg(c.ink)).child(div().text_size(px(size::MICRO)).text_color(c.prose).child(MONTHS[m])));
            }
            recap = recap.child(bars);
            if !r.top.is_empty() {
                let mut top = div().flex().flex_col().child(ui.hint("Am meisten geschaut"));
                for t in &r.top {
                    top = top.child(row(&t.title, format!("{} Folgen · {}", t.episodes, format_watch_minutes(t.minutes).short)));
                }
                recap = recap.child(top);
            }
            body = body.child(recap);
            if let Some(since) = recorded_since(items) {
                let day = Local.timestamp_millis_opt(since).single().map(|d| d.format("%d.%m.%Y").to_string()).unwrap_or_default();
                body = body.child(ui.hint(format!("Daten gibt es ab dem {day}; was vorher abgehakt wurde, hat kein Datum und zählt nicht.")));
            }
        } else {
            body = body.child(ui.hint("Für einen Rückblick fehlen noch Daten: jede abgehakte Folge bekommt von nun an ihr Datum."));
        }
        let close = me.clone();
        let away = me.clone();
        Some(
            ui.dialog("statistik-fenster", "Statistik und Rückblick")
                .width(640.)
                .child(body)
                .action(ui.button("statistik-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.merk.stats_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.merk.stats_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}
