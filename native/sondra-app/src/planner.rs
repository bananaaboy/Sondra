//! „Bis wohin?“ on the page of a series (`WatchPlanner.tsx`): pick a point to get to — a season and an
//! episode, the end of a season or the whole series — and the page says how much there is to watch to get
//! there, when that is done at a pace (episodes a day or a week), and how much a day it takes to be there by a
//! date. „Genauer rechnen“ counts from the start, with speed and skipped openings; „Als Ziel merken“ keeps the
//! point on the series (`goal`), where page and poster then say how much is left. The sums are
//! `sondra_merk::plan`, checked against the web app's; this only chooses and shows.

use chrono::{Local, NaiveDate};
use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::plan::{day_label, decimal, finish_at, goal_state, in_label, last_point, length_label, opening_of, pace_for, point_label, recent_pace, season_end, stand_point, watch_plan, PaceUnit, PlanOptions, PlanPoint};
use sondra_merk::progress::{season_name, seasons_of};
use sondra_merk::Item;
use sondra_ui::{radius, Ui};

use crate::shell::Shell;

/// What the person has chosen for the page of one series.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannerState {
    pub series: String,
    pub target: Option<PlanPoint>,
    pub speed: f64,
    pub skip_opening: bool,
    /// Episodes a day or a week, as `unit` says.
    pub per_day: f64,
    pub unit: PaceUnit,
    /// „Von vorn rechnen“: everything counts, what is seen too.
    pub from_start: bool,
    /// „Genauer rechnen“ is open.
    pub exact: bool,
}

impl PlannerState {
    pub fn for_series(id: &str) -> PlannerState {
        PlannerState { series: id.to_string(), target: None, speed: 1.0, skip_opening: true, per_day: 2.0, unit: PaceUnit::Day, from_start: false, exact: false }
    }
}

/// The time of the plan in words: „2 Std. 24 Min.“.
fn time(minutes: i64) -> String {
    length_label(minutes as f64)
}

/// A day typed as „24.12.2026“ (or „2026-12-24“).
pub fn read_day(text: &str) -> Option<NaiveDate> {
    let t = text.trim();
    if let Some(d) = sondra_merk::plan::parse_day(Some(t)) {
        return Some(d);
    }
    let mut parts = t.split('.').map(str::trim);
    let (d, m, y) = (parts.next()?.parse::<u32>().ok()?, parts.next()?.parse::<u32>().ok()?, parts.next()?);
    let y = match y.len() {
        2 => 2000 + y.parse::<i32>().ok()?,
        4 => y.parse::<i32>().ok()?,
        _ => return None,
    };
    NaiveDate::from_ymd_opt(y, m, d)
}

impl Shell {
    /// For tests: the field „Bis zum“.
    pub fn planner_day_field(&self) -> gpui::Entity<sondra_ui::TextField> {
        self.merk.plan_by.clone()
    }

    fn planner_state(&self, id: &str) -> PlannerState {
        match &self.merk.planner {
            Some(p) if p.series == id => p.clone(),
            _ => PlannerState::for_series(id),
        }
    }

    /// The block; `None` when there is nothing to plan (a series without a known stand).
    pub(crate) fn planner_block(&self, ui: Ui, item: &Item, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = ui.c;
        let me = cx.entity();
        let state = self.planner_state(&item.id);
        let seasons: Vec<_> = seasons_of(item).into_iter().filter(|s| s.number > 0).collect();
        if seasons.is_empty() && last_point(item).is_none() {
            return None;
        }
        let set = |change: Box<dyn Fn(&mut PlannerState)>| {
            let me = me.clone();
            let id = item.id.clone();
            move |_: &mut gpui::Window, app: &mut gpui::App| {
                me.update(app, |shell, cx| {
                    let mut p = shell.planner_state(&id);
                    change(&mut p);
                    shell.merk.planner = Some(p);
                    cx.notify();
                })
            }
        };
        let stand = stand_point(item);
        let (opening, _) = opening_of(item, None);
        let options = PlanOptions { from_stand: !state.from_start, speed: state.speed, skip_opening: if state.skip_opening { opening as f64 } else { 0.0 } };
        let now = Local::now();
        let today = now.date_naive();

        let mut block = div().flex().flex_col().gap(px(12.)).child(ui.subheading("Bis wohin?"));

        // A goal kept on the series: how much is left, and whether it is on time.
        if let Some(goal) = &item.goal {
            let g = goal_state(&Local, item, goal, options, today);
            let point = point_label(PlanPoint { season: goal.season, episode: goal.episode });
            let mut line = if g.reached { format!("Ziel {point} erreicht.") } else { format!("Ziel: {point} — noch {} {}", g.left, if g.left == 1 { "Folge" } else { "Folgen" }) };
            if let Some(per) = g.per_day.filter(|_| !g.reached) {
                line.push_str(&format!(", {} am Tag reichen", decimal(per.max(0.1), 1).replace('.', ",")));
            }
            if let Some(ahead) = g.ahead.filter(|a| *a != 0 && !g.reached) {
                line.push_str(&format!(" · {} {} {} dem Plan", ahead.abs(), if ahead.abs() == 1 { "Folge" } else { "Folgen" }, if ahead > 0 { "vor" } else { "hinter" }));
            }
            if g.overdue {
                line.push_str(" · Der Tag ist vorbei.");
            }
            let (me, id) = (me.clone(), item.id.clone());
            block = block.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .p(px(12.))
                    .rounded(px(radius::CARD))
                    .bg(c.ink_wash)
                    .child(ui.prose(line))
                    .child(ui.button("ziel-entfernen", "Ziel entfernen").small().ghost().on_click(move |_, app| {
                        let id = id.clone();
                        Shell::merk_do(&me, app, move |m| m.set_goal(&id, None, None))
                    })),
            );
        }

        // Where to: a season and an episode in it, the end of the season one is in, or the whole series.
        let mut targets = div().flex().flex_wrap().items_center().gap(px(6.));
        if let Some(end) = season_end(item, Some(stand.season.max(1))) {
            let name = seasons.iter().find(|s| s.number == end.season).map(season_name).unwrap_or_else(|| format!("Staffel {}", end.season));
            targets = targets.child(ui.chip(format!("ziel-ende-{}", end.season), format!("Ende {name}"), state.target == Some(end)).accessible_name(format!("Ziel Ende {name}")).on_click(set(Box::new(move |p| p.target = Some(end)))));
        }
        for s in &seasons {
            if s.number == stand.season.max(1) {
                continue;
            }
            if let Some(end) = season_end(item, Some(s.number)) {
                let name = season_name(s);
                targets = targets.child(ui.chip(format!("ziel-ende-{}", s.number), format!("Ende {name}"), state.target == Some(end)).accessible_name(format!("Ziel Ende {name}")).on_click(set(Box::new(move |p| p.target = Some(end)))));
            }
        }
        if let Some(last) = last_point(item) {
            targets = targets.child(ui.chip("ziel-ganze-serie", "Ganze Serie", state.target == Some(last)).accessible_name("Ziel Ganze Serie").on_click(set(Box::new(move |p| p.target = Some(last)))));
        }
        block = block.child(targets);

        // Any episode: the season, then the episode with − and +.
        let at = state.target.unwrap_or(PlanPoint { season: stand.season.max(1), episode: stand.episode.max(1) });
        let count = seasons.iter().find(|s| s.number == at.season).and_then(|s| s.episodes);
        let mut exact = div().flex().flex_wrap().items_center().gap(px(6.)).child(ui.hint("Bis"));
        for s in &seasons {
            let number = s.number;
            let last = s.episodes.unwrap_or(1).max(1);
            exact = exact.child(ui.chip(format!("ziel-staffel-{number}"), season_name(s), state.target.is_some() && at.season == number).accessible_name(format!("Ziel in {}", season_name(s))).on_click(set(Box::new(move |p| {
                let episode = p.target.filter(|t| t.season == number).map_or(last, |t| t.episode.min(last));
                p.target = Some(PlanPoint { season: number, episode });
            }))));
        }
        let (less, more) = (at, at);
        exact = exact
            .child(ui.button("ziel-folge-weniger", "−").small().accessible_name("Folge zurück").disabled(at.episode <= 1).on_click(set(Box::new(move |p| p.target = Some(PlanPoint { season: less.season, episode: (less.episode - 1).max(1) })))))
            .child(ui.value(format!("Folge {}", at.episode)))
            .child(ui.button("ziel-folge-mehr", "+").small().accessible_name("Folge weiter").disabled(count.is_some_and(|c| at.episode >= c)).on_click(set(Box::new(move |p| p.target = Some(PlanPoint { season: more.season, episode: more.episode + 1 })))));
        block = block.child(exact);

        let Some(target) = state.target else {
            return Some(block.child(ui.hint("Wählen Sie ein Ziel, und Sie sehen, wie viel bis dahin zu schauen ist.")).into_any_element());
        };

        let plan = watch_plan(item, target, options);
        let mut result = div().flex().flex_col().gap(px(6.)).p(px(14.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        result = result.child(ui.subheading(format!("Bis {}", point_label(target))));
        if plan.behind || plan.episodes == 0 {
            result = result.child(ui.prose(format!("{} ist schon erreicht — es bleibt nichts zu schauen.", point_label(target))));
        } else {
            let unit = if plan.films > 0 && plan.films == plan.episodes { if plan.episodes == 1 { "Film" } else { "Filme" } } else if plan.episodes == 1 { "Folge" } else { "Folgen" };
            let mut line = format!("{} {unit}, {}", plan.episodes, time(plan.minutes));
            if !plan.unknown.is_empty() {
                line = format!("mindestens {line} (für Staffel {} ist die Zahl der Folgen noch nicht bekannt)", plan.unknown.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", "));
            }
            result = result.child(ui.prose(line));
            let mut how = if state.from_start { "Von vorn".to_string() } else { format!("Ab {}", point_label(stand)) };
            if state.skip_opening {
                how.push_str(&format!(", ohne Vorspann ({})", crate::merk_edit::opening_text(opening)));
            }
            if (state.speed - 1.0).abs() > 1e-9 {
                how.push_str(&format!(", mit {}×", format!("{}", state.speed).replace('.', ",")));
            }
            if plan.minutes != plan.raw_minutes {
                how.push_str(&format!(" — statt {}", time(plan.raw_minutes)));
            }
            result = result.child(ui.hint(format!("{how}.")));

            // A pace gives a day: „Bei − 2 + am Tag → Fr., 25. Dez. · in 5 Wochen“.
            let rate = state.per_day.max(1.0);
            let (days, day) = finish_at(plan.episodes, rate, state.unit, today);
            let pace = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .child(ui.hint("Bei"))
                .child(ui.button("tempo-weniger", "−").small().accessible_name("Folgen zurück").disabled(rate <= 1.0).on_click(set(Box::new(|p| p.per_day = (p.per_day - 1.0).max(1.0)))))
                .child(ui.value(format!("{}", rate as i64)))
                .child(ui.button("tempo-mehr", "+").small().accessible_name("Folgen weiter").on_click(set(Box::new(|p| p.per_day = (p.per_day + 1.0).min(99.0)))))
                .child(ui.chip("einheit-tag", "am Tag", state.unit == PaceUnit::Day).on_click(set(Box::new(|p| p.unit = PaceUnit::Day))))
                .child(ui.chip("einheit-woche", "pro Woche", state.unit == PaceUnit::Week).on_click(set(Box::new(|p| p.unit = PaceUnit::Week))))
                .child(ui.value(format!("→ {} · {}", day_label(day, today), in_label(days.max(1)))));
            result = result.child(pace);
            if let Some(own) = recent_pace(item, now.timestamp_millis()) {
                let per = own.per_day;
                result = result.child(div().flex().flex_wrap().items_center().gap(px(8.)).child(ui.hint(format!("Ihr eigenes Tempo der letzten Wochen: etwa {} am Tag.", decimal(per, 1).replace('.', ",")))).child(ui.button("eigenes-tempo", "Übernehmen").small().ghost().on_click(set(Box::new(move |p| {
                    p.per_day = per.round().max(1.0);
                    p.unit = PaceUnit::Day;
                })))));
            }
            // A day gives a pace: „Bis zum [24.12.2026] → 2 am Tag“.
            let typed = self.merk.plan_by.read(cx).text().to_string();
            let by = read_day(&typed);
            let mut until = div().flex().flex_wrap().items_center().gap(px(8.)).child(ui.hint("Bis zum")).child(div().w(px(150.)).child(self.merk.plan_by.clone()));
            match by.and_then(|d| pace_for(plan.episodes, plan.minutes, d, today)) {
                Some(p) => until = until.child(ui.value(format!("→ {} am Tag ({} Min. am Tag)", decimal(p.per_day, 1).replace('.', ","), p.minutes_per_day.round() as i64))),
                None if !typed.trim().is_empty() && by.is_some() => until = until.child(ui.hint("Der Tag ist vorbei.")),
                None if !typed.trim().is_empty() => until = until.child(ui.hint("Als Tag schreiben, etwa 24.12.2026.")),
                None => until = until.child(ui.hint("→ wie viel am Tag")),
            }
            result = result.child(until);
            // Keep it on the series.
            let (me, id, by_text) = (me.clone(), item.id.clone(), by.map(sondra_merk::plan::day_text));
            let label = if item.goal.is_some() { "Als neues Ziel merken" } else { "Als Ziel merken" };
            result = result.child(div().flex().child(ui.button("als-ziel-merken", label).small().on_click(move |_, app| {
                let (id, by) = (id.clone(), by_text.clone());
                Shell::merk_do(&me, app, move |m| m.set_goal(&id, Some(target), by))
            })));
        }
        block = block.child(result);

        // „Genauer rechnen“: from the start, speed, openings.
        block = block.child(div().flex().child(ui.button("genauer-rechnen", if state.exact { "Weniger Optionen" } else { "Genauer rechnen" }).small().ghost().on_click(set(Box::new(|p| p.exact = !p.exact)))));
        if state.exact {
            let mut speeds = div().flex().flex_wrap().items_center().gap(px(6.)).child(ui.hint("Tempo der Wiedergabe:"));
            for x in [1.0f64, 1.25, 1.5, 1.75, 2.0] {
                let label = format!("{}×", format!("{x}").replace('.', ","));
                speeds = speeds.child(ui.chip(format!("plan-tempo-{label}"), label.clone(), (state.speed - x).abs() < 1e-9).accessible_name(format!("Planer Tempo {label}")).on_click(set(Box::new(move |p| p.speed = x))));
            }
            let more = div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .child(ui.chip("plan-ohne-vorspann", format!("Ohne Vorspann ({})", crate::merk_edit::opening_text(opening)), state.skip_opening).on_click(set(Box::new(|p| p.skip_opening = !p.skip_opening))))
                .child(ui.chip("plan-von-vorn", "Von vorn rechnen", state.from_start).accessible_name("Auch Gesehenes zählt — für ein zweites Mal oder für jemanden, der neu anfängt.").on_click(set(Box::new(|p| p.from_start = !p.from_start))));
            block = block.child(speeds).child(more);
        }
        Some(block.into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_is_read_the_way_people_write_it() {
        assert_eq!(read_day("24.12.2026"), NaiveDate::from_ymd_opt(2026, 12, 24));
        assert_eq!(read_day("1.2.27"), NaiveDate::from_ymd_opt(2027, 2, 1));
        assert_eq!(read_day("2026-12-24"), NaiveDate::from_ymd_opt(2026, 12, 24));
        assert_eq!(read_day("31.2.2026"), None);
        assert_eq!(read_day("morgen"), None);
    }
}
