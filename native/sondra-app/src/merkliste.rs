//! The Merkliste screen: the series one follows, grouped by where each one stands, with a bar for how far
//! one is and a step forward („+1“) on every line. What the lines say is `sondra-merk` (checked against the
//! website's sentences); this file only sets it out. Few things, as the web page has: a search from six
//! entries on, „Serie hinzufügen“, and the pills.

use gpui::{div, prelude::*, px, AnyElement, Context, ElementId, Entity, SharedString};
use sondra_a11y::{accessible, Role};
use sondra_merk::merge::Removed;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::progress::{caught_up, item_progress, seasons_of};
use sondra_merk::rows::{left_label, stand_label};
use sondra_merk::stats::Sort;
use sondra_merk::view::{counts, groups, Filter};
use sondra_merk::Item;
use sondra_ui::{family, radius, size, FieldEvent, NoticeKind, TextField, Ui};

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
        self.removed.remove(id);
        self.save();
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

impl Shell {
    pub(crate) fn add_series(&mut self, cx: &mut Context<Self>) {
        let text = self.merk.add.read(cx).text().to_string();
        if self.merk.add_series(&text).is_some() {
            self.merk.add.update(cx, |f, cx| f.set_text("", cx));
            self.merk.adding = false;
        }
        cx.notify();
    }

    /// The page of the Merkliste.
    pub(crate) fn merkliste(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
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
                me.update(app, |shell, cx| {
                    shell.merk.adding = !shell.merk.adding;
                    cx.notify();
                })
            })
        });
        head = head.child(actions);

        let mut page = div().flex().flex_col().gap(px(20.)).child(head);

        if let Some(problem) = &state.problem {
            page = page.child(ui.notice(NoticeKind::Warning, problem.clone()));
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
            ui.chip("stand-alle", format!("Alle {}", state.items.len()), state.filter.status.is_none()).on_click(move |_, app| {
                me.update(app, |shell, cx| {
                    shell.merk.filter.status = None;
                    cx.notify();
                })
            })
        });
        for (status, label, n) in counts(&state.items) {
            let me = me.clone();
            pills = pills.child(ui.chip(format!("stand-{label}"), format!("{label} {n}"), state.filter.status == Some(status)).on_click(move |_, app| {
                me.update(app, |shell, cx| {
                    shell.merk.filter.status = if shell.merk.filter.status == Some(status) { None } else { Some(status) };
                    cx.notify();
                })
            }));
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
        let type_one = ui.button("eine-serie-tippen", "Eine Serie eintippen").on_click(move |_, app| {
            me.update(app, |shell, cx| {
                shell.merk.adding = true;
                cx.notify();
            })
        });
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

        let mut line = div()
            .flex()
            .items_center()
            .gap(px(14.))
            .px(px(8.))
            .py(px(10.))
            .rounded(px(radius::NAV))
            .hover(move |s| s.bg(c.panel_soft));
        if !first {
            line = line.border_t_1().border_color(c.line);
        }
        line = line
            .child(
                // The poster is the name itself, set on the tint, until there is a cover to show.
                div()
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
                    .child(initials(&item.title)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .flex_1()
                    .min_w(px(0.))
                    .child(div().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).truncate().child(item.title.clone()))
                    .child(div().text_size(px(size::SMALL)).text_color(c.prose).truncate().child(stand.clone())),
            )
            .child(
                div()
                    .w(px(150.))
                    .flex_none()
                    .flex()
                    .flex_col()
                    .gap(px(5.))
                    .child(ui.bar(item.id.clone(), fraction, format!("{}: gesehen", item.title)))
                    .child(div().font_family(family::VALUE).text_size(px(size::MICRO)).text_color(c.prose).child(count.clone())),
            )
            .child(div().w(px(170.)).flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(left.clone()));
        let mut step = div().w(px(60.)).flex_none().flex().justify_end();
        if can_advance {
            let id = item.id.clone();
            step = step.child(
                ui.button(format!("plus-eins-{}", item.id), "+1")
                    .small()
                    .accessible_name(format!("{stand} von {} als gesehen markieren", item.title))
                    .on_click(move |_, app| {
                        let id = id.clone();
                        me.update(app, |shell, cx| {
                            shell.merk.advance(&id);
                            cx.notify();
                        })
                    }),
            );
        }
        accessible(ElementId::Name(format!("serie-{}", item.id).into()), Role::ListItem, line.child(step))
            .label(item.title.clone())
            .description(format!("{stand}. {count}. {left}"))
            .into_any_element()
    }
}

/// The first letters of the words of a title, for a poster without a cover.
fn initials(title: &str) -> String {
    let letters: String = title.split_whitespace().filter_map(|w| w.chars().find(|c| c.is_alphanumeric())).take(3).collect();
    letters.to_uppercase()
}
