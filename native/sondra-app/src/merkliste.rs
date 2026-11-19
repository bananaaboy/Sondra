//! The Merkliste screen: the series one follows, grouped by where each one stands, with a bar for how far
//! one is and a step forward („+1“) on every line. What the lines say is `sondra-merk` (checked against the
//! website's sentences); this file only sets it out. Few things, as the web page has: a search from six
//! entries on, „Serie hinzufügen“, and the pills.

use std::rc::Rc;

use gpui::{div, point, prelude::*, px, AnyElement, App, BoxShadow, Context, ElementId, Entity, SharedString, Window};
use sondra_a11y::{accessible, Role};
use sondra_merk::list::{remove_item, restore_item, Taken};
use sondra_merk::merge::Removed;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::progress::{caught_up, item_progress, season_name, season_progress, seasons_of, settle, toggle_watched, watched_up_to, with_season};
use sondra_merk::rows::{left_label, stand_label};
use sondra_merk::stats::Sort;
use sondra_merk::view::{counts, groups, Filter, STATUS_OPTIONS};
use sondra_merk::{Item, Season, Status};
use sondra_ui::{family, radius, size, Colors, FieldEvent, NoticeKind, TextField, Ui};

use crate::nav::Panel;
use crate::shell::Shell;
use crate::store::{Loaded, MerkStore};

/// With this many entries a search is worth its place on the page.
const SEARCH_FROM: usize = 6;

pub struct MerkState {
    pub items: Vec<Item>,
    pub removed: Removed,
    pub filter: Filter,
    pub sort: Sort,
    pub store: Option<MerkStore>,
    /// Why the list on disk was left alone, when it was.
    pub problem: Option<String>,
    /// Whether the line for a new series is open.
    pub adding: bool,
    /// The series whose page is open, by id.
    pub open: Option<String>,
    /// The last entry taken off the list, for „Rückgängig“.
    pub undo: Option<Taken>,
    pub search: Entity<TextField>,
    pub add: Entity<TextField>,
}

impl MerkState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> MerkState {
        let search = cx.new(|cx| TextField::new(cx, colors, "Merkliste durchsuchen").placeholder("Serie suchen…"));
        let add = cx.new(|cx| TextField::new(cx, colors, "Name der neuen Serie").placeholder("Name der Serie").max_chars(200));
        cx.subscribe(&search, |shell: &mut Shell, field, event: &FieldEvent, cx| {
            if *event == FieldEvent::Changed {
                shell.merk.filter.query = field.read(cx).text().to_string();
                cx.notify();
            }
        })
        .detach();
        cx.subscribe(&add, |shell: &mut Shell, _, event: &FieldEvent, cx| match event {
            FieldEvent::Submitted => shell.add_series(cx),
            FieldEvent::Cancelled => {
                shell.merk.adding = false;
                cx.notify();
            }
            FieldEvent::Changed => {}
        })
        .detach();
        MerkState {
            items: Vec::new(),
            removed: Removed::new(),
            filter: Filter::default(),
            sort: Sort::Recent,
            store: None,
            problem: None,
            adding: false,
            open: None,
            undo: None,
            search,
            add,
        }
    }

    /// Takes the list from the file at `store`. A file that is no Merkliste is left alone, and the list
    /// stays empty — nothing written later may replace what is there.
    pub fn open(&mut self, store: MerkStore) {
        match store.load() {
            Loaded::List(snapshot) => {
                self.items = snapshot.items;
                self.removed = snapshot.removed;
                self.problem = None;
                self.store = Some(store);
            }
            Loaded::Unreadable(why) => {
                self.problem = Some(why);
                self.store = None;
            }
        }
    }

    fn save(&mut self) {
        let Some(store) = &self.store else { return };
        if let Err(error) = store.save(&self.items, &self.removed, &Default::default()) {
            self.problem = Some(format!("Die Merkliste konnte nicht gespeichert werden: {error}"));
        }
    }

    /// „+1“: the episode one stands at is seen, the place moves on to the next.
    pub fn advance(&mut self, id: &str) {
        let Some(pos) = self.items.iter().position(|i| i.id == id) else { return };
        let mut ids = Ids::system();
        let luck = (ids.random)();
        let item = &self.items[pos];
        let seen = sondra_merk::matching::advance(item, ids.now, &luck.chars().take(4).collect::<String>());
        let item = &mut self.items[pos];
        item.seasons = Some(seen.settled.seasons);
        item.season = seen.settled.season;
        item.episode = seen.settled.episode;
        item.status = seen.settled.status;
        item.history = Some(seen.history);
        item.updated_at = ids.now;
        self.save();
    }

    /// Changes one entry and notes the change as made now (`updateMerkItem`).
    fn change(&mut self, id: &str, change: impl FnOnce(&mut Item)) {
        let Some(item) = self.items.iter_mut().find(|i| i.id == id) else { return };
        change(item);
        item.updated_at = Ids::system().now;
        self.save();
    }

    pub fn set_status(&mut self, id: &str, status: Status) {
        self.change(id, |item| item.status = status);
    }

    /// Marks an episode seen or not (everything up to it with `up_to`); the place moves to the first
    /// episode not seen, from this season on.
    pub fn tick(&mut self, id: &str, season: i64, episode: i64, up_to: bool) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let seasons = if up_to { watched_up_to(item, season, episode) } else { toggle_watched(item, season, episode) };
        let settled = settle(item, &seasons, season);
        self.change(id, |item| {
            item.seasons = Some(settled.seasons);
            item.season = settled.season;
            item.episode = settled.episode;
            item.status = settled.status;
        });
    }

    /// Sets how many episodes a season has. A count that cuts off where the entry stands, or that adds
    /// episodes to a series seen to the end, moves the place; otherwise it only changes the season.
    pub fn set_episodes(&mut self, id: &str, season: i64, episodes: Option<i64>) {
        let Some(item) = self.items.iter().find(|i| i.id == id) else { return };
        let seasons = with_season(item, season, |s| Some(Season { episodes, ..s.clone() }));
        let updated = seasons.iter().find(|s| s.number == season);
        let shorter = item.season == season
            && item.episode.is_some()
            && matches!((updated.and_then(|s| s.episodes), item.episode), (Some(total), Some(at)) if at > total);
        let longer = item.status == Status::Done && caught_up(&seasons_of(item)) && !caught_up(&seasons);
        if shorter || longer {
            let settled = settle(item, &seasons, item.season);
            self.change(id, |item| {
                item.seasons = Some(settled.seasons);
                item.season = settled.season;
                item.episode = settled.episode;
                item.status = settled.status;
            });
        } else {
            self.change(id, |item| item.seasons = Some(seasons));
        }
    }

    /// Takes the entry off the list; the page it was on closes and „Rückgängig“ is offered.
    pub fn remove(&mut self, id: &str) {
        let now = Ids::system().now;
        self.undo = remove_item(&mut self.items, &mut self.removed, id, now);
        if self.open.as_deref() == Some(id) {
            self.open = None;
        }
        self.save();
    }

    pub fn restore(&mut self) {
        if let Some(taken) = self.undo.take() {
            restore_item(&mut self.items, &mut self.removed, &taken, Ids::system().now);
            self.save();
        }
    }

    /// A new entry with the name typed and nothing else: it stands at the first season, nothing seen. How
    /// many episodes it has is never asked and never guessed.
    pub fn add_series(&mut self, title: &str) -> Option<String> {
        let title = title.trim();
        if title.is_empty() {
            return None;
        }
        let mut ids = Ids::system();
        let item = normalize(&serde_json::json!({ "title": title, "status": "watching", "updatedAt": ids.now }), &mut ids);
        let id = item.id.clone();
        self.items.insert(0, item);
        self.save();
        Some(id)
    }
}

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One line of the list that can be reached with Tab and opened with Enter or a click, and that a screen
/// reader finds as a list item with its name and what it says.
#[derive(IntoElement)]
struct Line {
    colors: Colors,
    id: SharedString,
    name: SharedString,
    says: SharedString,
    first: bool,
    body: Vec<AnyElement>,
    on_open: Handler,
}

impl RenderOnce for Line {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = self.colors;
        let focus = window
            .use_keyed_state(ElementId::Name(format!("{}-fokus", self.id).into()), cx, |_, cx| cx.focus_handle().tab_stop(true))
            .read(cx)
            .clone();
        let open = self.on_open.clone();
        let key = self.on_open.clone();
        let mut line = div()
            .id(ElementId::Name(format!("{}-bild", self.id).into()))
            .track_focus(&focus)
            .flex()
            .items_center()
            .gap(px(14.))
            .px(px(8.))
            .py(px(10.))
            .rounded(px(radius::NAV))
            .cursor_pointer()
            .hover(move |s| s.bg(c.panel_soft))
            .focus(move |s| {
                s.shadow(vec![
                    BoxShadow { color: c.ink.into(), offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(4.) },
                    BoxShadow { color: c.canvas.into(), offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(2.) },
                ])
            })
            .on_click(move |_, window, cx| open(window, cx))
            .on_key_down(move |event, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    key(window, cx);
                    cx.stop_propagation();
                }
            });
        if !self.first {
            line = line.border_t_1().border_color(c.line);
        }
        let on_open = self.on_open;
        accessible(ElementId::Name(self.id.clone()), Role::ListItem, line.children(self.body))
            .label(self.name)
            .description(self.says)
            .focus(&focus)
            .on_activate(move |window, cx| on_open(window, cx))
    }
}

impl Shell {
    pub(crate) fn add_series(&mut self, cx: &mut Context<Self>) {
        let text = self.merk.add.read(cx).text().to_string();
        if self.merk.add_series(&text).is_some() {
            self.merk.add.update(cx, |f, cx| f.set_text("", cx));
            self.merk.adding = false;
        }
        cx.notify();
    }

    /// Runs a change of the list and draws again.
    fn merk_do(me: &Entity<Shell>, app: &mut App, change: impl FnOnce(&mut MerkState)) {
        me.update(app, |shell, cx| {
            change(&mut shell.merk);
            cx.notify();
        });
    }

    /// The page of the Merkliste: the list, or the page of one series.
    pub(crate) fn merkliste(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        if let Some(item) = self.merk.open.as_ref().and_then(|id| self.merk.items.iter().find(|i| &i.id == id)) {
            return self.series_page(ui, item, cx);
        }
        self.merk_list(ui, cx)
    }

    fn merk_list(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let state = &self.merk;
        let c = ui.c;

        let mut head = div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(ui.heading("Merkliste"));
        let mut actions = div().flex().flex_wrap().items_center().gap(px(10.));
        if state.items.len() >= SEARCH_FROM {
            actions = actions.child(div().w(px(240.)).child(state.search.clone()));
        }
        actions = actions.child({
            let me = me.clone();
            ui.button("serie-hinzufuegen", "Serie hinzufügen").primary().small().on_click(move |_, app| {
                Self::merk_do(&me, app, |m| m.adding = !m.adding)
            })
        });
        head = head.child(actions);

        let mut page = div().flex().flex_col().gap(px(20.)).child(head);

        if let Some(problem) = &state.problem {
            page = page.child(ui.notice(NoticeKind::Warning, problem.clone()));
        }
        if let Some(taken) = &state.undo {
            let me = me.clone();
            page = page.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .child(ui.prose(format!("„{}“ ist von der Merkliste.", taken.item.title)))
                    .child(ui.button("rueckgaengig", "Rückgängig").small().on_click(move |_, app| Self::merk_do(&me, app, |m| m.restore()))),
            );
        }

        if state.adding {
            page = page.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .child(div().w(px(320.)).child(state.add.clone()))
                    .child({
                        let me = me.clone();
                        ui.button("serie-anlegen", "Hinzufügen").on_click(move |_, app| me.update(app, |shell, cx| shell.add_series(cx)))
                    })
                    .child(ui.hint("Die Zahl der Folgen wird später gesucht oder eingetragen.")),
            );
        }

        if state.items.is_empty() {
            return page.child(self.merk_empty(ui, cx)).into_any_element();
        }

        // The pills: all, and each stand somebody is in.
        let mut pills = div().flex().flex_wrap().gap(px(6.));
        pills = pills.child({
            let me = me.clone();
            ui.chip("stand-alle", format!("Alle {}", state.items.len()), state.filter.status.is_none())
                .on_click(move |_, app| Self::merk_do(&me, app, |m| m.filter.status = None))
        });
        for (status, label, n) in counts(&state.items) {
            let me = me.clone();
            pills = pills.child(
                ui.chip(format!("stand-{label}"), format!("{label} {n}"), state.filter.status == Some(status))
                    .on_click(move |_, app| Self::merk_do(&me, app, |m| m.filter.status = if m.filter.status == Some(status) { None } else { Some(status) })),
            );
        }
        page = page.child(pills);

        let sections = groups(&state.items, &state.filter, state.sort);
        if sections.is_empty() {
            return page.child(ui.prose("Keine Serien gefunden für die gewählten Filter.")).into_any_element();
        }
        for group in sections {
            let mut rows = div().flex().flex_col();
            for (n, item) in group.entries.iter().enumerate() {
                rows = rows.child(self.merk_row(ui, item, n == 0, cx));
            }
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(10.))
                            .pb(px(10.))
                            .border_b_1()
                            .border_color(c.line)
                            .child(ui.subheading(group.label))
                            .child(ui.value(group.entries.len().to_string())),
                    )
                    .child(rows),
            );
        }
        page.into_any_element()
    }

    /// No list yet: what to do, not a form.
    fn merk_empty(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let to_folder = {
            let me = me.clone();
            ui.button("ordner-waehlen", "Ordner mit Serien wählen").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.go(Panel::Folder, cx)))
        };
        let type_one = ui.button("eine-serie-tippen", "Eine Serie eintippen").on_click(move |_, app| Self::merk_do(&me, app, |m| m.adding = true));
        div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(ui.subheading("Noch nichts auf der Merkliste"))
            .child(ui.prose("Wählen Sie einen Ordner mit Ihren Serien, oder tippen Sie den Namen einer Serie ein. Sondra merkt sich, wie weit Sie sind."))
            .child(div().flex().flex_wrap().gap(px(8.)).child(to_folder).child(type_one))
            .into_any_element()
    }

    /// One series as a line: where it stands, the bar, what is left, the step forward.
    fn merk_row(&self, ui: Ui, item: &Item, first: bool, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let me = cx.entity();
        let progress = item_progress(item);
        let done = caught_up(&seasons_of(item));
        let can_advance = !done && item.episode.is_some_and(|e| e != 0);
        let stand = stand_label(item);
        let left = left_label(item).unwrap_or_else(|| if done { "Alles gesehen".into() } else { "—".into() });
        let count: SharedString = match progress.total {
            Some(total) => format!("{}/{}", progress.watched, total).into(),
            None => format!("{} gesehen", progress.watched).into(),
        };
        let fraction = progress.fraction.map(|f| f as f32).or(if progress.watched > 0 { None } else { Some(0.0) });

        let poster = div()
            .w(px(44.))
            .h(px(66.))
            .flex_none()
            .rounded(px(6.))
            .bg(c.panel_mid)
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_center()
            .p(px(4.))
            .text_size(px(size::MICRO))
            .text_color(c.muted)
            .child(initials(&item.title))
            .into_any_element();
        let name = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .flex_1()
            .min_w(px(0.))
            .child(div().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).truncate().child(item.title.clone()))
            .child(div().text_size(px(size::SMALL)).text_color(c.prose).truncate().child(stand.clone()))
            .into_any_element();
        let bar = div()
            .w(px(150.))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(5.))
            .child(ui.bar(item.id.clone(), fraction, format!("{}: gesehen", item.title)))
            .child(div().font_family(family::VALUE).text_size(px(size::MICRO)).text_color(c.prose).child(count.clone()))
            .into_any_element();
        let rest = div().w(px(170.)).flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(left.clone()).into_any_element();
        let mut step = div().w(px(60.)).flex_none().flex().justify_end();
        if can_advance {
            let id = item.id.clone();
            let me = me.clone();
            step = step.child(
                ui.button(format!("plus-eins-{}", item.id), "+1")
                    .small()
                    .accessible_name(format!("{stand} von {} als gesehen markieren", item.title))
                    .on_click(move |_, app| {
                        let id = id.clone();
                        Self::merk_do(&me, app, move |m| m.advance(&id))
                    }),
            );
        }
        let id = item.id.clone();
        Line {
            colors: c,
            id: format!("serie-{}", item.id).into(),
            name: item.title.clone().into(),
            says: format!("{stand}. {count}. {left}").into(),
            first,
            body: vec![poster, name, bar, rest, step.into_any_element()],
            on_open: Rc::new(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.open = Some(id))
            }),
        }
        .into_any_element()
    }

    /// The page of one series: where it stands, the step forward, the stand, and every season with its
    /// episodes to tick.
    fn series_page(&self, ui: Ui, item: &Item, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let progress = item_progress(item);
        let done = caught_up(&seasons_of(item));
        let stand = stand_label(item);
        let count = match progress.total {
            Some(total) => format!("{}/{} gesehen", progress.watched, total),
            None => format!("{} gesehen", progress.watched),
        };
        let mut facts = vec![stand.clone(), count];
        if let Some(left) = left_label(item) {
            facts.push(left);
        }

        let back = {
            let me = me.clone();
            ui.button("zurueck-zur-merkliste", "Zurück zur Merkliste").ghost().on_click(move |_, app| Self::merk_do(&me, app, |m| m.open = None))
        };

        let mut stands = div().flex().flex_wrap().gap(px(6.));
        for (status, label) in STATUS_OPTIONS {
            let me = me.clone();
            let id = item.id.clone();
            stands = stands.child(
                ui.chip(format!("setze-{label}"), label, item.status == status)
                    .accessible_name(format!("Stand: {label}"))
                    .on_click(move |_, app| {
                        let id = id.clone();
                        Self::merk_do(&me, app, move |m| m.set_status(&id, status))
                    }),
            );
        }

        let mut actions = div().flex().flex_wrap().items_center().gap(px(8.));
        if !done && item.episode.is_some_and(|e| e != 0) {
            let unit = if item.season == 0 { "Film" } else { "Folge" };
            let at = item.episode.unwrap_or(0);
            let me = me.clone();
            let id = item.id.clone();
            actions = actions.child(ui.button("naechste-gesehen", format!("{unit} {at} gesehen")).primary().on_click(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.advance(&id))
            }));
        }
        actions = actions.child({
            let me = me.clone();
            let id = item.id.clone();
            ui.button("serie-entfernen", "Von der Merkliste entfernen").on_click(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.remove(&id))
            })
        });

        let mut page = div()
            .flex()
            .flex_col()
            .gap(px(20.))
            .child(div().flex().child(back))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(ui.heading(item.title.clone()))
                    .child(ui.prose(facts.join(" · "))),
            )
            .child(stands)
            .child(actions);

        for season in seasons_of(item) {
            page = page.child(self.season_block(ui, item, &season, cx));
        }
        page.into_any_element()
    }

    /// One season: its name and count, how many episodes it has, and the episodes to tick.
    fn season_block(&self, ui: Ui, item: &Item, season: &Season, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let me = cx.entity();
        let number = season.number;
        let unit = if number == 0 { "Film" } else { "Folge" };
        let units = if number == 0 { "Filme" } else { "Folgen" };
        let one = if number == 0 { "Einen Film" } else { "Eine Folge" };
        let progress = season_progress(season);
        let name = season_name(season);
        let here = (item.season == number).then_some(item.episode).flatten();

        let count = match season.episodes {
            Some(total) => format!("{}/{}", progress.watched, total),
            None => format!("{} gesehen", progress.watched),
        };
        let stepper = {
            let mut row = div().flex().flex_wrap().items_center().gap(px(8.));
            match season.episodes {
                Some(total) => {
                    let (less, more) = (me.clone(), me.clone());
                    let (id_less, id_more) = (item.id.clone(), item.id.clone());
                    row = row
                        .child(ui.value(format!("{total} {units}")))
                        .child(
                            ui.button(format!("weniger-{number}"), "−")
                                .small()
                                .accessible_name(format!("{} weniger in {name}", one))
                                .on_click(move |_, app| {
                                    let id = id_less.clone();
                                    Self::merk_do(&less, app, move |m| m.set_episodes(&id, number, Some((total - 1).max(1))))
                                }),
                        )
                        .child(
                            ui.button(format!("mehr-{number}"), "+")
                                .small()
                                .accessible_name(format!("{} mehr in {name}", one))
                                .on_click(move |_, app| {
                                    let id = id_more.clone();
                                    Self::merk_do(&more, app, move |m| m.set_episodes(&id, number, Some(total + 1)))
                                }),
                        );
                }
                None => {
                    let me = me.clone();
                    let id = item.id.clone();
                    let start = season.watched.iter().copied().max().unwrap_or(0).max(1);
                    row = row.child(ui.hint(format!("Die Zahl der {units} ist nicht bekannt."))).child(
                        ui.button(format!("zahl-eintragen-{number}"), format!("Zahl der {units} eintragen"))
                            .small()
                            .accessible_name(format!("Zahl der {units} in {name} eintragen"))
                            .on_click(move |_, app| {
                                let id = id.clone();
                                Self::merk_do(&me, app, move |m| m.set_episodes(&id, number, Some(start)))
                            }),
                    );
                }
            }
            row
        };

        let mut grid = div().flex().flex_wrap().gap(px(6.));
        let shown = season.episodes.unwrap_or(0);
        for episode in 1..=shown {
            let seen = season.watched.contains(&episode);
            let me = me.clone();
            let id = item.id.clone();
            let at_here = here == Some(episode);
            let name = format!("{unit} {episode}{}", if at_here { ", hier sind Sie" } else { "" });
            grid = grid.child(
                ui.chip(format!("folge-{number}-{episode}"), episode.to_string(), seen).accessible_name(name).on_click(move |window, app| {
                    let id = id.clone();
                    let up_to = window.modifiers().shift;
                    Self::merk_do(&me, app, move |m| m.tick(&id, number, episode, up_to))
                }),
            );
        }

        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(10.))
                    .pb(px(10.))
                    .border_b_1()
                    .border_color(c.line)
                    .child(ui.subheading(name.clone()))
                    .child(ui.value(count)),
            )
            .child(stepper)
            .child(grid)
            .into_any_element()
    }
}

/// The first letters of the words of a title, for a poster without a cover.
fn initials(title: &str) -> String {
    let letters: String = title.split_whitespace().filter_map(|w| w.chars().find(|c| c.is_alphanumeric())).take(3).collect();
    letters.to_uppercase()
}
