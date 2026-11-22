//! The window, as a projection booth: the rack on the left (every place one click away), and the lit
//! plate the chosen page sits on. What a tool does is not here — only where it is and how to get to it; a
//! tool that is not built yet says so on its page instead of pretending.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use gpui::{
    div, prelude::*, px, AnyElement, Context, Entity, ExternalPaths, FocusHandle,
    KeyDownEvent, PathPromptOptions, Render, SharedString, Window,
};
use sondra_a11y::{a11y_root, Role};
use sondra_ui::{family, motion, radius, size, FieldEvent, Mode, NoticeKind, TextField, Ui};

use crate::actions::{self, Group};
use crate::layout::{columns_for, shell_width, RACK, RACK_COMPACT};
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
use crate::nav::{slide_from, Entry, Panel, ENTRIES};

pub struct Shell {
    pub(crate) mode: Mode,
    panel: Panel,
    /// Where the tool came from, for the side it slides in from.
    from: Panel,
    search: Entity<TextField>,
    /// A chosen group of tools on the start page; `None` is all of them.
    chosen_group: Option<Group>,
    /// Groups whose rest of tiles is shown.
    unfolded: HashSet<Group>,
    /// Files chosen or dropped; what to do with them is chosen among the tools.
    pub(crate) session: crate::session::Session,
    /// The field for a new name of a file of the session.
    pub(crate) session_rename: Entity<TextField>,
    pub(crate) focus: FocusHandle,
    /// One handle per place in the rack, in the order of `PANELS`: Up and Down walk them.
    rack_focus: Vec<FocusHandle>,
    /// Since when a dialog or the drawer is open: their way in is drawn frame by frame for a moment —
    /// an animation inside a deferred layer asks for no frames of its own and stayed invisible.
    layer_since: Option<std::time::Instant>,
    /// The notifications drawer: open or not, and its log.
    pub(crate) inbox: crate::inbox::Inbox,
    /// „Saallicht“: whether the house lights are down (a film plays), and since when — the rack fades.
    house: (bool, std::time::Instant),
    /// The pointer rests on the rack: the lights come back (through the same fade).
    rack_hovered: bool,
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
    pub(crate) anytype: crate::anytype_window::AnytypeState,
    pub(crate) anilist: crate::anilist_window::AniState,
    pub(crate) merk_drive: crate::merk_drive::MerkDrive,
    pub(crate) old_app: crate::old_app::OldApp,
    /// How many things waited for the person at the last frame (new episodes, offers of files).
    pub(crate) attention_seen: usize,
    /// The tray icon (the program's start only); what a click on it or on a notification asks for.
    tray: Option<sondra_tray::Tray>,
    /// The little window of „Bild im Bild“, while it is open.
    pub(crate) pip: Option<gpui::WindowHandle<crate::pip::PipView>>,
    pub(crate) pip_opening: bool,
    tray_asks: std::sync::Arc<TrayAsks>,
    pub update: crate::updater_ui::Updates,
    pub palette: crate::palette::Palette,
    /// Google Drive for the saves of results; `None` where nothing can be kept.
    pub drive: Option<crate::drive_hub::Drive>,
    pub drive_saves: crate::drive_hub::Saves,
    /// The sign-in to Drive is being waited for (the browser is open), or why it did not work.
    pub drive_signing: bool,
    pub drive_error: Option<String>,
    /// Which file the conversion is at, for the page that shows it.
    pub(crate) convert_watch: Option<std::sync::Arc<std::sync::Mutex<(usize, String)>>>,
    /// Where the focus goes at the next frame (a dialog that opened takes it).
    pub(crate) pending_focus: Option<FocusHandle>,
    /// „Was ist neu“ is open.
    pub(crate) whats_new_open: bool,
    pub(crate) licenses_open: bool,
    /// The version a line under the header says is new, until it is read or closed.
    pub(crate) news: Option<String>,
    /// Where the chosen theme is kept; without a choice the booth is dark.
    theme_store: Option<crate::store::FileStore>,
}

/// What the tray's thread leaves for the window's: a click on a notification.
#[derive(Default)]
struct TrayAsks {
    notification: std::sync::atomic::AtomicBool,
}

struct TrayHandler {
    asks: std::sync::Arc<TrayAsks>,
    window: Option<isize>,
}

impl sondra_tray::Handler for TrayHandler {
    fn open(&self, from_notification: bool) {
        if let Some(handle) = self.window {
            crate::system::bring_forward(handle);
        }
        if from_notification {
            self.asks.notification.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    fn quit(&self) {
        std::process::exit(0);
    }
}

const THEME_KEY: &str = "sondra:theme";

impl Shell {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Dark from the first start, whatever the system says (the user's word, 20.11.2026); a choice made
        // with the switch is kept (`open_theme_memory`).
        let _ = window;
        let mode = Mode::default();
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
        let session_rename = cx.new(|cx| TextField::new(cx, colors, "Neuer Name der Datei").max_chars(190));
        cx.subscribe(&session_rename, |shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.session_commit_rename(cx);
            }
        })
        .detach();
        let convert = ConvertState::new(cx, colors);
        let palette = crate::palette::Palette::new(cx, colors);
        crate::palette::subscribe(&palette.field, cx);
        cx.subscribe(&convert.name, |shell, _, event: &FieldEvent, cx| match event {
            FieldEvent::Changed => cx.notify(),
            FieldEvent::Submitted => shell.convert_save_own(cx),
            _ => {}
        })
        .detach();
        Self::start_new_episode_rounds(window, cx);
        Self::start_anytype_rounds(window, cx);
        Self::start_anilist_rounds(window, cx);
        Self::start_merk_drive_rounds(window, cx);
        Self::start_update_rounds(window, cx);
        // Twice a second: is the window minimised? (A window nobody draws does not ask by itself.)
        cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(500)).await;
            if this.update_in(cx, |shell, window, cx| {
                shell.player.pause_for_minimized(crate::system::is_minimized(window));
                // What the devices' worker says changes by itself; the page shows it while it is open.
                if (shell.panel == Panel::Devices && shell.devices.engine.is_some()) || (shell.panel == Panel::Folder && shell.folder.dupes.running) {
                    cx.notify();
                }
                // Something new waits for the person: draw it, so the card and the flashing come even on another page.
                if shell.attention_count() != shell.attention_seen {
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
            search,
            chosen_group: None,
            unfolded: HashSet::new(),
            session: Default::default(),
            session_rename,
            focus: cx.focus_handle(),
            rack_focus: (0..crate::nav::PANELS.len())
                .map(|_| cx.focus_handle().tab_stop(true))
                .collect(),
            house: (false, std::time::Instant::now() - motion::SLOW),
            inbox: Default::default(),
            layer_since: None,
            rack_hovered: false,
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
            convert,
            normalize: NormalizeState::new(),
            harmony: HarmonyState::new(),
            images: ImagesState::new(),
            mix: MixState::new(),
            video: VideoState::new(),
            discord: crate::discord::DiscordState::default(),
            news_rounds: crate::new_episodes::NewEpisodes::default(),
            anytype: crate::anytype_window::AnytypeState::new(cx, colors),
            anilist: crate::anilist_window::AniState::new(cx, colors),
            merk_drive: crate::merk_drive::MerkDrive::load(),
            old_app: Default::default(),
            attention_seen: 0,
            tray: None,
            pip: None,
            pip_opening: false,
            tray_asks: Default::default(),
            update: crate::updater_ui::Updates::default(),
            palette,
            drive: crate::drive_hub::Drive::production(),
            drive_saves: crate::drive_hub::Saves::default(),
            drive_signing: false,
            drive_error: None,
            convert_watch: None,
            pending_focus: None,
            theme_store: None,
            whats_new_open: false,
            licenses_open: false,
            news: None,
        }
    }

    /// Opens what was handed to the program (files dropped on it, „Öffnen mit Sondra“, the command line): a
    /// shared list goes to the Merkliste's window for receiving, a folder goes to the Ordner page, films and songs are played, anything else waits on the start page.
    pub fn open_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        // An address like the website's: `sondra #umwandeln` opens that tool (a file called that is
        // never taken for one — a real path wins).
        // A project (`.sondra`) is opened as one: its files come into the session and its tool opens.
        if let Some(project) = paths.iter().find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("sondra"))) {
            self.session_open_project(project.clone(), cx);
            return;
        }
        if let [only] = paths.as_slice() {
            let text = only.to_string_lossy();
            if text.starts_with('#') && !only.exists() {
                self.go(Panel::from_slug(&text), cx);
                return;
            }
        }
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
            if panel == Panel::Downloader {
                self.offer_clipboard(cx);
            }
        }
        cx.notify();
    }

    /// Whether the focus is on a place in the rack.
    fn in_rack(&self, window: &Window) -> bool {
        self.rack_focus.iter().any(|h| h.is_focused(window))
    }

    /// What waits for the person: announced episodes and devices that offer files.
    pub(crate) fn attention_count(&self) -> usize {
        let offers = self.devices.engine.as_ref().map_or(0, |e| e.snapshot().transfers.iter().filter(|t| t.state == sondra_devices::engine::State::Asking).count());
        self.news_rounds.notes.len() + offers
    }

    /// What waits, as a notification would say it (title, line), the announced episodes first.
    pub(crate) fn attention_lines(&self) -> Vec<(String, String)> {
        let mut lines: Vec<(String, String)> = self.news_rounds.notes.iter().map(|n| (format!("Neue Folge: {}", n.title), format!("Staffel {}, Folge {} ist auf AniWorld erschienen.", n.season, n.episode))).collect();
        if let Some(e) = &self.devices.engine {
            for t in e.snapshot().transfers.iter().filter(|t| t.state == sondra_devices::engine::State::Asking) {
                lines.push((format!("„{}“ möchte etwas senden", t.peer_name), crate::devices_page::say(t)));
            }
        }
        lines
    }

    /// More waiting than at the last frame while the window is behind others: the taskbar button flashes and, where
    /// there is a tray, a notification says what it is. A click on the notification brings that thing forward.
    fn flash_for_news(&mut self, window: &Window, cx: &mut Context<Self>) {
        let count = self.attention_count();
        if count > self.attention_seen && !window.is_window_active() {
            crate::system::flash_taskbar(window);
            if let Some(tray) = &self.tray {
                let lines = self.attention_lines();
                for (title, text) in lines.iter().skip(self.attention_seen.min(lines.len())) {
                    tray.notify(title, text);
                }
            }
        }
        self.attention_seen = count;
        // A click on a notification: the newest thing that waits.
        if self.tray_asks.notification.swap(false, std::sync::atomic::Ordering::SeqCst) {
            if let Some(id) = self.news_rounds.notes.last().map(|n| n.id.clone()) {
                self.open_announced(&id, cx);
            } else if self.devices.engine.as_ref().is_some_and(|e| e.snapshot().transfers.iter().any(|t| t.state == sondra_devices::engine::State::Asking)) {
                self.go(Panel::Devices, cx);
            }
        }
    }

    /// For tests: what the tray would leave when a notification is clicked.
    pub fn tray_notification_clicked_for_test(&self) {
        self.tray_asks.notification.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// For tests: what a notification would say now (title, line).
    pub fn attention_lines_for_test(&self) -> Vec<(String, String)> {
        self.attention_lines()
    }

    /// Puts the icon in the notification area (Windows) and takes its clicks. The program's start calls this; a test
    /// does not, so no test touches the real tray.
    pub fn start_tray(&mut self, window: &Window) {
        let handle = crate::system::window_handle(window);
        let handler = std::sync::Arc::new(TrayHandler { asks: self.tray_asks.clone(), window: handle });
        self.tray = sondra_tray::Tray::start("Sondra", handler);
    }

    /// Every text field of every page. One left out stays in the colours of the other theme and cannot be read.
    fn all_fields(&self) -> Vec<gpui::Entity<TextField>> {
        vec![
            self.search.clone(),
            self.merk.search.clone(),
            self.merk.add.clone(),
            self.merk.plan_by.clone(),
            self.folder.search.clone(),
            self.download.input.clone(),
            self.convert.name.clone(),
            self.convert.trim.from.clone(),
            self.convert.trim.to.clone(),
            self.devices.rename.clone(),
            self.session_rename.clone(),
            self.devices.text.clone(),
            self.devices.servers.stun.clone(),
            self.devices.servers.turn.clone(),
            self.devices.servers.user.clone(),
            self.devices.servers.password.clone(),
            self.palette.field.clone(),
            self.merk.receive.field.clone(),
            self.anytype.code.clone(),
            self.anytype.name.clone(),
            self.anilist.token.clone(),
        ]
    }

    /// Takes the theme a person chose earlier (`hell` or `dunkel`, as on the website); no choice means dark,
    /// which `new` already took.
    pub fn open_theme_memory(&mut self, store: crate::store::FileStore, cx: &mut Context<Self>) {
        use sondra_merk::folder_memory::Store;
        match store.get_item(THEME_KEY).as_deref() {
            Some("dunkel") => self.set_mode(Mode::Dark, cx),
            Some("hell") => self.set_mode(Mode::Light, cx),
            _ => {}
        }
        self.theme_store = Some(store);
    }

    /// A choice made with the button: shown and remembered.
    fn choose_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.set_mode(mode, cx);
        if let Some(store) = self.theme_store.as_mut() {
            use sondra_merk::folder_memory::Store;
            store.set_item(THEME_KEY, if mode == Mode::Dark { "dunkel" } else { "hell" }.to_string());
        }
    }

    fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.mode = mode;
        let colors = mode.colors();
        for field in self.all_fields() {
            field.update(cx, |field, cx| field.set_colors(colors, cx));
        }
        cx.notify();
    }

    /// For tests: the colours each field draws with now.
    pub fn field_colors_for_test(&self, cx: &gpui::App) -> Vec<sondra_ui::Colors> {
        self.all_fields().iter().map(|f| f.read(cx).colors()).collect()
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
        self.session_add(paths, cx);
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
    /// The rack: the wordmark, the six tasks, the tools under their three groups — every place one click
    /// away, no menu to open — and at its foot the session, Drive, what is new and the light switch.
    /// While a film plays on its page the rack dims („Saallicht“) and comes back under the pointer.
    fn rack(&self, ui: Ui, compact: bool, light: f32, cx: &mut Context<Self>) -> AnyElement {
        let c = ui.c;
        let mut list = div()
            .id("rack-liste")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(if compact { 12. } else { 10. }));
        let mut tasks_done = false;
        for entry in ENTRIES.iter() {
            match entry {
                Entry::Single(p) => list = list.child(self.rack_place(ui, *p, compact, cx)),
                Entry::Group { label, panels, .. } => {
                    if !tasks_done {
                        tasks_done = true;
                    }
                    // A group is a heading over its tools; in a narrow rack a hairline stands in for it.
                    list = list.child(if compact {
                        div().mx(px(6.)).my(px(10.)).h(px(1.)).bg(c.line).into_any_element()
                    } else {
                        div()
                            .pt(px(12.))
                            .pb(px(2.))
                            .px(px(12.))
                            .child(ui.rack_heading(*label))
                            .into_any_element()
                    });
                    for p in panels.iter() {
                        list = list.child(self.rack_place(ui, *p, compact, cx));
                    }
                }
            }
        }
        let nav = ui.landmark(Role::Navigation, "reiterleiste", "Werkzeuge und Aufgaben", list);

        let me = cx.entity();
        let to_mode = match self.mode {
            Mode::Light => Mode::Dark,
            Mode::Dark => Mode::Light,
        };
        let (theme_label, theme_icon) = match self.mode {
            Mode::Light => ("Dunkles Thema", "dunkel"),
            Mode::Dark => ("Helles Thema", "hell"),
        };
        let version = crate::whats_new::app_version();
        let mut foot = div()
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(if compact { 12. } else { 10. }))
            .pt(px(10.))
            .border_t_1()
            .border_color(c.line);
        if let Some(files) = self.session_header_button(&ui, compact, cx) {
            foot = foot.child(files);
        }
        if let Some(drive) = self.drive_header_button(&ui, compact, cx) {
            foot = foot.child(drive);
        }
        let (news, bell) = (me.clone(), me.clone());
        let waiting = self.inbox_count();
        // The small things at the foot as a row of marks (each with its name for the screen reader and as a
        // tooltip) — four full lines left the rack too short for its places on a laptop.
        let marks = div()
            .flex()
            .when(compact, |d| d.flex_col())
            .items_center()
            .gap(px(4.))
            .child(
                ui.rack_item("mitteilungen-glocke", "Mitteilungen", self.inbox.open)
                    .icon(Some(sondra_ui::ui_icon("glocke")))
                    .compact(true)
                    .count(Some(waiting))
                    .on_click(move |_, app| bell.update(app, |shell, cx| shell.toggle_inbox(cx))),
            )
            .child(
                ui.rack_item("version", format!("Was ist neu · {version}"), false)
                    .icon(Some(sondra_ui::ui_icon("neu")))
                    .compact(true)
                    .accessible_name(format!("Was ist neu, Version {version}"))
                    .on_click(move |_, app| {
                        news.update(app, |shell, cx| {
                            shell.whats_new_open = true;
                            shell.news = None;
                            cx.notify();
                        })
                    }),
            )
            .child(
                ui.rack_item("thema", theme_label, false)
                    .icon(Some(sondra_ui::ui_icon(theme_icon)))
                    .compact(true)
                    .on_click(move |_, app| {
                        me.update(app, |shell, cx| shell.choose_mode(to_mode, cx));
                    }),
            )
            .when(!compact, |d| d.child(div().flex_1().text_right().text_size(px(size::MICRO)).text_color(c.muted).child(version.clone())));
        foot = foot.child(marks);

        let head = div()
            .flex_none()
            .h(px(52.))
            .flex()
            .items_center()
            .px(px(if compact { 0. } else { 20. }))
            .when(compact, |d| d.justify_center())
            .gap(px(10.))
            .child(ui.mark(if compact { 32. } else { 28. }))
            .when(!compact, |d| d.child(ui.wordmark()));

        div()
            .id("rack")
            .flex_none()
            .w(px(if compact { RACK_COMPACT } else { RACK }))
            .h_full()
            .flex()
            .flex_col()
            .pb(px(12.))
            .bg(c.room)
            .when(light < 1.0, |d| d.opacity(light))
            .on_hover(cx.listener(|shell, hovered: &bool, _, cx| {
                if shell.rack_hovered != *hovered {
                    shell.rack_hovered = *hovered;
                    cx.notify();
                }
            }))
            .child(head)
            .child(nav)
            .child(foot)
            .into_any_element()
    }

    fn rack_place(&self, ui: Ui, panel: Panel, compact: bool, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let item = ui
            .rack_item(format!("reiter-{}", panel.slug()), panel.label(), panel == self.panel)
            .icon(sondra_ui::panel_icon(panel.meta().id))
            .compact(compact)
            .count(self.rack_count(panel))
            .focus_handle(self.rack_focus[panel.index()].clone())
            .on_click(move |_, app| me.update(app, |shell, cx| shell.go(panel, cx)));
        // At the start the rack fills from the top, place by place; after that it stands still.
        motion::enter(
            div().w_full().child(item),
            SharedString::from(format!("rack-ein-{}", panel.slug())),
            (-10.0, 0.0),
            motion::stagger(panel.index()),
            motion::BASE,
        )
    }

    /// What waits at a place: devices that offer files wait under „Geräte“.
    fn rack_count(&self, panel: Panel) -> Option<usize> {
        if panel != Panel::Devices {
            return None;
        }
        let offers = self.devices.engine.as_ref().map_or(0, |e| e.snapshot().transfers.iter().filter(|t| t.state == sondra_devices::engine::State::Asking).count());
        Some(offers)
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
            .px(px(28.))
            .py(px(26.))
            .rounded(px(radius::CARD))
            .bg(c.panel_soft)
            .border_1()
            .border_color(gpui::transparent_black())
            .drag_over::<ExternalPaths>(move |style, _, _, _| {
                style.bg(c.ink_wash).border_color(c.ink)
            })
            .on_drop(move |paths: &ExternalPaths, _, app| {
                let paths = paths.paths().to_vec();
                on_drop.update(app, |shell, cx| shell.take_files(paths, cx));
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    // A known width, not a maximum: text that wraps under a maximum is measured as one
                    // line, and the sentence below slid under the buttons.
                    .w_full()
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
                        ui.button("projekt-oeffnen", "Projekt öffnen").on_click(move |_, app| {
                            me.update(app, |shell, cx| shell.session_choose_project(cx));
                        })
                    })
                    .child({
                        let me = cx.entity();
                        ui.button("von-adresse", "Von Adresse laden")
                            .on_click(move |_, app| {
                                me.update(app, |shell, cx| shell.go(Panel::Downloader, cx));
                            })
                    })
                    .child(div().pl(px(6.)).child(ui.hint("oder Dateien hierher ziehen"))),
            );
        if !self.session.files.is_empty() {
            let names: Vec<String> = self.session.files.iter().map(file_name).collect();
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
        // What a project's save or open said, where the person is (the list under the header says it when it is open).
        if !self.session.open {
            block = block.children(self.session_said_line(&ui));
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
                // What the person chose goes to the tool they pick, if it takes such files.
                me.update(app, |shell, cx| shell.session_hand_over(panel, None, cx));
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
            .child(ui.subheading("Werkzeuge"))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .child(pills)
                    .child(div().w(px(240.)).child(self.search.clone())),
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
                            .pb(px(8.))
                            .border_b_1()
                            .border_color(ui.c.line)
                            .child(ui.title(group.label()))
                            .child(div().text_color(ui.c.muted).child(ui.value(list.len().to_string()))),
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

    /// Films and series: what is being watched, one click to each — the tasks themselves stand in the rack,
    /// a tile for each would only say it twice. With nothing being watched, one quiet line.
    fn media(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        if let Some(watching) = self.continue_watching(ui, cx) {
            return watching;
        }
        let me = cx.entity();
        let to_list = cx.entity();
        div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(ui.subheading("Filme und Serien"))
            .child(ui.empty(
                "start-serien",
                "Noch keine Serie am Schauen",
                "Wählen Sie einen Ordner mit Ihren Folgen, oder tippen Sie eine Serie ein — hier steht dann, wo Sie weiterschauen.",
                vec![
                    ui.button("start-ordner", "Ordner mit Serien öffnen").on_click(move |_, app| me.update(app, |shell, cx| shell.go(Panel::Folder, cx))).into_any_element(),
                    ui.button("start-merkliste", "Zur Merkliste").ghost().on_click(move |_, app| to_list.update(app, |shell, cx| shell.go(Panel::Merkliste, cx))).into_any_element(),
                ],
            ))
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
                keys_pass: false,
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
            .gap(px(40.))
            .child(self.way_in(ui, cx))
            .children(self.old_app_offer(ui, cx))
            .child(self.media(ui, cx))
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
        // The rack takes its width; the plate is what is left, inset 8 px from the window's edges.
        let compact = vw < crate::layout::RACK_NARROW_BELOW;
        let rack_w = if compact { RACK_COMPACT } else { RACK };
        let plate_w = (vw - rack_w - 8.0).max(320.0);
        let gutter = if plate_w < 640.0 { 18.0 } else { crate::layout::GUTTER };
        let column = shell_width(vw).min(plate_w);
        let inner = (column - 2.0 * gutter).max(280.0);
        let cols = columns_for(inner);
        let me = cx.entity();
        if let Some(handle) = self.pending_focus.take() {
            window.defer(cx, move |window, _| window.focus(&handle));
        }

        self.sync_download_chrome(window, cx);

        // What plays goes on whichever page is open; the picture is taken only for the page that shows it.
        // With „Bild im Bild“ open, that window keeps the clock (it is drawn when this one is minimised, too).
        let showing = self.panel == Panel::Player;
        if self.pip.is_none() && self.player.tick(window, showing) {
            // Draw again at the next frame. (`request_animation_frame` asks the view being drawn, which a
            // window's root view is not yet while it renders itself — it is asked by name instead.)
            let me = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(me));
        }
        for old in std::mem::take(&mut self.player.retired) {
            let _ = window.drop_image(old);
        }
        self.player_merkliste_tick();
        self.update_discord();
        self.flash_for_news(window, cx);
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
        self.sync_pinned(window);
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

        // The window's one open dialog. Each step asks only when its own thing is open and falls through when it
        // has nothing to show — before, an open flag whose dialog had nothing to show (the offer of the old
        // app with nothing found) swallowed every dialog after it, and „Was ist neu“ opened unseen.
        let overlay = None
            .or_else(|| if self.palette.open || self.palette.help { self.palette_overlay(ui, cx) } else { None })
            .or_else(|| if self.panel == Panel::Start && self.old_app.open { self.old_app_overlay(ui, cx) } else { None })
            .or_else(|| if self.licenses_open { self.licenses_overlay(ui, cx) } else { None })
            .or_else(|| if self.whats_new_open { self.whats_new_overlay(ui, cx) } else { None })
            .or_else(|| if self.panel == Panel::Folder { self.folder_overlay(ui, cx) } else { None })
            .or_else(|| if self.panel == Panel::Player { self.player_overlay(ui, cx) } else { None })
            .or_else(|| {
                if self.panel != Panel::Merkliste {
                    return None;
                }
                self.edit_overlay(ui, cx)
                    .or_else(|| self.season_overlay(ui, cx))
                    .or_else(|| self.stats_overlay(ui, cx))
                    .or_else(|| self.share_overlay(ui, cx))
                    .or_else(|| self.anytype_overlay(ui, cx))
                    .or_else(|| self.anilist_overlay(ui, cx))
                    .or_else(|| self.receive_overlay(ui, cx))
                    .or_else(|| self.history_overlay(ui, cx))
                    .or_else(|| self.dice_overlay(ui, cx))
            });
        // A film that goes on behind another tool says so, and can be stopped from here.
        let mini = if self.panel != Panel::Player { self.player_mini(ui, cx) } else { None };
        let floating = self.floating_cards(ui, cx);
        let drawer = if immersive { None } else { self.inbox_drawer(ui, rack_w + 12.0, cx) };
        match (overlay.is_some() || drawer.is_some(), self.layer_since) {
            (true, None) => self.layer_since = Some(std::time::Instant::now()),
            (false, Some(_)) => self.layer_since = None,
            _ => {}
        }
        if self.layer_since.is_some_and(|at| at.elapsed() < std::time::Duration::from_millis(600)) {
            let me = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(me));
        }
        // What stands above every page: a line about a new version, the offer of the last session, the
        // files of the session when they are open.
        let above: Vec<AnyElement> = self
            .news_banner(ui, cx)
            .into_iter()
            .chain(self.session_offer_line(ui, cx))
            .chain(self.session_panel(ui, cx))
            .collect();
        // „Saallicht“: while a film plays on its page, the rack goes dim.
        let playing = self.panel == Panel::Player
            && self.player.playback.as_ref().is_some_and(|p| p.state() == sondra_playback::State::Playing);
        // The lights come back the moment the rack has the focus (Up and Down walk it), and fade either way.
        let lights_down = playing && !self.in_rack(window) && !self.rack_hovered;
        if lights_down != self.house.0 {
            self.house = (lights_down, std::time::Instant::now());
        }
        let t = if motion::reduced() { 1.0 } else { (self.house.1.elapsed().as_secs_f32() / motion::SLOW.as_secs_f32()).min(1.0) };
        let e = motion::ease_out(t);
        let light = if self.house.0 { 1.0 - 0.68 * e } else { 0.32 + 0.68 * e };
        if t < 1.0 {
            let me = cx.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(me));
        }
        let rack = if immersive { None } else { Some(self.rack(ui, compact, light, cx)) };

        a11y_root(
            div()
                .id("fenster")
                .key_context("SondraShell")
                .track_focus(&self.focus)
                .on_key_down(move |event: &KeyDownEvent, window, app| {
                    let step = match event.keystroke.key.as_str() {
                        "up" => -1,
                        "down" => 1,
                        _ => 0,
                    };
                    // Up and Down walk the places of the rack.
                    if step != 0 && me.read(app).in_rack(window) {
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
                    // Ctrl/⌘ + K: the command palette; „?“: the overview of keys (when no field took the key).
                    if (m.control || m.platform) && !m.alt && event.keystroke.key == "k" {
                        me.update(app, |shell, cx| shell.open_palette(cx));
                        app.stop_propagation();
                        return;
                    }
                    if (event.keystroke.key == "?" || (m.shift && event.keystroke.key == "/")) && !window.context_stack().iter().any(|c| c.contains("SondraTextField")) {
                        me.update(app, |shell, cx| shell.toggle_help(cx));
                        app.stop_propagation();
                        return;
                    }
                    // „Ton bearbeiten“: Space, Strg+Z/Y/X/C/V, Entf, T and the zoom, as on the website (not in a field).
                    if !(m.alt || m.platform) && me.read(app).panel == Panel::Audio && !window.context_stack().iter().any(|c| c.contains("SondraTextField")) {
                        let key = event.keystroke.key.clone();
                        let (control, shift) = (m.control, m.shift);
                        if me.update(app, |shell, cx| shell.audio_key(&key, control, shift, cx)) {
                            app.stop_propagation();
                            return;
                        }
                    }
                    // Ordner: the arrows, Space, Strg+A, Escape and Enter go through the list (not in a field).
                    if !(m.alt || m.platform) && me.read(app).panel == Panel::Folder && !window.context_stack().iter().any(|c| c.contains("SondraTextField")) {
                        let key = event.keystroke.key.clone();
                        let (control, shift) = (m.control, m.shift);
                        if me.update(app, |shell, cx| shell.folder_key(&key, control, shift, cx)) {
                            app.stop_propagation();
                            return;
                        }
                    }
                    // Video and Bilder: Strg+Z and Strg+Umschalt+Z (or Strg+Y) walk the settings back and forth.
                    if m.control && !(m.alt || m.platform) && matches!(me.read(app).panel, Panel::Video | Panel::Images) && !window.context_stack().iter().any(|c| c.contains("SondraTextField")) {
                        let key = event.keystroke.key.clone();
                        let shift = m.shift;
                        let taken = me.update(app, |shell, cx| {
                            let video = shell.panel == Panel::Video;
                            match (shift, key.as_str(), video) {
                                (false, "z", true) => shell.video_undo(cx),
                                (true, "z", true) | (false, "y", true) => shell.video_redo(cx),
                                (false, "z", false) => shell.images_undo(cx),
                                (true, "z", false) | (false, "y", false) => shell.images_redo(cx),
                                _ => return false,
                            }
                            true
                        });
                        if taken {
                            app.stop_propagation();
                            return;
                        }
                    }
                    // „Zerschneiden“: sixteen keys play sixteen pads, 1 2 3 4 / Q W E R / A S D F / Y X C V.
                    if !(m.control || m.alt || m.platform || m.shift) && me.read(app).panel == Panel::Sampler {
                        let key = event.keystroke.key.clone();
                        if me.update(app, |shell, cx| shell.sampler_key(&key, cx)) {
                            app.stop_propagation();
                            return;
                        }
                    }
                    // With Shift only the speed: „>“ (Shift and „.“ or, on a German keyboard, Shift and „<“), „<“.
                    let shifted = match (m.shift, event.keystroke.key.as_str()) {
                        (true, "." | "<") => Some(">".to_string()),
                        (true, ",") => Some("<".to_string()),
                        (true, ">") => Some(">".to_string()),
                        _ => None,
                    };
                    if !(m.control || m.alt || m.platform) && (!m.shift || shifted.is_some()) && me.read(app).panel == Panel::Player {
                        let key = shifted.unwrap_or_else(|| event.keystroke.key.clone());
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
                    if event.keystroke.key == "escape" && me.read(app).inbox.open {
                        me.update(app, |shell, cx| shell.toggle_inbox(cx));
                        return;
                    }
                    if event.keystroke.key == "escape" && me.read(app).merk.more {
                        me.update(app, |shell, cx| {
                            shell.merk.more = false;
                            cx.notify();
                        });
                        return;
                    }
                })
                .size_full()
                .relative()
                .bg(if immersive { Mode::Dark.colors().stage } else { c.room })
                .text_color(c.prose)
                .font_family(family::SANS)
                .text_size(px(size::BODY))
                .flex()
                .children(rack)
                .child(if immersive { page } else {
                    // The plate: the lit thing in the dark room, one step lighter, with a catch-light on
                    // its edge and the window's one shadow under it.
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .py(px(8.))
                        .pr(px(8.))
                        .child(
                            div()
                                .id("blatt")
                                .size_full()
                                .rounded(px(radius::PLATE))
                                .bg(c.canvas)
                                // The catch-light: the plate's upper edge only.
                                .border_t_1()
                                .border_color(c.plate_edge)
                                .shadow(plate_shadow(self.mode))
                                .overflow_y_scroll()
                                .flex()
                                .justify_center()
                                // Not stretched: a stretched column is as tall as the plate, and the plate
                                // then had nothing to scroll — the wheel did nothing on a long page.
                                .items_start()
                                .child(
                                    div()
                                        .w_full()
                                        .max_w(px(column))
                                        .px(px(gutter))
                                        .pt(px(28.))
                                        .pb(px(48.))
                                        .flex()
                                        .flex_col()
                                        .gap(px(24.))
                                        .children(above)
                                        .child(page),
                                ),
                        ).into_any_element() })
                .children(overlay)
                .children(mini)
                .children(floating)
                .children(drawer),
        )
    }
}

/// The shadow the plate throws into the room: deep and soft in the dark, a breath in the light.
fn plate_shadow(mode: Mode) -> Vec<gpui::BoxShadow> {
    let alpha = if mode == Mode::Dark { 0.45 } else { 0.07 };
    vec![gpui::BoxShadow {
        color: gpui::hsla(0., 0., 0., alpha),
        offset: gpui::point(px(0.), px(6.)),
        blur_radius: px(24.),
        spread_radius: px(-6.),
    }]
}
