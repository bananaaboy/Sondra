//! The Ordner page: the files of a folder on this computer, read once and then shown by what one asks of
//! them — kind, search, order, a folder at a time or everything below. What is shown and in which order is
//! `sondra-merk` (checked against the website); this file sets it out and keeps what the person chose.
//! Playing, sending and deleting come with the tools they belong to.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, App, Context, ElementId, Entity, FocusHandle, PathPromptOptions, SharedString};
use sondra_a11y::{accessible, Role};
use serde_json::{json, Map, Value};
use sondra_merk::bin::{bin_files, count_bin, erase_files, erase_from_bin, list_bin, restore_binned, restore_from_bin, BinItem, Binned, BIN_NAME};
use sondra_merk::folder::{click_select, crumbs, listing, without_files, AssetKind, FolderFile, FolderScan, KindFilter, ListingOptions, SortKey};
use sondra_merk::folder_memory::{folder_key, last_visit, prefs_for, save_prefs, Session, Store};
use sondra_merk::format::{format_bytes, short_date};
use sondra_merk::scan::scan_dir;
use sondra_ui::{family, size, FieldEvent, NoticeKind, TextField, Ui};

use crate::lines::Line;
use crate::shell::Shell;
use crate::store::FileStore;

/// Lines drawn at once; more on request — a folder of thousands stays quick.
const PAGE: usize = 240;
/// A tile and the picture on it.
const TILE_W: f32 = 232.0;
const TILE_H: f32 = 130.0;
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
    /// Tiles with a picture (the first look of a folder, as on the website) or lines.
    pub tiles: bool,
    /// Hide what the Merkliste has seen.
    pub unseen: bool,
    /// The episodes of one series and season together under their heading.
    pub group: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { filter: KindFilter::All, sort: SortKey::Name, descending: false, deep: false, tiles: true, unseen: false, group: true }
    }
}

impl Prefs {
    fn to_map(self) -> Map<String, Value> {
        let kind = FILTERS.iter().find(|(f, _, _)| *f == self.filter).map_or("alle", |(_, id, _)| id);
        let sort = SORTS.iter().find(|(s, _, _)| *s == self.sort).map_or("name", |(_, id, _)| id);
        let Value::Object(map) = json!({ "kind": kind, "sort": sort, "descending": self.descending, "deep": self.deep, "view": if self.tiles { "kacheln" } else { "liste" }, "unseen": self.unseen, "group": self.group }) else { unreachable!() };
        map
    }

    fn from_map(map: &Map<String, Value>) -> Prefs {
        let text = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or("");
        Prefs {
            filter: FILTERS.iter().find(|(_, id, _)| *id == text("kind")).map_or(KindFilter::All, |(f, _, _)| *f),
            sort: SORTS.iter().find(|(_, id, _)| *id == text("sort")).map_or(SortKey::Name, |(s, _, _)| *s),
            descending: map.get("descending").and_then(Value::as_bool).unwrap_or(false),
            deep: map.get("deep").and_then(Value::as_bool).unwrap_or(false),
            tiles: text("view") != "liste",
            unseen: map.get("unseen").and_then(Value::as_bool).unwrap_or(false),
            group: map.get("group").and_then(Value::as_bool).unwrap_or(true),
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
    /// Only what came since the visit before this one.
    pub only_new: bool,
    pub(crate) cancel: Arc<AtomicBool>,
    pub(crate) generation: u64,
    /// The files a delete is being asked about.
    pub confirm: Option<Vec<FolderFile>>,
    /// Something is being moved or deleted.
    pub busy: bool,
    /// What the last „In den Papierkorb“ moved, for „Rückgängig“.
    pub undo: Option<Vec<Binned>>,
    /// A line of what happened, under the head.
    pub notice: Option<String>,
    /// The bin window, when it is open.
    pub bin: Option<BinWindow>,
    pub bin_count: usize,
    /// After a read caused by an undo, the folder one was in.
    pub reopen_dir: Option<String>,
    pub delete_first: FocusHandle,
    pub delete_cancel: FocusHandle,
    pub bin_first: FocusHandle,
    pub bin_last: FocusHandle,
    /// The small pictures of the tiles, and how long each file is.
    pub thumbs: crate::thumbs::SharedThumbs,
    /// „Doppelte finden“.
    pub dupes: crate::folder_dupes::Dupes,
    /// „Eine Serie erkannt“.
    pub offer: crate::folder_series::Offer,
}

/// The window onto Sondra's bin in this folder.
pub struct BinWindow {
    pub items: Vec<BinItem>,
    pub chosen: BTreeSet<String>,
    /// „Wirklich endgültig?“ has been asked.
    pub asking: bool,
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
            only_new: false,
            cancel: Arc::new(AtomicBool::new(false)),
            generation: 0,
            confirm: None,
            busy: false,
            undo: None,
            notice: None,
            bin: None,
            bin_count: 0,
            reopen_dir: None,
            delete_first: cx.focus_handle().tab_stop(true),
            delete_cancel: cx.focus_handle().tab_stop(true),
            bin_first: cx.focus_handle().tab_stop(true),
            bin_last: cx.focus_handle().tab_stop(true),
            thumbs: Default::default(),
            dupes: Default::default(),
            offer: Default::default(),
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
        f.dupes.cancel.store(true, Ordering::Relaxed);
        f.dupes = Default::default();
        f.only_new = false;
        f.thumbs.borrow_mut().clear_waiting();
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

    pub(crate) fn folder_read(&mut self, generation: u64, result: std::io::Result<FolderScan>, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        if generation != f.generation {
            return;
        }
        f.reading = false;
        match result {
            Ok(scan) => {
                f.dir = f.reopen_dir.take().filter(|d| d.is_empty() || scan.dirs.contains(d)).unwrap_or_default();
                f.bin_count = f.root.as_ref().map_or(0, |r| count_bin(r));
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
        let mut view = listing(scan, &options);
        // „Ungesehen“ and „Neu“ narrow what is in view; files that are no episode of the list stay.
        let (has_series, has_new) = (!sondra_merk::folder::folder_episodes(&scan.files, &self.merk.items).is_empty(), f.last_visit.is_some_and(|since| scan.files.iter().any(|file| file.modified as f64 > since)));
        if f.prefs.unseen {
            view.files.retain(|file| sondra_merk::folder::episode_of(file, &self.merk.items).is_none_or(|e| !e.seen));
        }
        if let (true, Some(since)) = (f.only_new, f.last_visit) {
            view.files.retain(|file| file.modified as f64 > since);
        }
        // „Nach Serie“: the episodes of a series' season in a run, after them what the list does not know.
        let grouped = (f.prefs.group && has_series).then(|| sondra_merk::folder::group_by_series(&view.files, &self.merk.items)).filter(|g| !g.groups.is_empty());
        if let Some(g) = &grouped {
            view.files = g.ordered.clone();
        }

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
        // Where the files come from, how many there are, and reading again.
        let source = if scan.drive { "Google Drive".to_string() } else { format!("„{}“", scan.name) };
        let heading = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(ui.heading("Ordner"))
            .child(ui.hint(format!("{source} · {} {}{}", scan.files.len(), if scan.files.len() == 1 { "Datei" } else { "Dateien" }, if scan.truncated { " (nur die ersten)" } else { "" })));
        page = page.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .child(heading)
                .child({
                    let mut right = div().flex().flex_wrap().items_center().gap(px(8.));
                    if f.bin_count > 0 {
                        let me = me.clone();
                        right = right.child(ui.button("papierkorb-ansehen", format!("Papierkorb ({})", f.bin_count)).small().ghost().on_click(move |_, app| me.update(app, |shell, cx| shell.open_bin(cx))));
                    }
                    {
                        let me = me.clone();
                        let drive = scan.drive;
                        right = right.child(ui.button("neu-einlesen", "Neu einlesen").small().on_click(move |_, app| me.update(app, |shell, cx| {
                            if drive {
                                shell.open_drive_folder(cx);
                            } else if let Some(root) = shell.folder.root.clone() {
                                shell.open_folder(root, cx);
                            }
                        })));
                    }
                    if self.drive.as_ref().is_some_and(|d| d.configured) && !scan.drive {
                        let me = me.clone();
                        right = right.child(ui.button("ordner-aus-drive", "Aus Google Drive").small().ghost().on_click(move |_, app| me.update(app, |shell, cx| shell.open_drive_folder(cx))));
                    }
                    let me = me.clone();
                    right.child(ui.button("anderer-ordner", if scan.drive { "Ordner auf diesem Gerät" } else { "Anderen Ordner wählen" }).small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_folder(cx))))
                }),
        );
        if scan.drive {
            page = page.child(div().w(px(640.)).child(ui.hint("Der Ordner „Sondra“ in Ihrem Google Drive. Sondra sieht dort nur, was es selbst abgelegt hat — Heruntergeladenes, Dateien, Projekte. Filme spielen direkt aus Drive; was Sie zu Ende schauen, hakt die Merkliste ab. Gelöschtes landet im Papierkorb von Drive.")));
        }
        page = page.child(steps);

        // What just happened, with the way back.
        if let Some(text) = &f.notice {
            let mut line = div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.prose(text.clone()));
            if f.undo.is_some() {
                let me = me.clone();
                line = line.child(ui.button("rueckgaengig-papierkorb", "Rückgängig").small().disabled(f.busy).on_click(move |_, app| me.update(app, |shell, cx| shell.undo_bin(cx))));
            }
            page = page.child(line);
        }

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
        let mut narrow = div().flex().gap(px(6.));
        if has_series || f.prefs.unseen {
            let me = me.clone();
            narrow = narrow.child(ui.chip("nur-ungesehen", "Ungesehen", f.prefs.unseen).accessible_name("Nur Ungesehenes zeigen").on_click(move |_, app| Self::folder_do(&me, app, |f| f.set_prefs(|p| p.unseen = !p.unseen))));
        }
        if has_series || !f.prefs.group {
            let me = me.clone();
            narrow = narrow.child(ui.chip("nach-serie", "Nach Serie", f.prefs.group).accessible_name("Nach Serie ordnen").on_click(move |_, app| Self::folder_do(&me, app, |f| f.set_prefs(|p| p.group = !p.group))));
        }
        if has_new || f.only_new {
            let me = me.clone();
            narrow = narrow.child(ui.chip("nur-neu", "Neu", f.only_new).accessible_name("Nur zeigen, was seit dem letzten Besuch dazukam").on_click(move |_, app| Self::folder_do(&me, app, |f| f.only_new = !f.only_new)));
        }
        let looks = {
            let (tiles_me, lines_me) = (me.clone(), me.clone());
            div()
                .flex()
                .gap(px(6.))
                .child(ui.chip("ansicht-kacheln", "Kacheln", f.prefs.tiles).accessible_name("Ansicht: Kacheln").on_click(move |_, app| Self::folder_do(&tiles_me, app, |f| f.set_prefs(|p| p.tiles = true))))
                .child(ui.chip("ansicht-liste", "Liste", !f.prefs.tiles).accessible_name("Ansicht: Liste").on_click(move |_, app| Self::folder_do(&lines_me, app, |f| f.set_prefs(|p| p.tiles = false))))
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
                .child(narrow)
                .child(looks)
                .child(sorts)
                .child({
                    let me = me.clone();
                    ui.button("doppelte-finden", "Doppelte finden").small().ghost().disabled(f.dupes.running).on_click(move |_, app| me.update(app, |shell, cx| shell.dupes_run(cx)))
                }),
        );

        if let Some(section) = self.continue_section(ui, cx) {
            page = page.child(section);
        }
        if let Some(section) = self.filing_section(ui, cx) {
            page = page.child(section);
        }
        if let Some(section) = self.offer_section(ui, cx) {
            page = page.child(section);
        }
        if let Some(section) = self.dupes_section(ui, cx) {
            page = page.child(section);
        }

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
                    .child({
                        let me = me.clone();
                        ui.button("auswahl-abspielen", "Abspielen").small().primary().accessible_name("Gewählte Dateien abspielen").on_click(move |_, app| me.update(app, |shell, cx| shell.play_selected(cx)))
                    })
                    .child({
                        let me = me.clone();
                        ui.button("auswahl-zip", "Als ZIP").small().accessible_name("Gewählte Dateien als ZIP speichern").disabled(f.busy).on_click(move |_, app| me.update(app, |shell, cx| shell.zip_selected(cx)))
                    })
                    .child({
                        let me = me.clone();
                        ui.button("auswahl-loeschen", "Löschen …").small().on_click(move |_, app| me.update(app, |shell, cx| shell.ask_delete(cx)))
                    })
                    .children(self.play_on_device_buttons(&ui, &me))
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
        let tiles = f.prefs.tiles;
        let mut rows = if tiles { div().flex().flex_wrap().gap(px(10.)) } else { div().flex().flex_col() };
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
                tile: tiles.then_some(TILE_W),
                selected: false,
                body: if tiles {
                    vec![
                        div().w(px(TILE_W - 8.)).h(px(TILE_H)).rounded(px(sondra_ui::radius::NAV)).bg(c.panel_soft).flex().items_center().justify_center().text_color(c.prose).child("Ordner ›").into_any_element(),
                        div().flex().flex_col().gap(px(2.)).child(div().truncate().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).child(dir.name.clone())).child(div().text_size(px(size::SMALL)).text_color(c.prose).child(says.trim_start_matches("Ordner. ").to_string())).into_any_element(),
                    ]
                } else {
                    vec![
                        div().flex_1().min_w(px(0.)).truncate().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).child(format!("{} ›", dir.name)).into_any_element(),
                        div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(says.trim_start_matches("Ordner. ").to_string()).into_any_element(),
                    ]
                },
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
        let mut last_key: Option<Option<String>> = None;
        for file in view.files.iter().take(f.shown) {
            if let Some(g) = &grouped {
                let key = g.key_of.get(&file.path).cloned();
                if last_key.as_ref() != Some(&key) {
                    rows = rows.child(self.series_head(&ui, g, key.as_deref()));
                    last_key = Some(key);
                }
            }
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
                tile: tiles.then_some(TILE_W),
                selected,
                body: if tiles {
                    let picture = self.tile_picture(c, file, &me);
                    let mut under = div().flex().flex_col().gap(px(2.)).child(div().font_family(family::VALUE).text_color(c.ink).truncate().child(file.name.clone())).child(div().text_size(px(size::SMALL)).text_color(c.prose).truncate().child(facts));
                    if !place.is_empty() {
                        under = under.child(div().text_size(px(size::SMALL)).text_color(c.muted).truncate().child(place.clone()));
                    }
                    vec![picture, under.into_any_element()]
                } else {
                    vec![
                        name.into_any_element(),
                        div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(facts).into_any_element(),
                    ]
                },
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
        {
            let t = self.folder.thumbs.borrow();
            if t.waiting() > 0 && t.running() < crate::thumbs::AT_ONCE {
                cx.spawn(async move |this, cx| {
                    this.update(cx, |shell, cx| shell.pump_thumbs(cx)).ok();
                })
                .detach();
            }
        }
        if total > f.shown {
            let me = me.clone();
            let more = (total - f.shown).min(PAGE);
            page = page.child(div().flex().child(ui.button("weitere-zeigen", format!("Weitere {more} zeigen")).on_click(move |_, app| {
                Self::folder_do(&me, app, |f| f.shown += PAGE)
            })));
        }
        page = page.child(ui.hint("Klick wählt, Strg dazu, Umschalt einen Bereich; ▶ auf einer Kachel spielt sie ab, „Abspielen“ unten die Auswahl."));
        page.into_any_element()
    }


    /// The heading over one season's episodes: whose, how many are here and how far along — and over the files the
    /// list does not know, „Weitere Dateien“.
    fn series_head(&self, ui: &Ui, grouped: &sondra_merk::folder::Grouped, key: Option<&str>) -> AnyElement {
        let c = ui.c;
        let group = key.and_then(|k| grouped.groups.iter().find(|g| g.key == k));
        let (title, meta) = match group {
            Some(g) => {
                let name = self.merk.items.iter().find(|i| i.id == g.item).map(|i| i.title.clone()).unwrap_or_default();
                let meta = match g.total {
                    Some(total) => format!("{} hier · {} von {} gesehen", g.here, g.seen, total),
                    None => format!("{} hier · {} gesehen", g.here, g.seen),
                };
                (format!("{name} · {}", sondra_merk::folder::season_folder_name(g.season)), meta)
            }
            None => ("Weitere Dateien".to_string(), grouped.rest.len().to_string()),
        };
        let progress = group.map_or(0.0, |g| if g.here > 0 { g.seen_here as f32 / g.here as f32 } else { 0.0 });
        let mut head = div().w_full().flex().flex_col().gap(px(6.)).pt(px(14.)).pb(px(4.));
        head = head.child(div().flex().flex_wrap().items_baseline().justify_between().gap(px(12.)).child(ui.subheading(title)).child(ui.value(meta)));
        if group.is_some() {
            head = head.child(div().h(px(3.)).rounded(px(sondra_ui::radius::PILL)).bg(c.line).overflow_hidden().child(div().h_full().rounded(px(sondra_ui::radius::PILL)).bg(c.ink).w(gpui::relative(progress))));
        }
        head.into_any_element()
    }

    /// The picture of a tile: the file's own small picture when there is one, otherwise what kind of file it is;
    /// the length of a film or a song in a corner.
    fn tile_picture(&self, colors: sondra_ui::Colors, file: &FolderFile, me: &Entity<Shell>) -> AnyElement {
        let mut frame = div().relative().w(px(TILE_W - 8.)).h(px(TILE_H)).flex_none().overflow_hidden().rounded(px(sondra_ui::radius::NAV)).bg(colors.panel_mid).flex().items_center().justify_center();
        let mut seconds = None;
        let mut shown = false;
        if let (Some(root), None) = (&self.folder.root, &file.drive) {
            if matches!(file.kind, AssetKind::Video | AssetKind::Audio | AssetKind::Image) {
                let path = root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
                let key = crate::thumbs::key_of(&path, file.size, file.modified);
                let mut t = self.folder.thumbs.borrow_mut();
                if let Some(Some(image)) = t.ask(&key, path, file.kind) {
                    frame = frame.child(gpui::img(gpui::ImageSource::Render(image)).object_fit(gpui::ObjectFit::Cover).w(px(TILE_W - 8.)).h(px(TILE_H)));
                    shown = true;
                }
                seconds = t.seconds.get(&key).copied().flatten();
            }
        }
        if !shown {
            frame = frame.child(div().text_color(colors.prose).child(kind_word(file.kind)));
        }
        if let Some(seconds) = seconds {
            frame = frame.child(div().absolute().right(px(6.)).bottom(px(6.)).px(px(6.)).py(px(1.)).rounded(px(sondra_ui::radius::PILL)).bg(colors.ink).text_color(colors.canvas).font_family(family::VALUE).text_size(px(size::MICRO)).child(crate::thumbs::clock(seconds)));
        }
        // ▶ on a film or a song of this computer: plays that one file, as a tap on the tile does on the website.
        if let (Some(root), None, true) = (&self.folder.root, &file.drive, matches!(file.kind, AssetKind::Video | AssetKind::Audio)) {
            let path = root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let (me, name) = (me.clone(), file.name.clone());
            let play = {
                let (me, path) = (me.clone(), path.clone());
                move |app: &mut App| {
                    let path = path.clone();
                    me.update(app, move |shell, cx| {
                        shell.go(crate::nav::Panel::Player, cx);
                        shell.play_files(vec![path], cx);
                    })
                }
            };
            let again = play.clone();
            frame = frame.child(
                accessible(
                    ElementId::Name(format!("abspielen-{}", file.path).into()),
                    Role::Button,
                    div()
                        .id(ElementId::Name(format!("abspielen-bild-{}", file.path).into()))
                        .absolute()
                        .left(px(6.))
                        .bottom(px(6.))
                        .w(px(28.))
                        .h(px(28.))
                        .rounded(px(sondra_ui::radius::PILL))
                        .bg(colors.ink)
                        .text_color(colors.canvas)
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .on_click(move |_, _, app| {
                            app.stop_propagation();
                            play(app);
                        })
                        .child("▶"),
                )
                .label(format!("{name} abspielen"))
                .on_activate(move |_, app| again(app)),
            );
        }
        frame.into_any_element()
    }

    /// Does `work` away from the window and then hands its answer to `then`.
    pub(crate) fn in_background<T: Send + 'static>(
        cx: &mut Context<Self>,
        work: impl FnOnce() -> T + Send + 'static,
        then: impl FnOnce(&mut Shell, T, &mut Context<Shell>) + 'static,
    ) {
        let task = cx.background_spawn(async move { work() });
        cx.spawn(async move |this, cx| {
            let answer = task.await;
            this.update(cx, |shell, cx| then(shell, answer, cx)).ok();
        })
        .detach();
    }

    /// Plays the chosen files that can be played, in the order of the list; the Player takes over.
    pub(crate) fn play_selected(&mut self, cx: &mut Context<Self>) {
        if self.folder.scan.as_ref().is_some_and(|s| s.drive) {
            return self.play_selected_from_drive(cx);
        }
        let f = &self.folder;
        let (Some(scan), Some(root)) = (&f.scan, f.root.clone()) else { return };
        // In the order the list shows them, not the order the disk gave them.
        let options = ListingOptions { dir: f.dir.clone(), deep: f.prefs.deep, filter: f.prefs.filter, query: f.search.read(cx).text().to_string(), sort: f.prefs.sort, descending: f.prefs.descending };
        let shown = listing(scan, &options);
        let files: Vec<PathBuf> = shown
            .files
            .iter()
            .filter(|file| f.selected.contains(&file.path) && file.drive.is_none() && matches!(file.kind, AssetKind::Video | AssetKind::Audio))
            .map(|file| root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR)))
            .collect();
        if files.is_empty() {
            self.folder.notice = Some("Unter den gewählten Dateien ist nichts, was sich abspielen lässt.".into());
            cx.notify();
            return;
        }
        self.go(crate::nav::Panel::Player, cx);
        self.play_files(files, cx);
    }

    /// For tests: is something being done to the folder (a ZIP being written, files being moved)?
    /// For tests: a folder that was read, with some of its files chosen.
    pub fn folder_show_for_test(&mut self, scan: FolderScan, chosen: &[&str], cx: &mut Context<Self>) {
        self.folder.scan = Some(scan);
        self.folder.selected = chosen.iter().map(|p| p.to_string()).collect();
        cx.notify();
    }

    pub fn folder_scan_for_test(&self) -> Option<FolderScan> {
        self.folder.scan.clone()
    }

    pub fn folder_busy(&self) -> bool {
        self.folder.busy
    }

    /// Packs the chosen files of this computer into one ZIP in the folder, with their folders kept; what lies in Drive is
    /// not packed (it would have to be fetched first) and the notice says so.
    pub(crate) fn zip_selected(&mut self, cx: &mut Context<Self>) {
        let f = &self.folder;
        let (Some(scan), Some(root)) = (&f.scan, f.root.clone()) else { return };
        let chosen: Vec<&FolderFile> = scan.files.iter().filter(|file| f.selected.contains(&file.path)).collect();
        let (local, remote): (Vec<&FolderFile>, Vec<&FolderFile>) = chosen.into_iter().partition(|file| file.drive.is_none());
        if local.is_empty() {
            self.folder.notice = Some(if remote.is_empty() { "Es ist nichts gewählt." } else { "Dateien in Drive lassen sich hier nicht packen; holen Sie sie zuerst auf diesen Computer." }.into());
            cx.notify();
            return;
        }
        let skipped = remote.len();
        // In the order of the list, with the folders as they lie.
        let options = ListingOptions { dir: f.dir.clone(), deep: f.prefs.deep, filter: f.prefs.filter, query: f.search.read(cx).text().to_string(), sort: f.prefs.sort, descending: f.prefs.descending };
        let shown: Vec<String> = listing(scan, &options).files.iter().map(|file| file.path.clone()).collect();
        let mut files: Vec<(String, PathBuf)> = local.iter().map(|file| (file.path.clone(), root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR)))).collect();
        files.sort_by_key(|(name, _)| shown.iter().position(|p| p == name).unwrap_or(usize::MAX));
        let suggestion = scan.name.clone();
        self.folder.busy = true;
        self.folder.notice = Some("Das ZIP wird geschrieben …".into());
        cx.notify();
        Self::pack_in_background(cx, files, root, suggestion, move |shell, result, cx| {
            shell.folder.busy = false;
            shell.folder.notice = Some(match result {
                Ok((path, bytes)) => format!("ZIP gespeichert: {} · {}{}", path.display(), format_bytes(bytes as f64, 1), if skipped > 0 { format!(" (ohne {skipped} Datei{} in Drive)", if skipped == 1 { "" } else { "en" }) } else { String::new() }),
                Err(message) => message,
            });
            cx.notify();
        });
    }

    /// Asks whether the chosen files are to go.
    pub(crate) fn ask_delete(&mut self, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        let Some(scan) = &f.scan else { return };
        let files: Vec<FolderFile> = scan.files.iter().filter(|file| f.selected.contains(&file.path)).cloned().collect();
        if files.is_empty() {
            return;
        }
        f.confirm = Some(files);
        // The safe answer takes the focus: Enter on a dialog that was not expected must not delete.
        self.pending_focus = Some(self.folder.delete_cancel.clone());
        cx.notify();
    }

    /// Into the bin, or for good: moved or deleted away from the window, then the page is told.
    fn delete_chosen(&mut self, into_bin: bool, cx: &mut Context<Self>) {
        if self.folder.scan.as_ref().is_some_and(|s| s.drive) {
            return self.trash_chosen_in_drive(cx);
        }
        let f = &mut self.folder;
        let (Some(files), Some(root)) = (f.confirm.clone(), f.root.clone()) else { return };
        f.busy = true;
        Self::in_background(
            cx,
            move || -> (Vec<String>, Vec<Binned>, Vec<String>) {
                if into_bin {
                    match bin_files(&root, &files) {
                        Ok((binned, failed)) => (
                            binned.iter().map(|b| b.path.clone()).collect(),
                            binned,
                            failed.into_iter().map(|x| format!("{}: {}", x.item.name, x.reason)).collect(),
                        ),
                        Err(e) => (Vec::new(), Vec::new(), vec![format!("Der Papierkorb konnte nicht angelegt werden: {e}")]),
                    }
                } else {
                    let (done, failed) = erase_files(&root, &files);
                    (done.into_iter().map(|d| d.path).collect(), Vec::new(), failed.into_iter().map(|x| format!("{}: {}", x.item.name, x.reason)).collect())
                }
            },
            move |shell, (gone, binned, failed), cx| shell.deleted(into_bin, gone, binned, failed, cx),
        );
        cx.notify();
    }

    pub(crate) fn deleted(&mut self, into_bin: bool, gone: Vec<String>, binned: Vec<Binned>, failed: Vec<String>, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        f.busy = false;
        f.confirm = None;
        let set: std::collections::HashSet<String> = gone.iter().cloned().collect();
        if let Some(scan) = &f.scan {
            f.scan = Some(without_files(scan, &set));
        }
        f.selected.clear();
        f.anchor = None;
        let n = gone.len();
        let mut text = match (n, into_bin) {
            (0, _) => String::new(),
            (1, true) => "1 Datei in den Papierkorb gelegt.".to_string(),
            (n, true) => format!("{n} Dateien in den Papierkorb gelegt."),
            (1, false) => "1 Datei endgültig gelöscht.".to_string(),
            (n, false) => format!("{n} Dateien endgültig gelöscht."),
        };
        if !failed.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&format!("{} {} nicht {}: {}", failed.len(), if failed.len() == 1 { "Datei konnte" } else { "Dateien konnten" }, "bearbeitet werden", failed[0]));
        }
        f.notice = (!text.is_empty()).then_some(text);
        f.undo = (!binned.is_empty()).then_some(binned);
        f.bin_count = f.root.as_ref().map_or(0, |r| count_bin(r));
        self.pending_focus = Some(self.focus.clone());
        cx.notify();
    }

    /// The files of the last „In den Papierkorb“ back where they lay, and the folder read again.
    pub(crate) fn undo_bin(&mut self, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        let (Some(binned), Some(root)) = (f.undo.take(), f.root.clone()) else { return };
        f.busy = true;
        let dir = f.dir.clone();
        Self::in_background(
            cx,
            {
                let root = root.clone();
                move || restore_binned(&root, &binned)
            },
            move |shell, (restored, failed), cx| {
                shell.folder.busy = false;
                let mut text = match restored.len() {
                    0 => String::new(),
                    1 => "1 Datei zurückgelegt.".to_string(),
                    n => format!("{n} Dateien zurückgelegt."),
                };
                if let Some(first) = failed.first() {
                    text.push_str(&format!(" {} nicht zurückgelegt: {}", failed.len(), first.reason));
                }
                shell.folder.notice = Some(text.trim().to_string());
                shell.folder.reopen_dir = Some(dir);
                shell.open_folder(root, cx);
            },
        );
        cx.notify();
    }

    /// The window onto what lies in the bin.
    pub(crate) fn open_bin(&mut self, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        let Some(root) = f.root.clone() else { return };
        f.bin = Some(BinWindow { items: list_bin(&root), chosen: BTreeSet::new(), asking: false });
        self.pending_focus = Some(self.folder.bin_first.clone());
        cx.notify();
    }

    /// Back where the chosen lay, or — after the second question — for good.
    fn bin_do(&mut self, erase: bool, cx: &mut Context<Self>) {
        let f = &mut self.folder;
        let (Some(window), Some(root)) = (&f.bin, f.root.clone()) else { return };
        let items: Vec<BinItem> = window.items.iter().filter(|i| window.chosen.contains(&i.name)).cloned().collect();
        if items.is_empty() {
            return;
        }
        f.busy = true;
        let dir = f.dir.clone();
        Self::in_background(
            cx,
            {
                let root = root.clone();
                move || if erase { erase_from_bin(&root, &items) } else { restore_from_bin(&root, &items) }
            },
            move |shell, (done, failed), cx| {
                let f = &mut shell.folder;
                f.busy = false;
                let verb = if erase { "endgültig gelöscht" } else { "zurückgelegt" };
                let mut text = match done.len() {
                    0 => String::new(),
                    1 => format!("1 Datei {verb}."),
                    n => format!("{n} Dateien {verb}."),
                };
                if let Some(first) = failed.first() {
                    text.push_str(&format!(" {} nicht bearbeitet: {}", failed.len(), first.reason));
                }
                f.notice = Some(text.trim().to_string());
                f.bin = Some(BinWindow { items: list_bin(&root), chosen: BTreeSet::new(), asking: false });
                f.bin_count = count_bin(&root);
                if erase || f.bin.as_ref().is_some_and(|b| b.items.is_empty()) {
                    f.bin = if erase && f.bin_count > 0 { f.bin.take() } else { None };
                }
                if !erase {
                    f.reopen_dir = Some(dir);
                    shell.open_folder(root, cx);
                } else {
                    cx.notify();
                }
            },
        );
        cx.notify();
    }

    /// The dialogs that stand over the page: the question before deleting, and the bin.
    pub(crate) fn folder_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let me = cx.entity();
        let f = &self.folder;
        if let Some(files) = &f.confirm {
            let total: u64 = files.iter().map(|x| x.size).sum();
            let n = files.len();
            let title = if n == 1 { "Datei löschen?".to_string() } else { format!("{n} Dateien löschen?") };
            let in_drive = self.folder.scan.as_ref().is_some_and(|s| s.drive);
            let text = if in_drive {
                format!("{} in den Papierkorb von Google Drive. Dort liegt es 30 Tage und lässt sich in Drive zurückholen. Zusammen {}.", if n == 1 { "Die Datei kommt" } else { "Die Dateien kommen" }, format_bytes(total as f64, 1))
            } else { format!(
                "{} in den Ordner „{BIN_NAME}“ in diesem Ordner und {} sich gleich mit „Rückgängig“ und später unter „Papierkorb“ zurücklegen. Weg ist es erst, wenn Sie es dort endgültig löschen. Zusammen {}.",
                if n == 1 { "Sie kommt" } else { "Sie kommen" },
                if n == 1 { "lässt" } else { "lassen" },
                format_bytes(total as f64, 1)
            ) };
            let mut list = div().flex().flex_col().max_h(px(240.));
            for file in files.iter().take(12) {
                list = list.child(div().border_t_1().border_color(ui.c.line).py(px(5.)).child(ui.value(file.path.clone())));
            }
            if n > 12 {
                list = list.child(div().border_t_1().border_color(ui.c.line).py(px(5.)).child(ui.hint(format!("und {} weitere", n - 12))));
            }
            let busy = f.busy;
            let (m1, m2, m3) = (me.clone(), me.clone(), me.clone());
            return Some(
                ui.dialog("loeschen", title)
                    .child(ui.prose(text))
                    .child(list)
                    .action(
                        ui.button("in-den-papierkorb", if busy { "Löscht …" } else { "In den Papierkorb" })
                            .primary()
                            .disabled(busy)
                            .focus_handle(f.delete_first.clone())
                            .on_click(move |_, app| m1.update(app, |shell, cx| shell.delete_chosen(true, cx))),
                    )
                    .action(if in_drive { div().into_any_element() } else { ui.button("endgueltig-loeschen", "Endgültig löschen").disabled(busy).on_click(move |_, app| m2.update(app, |shell, cx| shell.delete_chosen(false, cx))).into_any_element() })
                    .action(
                        ui.button("loeschen-abbrechen", "Abbrechen")
                            .disabled(busy)
                            .focus_handle(f.delete_cancel.clone())
                            .on_click(move |_, app| Self::folder_do(&m3, app, |f| f.confirm = None)),
                    )
                    .keeps_focus_between(f.delete_first.clone(), f.delete_cancel.clone())
                    .on_close({
                        let me = me.clone();
                        move |_, app| Self::folder_do(&me, app, |f| if !f.busy { f.confirm = None })
                    })
                    .into_any_element(),
            );
        }
        if let Some(window) = &f.bin {
            let local = chrono::Local;
            let mut list = div().flex().flex_col().max_h(px(320.)).overflow_y_hidden();
            if window.items.is_empty() {
                list = list.child(ui.prose("Der Papierkorb ist leer."));
            }
            for (n, item) in window.items.iter().enumerate() {
                let chosen = window.chosen.contains(&item.name);
                let from = item.from.clone().map(|p| match p.rsplit_once('/') {
                    Some((dir, _)) => format!("aus {dir}"),
                    None => "aus dem obersten Ordner".to_string(),
                });
                let when = short_date(&local, item.at.unwrap_or(item.modified));
                let says = format!("{} · {}{}", format_bytes(item.size as f64, 1), when, from.as_ref().map(|f| format!(" · {f}")).unwrap_or_default());
                let me = me.clone();
                let name = item.name.clone();
                list = list.child(Line {
                    colors: ui.c,
                    id: format!("papierkorb-{}", item.name).into(),
                    name: item.name.clone().into(),
                    says: says.clone().into(),
                    first: n == 0,
                    tile: None,
                    selected: chosen,
                    body: vec![
                        div().flex_1().min_w(px(0.)).child(ui.value(item.name.clone())).into_any_element(),
                        div().flex_none().text_size(px(size::SMALL)).text_color(ui.c.prose).child(says).into_any_element(),
                    ],
                    on_open: std::rc::Rc::new(move |_, app| {
                        let name = name.clone();
                        Self::folder_do(&me, app, move |f| {
                            if let Some(w) = f.bin.as_mut() {
                                if !w.chosen.remove(&name) {
                                    w.chosen.insert(name);
                                }
                                w.asking = false;
                            }
                        })
                    }),
                });
            }
            let busy = f.busy;
            let none = window.chosen.is_empty();
            let (m1, m2, m3, m4) = (me.clone(), me.clone(), me.clone(), me.clone());
            let mut dialog = ui.dialog("papierkorb", "Papierkorb").width(640.).child(ui.prose(format!("Was Sie in den Papierkorb gelegt haben, liegt im Ordner „{BIN_NAME}“. Wählen Sie Dateien, um sie zurückzulegen oder endgültig zu löschen.")));
            dialog = dialog.child(list);
            if window.asking {
                dialog = dialog
                    .child(ui.notice(NoticeKind::Warning, format!("{} endgültig löschen? Das lässt sich nicht rückgängig machen.", if window.chosen.len() == 1 { "1 Datei".to_string() } else { format!("{} Dateien", window.chosen.len()) })))
                    .action(
                        ui.button("papierkorb-ja", "Ja, endgültig löschen")
                            .primary()
                            .disabled(busy)
                            .focus_handle(f.bin_first.clone())
                            .on_click(move |_, app| m1.update(app, |shell, cx| shell.bin_do(true, cx))),
                    )
                    .action(ui.button("papierkorb-zurueck", "Zurück").disabled(busy).focus_handle(f.bin_last.clone()).on_click(move |_, app| Self::folder_do(&m2, app, |f| if let Some(w) = f.bin.as_mut() { w.asking = false })));
            } else {
                dialog = dialog
                    .action(
                        ui.button("papierkorb-zuruecklegen", "Zurücklegen")
                            .primary()
                            .disabled(busy || none)
                            .focus_handle(f.bin_first.clone())
                            .on_click(move |_, app| m1.update(app, |shell, cx| shell.bin_do(false, cx))),
                    )
                    .action(ui.button("papierkorb-loeschen", "Endgültig löschen …").disabled(busy || none).on_click(move |_, app| Self::folder_do(&m2, app, |f| if let Some(w) = f.bin.as_mut() { w.asking = true })))
                    .action(ui.button("papierkorb-schliessen", "Schliessen").focus_handle(f.bin_last.clone()).on_click(move |_, app| Self::folder_do(&m3, app, |f| f.bin = None)));
            }
            let _ = m4;
            return Some(
                dialog
                    .keeps_focus_between(f.bin_first.clone(), f.bin_last.clone())
                    .on_close(move |_, app| Self::folder_do(&me, app, |f| f.bin = None))
                    .into_any_element(),
            );
        }
        None
    }

    /// No folder yet: what the page is for, and the way in.
    fn folder_empty(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let mut ways = div().flex().flex_wrap().items_center().gap(px(10.));
        ways = ways.child({
            let me = me.clone();
            ui.button("ordner-waehlen-start", "Ordner wählen").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_folder(cx)))
        });
        if self.drive.as_ref().is_some_and(|d| d.configured) {
            let me = me.clone();
            ways = ways.child(ui.button("ordner-aus-drive", "Aus Google Drive").on_click(move |_, app| me.update(app, |shell, cx| shell.open_drive_folder(cx))));
        }
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
            .gap(px(20.))
            .child(ui.page_head("Ordner", "Die Dateien eines Ordners auf diesem Computer: ansehen, auswählen, abspielen, bearbeiten. Gelesen wird nur, was Sie ansehen; gesendet wird nichts."))
            .child(ui.empty(
                "ordner-leer",
                "Ihre Dateien, aus einem Ordner",
                "Wählen Sie einen Ordner, und Sondra zeigt, was darin liegt — Filme mit Vorschaubild, Serien unter ihrem Namen.",
                vec![ways.into_any_element()],
            ))
            .into_any_element()
    }
}
