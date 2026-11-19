//! „Bis wohin?“ on the page of a series (`WatchPlanner.tsx`): pick a point to get to, and the page says how
//! much there is to watch to get there — episodes, time with speed and skipped openings — and, for a pace
//! (episodes a day or a week) when that is done. The sums are `sondra_merk::plan`, checked against the web
//! app's; this only chooses and shows.

use chrono::Local;
use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::plan::{day_label, finish_at, in_label, length_label, opening_of, point_label, recent_pace, season_end, last_point, watch_plan, PaceUnit, PlanOptions, PlanPoint};
use sondra_merk::progress::{season_name, seasons_of};
use sondra_merk::Item;
use sondra_ui::Ui;

use crate::shell::Shell;

/// What the person has chosen for the page of one series.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannerState {
    pub series: String,
    pub target: Option<PlanPoint>,
    pub speed: f64,
    pub skip_opening: bool,
    /// Episodes a day.
    pub per_day: f64,
    pub unit: PaceUnit,
}

impl PlannerState {
    pub fn for_series(id: &str) -> PlannerState {
        PlannerState { series: id.to_string(), target: None, speed: 1.0, skip_opening: false, per_day: 2.0, unit: PaceUnit::Day }
    }
}

/// The time of the plan in words: „2 Std. 24 Min.“.
fn time(minutes: i64) -> String {
    length_label(minutes as f64)
}

impl Shell {
    /// The block; `None` when there is nothing to plan (a series without a known stand).
    pub(crate) fn planner_block(&self, ui: Ui, item: &Item, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = ui.c;
        let me = cx.entity();
        let state = match &self.merk.planner {
            Some(p) if p.series == item.id => p.clone(),
            _ => PlannerState::for_series(&item.id),
        };
        let seasons: Vec<_> = seasons_of(item).into_iter().filter(|s| s.number > 0).collect();
        if seasons.is_empty() && last_point(item).is_none() {
            return None;
        }
        let set = |change: Box<dyn Fn(&mut PlannerState)>| {
            let me = me.clone();
            let id = item.id.clone();
            move |_: &mut gpui::Window, app: &mut gpui::App| {
                me.update(app, |shell, cx| {
                    let mut p = match &shell.merk.planner {
                        Some(p) if p.series == id => p.clone(),
                        _ => PlannerState::for_series(&id),
                    };
                    change(&mut p);
                    shell.merk.planner = Some(p);
                    cx.notify();
                })
            }
        };

        // Where to: the end of a season, or the whole series.
        let mut targets = div().flex().flex_wrap().gap(px(6.));
        for s in &seasons {
            if let Some(end) = season_end(item, Some(s.number)) {
                let name = season_name(s);
                let on = state.target == Some(end);
                targets = targets.child(ui.chip(format!("ziel-ende-{}", s.number), format!("Ende {name}"), on).accessible_name(format!("Ziel Ende {name}")).on_click(set(Box::new(move |p| p.target = Some(end)))));
            }
        }
        if let Some(last) = last_point(item) {
            targets = targets.child(ui.chip("ziel-ganze-serie", "Ganze Serie", state.target == Some(last)).accessible_name("Ziel Ganze Serie").on_click(set(Box::new(move |p| p.target = Some(last)))));
        }

        let mut block = div().flex().flex_col().gap(px(12.)).child(ui.subheading("Bis wohin?")).child(ui.hint("Wählen Sie ein Ziel, und Sie sehen, wie viel bis dahin zu schauen ist.")).child(targets);
        let Some(target) = state.target else { return Some(block.into_any_element()) };

        // How: speed and skipped openings.
        let (opening, _) = opening_of(item, None);
        let mut speeds = div().flex().flex_wrap().items_center().gap(px(6.)).child(ui.hint("Tempo:"));
        for x in [1.0f64, 1.25, 1.5, 2.0] {
            let label = format!("{}×", format!("{x}").replace('.', ","));
            speeds = speeds.child(ui.chip(format!("plan-tempo-{label}"), label.clone(), (state.speed - x).abs() < 1e-9).accessible_name(format!("Planer Tempo {label}")).on_click(set(Box::new(move |p| p.speed = x))));
        }
        speeds = speeds.child(ui.chip("plan-ohne-vorspann", format!("Ohne Vorspann ({opening} s)"), state.skip_opening).on_click(set(Box::new(|p| p.skip_opening = !p.skip_opening))));
        block = block.child(speeds);

        let plan = watch_plan(item, target, PlanOptions { from_stand: true, speed: state.speed, skip_opening: if state.skip_opening { opening as f64 } else { 0.0 } });
        let now = Local::now();
        let today = now.date_naive();
        let mut words = vec![];
        if plan.behind || plan.episodes == 0 {
            words.push(format!("{} ist schon erreicht — es bleibt nichts zu schauen.", point_label(target)));
        } else {
            let unit = if plan.films > 0 && plan.films == plan.episodes { if plan.episodes == 1 { "Film" } else { "Filme" } } else if plan.episodes == 1 { "Folge" } else { "Folgen" };
            let mut line = format!("{} {unit}, {}", plan.episodes, time(plan.minutes));
            if !plan.unknown.is_empty() {
                line = format!("mindestens {line} (für Staffel {} ist die Zahl der Folgen noch nicht bekannt)", plan.unknown.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", "));
            }
            words.push(line);
            if plan.minutes != plan.raw_minutes {
                words.push(format!("statt {} ohne Tempo und Vorspann", time(plan.raw_minutes)));
            }
        }
        let mut result = div().flex().flex_col().gap(px(4.)).p(px(14.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft);
        result = result.child(ui.subheading(format!("Bis {}", point_label(target))));
        for w in &words {
            result = result.child(ui.prose(w.clone()));
        }
        // Pace: when it is done at so many a day (the own pace of the last weeks is the first choice).
        if plan.episodes > 0 && !plan.behind {
            let own = recent_pace(item, now.timestamp_millis());
            let mut paces = div().flex().flex_wrap().items_center().gap(px(6.)).child(ui.hint("Bei"));
            let mut options = vec![1.0f64, 2.0, 3.0, 4.0];
            if let Some(o) = own {
                let r = o.per_day.round().max(1.0);
                if !options.contains(&r) {
                    options.push(r);
                    options.sort_by(|a, b| a.total_cmp(b));
                }
            }
            for x in options {
                paces = paces.child(ui.chip(format!("plan-rate-{x}"), format!("{x}"), state.unit == PaceUnit::Day && (state.per_day - x).abs() < 1e-9).accessible_name(format!("{x} am Tag")).on_click(set(Box::new(move |p| {
                    p.per_day = x;
                    p.unit = PaceUnit::Day;
                }))));
            }
            paces = paces.child(ui.hint("am Tag →"));
            let (days, day) = finish_at(plan.episodes, state.per_day, state.unit, today);
            result = result.child(paces).child(ui.value(format!("Fertig {} ({})", day_label(day, today), in_label(days.max(1)))));
            if let Some(o) = own {
                result = result.child(ui.hint(format!("Ihr eigenes Tempo der letzten Wochen: etwa {} am Tag.", sondra_merk::plan::decimal(o.per_day, 1).replace('.', ","))));
            }
        }
        block = block.child(result);
        Some(block.into_any_element())
    }
}
