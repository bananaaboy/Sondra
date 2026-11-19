//! The Merkliste screen: the series one follows, grouped by where each one stands, with a bar for how far
//! one is and a step forward („+1“) on every line. What the lines say is `sondra-merk` (checked against the
//! website's sentences); this file only sets it out. Few things, as the web page has: a search from six
//! entries on, „Serie hinzufügen“, and the pills.

use std::rc::Rc;

use gpui::{deferred, div, prelude::*, px, AnyElement, App, Context, Entity, SharedString};
use sondra_merk::list::{remove_item, restore_item, Taken};
use sondra_merk::merge::Removed;
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::progress::{caught_up, item_progress, season_name, season_progress, seasons_of, settle, toggle_watched, watched_up_to, with_season};
use sondra_merk::rows::{left_label, stand_label};
use sondra_merk::stats::{Sort, SORT_OPTIONS};
use sondra_merk::view::{counts, groups, Filter, STATUS_OPTIONS};
use sondra_merk::{Item, Season, Status};
use sondra_ui::{family, size, FieldEvent, NoticeKind, TextField, Ui};

use crate::covers::{render_cover, Covers, SharedCovers};
use crate::lines::Line;
use crate::nav::Panel;
use crate::shell::Shell;
use crate::store::{Loaded, MerkStore};

/// With this many entries a search is worth its place on the page.
const SEARCH_FROM: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Poster,
    List,
}

pub struct MerkState {
    pub items: Vec<Item>,
    pub removed: Removed,
    pub filter: Filter,
    pub sort: Sort,
    /// Posters on a shelf, or one line a series.
    pub view: View,
    /// The menu behind „Mehr“ is open.
    pub more: bool,
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
    /// The pictures of the covers, made at the size they are shown.
    pub covers: SharedCovers,
    /// What is chosen in „Bis wohin?“ for the series whose page is open.
    pub planner: Option<crate::planner::PlannerState>,
    /// The window with the numbers and the year looked back on.
    pub stats_open: bool,
    /// The windows „Verlauf“ and „Was soll ich schauen?“, and the series the dice showed last.
    pub history_open: bool,
    pub dice_open: bool,
    pub dice_id: Option<String>,
    pub recap_year: Option<i32>,
    /// What the last export or reading-in said, in a sentence.
    pub note: Option<String>,
    pub share: crate::share_window::ShareState,
    pub receive: crate::receive_window::ReceiveState,
    /// „Wie weit sind Sie?“ when adding: the episode to watch next (1: not begun).
    pub add_next: i64,
    /// What „Suchen“ found for the name typed.
    pub add_found: Option<crate::anilist::Media>,
    pub add_searching: bool,
    /// The list as it was before a file was read in, to take it back.
    pub before_import: Option<(Vec<Item>, Removed)>,
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
            view: View::Poster,
            more: false,
            store: None,
            problem: None,
            adding: false,
            open: None,
            undo: None,
            search,
            add,
            covers: SharedCovers::default(),
            planner: None,
            stats_open: false,
            history_open: false,
            dice_open: false,
            dice_id: None,
            recap_year: None,
            note: None,
            share: Default::default(),
            receive: crate::receive_window::ReceiveState::new(cx, colors),
            add_next: 1,
            add_found: None,
            add_searching: false,
            before_import: None,
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

    pub(crate) fn save(&mut self) {
        let Some(store) = &self.store else { return };
        if let Err(error) = store.save(&self.items, &self.removed, &Default::default()) {
            self.problem = Some(format!("Die Merkliste konnte nicht gespeichert werden: {error}"));
        }
    }

    /// Writes the list as a SQLite file into the downloads folder (the same format the website exports).
    pub fn export_list(&mut self, folder: &std::path::Path) {
        let snapshot = sondra_merk::sqlite::Snapshot { items: self.items.clone(), removed: self.removed.clone(), ..Default::default() };
        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        let result = std::fs::create_dir_all(folder).and_then(|_| {
            let bytes = sondra_merk::sqlite::write_sqlite(&snapshot).map_err(|e| std::io::Error::other(e.to_string()))?;
            let target = sondra_media::run::unique_path(folder, &format!("Sondra-Merkliste-{day}"), "sqlite");
            std::fs::write(&target, bytes).map(|_| target)
        });
        self.before_import = None;
        self.note = Some(match result {
            Ok(path) => format!("Die Merkliste liegt in {}.", path.display()),
            Err(e) => format!("Die Merkliste liess sich nicht schreiben: {e}"),
        });
    }

    /// Reads a file in (SQLite, JSON, MyAnimeList, AniList) and brings its entries into the list: the same
    /// series is not doubled, and whichever side was changed last wins.
    pub fn import_file(&mut self, path: &std::path::Path) {
        self.before_import = None;
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                self.note = Some(format!("Die Datei liess sich nicht lesen: {e}"));
                return;
            }
        };
        let mut ids = sondra_merk::normalize::Context::system();
        match sondra_merk::importer::read_merkliste_file(&bytes, &mut ids) {
            Ok(incoming) => {
                let merged = sondra_merk::merge::merge_merkliste(&self.items, &incoming);
                let before = (self.items.clone(), self.removed.clone());
                self.items = merged.items;
                self.save();
                self.before_import = Some(before);
                let mut parts = vec![];
                if merged.added > 0 {
                    parts.push(format!("{} neu", merged.added));
                }
                if merged.updated > 0 {
                    parts.push(format!("{} aktualisiert", merged.updated));
                }
                if merged.same > 0 {
                    parts.push(format!("{} schon gleich", merged.same));
                }
                if merged.kept > 0 {
                    parts.push(format!("{} hier neuer, so belassen", merged.kept));
                }
                self.note = Some(format!("Eingelesen: {}.", if parts.is_empty() { "nichts Neues".to_string() } else { parts.join(", ") }));
            }
            Err(e) => self.note = Some(e.to_string()),
        }
    }

    /// Takes a reading-in back: the list as it was.
    pub fn revert_import(&mut self) {
        if let Some((items, removed)) = self.before_import.take() {
            self.items = items;
            self.removed = removed;
            self.save();
            self.note = Some("Das Einlesen ist zurückgenommen.".into());
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

    /// What is new online, taken onto the list: the season and any missing before it added, or its count
    /// raised; the place settles on the first episode not seen.
    pub fn take_news(&mut self, id: &str) {
        let Some(taken) = self.items.iter().find(|i| i.id == id).and_then(sondra_merk::progress::take_online_news) else { return };
        self.change(id, |item| {
            item.seasons = Some(taken.seasons);
            item.season = taken.season;
            item.episode = taken.episode;
            item.status = taken.status;
        });
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

    /// An episode the player saw to 90 %: ticked off, the place settled on the next, the history written.
    /// Returns the entry as it was before, for „Rückgängig“.
    pub fn saw_episode(&mut self, id: &str, season: i64, episode: i64) -> Option<Item> {
        let pos = self.items.iter().position(|i| i.id == id)?;
        let before = self.items[pos].clone();
        let mut ids = Ids::system();
        let luck = (ids.random)();
        let seen = sondra_merk::matching::seen_episode(&before, season, episode, ids.now, format!("wh-{}-{}", ids.now, luck.chars().take(4).collect::<String>()));
        let item = &mut self.items[pos];
        item.seasons = Some(seen.settled.seasons);
        item.season = seen.settled.season;
        item.episode = seen.settled.episode;
        item.status = seen.settled.status;
        item.history = Some(seen.history);
        item.updated_at = ids.now;
        self.save();
        Some(before)
    }

    /// An entry put back as it was, counted as changed now — or the copy in Drive would bring the change
    /// it undoes back.
    pub fn put_back(&mut self, before: Item) {
        let now = Ids::system().now;
        if let Some(slot) = self.items.iter_mut().find(|i| i.id == before.id) {
            *slot = Item { updated_at: now, ..before };
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
        let next = self.add_next.clamp(1, 999);
        let mut raw = serde_json::json!({ "title": title, "status": "watching", "updatedAt": ids.now });
        let found = self.add_found.take();
        if let Some(media) = &found {
            raw["cover"] = media.cover_url.clone().into();
            if next <= 1 {
                if let Some(n) = media.episodes {
                    raw["seasons"] = serde_json::json!([{ "number": 1, "episodes": n, "watched": [] }]);
                }
            }
        }
        if next > 1 {
            // Begun already: the episodes before the next one are seen, and the length stays unknown.
            raw["season"] = 1.into();
            raw["episode"] = next.into();
            let episodes = found.as_ref().and_then(|m| m.episodes);
            raw["seasons"] = serde_json::json!([{ "number": 1, "episodes": episodes, "watched": (1..next).collect::<Vec<i64>>() }]);
        }
        self.add_next = 1;
        let item = normalize(&raw, &mut ids);
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

    /// Runs a change of the list and draws again.
    fn merk_do(me: &Entity<Shell>, app: &mut App, change: impl FnOnce(&mut MerkState)) {
        me.update(app, |shell, cx| {
            change(&mut shell.merk);
            cx.notify();
        });
    }

    /// The page of the Merkliste: the list, or the page of one series.
    pub(crate) fn merkliste(&self, ui: Ui, width: f32, cx: &mut Context<Self>) -> AnyElement {
        if let Some(item) = self.merk.open.as_ref().and_then(|id| self.merk.items.iter().find(|i| &i.id == id)) {
            return self.series_page(ui, item, cx);
        }
        self.merk_list(ui, width, cx)
    }

    fn merk_list(&self, ui: Ui, width: f32, cx: &mut Context<Self>) -> AnyElement {
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
        if !state.items.is_empty() {
            actions = actions.child(self.merk_more(ui, cx));
        }
        head = head.child(actions);

        let mut page = div().flex().flex_col().gap(px(20.)).child(head);

        if let Some(problem) = &state.problem {
            page = page.child(ui.notice(NoticeKind::Warning, problem.clone()));
        }
        if let Some(note) = &state.note {
            let (back, close) = (me.clone(), me.clone());
            let mut line = div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.prose(note.clone()));
            if state.before_import.is_some() {
                line = line.child(ui.button("einlesen-zuruecknehmen", "Zurücknehmen").small().on_click(move |_, app| Self::merk_do(&back, app, |m| m.revert_import())));
            }
            line = line.child(ui.button("hinweis-schliessen", "Schliessen").small().on_click(move |_, app| Self::merk_do(&close, app, |m| {
                m.note = None;
                m.before_import = None;
            })));
            page = page.child(line);
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
                    .child({
                        let me = me.clone();
                        ui.button("serie-suchen", if state.add_searching { "Sucht …" } else { "Suchen" }).disabled(state.add_searching).on_click(move |_, app| me.update(app, |shell, cx| shell.search_series(cx)))
                    })
                    .child(ui.hint(if state.add_found.is_some() { "Gefunden — mit „Hinzufügen“ kommt es mit Bild und Länge." } else { "Ohne Suchen wird die Zahl der Folgen später gesucht oder eingetragen. „Suchen“ fragt AniList." })),
            );
            if let Some(media) = &state.add_found {
                page = page.child(ui.value(format!("{}{}{}", media.title, media.season_year.map_or(String::new(), |y| format!(" ({y})")), media.episodes.map_or(String::new(), |n| format!(" — {n} Folgen")))));
            }
            // „Wie weit sind Sie?“: not begun, or the episode to watch next.
            let (new, less, more) = (me.clone(), me.clone(), me.clone());
            let n = state.add_next;
            page = page.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(ui.hint("Wie weit sind Sie?"))
                    .child(ui.chip("add-ganz-neu", "Ganz neu", n <= 1).on_click(move |_, app| Self::merk_do(&new, app, |m| m.add_next = 1)))
                    .child(ui.button("add-weniger", "Eine Folge weniger").small().disabled(n <= 1).on_click(move |_, app| Self::merk_do(&less, app, |m| m.add_next = (m.add_next - 1).max(1))))
                    .child(ui.value(if n <= 1 { "Folge 1".to_string() } else { format!("Schon angefangen: weiter mit Folge {n}") }))
                    .child(ui.button("add-mehr", "Eine Folge mehr").small().on_click(move |_, app| Self::merk_do(&more, app, |m| m.add_next = (m.add_next + 1).min(999)))),
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
        let mut views = div().flex().gap(px(6.));
        for (view, label) in [(View::Poster, "Als Poster"), (View::List, "Als Liste")] {
            let me = me.clone();
            views = views.child(ui.chip(format!("ansicht-{label}"), label, state.view == view).on_click(move |_, app| Self::merk_do(&me, app, move |m| m.view = view)));
        }
        page = page.child(div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(pills).child(views));

        let sections = groups(&state.items, &state.filter, state.sort);
        if sections.is_empty() {
            return page.child(ui.prose("Keine Serien gefunden für die gewählten Filter.")).into_any_element();
        }
        for group in sections {
            let rows = if state.view == View::List {
                let mut rows = div().flex().flex_col();
                for (n, item) in group.entries.iter().enumerate() {
                    rows = rows.child(self.merk_row(ui, item, n == 0, cx));
                }
                rows
            } else {
                // A shelf: as many posters in a row as fit, 150 px wide at the least.
                let gap = 14.0;
                let per_row = (((width + gap) / (150.0 + gap)).floor() as usize).clamp(2, 8);
                let tile = ((width - gap * (per_row as f32 - 1.0)) / per_row as f32).floor();
                let mut shelf = div().flex().flex_wrap().gap(px(gap));
                for item in &group.entries {
                    shelf = shelf.child(self.merk_tile(ui, item, tile, cx));
                }
                shelf
            };
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

    /// „Mehr“: the few things that are not on the page itself — for now the order of the series.
    fn merk_more(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let open = self.merk.more;
        let button = {
            let me = me.clone();
            ui.button("merkliste-mehr", "Mehr").small().on_click(move |_, app| Self::merk_do(&me, app, |m| m.more = !m.more))
        };
        let mut holder = div().relative().child(button);
        if open {
            let mut items: Vec<AnyElement> = vec![ui.hint("Ordnung")];
            for (sort, label) in SORT_OPTIONS {
                let me = me.clone();
                items.push(
                    ui.menu_item(format!("ordnung-{label}"), label, self.merk.sort == sort)
                        .on_click(move |_, app| Self::merk_do(&me, app, move |m| {
                            m.sort = sort;
                            m.more = false;
                        }))
                        .into_any_element(),
                );
            }
            items.push(ui.hint("Datei"));
            {
                let (me, me2) = (me.clone(), me.clone());
                items.push(ui.menu_item("merkliste-exportieren", "Exportieren", false).on_click(move |_, app| Self::merk_do(&me, app, |m| {
                    m.more = false;
                    m.export_list(&crate::store::downloads_dir());
                })).into_any_element());
                items.push(ui.menu_item("merkliste-einlesen", "Einlesen …", false).on_click(move |_, app| me2.update(app, |shell, cx| {
                    shell.merk.more = false;
                    shell.choose_list_file(cx);
                })).into_any_element());
            }
            {
                let me = me.clone();
                let on = self.discord.on;
                items.push(ui.menu_item("discord-zeigen", "In Discord zeigen", on).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.merk.more = false;
                    let on = shell.discord.on;
                    shell.set_discord(!on);
                    cx.notify();
                })).into_any_element());
            }
            {
                let me = me.clone();
                let on = self.news_rounds.on;
                items.push(ui.menu_item("neue-folgen-melden", "Neue Folgen melden", on).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.merk.more = false;
                    let on = shell.news_rounds.on;
                    shell.set_new_episodes(!on, cx);
                })).into_any_element());
            }
            {
                let me = me.clone();
                let on = self.anytype.link.as_ref().is_some_and(|l| l.connected());
                items.push(ui.menu_item("anytype-oeffnen", "Anytype …", on).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.merk.more = false;
                    shell.anytype_open(cx);
                })).into_any_element());
            }
            {
                let me = me.clone();
                items.push(ui.menu_item("teilen-oeffnen", "Teilen …", false).on_click(move |_, app| Self::merk_do(&me, app, |m| {
                    m.share.open = true;
                    m.share.said = None;
                    m.share.only = None;
                    m.more = false;
                })).into_any_element());
            }
            {
                let me = me.clone();
                items.push(ui.menu_item("empfangen-oeffnen", "Liste empfangen …", false).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.merk.more = false;
                    shell.receive_open(cx);
                })).into_any_element());
            }
            items.push(ui.hint("Auswertung"));
            {
                let me = me.clone();
                items.push(ui.menu_item("wuerfeln-oeffnen", "Zufällige Serie würfeln", false).on_click(move |_, app| Self::merk_do(&me, app, |m| {
                    m.more = false;
                    m.roll();
                    m.dice_open = m.dice_id.is_some();
                })).into_any_element());
            }
            {
                let me = me.clone();
                items.push(ui.menu_item("verlauf-oeffnen", "Verlauf", false).on_click(move |_, app| Self::merk_do(&me, app, |m| {
                    m.history_open = true;
                    m.more = false;
                })).into_any_element());
            }
            {
                let me = me.clone();
                items.push(ui.menu_item("statistik-oeffnen", "Statistik und Rückblick", false).on_click(move |_, app| Self::merk_do(&me, app, |m| {
                    m.stats_open = true;
                    m.more = false;
                })).into_any_element());
            }
            let pop = ui.popover("menue-merkliste-mehr", "Mehr", items);
            let away = me.clone();
            holder = holder.child(
                deferred(
                    div()
                        .absolute()
                        .top(px(40.))
                        .right_0()
                        .on_mouse_down_out(move |_, _, app| Self::merk_do(&away, app, |m| m.more = false))
                        .child(pop),
                )
                .with_priority(10),
            );
        }
        holder.into_any_element()
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
    /// The cover of an entry as a picture of `w × h` points (made at twice that, for a screen that is sharp),
    /// or `None` while it is coming, when there is none, or when it cannot be read: the caller then shows the
    /// title instead. The first call starts the making.
    pub(crate) fn cover_element(&self, cx: &mut Context<Self>, cover: &Option<String>, frame: Option<sondra_merk::model::CoverFrame>, w: f32, h: f32) -> Option<AnyElement> {
        let src = cover.as_ref().filter(|c| c.starts_with("data:") || c.starts_with("http"))?.clone();
        let (dw, dh) = ((w * 2.0).round().max(2.0) as u32, (h * 2.0).round().max(2.0) as u32);
        let key = Covers::key(&src, frame, dw, dh);
        let state = self.merk.covers.borrow().get(&key);
        match state {
            Some(Some(image)) => Some(gpui::img(gpui::ImageSource::Render(image)).object_fit(gpui::ObjectFit::Fill).w(px(w)).h(px(h)).into_any_element()),
            Some(None) => None,
            None => {
                if self.merk.covers.borrow_mut().begin(&key) {
                    Self::in_background(cx, move || render_cover(&src, frame, dw, dh), move |shell, made, cx| {
                        shell.merk.covers.borrow_mut().finish(&key, made);
                        cx.notify();
                    });
                }
                None
            }
        }
    }

    /// Asks AniList about the name typed — only because „Suchen“ was pressed.
    pub fn search_series(&mut self, cx: &mut Context<Self>) {
        let title = self.merk.add.read(cx).text().to_string();
        if title.trim().is_empty() || self.merk.add_searching {
            return;
        }
        self.merk.add_searching = true;
        self.merk.add_found = None;
        Self::in_background(cx, move || crate::anilist::search(&title, 1), |shell, found, cx| {
            shell.merk.add_searching = false;
            shell.merk.note = if found.is_none() { Some("Dazu hat AniList nichts gefunden. Die Serie lässt sich trotzdem hinzufügen.".into()) } else { None };
            shell.merk.add_found = found;
            cx.notify();
        });
        cx.notify();
    }

    /// Reads a file into the list (what „Einlesen …“ does with the chosen file).
    pub fn merk_import_file(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        self.merk.import_file(path);
        cx.notify();
    }

    fn choose_list_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| {
                        shell.merk.import_file(&path);
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// For tests: how many covers have been made (or found unmakeable) so far.
    pub fn covers_asked(&self) -> usize {
        self.merk.covers.borrow().asked()
    }

    /// For tests: how many covers are there to show.
    pub fn covers_ready(&self) -> usize {
        self.merk.covers.borrow().ready()
    }

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

        let cover = self.cover_element(cx, &item.cover, item.cover_frame, 44.0, 66.0);
        let poster = if let Some(cover) = cover {
            div().w(px(44.)).h(px(66.)).flex_none().rounded(px(6.)).overflow_hidden().child(cover).into_any_element()
        } else {
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
            .child(initials(&item.title))
            .into_any_element()
        };
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
            selected: false,
            colors: c,
            id: format!("serie-{}", item.id).into(),
            name: item.title.clone().into(),
            says: format!("{stand}. {count}. {left}").into(),
            first,
            tile: None,
            body: vec![poster, name, bar, rest, step.into_any_element()],
            on_open: Rc::new(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.open = Some(id))
            }),
        }
        .into_any_element()
    }

    /// One series as a poster on a shelf: the name set on the tint, the bar, where it stands.
    fn merk_tile(&self, ui: Ui, item: &Item, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let me = cx.entity();
        let progress = item_progress(item);
        let stand = stand_label(item);
        let count: SharedString = match progress.total {
            Some(total) => format!("{}/{}", progress.watched, total).into(),
            None => format!("{} gesehen", progress.watched).into(),
        };
        let left = left_label(item).unwrap_or_else(|| if caught_up(&seasons_of(item)) { "Alles gesehen".into() } else { "—".into() });
        let fraction = progress.fraction.map(|f| f as f32).or(if progress.watched > 0 { None } else { Some(0.0) });
        let picture = width - 8.0;
        let cover = self.cover_element(cx, &item.cover, item.cover_frame, picture, (picture * 1.5).floor());
        let poster = if let Some(cover) = cover {
            div().w(px(picture)).h(px((picture * 1.5).floor())).rounded(px(sondra_ui::radius::NAV)).overflow_hidden().child(cover).into_any_element()
        } else {
            div()
            .w(px(picture))
            .h(px((picture * 1.5).floor()))
            .rounded(px(sondra_ui::radius::NAV))
            .bg(c.panel_mid)
            .overflow_hidden()
            .flex()
            .items_center()
            .justify_center()
            .p(px(picture * 0.12))
            .text_center()
            .text_size(px(size::SUBHEADING))
            .font_weight(gpui::FontWeight::SEMIBOLD)
            .text_color(c.muted)
            .child(item.title.clone())
            .into_any_element()
        };
        let words = div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(div().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).truncate().child(item.title.clone()))
            .child(div().text_size(px(size::SMALL)).text_color(c.prose).truncate().child(stand.clone()))
            .child(div().pt(px(4.)).child(ui.bar(format!("kachel-{}", item.id), fraction, format!("{}: gesehen", item.title))))
            .into_any_element();
        let id = item.id.clone();
        Line {
            colors: c,
            id: format!("serie-{}", item.id).into(),
            name: item.title.clone().into(),
            says: format!("{stand}. {count}. {left}").into(),
            first: true,
            tile: Some(width),
            selected: false,
            body: vec![poster, words],
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
        // The best way forward there is: from the folder the Ordner page has read, when the next episode lies in it.
        let from_folder = self.continue_here().into_iter().find(|s| s.item == item.id);
        if let Some(here) = &from_folder {
            let unit = if here.next.season == 0 { "Film" } else { "Folge" };
            let (me, id) = (me.clone(), item.id.clone());
            actions = actions.child(ui.button("naechste-abspielen", format!("{unit} {} abspielen", here.next.episode)).primary().on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| shell.continue_play(&id, cx))
            }));
        }
        if !done && item.episode.is_some_and(|e| e != 0) {
            let unit = if item.season == 0 { "Film" } else { "Folge" };
            let at = item.episode.unwrap_or(0);
            let me = me.clone();
            let id = item.id.clone();
            let button = ui.button("naechste-gesehen", format!("{unit} {at} gesehen"));
            actions = actions.child((if from_folder.is_some() { button } else { button.primary() }).on_click(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.advance(&id))
            }));
        }
        actions = actions.child({
            let me = me.clone();
            let id = item.id.clone();
            ui.button("serie-empfehlen", "Empfehlen").on_click(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| {
                    m.share.open = true;
                    m.share.said = None;
                    m.share.only = Some(id);
                    m.share.part = 0;
                })
            })
        });
        actions = actions.child({
            let me = me.clone();
            let id = item.id.clone();
            ui.button("serie-entfernen", "Von der Merkliste entfernen").on_click(move |_, app| {
                let id = id.clone();
                Self::merk_do(&me, app, move |m| m.remove(&id))
            })
        });

        let news = sondra_merk::progress::online_news(item, None).map(|news| {
            let me = me.clone();
            let id = item.id.clone();
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .p(px(12.))
                .rounded(px(sondra_ui::radius::CARD))
                .bg(ui.c.panel_soft)
                .child(ui.prose(format!("Neu auf AniWorld: {}", news_label(&news))))
                .child(ui.button("neu-auf-merkliste", "Auf die Merkliste nehmen").small().on_click(move |_, app| {
                    let id = id.clone();
                    Self::merk_do(&me, app, move |m| m.take_news(&id))
                }))
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
        if let Some(news) = news {
            page = page.child(news);
        }

        if let Some(planner) = self.planner_block(ui, item, cx) {
            page = page.child(planner);
        }
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
/// What is new online, in words (`newsLabel`).
pub(crate) fn news_label(news: &sondra_merk::progress::OnlineNews) -> String {
    if news.new_season {
        return format!("Staffel {} mit {} {}", news.season, news.to, if news.to == 1 { "Folge" } else { "Folgen" });
    }
    if news.count_unknown {
        return format!("Staffel {} hat {} Folgen", news.season, news.to);
    }
    format!("Staffel {}, {}", news.season, if news.from == news.to { format!("Folge {}", news.from) } else { format!("Folgen {}–{}", news.from, news.to) })
}

pub(crate) fn initials(title: &str) -> String {
    let letters: String = title.split_whitespace().filter_map(|w| w.chars().find(|c| c.is_alphanumeric())).take(3).collect();
    letters.to_uppercase()
}

impl Shell {
    /// For tests: the entries of the list.
    pub fn merk_items(&self) -> Vec<Item> {
        self.merk.items.clone()
    }
}
