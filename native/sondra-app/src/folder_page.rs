//! The Ordner page: the files of a folder on this computer, read once and then shown by what one asks of
//! them — kind, search, order, a folder at a time or everything below. What is shown and in which order is
//! `sondra-merk` (checked against the website); this file sets it out and keeps what the person chose.
//! Playing, sending and deleting come with the tools they belong to.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, PathPromptOptions, SharedString};
use serde_json::{json, Map, Value};
use sondra_merk::folder::{click_select, crumbs, listing, AssetKind, FolderScan, KindFilter, ListingOptions, SortKey};
use sondra_merk::folder_memory::{folder_key, last_visit, prefs_for, save_prefs, Session, Store};
use sondra_merk::format::{format_bytes, short_date};
use sondra_merk::scan::scan_dir;
use sondra_ui::{family, size, FieldEvent, NoticeKind, TextField, Ui};

use crate::lines::Line;
use crate::shell::Shell;
use crate::store::FileStore;

/// Lines drawn at once; more on request — a folder of thousands stays quick.
const PAGE: usize = 240;
const PATH_KEY: &str = "sondra:ordner:pfad";

const FILTERS: [(KindFilter, &str, &str); 5] = [
    (KindFilter::All, "alle", "Alle"),
    (KindFilter::Video, "video", "Video"),
    (KindFilter::Audio, "audio", "Ton"),
    (KindFilter::Image, "image", "Bilder"),
    (KindFilter::Other, "andere", "Andere"),
];
const SORTS: [(SortKey, &str, &str); 4] = [
    (SortKey::Name, "name", "Name"),
    (SortKey::Modified, "modified", "Geändert"),
    (SortKey::Size, "size", "Grösse"),
    (SortKey::Kind, "kind", "Art"),
];

/// What the person set on this folder and keeps for the next time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prefs {
    pub filter: KindFilter,
    pub sort: SortKey,
    pub descending: bool,
    pub deep: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { filter: KindFilter::All, sort: SortKey::Name, descending: false, deep: false }
    }
}

impl Prefs {
    fn to_map(self) -> Map<String, Value> {
        let kind = FILTERS.iter().find(|(f, _, _)| *f == self.filter).map_or("alle", |(_, id, _)| id);
        let sort = SORTS.iter().find(|(s, _, _)| *s == self.sort).map_or("name", |(_, id, _)| id);
        let Value::Object(map) = json!({ "kind": kind, "sort": sort, "descending": self.descending, "deep": self.deep }) else { unreachable!() };
        map
    }

    fn from_map(map: &Map<String, Value>) -> Prefs {
        let text = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or("");
        Prefs {
            filter: FILTERS.iter().find(|(_, id, _)| *id == text("kind")).map_or(KindFilter::All, |(f, _, _)| *f),
            sort: SORTS.iter().find(|(_, id, _)| *id == text("sort")).map_or(SortKey::Name, |(s, _, _)| *s),
            descending: map.get("descending").and_then(Value::as_bool).unwrap_or(false),
            deep: map.get("deep").and_then(Value::as_bool).unwrap_or(false),
        }
    }
}

pub struct FolderState {
    pub root: Option<PathBuf>,
    pub scan: Option<FolderScan>,
    /// A folder is being read.
    pub reading: bool,
    pub error: Option<String>,
    /// The folder being looked at, inside the chosen one; empty for the top.
    pub dir: String,
    pub prefs: Prefs,
    pub selected: BTreeSet<String>,
    pub anchor: Option<String>,
    /// How many lines are drawn.
    pub shown: usize,
    pub search: Entity<TextField>,
    pub memory: Option<FileStore>,
    pub session: Session,
    /// The folder of the last time, offered and never read on its own.
    pub remembered: Option<PathBuf>,
    /// When this folder was last looked at before now, for „Neu“ later.
    pub last_visit: Option<f64>,
    cancel: Arc<AtomicBool>,
    generation: u64,
}

impl FolderState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> FolderState {
        let search = cx.new(|cx| TextField::new(cx, colors, "Dateinamen durchsuchen").placeholder("Dateiname suchen…"));
        cx.subscribe(&search, |_, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Changed {
                cx.notify();
            }
        })
        .detach();
        FolderState {
            root: None,
            scan: None,
            reading: false,
            error: None,
            dir: String::new(),
            prefs: Prefs::default(),
            selected: BTreeSet::new(),
            anchor: None,
            shown: PAGE,
            search,
            memory: None,
            session: Session::default(),
            remembered: None,
            last_visit: None,
            cancel: Arc::new(AtomicBool::new(false)),
            generation: 0,
        }
    }

    /// Takes what the page remembered: the folder of the last time, to be offered.
    pub fn remember_from(&mut self, store: FileStore) {
        self.remembered = store.get_item(PATH_KEY).map(PathBuf::from).filter(|p| p.is_dir());
        self.memory = Some(store);
    }

    fn key(&self) -> Option<String> {
        self.scan.as_ref().map(|s| folder_key(&s.name, s.drive))
    }

    fn set_prefs(&mut self, change: impl FnOnce(&mut Prefs)) {
        change(&mut self.prefs);
        if let (Some(key), Some(store)) = (self.key(), self.memory.as_mut()) {
            save_prefs(Some(&key), &self.prefs.to_map(), store);
        }
        self.shown = PAGE;
    }

    /// Chooses among the files in view (Ctrl/Cmd adds or takes away, Shift takes the run from the last).
    pub fn select(&mut self, path: &str, toggle: bool, range: bool, order: &[String]) {
        let (next, anchor) = click_select(&self.selected, order, self.anchor.as_deref(), path, toggle, range);
        self.selected = next;
        self.anchor = Some(anchor);
    }
}

fn kind_word(kind: AssetKind) -> &'static str {
    kind.label()
}

fn extension_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e)
        .filter(|e| (1..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(str::to_uppercase)
        .unwrap_or_default()
}

impl Shell {
    fn folder_do(me: &Entity<Shell>, app: &mut App, change: impl FnOnce(&mut FolderState)) {
        me.update(app, |shell, cx| {
            change(&mut shell.folder);
            cx.notify();
        });
    }

    /// Asks for a folder.
    pub(crate) fn choose_folder(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.open_folder(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Reads a folder in the background; the page says so meanwhile and can stop it.
    pub fn open_folder(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        f.cancel.store(true, Ordering::Relaxed);
        f.cancel = Arc::new(AtomicBool::new(false));
        f.generation += 1;
        f.reading = true;
        f.error = None;
        f.root = Some(path.clone());
        let (cancel, generation) = (f.cancel.clone(), f.generation);
        let task = cx.background_spawn(async move { scan_dir(&path, &cancel, |_| {}) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |shell, cx| shell.folder_read(generation, result, cx)).ok();
        })
        .detach();
        cx.notify();
    }

    fn folder_read(&mut self, generation: u64, result: std::io::Result<FolderScan>, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        if generation != f.generation {
            return;
        }
        f.reading = false;
        match result {
            Ok(scan) => {
                f.dir = String::new();
                f.selected.clear();
                f.anchor = None;
                f.shown = PAGE;
                let key = folder_key(&scan.name, scan.drive);
                f.prefs = Prefs::default();
                if let Some(store) = f.memory.as_mut() {
                    let defaults = Prefs::default().to_map();
                    f.prefs = Prefs::from_map(&prefs_for(&defaults, &key, store));
                    let now = chrono::Utc::now().timestamp_millis() as f64;
                    f.last_visit = last_visit(&key, now, store, &mut f.session);
                    if let Some(root) = &f.root {
                        store.set_item(PATH_KEY, root.to_string_lossy().into_owned());
                    }
                }
                f.scan = Some(scan);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                f.root = None;
            }
            Err(e) => {
                f.scan = None;
                f.error = Some(format!("Der Ordner konnte nicht gelesen werden: {e}"));
            }
        }
        cx.notify();
    }

    /// The Ordner page.
    pub(crate) fn folder_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let f = &self.folder;
        let c = ui.c;

        let mut page = div().flex().flex_col().gap(px(20.));
        if let Some(error) = &f.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }

        if f.reading {
            let me = me.clone();
            return page
                .child(ui.heading("Ordner"))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(14.))
                        .child(ui.prose("Liest den Ordner …"))
                        .child(ui.button("lesen-abbrechen", "Abbrechen").small().on_click(move |_, app| {
                            me.update(app, |shell, cx| {
                                shell.folder.cancel.store(true, Ordering::Relaxed);
                                cx.notify();
                            })
                        })),
                )
                .into_any_element();
        }

        let Some(scan) = &f.scan else {
            return page.child(self.folder_empty(ui, cx)).into_any_element();
        };

        let query = f.search.read(cx).text().to_string();
        let options = ListingOptions {
            dir: f.dir.clone(),
            deep: f.prefs.deep,
            filter: f.prefs.filter,
            query: query.clone(),
            sort: f.prefs.sort,
            descending: f.prefs.descending,
        };
        let view = listing(scan, &options);

        // The head: where one is, and the ways to look.
        let mut steps = div().flex().flex_wrap().items_center().gap(px(6.));
        for (n, (label, path)) in crumbs(&scan.name, &f.dir).into_iter().enumerate() {
            if n > 0 {
                steps = steps.child(ui.hint("/"));
            }
            let me = me.clone();
            steps = steps.child(ui.button(format!("pfad-{n}"), label).ghost().on_click(move |_, app| {
                let path = path.clone();
                Self::folder_do(&me, app, move |f| {
                    f.dir = path;
                    f.selected.clear();
                    f.shown = PAGE;
                })
            }));
        }
        page = page.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(ui.heading("Ordner"))
                .child({
                    let me = me.clone();
                    ui.button("anderer-ordner", "Anderen Ordner wählen").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_folder(cx)))
                }),
        );
        page = page.child(steps);

        let mut kinds = div().flex().flex_wrap().gap(px(6.));
        for (filter, id, label) in FILTERS {
            let n = view.counts.get(&filter).copied().unwrap_or(0);
            if n == 0 && filter != KindFilter::All && f.prefs.filter != filter {
                continue;
            }
            let me = me.clone();
            kinds = kinds.child(ui.chip(format!("art-{id}"), format!("{label} {n}"), f.prefs.filter == filter).on_click(move |_, app| {
                Self::folder_do(&me, app, move |f| f.set_prefs(|p| p.filter = filter))
            }));
        }
        let mut sorts = div().flex().flex_wrap().items_center().gap(px(6.));
        sorts = sorts.child(ui.hint("Ordnung:"));
        for (sort, id, label) in SORTS {
            let me = me.clone();
            let on = f.prefs.sort == sort;
            sorts = sorts.child(
                ui.chip(format!("ordnung-{id}"), if on && f.prefs.descending { format!("{label} ↓") } else { label.to_string() }, on)
                    .accessible_name(if on { format!("Ordnung: {label}, {}", if f.prefs.descending { "absteigend" } else { "aufsteigend" }) } else { format!("Ordnung: {label}") })
                    .on_click(move |_, app| {
                        Self::folder_do(&me, app, move |f| {
                            f.set_prefs(|p| {
                                if p.sort == sort {
                                    p.descending = !p.descending;
                                } else {
                                    p.sort = sort;
                                    p.descending = false;
                                }
                            })
                        })
                    }),
            );
        }
        let deep = {
            let me = me.clone();
            ui.chip("mit-unterordnern", "Mit Unterordnern", f.prefs.deep).on_click(move |_, app| {
                Self::folder_do(&me, app, |f| f.set_prefs(|p| p.deep = !p.deep))
            })
        };
        page = page.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(14.))
                .child(kinds)
                .child(div().w(px(240.)).child(f.search.clone()))
                .child(deep)
                .child(sorts),
        );

        if scan.truncated {
            page = page.child(ui.notice(
                NoticeKind::Info,
                format!("Sondra hat die ersten {} Dateien gelesen und dann aufgehört. Ein Unterordner davon ist schneller.", scan.files.len()),
            ));
        }

        // What is chosen: said, and one way to let go of it.
        if !f.selected.is_empty() {
            let me = me.clone();
            page = page.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(12.))
                    .child(ui.prose(if f.selected.len() == 1 { "1 Datei ausgewählt".to_string() } else { format!("{} Dateien ausgewählt", f.selected.len()) }))
                    .child(ui.button("auswahl-aufheben", "Auswahl aufheben").small().on_click(move |_, app| {
                        Self::folder_do(&me, app, |f| {
                            f.selected.clear();
                            f.anchor = None;
                        })
                    })),
            );
        }

        if view.dirs.is_empty() && view.files.is_empty() {
            let text = if !query.trim().is_empty() {
                format!("Nichts gefunden für „{}“.", query.trim())
            } else if f.prefs.filter != KindFilter::All {
                "In dieser Ansicht gibt es keine Dateien dieser Art.".to_string()
            } else {
                "In diesem Ordner liegt nichts.".to_string()
            };
            return page.child(ui.prose(text)).into_any_element();
        }

        let local = chrono::Local;
        let order: Vec<String> = view.files.iter().map(|file| file.path.clone()).collect();
        let mut rows = div().flex().flex_col();
        let mut first = true;
        for dir in &view.dirs {
            let me = me.clone();
            let path = dir.path.clone();
            let says = format!("Ordner. {} {}, {}", dir.count, if dir.count == 1 { "Datei" } else { "Dateien" }, format_bytes(dir.size as f64, 1));
            rows = rows.child(Line {
                colors: c,
                id: format!("ordner-{}", dir.path).into(),
                name: dir.name.clone().into(),
                says: says.clone().into(),
                first,
                tile: None,
                selected: false,
                body: vec![
                    div().flex_1().min_w(px(0.)).truncate().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).child(format!("{} ›", dir.name)).into_any_element(),
                    div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(says.trim_start_matches("Ordner. ").to_string()).into_any_element(),
                ],
                on_open: std::rc::Rc::new(move |_, app| {
                    let path = path.clone();
                    Self::folder_do(&me, app, move |f| {
                        f.dir = path;
                        f.selected.clear();
                        f.shown = PAGE;
                    })
                }),
            });
            first = false;
        }
        let total = view.files.len();
        for file in view.files.iter().take(f.shown) {
            let me = me.clone();
            let path = file.path.clone();
            let order = order.clone();
            let selected = f.selected.contains(&file.path);
            let extension = extension_of(&file.name);
            let facts: SharedString = format!(
                "{}{} · {} · {}",
                kind_word(file.kind),
                if extension.is_empty() { String::new() } else { format!(" {extension}") },
                format_bytes(file.size as f64, 1),
                short_date(&local, file.modified)
            )
            .into();
            let place = if f.prefs.deep || !query.trim().is_empty() { file.dir.clone() } else { String::new() };
            let mut name = div().flex().flex_col().gap(px(2.)).flex_1().min_w(px(0.)).child(
                div().font_family(family::VALUE).text_color(c.ink).truncate().child(file.name.clone()),
            );
            if !place.is_empty() {
                name = name.child(div().text_size(px(size::SMALL)).text_color(c.muted).truncate().child(place.clone()));
            }
            rows = rows.child(Line {
                colors: c,
                id: format!("datei-{}", file.path).into(),
                name: file.name.clone().into(),
                says: format!("{facts}{}", if place.is_empty() { String::new() } else { format!(" · in {place}") }).into(),
                first,
                tile: None,
                selected,
                body: vec![
                    name.into_any_element(),
                    div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(facts).into_any_element(),
                ],
                on_open: std::rc::Rc::new(move |window, app| {
                    let modifiers = window.modifiers();
                    let (toggle, range) = (modifiers.control || modifiers.platform, modifiers.shift);
                    let (path, order) = (path.clone(), order.clone());
                    Self::folder_do(&me, app, move |f| f.select(&path, toggle, range, &order))
                }),
            });
            first = false;
        }
        page = page.child(rows);
        if total > f.shown {
            let me = me.clone();
            let more = (total - f.shown).min(PAGE);
            page = page.child(div().flex().child(ui.button("weitere-zeigen", format!("Weitere {more} zeigen")).on_click(move |_, app| {
                Self::folder_do(&me, app, |f| f.shown += PAGE)
            })));
        }
        page.into_any_element()
    }

    /// No folder yet: what the page is for, and the way in.
    fn folder_empty(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let mut ways = div().flex().flex_wrap().items_center().gap(px(10.));
        ways = ways.child({
            let me = me.clone();
            ui.button("ordner-waehlen-start", "Ordner wählen").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_folder(cx)))
        });
        if let Some(path) = &self.folder.remembered {
            let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
            let path = path.clone();
            ways = ways.child(ui.button("wieder-oeffnen", format!("„{name}“ wieder öffnen")).on_click(move |_, app| {
                let path = path.clone();
                me.update(app, |shell, cx| shell.open_folder(path, cx))
            }));
        }
        div()
            .flex()
            .flex_col()
            .items_start()
            .gap(px(14.))
            .max_w(px(640.))
            .child(ui.heading("Ordner"))
            .child(ui.subheading("Ihre Dateien, aus einem Ordner"))
            .child(ui.prose("Wählen Sie einen Ordner auf diesem Computer. Sondra zeigt, was darin liegt, und Sie wählen aus, was abgespielt, bearbeitet oder gespeichert wird. Gelesen wird nur, was Sie ansehen; gesendet wird nichts."))
            .child(ways)
            .into_any_element()
    }
}
