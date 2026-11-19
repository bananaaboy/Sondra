//! The window: header, row of tabs, and the screen of the chosen tool. What a tool does is not here —
//! only where it is and how to get to it; a tool that is not built yet says so on its page instead of
//! pretending.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{
    deferred, div, prelude::*, px, AnyElement, Context, Entity, ExternalPaths, FocusHandle,
    KeyDownEvent, PathPromptOptions, Render, SharedString, Window, WindowAppearance,
};
use sondra_a11y::{a11y_root, Role};
use sondra_ui::{family, motion, radius, size, FieldEvent, Mode, NoticeKind, TextField, Ui};

use crate::actions::{self, Group};
use crate::layout::{columns, shell_width, tab_width, GUTTER};
use crate::convert_page::ConvertState;
use crate::audio_page::AudioState;
use crate::devices_page::DevicesState;
use crate::download_page::DownloadState;
use crate::folder_page::FolderState;
use crate::merkliste::MerkState;
use crate::harmony_page::HarmonyState;
use crate::images_page::ImagesState;
use crate::mic_page::MicState;
use crate::sampler_page::SamplerState;
use crate::phone_page::PhoneState;
use crate::screen_page::ScreenState;
use crate::stems_page::StemsState;
use crate::subtitles_page::SubtitlesState;
use crate::mix_page::MixState;
use crate::video_page::VideoState;
use crate::normalize_page::NormalizeState;
use crate::player_page::PlayerState;
use crate::nav::{entry_of, fit_row, slide_from, Entry, Panel, ENTRIES};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Menu {
    /// The menu of a group of tabs.
    Entry(usize),
    /// What did not fit the row.
    More,
}

pub struct Shell {
    mode: Mode,
    panel: Panel,
    /// Where the tool came from, for the side it slides in from.
    from: Panel,
    menu: Option<Menu>,
    /// When a click outside shut a menu — the click on its own tab must not open it again.
    closed_at: Option<(Menu, Instant)>,
    search: Entity<TextField>,
    /// A chosen group of tools on the start page; `None` is all of them.
    chosen_group: Option<Group>,
    /// Groups whose rest of tiles is shown.
    unfolded: HashSet<Group>,
    /// Files chosen or dropped; what to do with them is chosen among the tools.
    picked: Vec<PathBuf>,
    pub(crate) focus: FocusHandle,
    /// The first entry of whatever menu is open takes the focus when it opens.
    menu_focus: FocusHandle,
    focus_menu: bool,
    /// One handle per tab (the last is „Mehr“): the focus goes back to the one that opened a menu.
    tab_focus: Vec<FocusHandle>,
    /// The Merkliste: the list, what narrows it, the lines being typed into.
    pub(crate) merk: MerkState,
    /// The Ordner page: the folder read, what it shows, what is chosen.
    pub(crate) folder: FolderState,
    /// The player: what is queued, what plays.
    pub(crate) player: PlayerState,
    /// The Herunterladen page: the address, what was found, what loads.
    pub(crate) download: DownloadState,
    pub(crate) devices: DevicesState,
    pub(crate) mic: MicState,
    pub(crate) audio: AudioState,
    pub(crate) sampler: SamplerState,
    pub(crate) subtitles: SubtitlesState,
    pub(crate) stems: StemsState,
    pub(crate) phone: PhoneState,
    pub(crate) screen: ScreenState,
    /// The Umwandeln page.
    pub(crate) convert: ConvertState,
    /// The Lautstärke page.
    pub(crate) normalize: NormalizeState,
    pub(crate) harmony: HarmonyState,
    pub(crate) images: ImagesState,
    pub(crate) mix: MixState,
    pub(crate) video: VideoState,
    pub(crate) discord: crate::discord::DiscordState,
    pub(crate) news_rounds: crate::new_episodes::NewEpisodes,
    /// Which file the conversion is at, for the page that shows it.
    pub(crate) convert_watch: Option<std::sync::Arc<std::sync::Mutex<(usize, String)>>>,
    /// Where the focus goes at the next frame (a dialog that opened takes it).
    pub(crate) pending_focus: Option<FocusHandle>,
    /// „Was ist neu“ is open.
    pub(crate) whats_new_open: bool,
    /// The version a line under the header says is new, until it is read or closed.
    pub(crate) news: Option<String>,
}

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mode = match window.appearance() {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Mode::Dark,
            _ => Mode::Light,
        };
        let colors = mode.colors();
        let search = cx.new(|cx| {
            TextField::new(cx, colors, "Werkzeuge durchsuchen").placeholder("Werkzeug suchen…")
        });
        cx.subscribe(&search, |_, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Changed {
                cx.notify();
            }
        })
        .detach();
        let merk = MerkState::new(cx, colors);
        let folder = FolderState::new(cx, colors);
        let download = DownloadState::new(cx, colors);
        let devices = DevicesState::new(cx, colors);
        Self::start_new_episode_rounds(window, cx);
        // Twice a second: is the window minimised? (A window nobody draws does not ask by itself.)
        cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(500)).await;
            if this.update_in(cx, |shell, window, cx| {
                shell.player.pause_for_minimized(crate::system::is_minimized(window));
                // What the devices' worker says changes by itself; the page shows it while it is open.
                if (shell.panel == Panel::Devices && shell.devices.engine.is_some()) || (shell.panel == Panel::Folder && shell.folder.dupes.running) {
                    cx.notify();
                }
            }).is_err() {
                break;
            }
        })
        .detach();
        Self {
            mode,
            panel: Panel::Start,
            from: Panel::Start,
            menu: None,
            closed_at: None,
            search,
            chosen_group: None,
            unfolded: HashSet::new(),
            picked: Vec::new(),
            focus: cx.focus_handle(),
            menu_focus: cx.focus_handle().tab_stop(true),
            focus_menu: false,
            tab_focus: (0..=ENTRIES.len())
                .map(|_| cx.focus_handle().tab_stop(true))
                .collect(),
            merk,
            folder,
            player: PlayerState::new(cx),
            download,
            devices,
            mic: MicState::new(),
            audio: AudioState::new(),
            sampler: SamplerState::new(),
            subtitles: SubtitlesState::new(),
            stems: StemsState::new(),
            phone: PhoneState::new(cx),
            screen: ScreenState::new(),
            convert: ConvertState::new(),
            normalize: NormalizeState::new(),
            harmony: HarmonyState::new(),
            images: ImagesState::new(),
            mix: MixState::new(),
            video: VideoState::new(),
            discord: crate::discord::DiscordState::default(),
            news_rounds: crate::new_episodes::NewEpisodes::default(),
            convert_watch: None,
            pending_focus: None,
            whats_new_open: false,
            news: None,
        }
    }

    /// Opens what was handed to the program (files dropped on it, „Öffnen mit Sondra“, the command line): a
    /// shared list goes to the Merkliste's window for receiving, a folder goes to the Ordner page, films and songs are played, anything else waits on the start page.
    pub fn open_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        // A shared list (`.sondra-liste`) opens the window that sets it beside one's own.
        if let Some(list) = paths.iter().find(|p| p.file_name().is_some_and(|n| sondra_merk::share::is_share_file(&n.to_string_lossy()))) {
            self.go(Panel::Merkliste, cx);
            self.receive_open(cx);
            self.receive_read_file(list);
            cx.notify();
            return;
        }
        if let [only] = paths.as_slice() {
            if only.is_dir() {
                self.go(Panel::Folder, cx);
                self.open_folder(only.clone(), cx);
                return;
            }
        }
        let playable = paths.iter().any(|p| p.file_name().is_some_and(|n| sondra_player::player_kind(&n.to_string_lossy(), "").is_some()));
        if playable {
            self.go(Panel::Player, cx);
            self.play_files(paths, cx);
        } else if !paths.is_empty() {
            self.take_files(paths, cx);
        }
    }

    /// Opens what a second start hands over, and brings the window forward.
    pub fn listen_for_instances(&mut self, paths: std::sync::mpsc::Receiver<Vec<PathBuf>>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(300)).await;
            while let Ok(given) = paths.try_recv() {
                let alive = this.update(cx, |shell, cx| {
                    if !given.is_empty() {
                        shell.open_paths(given, cx);
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    return;
                }
                cx.update(|app| app.activate(true)).ok();
            }
        })
        .detach();
    }

    /// Gives the player the settings and the places it remembered.
    pub fn open_player_memory(&mut self, store: crate::store::FileStore, cx: &mut Context<Self>) {
        self.player.remember_from(store);
        cx.notify();
    }

    /// Gives the Ordner page what it remembered the last time.
    pub fn open_ordner_memory(&mut self, store: crate::store::FileStore, cx: &mut Context<Self>) {
        self.folder.remember_from(store);
        cx.notify();
    }

    /// Reads the Merkliste from this store and keeps writing to it.
    pub fn open_merkliste(&mut self, store: crate::store::MerkStore, cx: &mut Context<Self>) {
        self.merk.open(store);
        cx.notify();
    }

    pub fn panel(&self) -> Panel {
        self.panel
    }

    pub fn go(&mut self, panel: Panel, cx: &mut Context<Self>) {
        if panel != self.panel {
            self.from = self.panel;
            self.panel = panel;
        }
        self.menu = None;
        cx.notify();
    }

    fn toggle_menu(&mut self, menu: Menu, cx: &mut Context<Self>) {
        let just_closed = self
            .closed_at
            .is_some_and(|(m, at)| m == menu && at.elapsed() < Duration::from_millis(250));
        self.closed_at = None;
        self.menu = if self.menu == Some(menu) || just_closed {
            None
        } else {
            Some(menu)
        };
        self.focus_menu = self.menu.is_some();
        cx.notify();
    }

    /// Whether the focus is on a tab, or in a menu hanging from one.
    fn in_tab_row(&self, window: &Window) -> bool {
        self.menu.is_some() || self.tab_focus.iter().any(|h| h.is_focused(window))
    }

    /// The tab that opened the menu now open, if one is.
    fn opener_focus(&self) -> Option<FocusHandle> {
        match self.menu? {
            Menu::Entry(i) => self.tab_focus.get(i).cloned(),
            Menu::More => self.tab_focus.get(ENTRIES.len()).cloned(),
        }
    }

    fn close_menu(&mut self, by_click: bool, cx: &mut Context<Self>) {
        if let Some(menu) = self.menu.take() {
            if by_click {
                self.closed_at = Some((menu, Instant::now()));
            }
            cx.notify();
        }
    }

    fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        let colors = mode.colors();
        self.search
            .update(cx, |field, cx| field.set_colors(colors, cx));
        self.merk.search.update(cx, |field, cx| field.set_colors(colors, cx));
        self.merk.add.update(cx, |field, cx| field.set_colors(colors, cx));
        self.folder.search.update(cx, |field, cx| field.set_colors(colors, cx));
        self.download.input.update(cx, |field, cx| field.set_colors(colors, cx));
        cx.notify();
    }

    fn choose_files(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.take_files(paths, cx))
                    .ok();
            }
        })
        .detach();
    }

    fn take_files(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if !paths.is_empty() {
            self.picked = paths;
            cx.notify();
        }
    }
}

fn file_name(path: &PathBuf) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/* The pieces ------------------------------------------------------------------------------------- */

impl Shell {
    fn header(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let to_mode = match self.mode {
            Mode::Light => Mode::Dark,
            Mode::Dark => Mode::Light,
        };
        let label = match self.mode {
            Mode::Light => "Dunkles Thema",
            Mode::Dark => "Helles Thema",
        };
        div()
            .flex()
            .items_center()
            .justify_between()
            .child(ui.wordmark())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child({
                        let me = me.clone();
                        let version = crate::whats_new::app_version();
                        ui.button("version", version.clone()).small().ghost().accessible_name(format!("Was ist neu, Version {version}")).on_click(move |_, app| {
                            me.update(app, |shell, cx| {
                                shell.whats_new_open = true;
                                shell.news = None;
                                cx.notify();
                            })
                        })
                    })
                    .child(ui.button("thema", label).small().on_click(move |_, app| {
                        me.update(app, |shell, cx| shell.set_mode(to_mode, cx));
                    })),
            )
            .into_any_element()
    }

    /// The row of tabs on the line of the header: the tasks first, the tools in three groups, and what does
    /// not fit behind „Mehr“ — never cut off, never to be scrolled sideways.
    fn tab_row(&self, ui: Ui, available: f32, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let chosen = entry_of(self.panel);
        let label_of = |i: usize| -> String {
            match ENTRIES[i] {
                // A group names the tool chosen in it: „Ton · Mischen“.
                Entry::Group { label, .. } if i == chosen => {
                    format!("{label} · {} ▾", self.panel.label())
                }
                Entry::Group { label, .. } => format!("{label} ▾"),
                Entry::Single(p) => p.label().to_string(),
            }
        };
        let widths: Vec<f32> = (0..ENTRIES.len())
            .map(|i| tab_width(&label_of(i), matches!(ENTRIES[i], Entry::Group { .. })))
            .collect();
        let fit = fit_row(&widths, 2.0, tab_width("Mehr", false), available, chosen);

        let mut row = div()
            .id("reiter-zeile")
            .relative()
            .flex()
            .items_center()
            .gap(px(2.));
        for i in &fit.shown {
            let i = *i;
            let entry = ENTRIES[i];
            let selected = i == chosen;
            let me = me.clone();
            let mut tab = ui
                .tab(format!("reiter-{}", entry.id()), label_of(i), selected)
                .focus_handle(self.tab_focus[i].clone());
            if let Entry::Group { label, panels, .. } = entry {
                // The little arrow is for the eye; the reader gets the name and what the button does.
                let name = if selected {
                    format!("{label} · {}", self.panel.label())
                } else {
                    label.to_string()
                };
                tab = tab
                    .accessible_name(name)
                    .note(format!("Menü mit {} Werkzeugen", panels.len()));
            }
            let tab = tab.on_click(move |_, app| {
                me.update(app, |shell, cx| match entry {
                    Entry::Single(p) => shell.go(p, cx),
                    Entry::Group { .. } => shell.toggle_menu(Menu::Entry(i), cx),
                });
            });
            let mut cell = div().relative().child(tab);
            if self.menu == Some(Menu::Entry(i)) {
                cell = cell.child(self.popover(ui, Menu::Entry(i), cx));
            }
            row = row.child(cell);
        }
        if !fit.hidden.is_empty() {
            let me = me.clone();
            let more = ui
                .tab("reiter-mehr", "Mehr ▾", fit.hidden.contains(&chosen))
                .accessible_name("Mehr")
                .note("Menü mit den weiteren Werkzeugen")
                .focus_handle(self.tab_focus[ENTRIES.len()].clone())
                .on_click(move |_, app| {
                    me.update(app, |shell, cx| shell.toggle_menu(Menu::More, cx));
                });
            let mut cell = div().relative().child(more);
            if self.menu == Some(Menu::More) {
                cell = cell.child(self.more_popover(ui, &fit.hidden, cx));
            }
            row = row.child(cell);
        }
        ui.landmark(
            Role::Navigation,
            "reiterleiste",
            "Werkzeuge und Aufgaben",
            row,
        )
    }

    fn item(&self, ui: Ui, panel: Panel, first: bool, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let item = ui
            .menu_item(
                format!("menue-{}", panel.slug()),
                panel.label(),
                panel == self.panel,
            )
            .hint(panel.meta().summary)
            .on_click(move |_, app| {
                me.update(app, |shell, cx| shell.go(panel, cx));
            });
        if first {
            item.focus_handle(self.menu_focus.clone())
                .into_any_element()
        } else {
            item.into_any_element()
        }
    }

    fn floating(&self, popover: AnyElement, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        // Above everything else, just under its tab, unfolding from it (`drop`); a press anywhere else
        // shuts it.
        deferred(
            div()
                .absolute()
                .top(px(40.))
                .left_0()
                .on_mouse_down_out(move |_, _, app| {
                    me.update(app, |shell, cx| shell.close_menu(true, cx));
                })
                .child(motion::enter(
                    div().child(popover),
                    "menue-auf",
                    (0.0, -6.0),
                    Duration::ZERO,
                    motion::FAST,
                )),
        )
        .with_priority(10)
        .into_any_element()
    }

    fn popover(&self, ui: Ui, menu: Menu, cx: &mut Context<Self>) -> AnyElement {
        let Menu::Entry(i) = menu else {
            unreachable!("a popover belongs to a group")
        };
        let entry = ENTRIES[i];
        let items: Vec<AnyElement> = entry
            .panels()
            .iter()
            .enumerate()
            .map(|(n, p)| self.item(ui, *p, n == 0, cx))
            .collect();
        let pop = ui.popover(format!("menue-{}", entry.id()), entry.label(), items);
        self.floating(pop, cx)
    }

    fn more_popover(&self, ui: Ui, hidden: &[usize], cx: &mut Context<Self>) -> AnyElement {
        let mut items: Vec<AnyElement> = Vec::new();
        let mut first_given = false;
        for i in hidden {
            let entry = ENTRIES[*i];
            // A group is a heading over its tools; a single tool is an entry.
            if let Entry::Group { label, .. } = entry {
                items.push(ui.hint(label));
            }
            for p in entry.panels() {
                let first = !first_given;
                first_given = true;
                items.push(self.item(ui, *p, first, cx));
            }
        }
        let pop = ui.popover("menue-mehr", "Weitere Werkzeuge", items);
        self.floating(pop, cx)
    }

    /// A tool that is not built yet says so, and says where it is available meanwhile.
    fn unfinished(&self, ui: Ui, panel: Panel) -> AnyElement {
        let meta = panel.meta();
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(ui.heading(meta.label))
            .child(ui.prose(meta.summary))
            .child(ui.notice(
                NoticeKind::Info,
                "Dieses Werkzeug gibt es in der neuen App noch nicht. In der Windows-App und auf der Website funktioniert es wie gewohnt.",
            ))
            .into_any_element()
    }

    /* The start page ------------------------------------------------------------------------------ */

    fn way_in(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let me = cx.entity();
        let on_drop = cx.entity();
        let mut block = div()
            .id("einstieg")
            .flex()
            .flex_col()
            .gap(px(20.))
            .p(px(28.))
            .rounded(px(radius::CARD))
            .bg(c.panel_soft)
            .border_1()
            .border_color(c.line)
            .drag_over::<ExternalPaths>(move |style, _, _, _| {
                style.bg(c.panel_mid).border_2().border_color(c.ink)
            })
            .on_drop(move |paths: &ExternalPaths, _, app| {
                let paths = paths.paths().to_vec();
                on_drop.update(app, |shell, cx| shell.take_files(paths, cx));
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .w_full()
                    .max_w(px(34. * size::BODY))
                    .child(ui.display("Ton, Video und Bilder bearbeiten"))
                    .child(
                        ui.prose("Gerechnet wird auf Ihrem Gerät — keine Datei wird hochgeladen."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        ui.button("datei-waehlen", "Datei auswählen")
                            .primary()
                            .on_click(move |_, app| {
                                me.update(app, |shell, cx| shell.choose_files(cx));
                            }),
                    )
                    .child({
                        let me = cx.entity();
                        ui.button("von-adresse", "Von Adresse laden")
                            .on_click(move |_, app| {
                                me.update(app, |shell, cx| shell.go(Panel::Downloader, cx));
                            })
                    })
                    .child(ui.hint("oder hierher ziehen")),
            );
        if !self.picked.is_empty() {
            let names: Vec<String> = self.picked.iter().map(file_name).collect();
            let shown = names.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            let more = names.len().saturating_sub(3);
            let text = if more == 0 {
                shown
            } else {
                format!("{shown} und {more} weitere")
            };
            block = block
                .child(div().flex().gap(px(8.)).child(ui.value(text)))
                .child(ui.prose("Wählen Sie unten, was damit geschehen soll."));
        }
        block.into_any_element()
    }

    fn tile(
        &self,
        ui: Ui,
        action: &'static actions::Action,
        index: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let me = cx.entity();
        let panel = action.panel;
        let tile = ui
            .tile(
                format!("kachel-{}", action.id),
                action.label.clone(),
                action.hint.clone(),
            )
            // The job's own mark, else the one of the tool it opens — as on the web.
            .icon(
                sondra_ui::action_icon(&action.id)
                    .or_else(|| sondra_ui::panel_icon(panel.meta().id)),
            )
            .on_click(move |_, app| {
                me.update(app, |shell, cx| shell.go(panel, cx));
            });
        // A list arrives as a list: the tiles follow one another, 30 ms apart.
        motion::enter(
            div().child(tile),
            SharedString::from(format!("rise-{}", action.id)),
            (0.0, 8.0),
            motion::stagger(index),
            motion::BASE,
        )
    }

    fn grid(&self, ui: Ui, tiles: Vec<AnyElement>, cols: usize) -> AnyElement {
        let _ = ui;
        div()
            .grid()
            .grid_cols(cols as u16)
            .gap(px(12.))
            .children(tiles)
            .into_any_element()
    }

    fn tools(&self, ui: Ui, cols: usize, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let query = self.search.read(cx).text().to_string();
        let searching = !query.trim().is_empty();

        // The pills: all, and the four groups. A search overrides them, and they stand back.
        let mut pills = div().flex().flex_wrap().gap(px(6.));
        pills = pills.child({
            let me = me.clone();
            ui.chip(
                "gruppe-alle",
                "Alle",
                !searching && self.chosen_group.is_none(),
            )
            .on_click(move |_, app| {
                me.update(app, |shell, cx| {
                    shell.search.update(cx, |f, cx| f.set_text("", cx));
                    shell.chosen_group = None;
                    cx.notify();
                });
            })
        });
        for group in actions::filters() {
            let group = *group;
            let me = me.clone();
            pills = pills.child(
                ui.chip(
                    format!("gruppe-{}", group.label()),
                    group.label(),
                    !searching && self.chosen_group == Some(group),
                )
                .on_click(move |_, app| {
                    me.update(app, |shell, cx| {
                        shell.search.update(cx, |f, cx| f.set_text("", cx));
                        shell.chosen_group = Some(group);
                        cx.notify();
                    });
                }),
            );
        }
        let pills = if searching { pills.opacity(0.4) } else { pills };

        let head = div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(12.))
            .pb(px(14.))
            .border_b_1()
            .border_color(ui.c.line)
            .child(ui.subheading("Werkzeuge"))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .child(pills)
                    .child(div().w(px(260.)).child(self.search.clone())),
            );

        let mut body = div().flex().flex_col().gap(px(28.));
        if searching {
            let found = actions::search(&query);
            if found.is_empty() {
                body = body.child(ui.prose(format!(
                    "Nichts gefunden für „{}“. Versuchen Sie es mit einem Format („mp3“, „webp“, „gif“) oder mit dem, was herauskommen soll.",
                    query.trim()
                )));
            } else {
                let tiles = found
                    .iter()
                    .enumerate()
                    .map(|(i, a)| self.tile(ui, a, i, cx))
                    .collect();
                body = body.child(self.grid(ui, tiles, cols));
            }
        } else {
            for (group, list) in actions::start_groups() {
                if self.chosen_group.is_some_and(|g| g != group) {
                    continue;
                }
                // Two rows of each group; a chosen group, or one opened, whole.
                let whole = self.chosen_group == Some(group) || self.unfolded.contains(&group);
                let shown = if whole {
                    list.len()
                } else {
                    (cols * 2).min(list.len())
                };
                let rest = list.len() - shown;
                let tiles = list[..shown]
                    .iter()
                    .enumerate()
                    .map(|(i, a)| self.tile(ui, a, i, cx))
                    .collect();
                let mut section = div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(8.))
                            .child(ui.title(group.label()))
                            .child(ui.value(list.len().to_string())),
                    )
                    .child(self.grid(ui, tiles, cols));
                if rest > 0 {
                    let me = me.clone();
                    let text = if rest == 1 {
                        format!("Noch ein Werkzeug für {}", group.label())
                    } else {
                        format!("Noch {rest} Werkzeuge für {}", group.label())
                    };
                    section = section.child(
                        div().flex().child(
                            ui.button(format!("mehr-{}", group.label()), text)
                                .ghost()
                                .on_click(move |_, app| {
                                    me.update(app, |shell, cx| {
                                        shell.unfolded.insert(group);
                                        cx.notify();
                                    });
                                }),
                        ),
                    );
                }
                body = body.child(section);
            }
        }
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(head)
            .child(body)
            .into_any_element()
    }

    /// The other tasks as tiles: what the tab row names, one click from the start.
    fn media(&self, ui: Ui, cols: usize, cx: &mut Context<Self>) -> AnyElement {
        let tiles: Vec<AnyElement> = [
            Panel::Merkliste,
            Panel::Folder,
            Panel::Player,
            Panel::Downloader,
        ]
        .iter()
        .map(|p| {
            let me = cx.entity();
            let panel = *p;
            ui.tile(format!("aufgabe-{}", p.slug()), p.label(), p.meta().summary)
                .icon(sondra_ui::panel_icon(p.meta().id))
                .on_click(move |_, app| {
                    me.update(app, |shell, cx| shell.go(panel, cx));
                })
                .into_any_element()
        })
        .collect();
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(ui.subheading("Filme und Serien"))
            .child(self.grid(ui, tiles, if cols >= 3 { 4 } else { 2 }))
            .into_any_element()
    }

    /// „Heute weiterschauen“: the three series watched last, one click to each (`ContinueTiles` of the web
    /// app). Nothing is shown when nothing is being watched.
    fn continue_watching(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = ui.c;
        let mut watching: Vec<&sondra_merk::Item> = self.merk.items.iter().filter(|i| i.status == sondra_merk::Status::Watching && i.episode.is_some()).collect();
        watching.sort_by_key(|i| std::cmp::Reverse(i.last_opened_at.unwrap_or(i.updated_at)));
        watching.truncate(3);
        if watching.is_empty() {
            return None;
        }
        let mut rows = div().flex().flex_col();
        for (n, item) in watching.iter().enumerate() {
            let stand = sondra_merk::rows::position_label(item.season, item.episode, sondra_merk::rows::EpisodeKind::Series);
            let poster = match self.cover_element(cx, &item.cover, item.cover_frame, 44.0, 66.0) {
                Some(cover) => div().w(px(44.)).h(px(66.)).flex_none().rounded(px(6.)).overflow_hidden().child(cover).into_any_element(),
                None => div().w(px(44.)).h(px(66.)).flex_none().rounded(px(6.)).bg(c.panel_mid).flex().items_center().justify_center().text_size(px(sondra_ui::size::MICRO)).text_color(c.muted).child(crate::merkliste::initials(&item.title)).into_any_element(),
            };
            let (me, id) = (cx.entity(), item.id.clone());
            rows = rows.child(crate::lines::Line {
                colors: c,
                id: format!("weiter-{n}").into(),
                name: item.title.clone().into(),
                says: format!("{stand}. Weiter").into(),
                first: n == 0,
                tile: None,
                selected: false,
                body: vec![
                    poster,
                    div().flex().flex_col().gap(px(2.)).flex_1().min_w(px(0.)).child(div().text_color(c.ink).font_weight(gpui::FontWeight::SEMIBOLD).truncate().child(item.title.clone())).child(div().text_size(px(sondra_ui::size::SMALL)).text_color(c.prose).truncate().child(stand)).into_any_element(),
                    div().text_size(px(sondra_ui::size::SMALL)).font_weight(gpui::FontWeight::SEMIBOLD).text_color(c.ink).child("Weiter →").into_any_element(),
                ],
                on_open: std::rc::Rc::new(move |_, app| {
                    let id = id.clone();
                    me.update(app, |shell, cx| {
                        shell.merk.open = Some(id);
                        shell.go(Panel::Merkliste, cx);
                    })
                }),
            });
        }
        Some(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Heute weiterschauen")).child(rows).into_any_element())
    }

    fn start(&self, ui: Ui, cols: usize, cx: &mut Context<Self>) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap(px(36.))
            .child(self.way_in(ui, cx))
            .children(self.continue_watching(ui, cx))
            .child(self.media(ui, cols, cx))
            .child(self.tools(ui, cols, cx))
            .into_any_element()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ui = Ui::new(self.mode.colors());
        let c = ui.c;
        let vw: f32 = window.viewport_size().width.into();
        let vh_px: f32 = window.viewport_size().height.into();
        let column = shell_width(vw).min(vw);
        let gutter = if vw < 640.0 { 16.0 } else { GUTTER };
        let inner = (column - 2.0 * gutter).max(280.0);
        let cols = columns(vw);
        let me = cx.entity();
        if let Some(handle) = self.pending_focus.take() {
            window.defer(cx, move |window, _| window.focus(&handle));
        }
        if self.focus_menu && self.menu.is_some() {
            self.focus_menu = false;
            let handle = self.menu_focus.clone();
            window.defer(cx, move |window, _| window.focus(&handle));
        }

        self.sync_download_chrome(window, cx);

        // What plays goes on whichever page is open; the picture is taken only for the page that shows it.
        let showing = self.panel == Panel::Player;
        if self.player.tick(window, showing) {
            // Draw again at the next frame. (`request_animation_frame` asks the view being drawn, which a
            // window's root view is not yet while it renders itself — it is asked by name instead.)
            let me = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(me));
        }
        self.player_merkliste_tick();
        self.update_discord();
        // A download in progress is drawn again and again: the bar moves.
        if self.download.job.is_some() || self.convert.run.is_some() || self.video.run.is_some() {
            let me = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(me));
        }
        // Pictures the Bilder page has replaced are let go of here, where the window is at hand.
        let cover_trash = std::mem::take(&mut self.merk.covers.borrow_mut().trash);
        for old in std::mem::take(&mut self.images.trash).into_iter().chain(std::mem::take(&mut self.video.trash)).chain(cover_trash) {
            let _ = window.drop_image(old);
        }
        // The picture over the whole window (or screen): the page is nothing but it, in dark colours.
        let immersive = self.panel == Panel::Player && self.player.playback.is_some() && self.player.size.immersive();
        self.sync_fullscreen(window);
        if immersive && !self.focus.contains_focused(window, cx) {
            // Over the whole window the controls come and go; the keys must have somewhere to land.
            let handle = self.focus.clone();
            window.defer(cx, move |window, _| window.focus(&handle));
        }
        let page = if immersive {
            self.player_page(Ui::new(Mode::Dark.colors()), inner, vh_px, cx)
        } else if self.panel == Panel::Start {
            self.start(ui, cols, cx)
        } else if self.panel == Panel::Merkliste {
            self.merkliste(ui, inner, cx)
        } else if self.panel == Panel::Folder {
            self.folder_page(ui, cx)
        } else if self.panel == Panel::Player {
            self.player_page(ui, inner, vh_px, cx)
        } else if self.panel == Panel::Downloader {
            self.download_page(ui, cx)
        } else if self.panel == Panel::Converter {
            self.convert_page(ui, cx)
        } else if self.panel == Panel::Video {
            self.video_page(ui, cx)
        } else if self.panel == Panel::Screen {
            self.screen_page(ui, cx)
        } else if self.panel == Panel::Phone {
            self.phone_page(ui, cx)
        } else if self.panel == Panel::Stems {
            self.stems_page(ui, cx)
        } else if self.panel == Panel::Subtitles {
            self.subtitles_page(ui, cx)
        } else if self.panel == Panel::Sampler {
            self.sampler_page(ui, cx)
        } else if self.panel == Panel::Audio {
            self.audio_page(ui, cx)
        } else if self.panel == Panel::Mic {
            self.mic_page(ui, cx)
        } else if self.panel == Panel::Devices {
            self.devices_page(ui, cx)
        } else if self.panel == Panel::Mix {
            self.mix_page(ui, cx)
        } else if self.panel == Panel::Images {
            self.images_page(ui, cx)
        } else if self.panel == Panel::Harmony {
            self.harmony_page(ui, cx)
        } else if self.panel == Panel::Normalize {
            self.normalize_page(ui, cx)
        } else {
            self.unfinished(ui, self.panel)
        };
        // A tool comes from the side of its tab, ±20 px; the start page comes from below, a little.
        let side = slide_from(self.from, self.panel) as f32;
        let page = if immersive { page } else { motion::enter(
            div().w_full().child(page),
            ("seite", self.panel.index()),
            (20.0 * side, if side == 0.0 { 8.0 } else { 0.0 }),
            Duration::ZERO,
            motion::BASE,
        ).into_any_element() };

        let overlay = if self.whats_new_open { self.whats_new_overlay(ui, cx) } else if self.panel == Panel::Folder { self.folder_overlay(ui, cx) } else if self.panel == Panel::Player { self.player_overlay(ui, cx) } else if self.panel == Panel::Merkliste { self.stats_overlay(ui, cx).or_else(|| self.share_overlay(ui, cx)).or_else(|| self.receive_overlay(ui, cx)).or_else(|| self.history_overlay(ui, cx)).or_else(|| self.dice_overlay(ui, cx)) } else { None };
        // A film that goes on behind another tool says so, and can be stopped from here.
        let mini = if self.panel != Panel::Player { self.player_mini(ui, cx) } else { None };
        let floating = self.floating_cards(ui, cx);
        let header = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.header(ui, cx))
            .children(self.news_banner(ui, cx))
            .child(self.tab_row(ui, inner, cx))
            .child(ui.rule());

        a11y_root(
            div()
                .id("fenster")
                .key_context("SondraShell")
                .track_focus(&self.focus)
                .on_key_down(move |event: &KeyDownEvent, window, app| {
                    let step = match event.keystroke.key.as_str() {
                        "left" => -1,
                        "right" => 1,
                        _ => 0,
                    };
                    // Left and Right walk the row of tabs (sideways out of an open menu shuts it first).
                    if step != 0 && me.read(app).in_tab_row(window) {
                        me.update(app, |shell, cx| shell.close_menu(false, cx));
                        if step < 0 {
                            window.focus_prev();
                        } else {
                            window.focus_next();
                        }
                        app.stop_propagation();
                        return;
                    }
                    if me.read(app).panel == Panel::Player {
                        me.update(app, |shell, _| shell.player.activity = std::time::Instant::now());
                    }
                    // The player's own keys, on its page: Space, the arrows, M — when nothing else took them.
                    let m = &event.keystroke.modifiers;
                    if m.shift && !(m.control || m.alt || m.platform) && me.read(app).panel == Panel::Player && matches!(event.keystroke.key.as_str(), "left" | "right") {
                        let forward = event.keystroke.key == "right";
                        me.update(app, |shell, cx| {
                            shell.player.jump_mark(forward);
                            cx.notify();
                        });
                        app.stop_propagation();
                        return;
                    }
                    if !(m.control || m.alt || m.platform || m.shift) && me.read(app).panel == Panel::Player {
                        let key = event.keystroke.key.clone();
                        if me.update(app, |shell, cx| {
                            let taken = shell.player.key(&key);
                            if taken {
                                cx.notify();
                            }
                            taken
                        }) {
                            app.stop_propagation();
                            return;
                        }
                    }
                    if event.keystroke.key == "escape" && me.read(app).merk.more {
                        me.update(app, |shell, cx| {
                            shell.merk.more = false;
                            cx.notify();
                        });
                        return;
                    }
                    if event.keystroke.key == "escape" {
                        // Escape shuts the menu and gives the focus back to the tab that opened it.
                        let back = me.read(app).opener_focus();
                        me.update(app, |shell, cx| shell.close_menu(false, cx));
                        if let Some(handle) = back {
                            window.focus(&handle);
                        }
                    }
                })
                .size_full()
                .relative()
                .bg(if immersive { Mode::Dark.colors().stage } else { c.canvas })
                .text_color(c.prose)
                .font_family(family::SANS)
                .text_size(px(size::BODY))
                .flex()
                .justify_center()
                .child(if immersive { page } else {
                    div()
                        .id("blatt")
                        .size_full()
                        .overflow_y_scroll()
                        .flex()
                        .justify_center()
                        .child(
                            div()
                                .w_full()
                                .max_w(px(column))
                                .px(px(gutter))
                                .py(px(24.))
                                .flex()
                                .flex_col()
                                .gap(px(28.))
                                .child(header)
                                .child(page),
                        ).into_any_element() })
                .children(overlay)
                .children(mini)
                .children(floating),
        )
    }
}
