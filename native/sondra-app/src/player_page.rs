//! The Abspielen page: a film or a song from a file on this computer, with the picture on a stage, the
//! controls under it and the list of what is queued. What is played, when the picture shows and how the
//! clock runs is `sondra-playback`; what is offered when, what is remembered and how the time reads is
//! `sondra-player` (checked against the website). This file sets it out.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, img, prelude::*, px, AnyElement, App, Context, Entity, ImageSource, ObjectFit, PathPromptOptions, RenderImage, SharedString, Window};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_media::Ffmpeg;
use sondra_player::cues::{cues_at, parse_cues, Cue};
use sondra_player::{clock, minutes_seconds, player_kind, rate_label, remember_place, remembered_place, stem_of, Kind, Repeat, Settings, RATES};
use sondra_playback::{Playback, State};
use sondra_ui::{family, size, NoticeKind, Ui};

use crate::lines::Line;
use crate::shell::Shell;
use crate::store::FileStore;

const SETTINGS_KEY: &str = "sondra:abspielen";
const PLACES_KEY: &str = "sondra:abspielen:stellen";

pub struct PlayerState {
    pub ffmpeg: Option<Ffmpeg>,
    pub playback: Option<Playback>,
    pub queue: Vec<PathBuf>,
    pub index: usize,
    pub image: Option<Arc<RenderImage>>,
    pub error: Option<String>,
    pub settings: Settings,
    pub memory: Option<FileStore>,
    pub cues: Vec<Cue>,
    /// When the place was last written down.
    saved_at: Option<std::time::Instant>,
}

impl PlayerState {
    pub fn new() -> PlayerState {
        PlayerState {
            ffmpeg: Ffmpeg::locate(),
            playback: None,
            queue: Vec::new(),
            index: 0,
            image: None,
            error: None,
            settings: Settings::default(),
            memory: None,
            cues: Vec::new(),
            saved_at: None,
        }
    }

    /// Takes the settings and places the page remembered.
    pub fn remember_from(&mut self, store: FileStore) {
        use sondra_merk::folder_memory::Store;
        self.settings = Settings::from_json(store.get_item(SETTINGS_KEY).as_deref());
        self.memory = Some(store);
    }

    fn keep_settings(&mut self) {
        use sondra_merk::folder_memory::Store;
        let json = self.settings.to_json();
        if let Some(store) = self.memory.as_mut() {
            store.set_item(SETTINGS_KEY, json);
        }
    }

    fn current_path(&self) -> Option<&PathBuf> {
        self.queue.get(self.index)
    }

    /// Where the current file was left, written down (or forgotten at the end).
    fn keep_place(&mut self, forget: bool) {
        use sondra_merk::folder_memory::Store;
        let (Some(path), Some(playback)) = (self.queue.get(self.index).cloned(), self.playback.as_ref()) else { return };
        let (Some(name), Ok(meta)) = (path.file_name().map(|n| n.to_string_lossy().into_owned()), std::fs::metadata(&path)) else { return };
        let at = playback.position();
        let seconds = if forget || at < 5.0 || playback.duration().is_some_and(|d| at > d - 30.0) { None } else { Some(at) };
        if let Some(store) = self.memory.as_mut() {
            let next = remember_place(store.get_item(PLACES_KEY).as_deref(), &name, meta.len(), seconds);
            store.set_item(PLACES_KEY, next);
        }
        self.saved_at = Some(std::time::Instant::now());
    }

    fn place_of(&self, path: &PathBuf) -> f64 {
        use sondra_merk::folder_memory::Store;
        let (Some(name), Ok(meta), Some(store)) = (path.file_name().map(|n| n.to_string_lossy().into_owned()), std::fs::metadata(path), self.memory.as_ref()) else { return 0.0 };
        remembered_place(store.get_item(PLACES_KEY).as_deref(), &name, meta.len()).unwrap_or(0.0)
    }

    /// Starts the file at `index` of the queue, where it was left.
    pub fn start(&mut self, index: usize) {
        self.keep_place(false);
        self.index = index.min(self.queue.len().saturating_sub(1));
        self.error = None;
        self.cues.clear();
        self.playback = None;
        self.image = None;
        let Some(path) = self.current_path().cloned() else { return };
        let Some(ffmpeg) = Ffmpeg::locate() else {
            self.error = Some("FFmpeg ist nicht da. Ohne FFmpeg kann Sondra nichts abspielen.".into());
            return;
        };
        let from = self.place_of(&path);
        match Playback::open(ffmpeg, &path, from) {
            Ok(mut playback) => {
                playback.set_volume(self.settings.volume as f32);
                playback.set_muted(self.settings.muted);
                if (self.settings.rate - 1.0).abs() > 1e-9 {
                    let _ = playback.set_rate(self.settings.rate);
                }
                self.playback = Some(playback);
                self.load_subtitles(&path);
            }
            Err(e) => self.error = Some(e.to_string()),
        }
    }

    /// A subtitle file with the name of the film, beside it, goes with it.
    fn load_subtitles(&mut self, film: &std::path::Path) {
        let (Some(dir), Some(name)) = (film.parent(), film.file_name().map(|n| n.to_string_lossy().into_owned())) else { return };
        let stem = stem_of(&name);
        let Ok(read) = std::fs::read_dir(dir) else { return };
        let mut found: Vec<PathBuf> = read
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| sondra_player::is_subtitle_file(&n.to_string_lossy())))
            .filter(|p| {
                let sub = p.file_name().map(|n| stem_of(&n.to_string_lossy())).unwrap_or_default();
                sub == stem || sub.rsplit_once('.').is_some_and(|(s, tag)| s == stem && (2..=3).contains(&tag.len()))
            })
            .collect();
        found.sort();
        if let Some(path) = found.first() {
            if let Ok(bytes) = std::fs::read(path) {
                self.cues = parse_cues(&String::from_utf8_lossy(&bytes));
            }
        }
    }

    /// One step of the clock of the window: takes the picture that is due, notices the end and moves on.
    /// Returns whether the page has to be drawn again soon (something is playing).
    pub fn tick(&mut self, window: &mut Window, show: bool) -> bool {
        let Some(playback) = self.playback.as_mut() else { return false };
        let frame = playback.next_frame();
        if show {
            if let Some(frame) = frame {
                if let Some(buffer) = RgbaImage::from_raw(frame.width, frame.height, frame.bgra) {
                    let new = Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)]));
                    if let Some(old) = self.image.replace(new) {
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        let state = playback.state();
        if state == State::Ended {
            self.keep_place(true);
            let last = self.index + 1 >= self.queue.len();
            match (self.settings.repeat, self.settings.auto_next) {
                (Repeat::Titel, _) => {
                    if let Some(p) = self.playback.as_mut() {
                        p.play();
                    }
                }
                (Repeat::Liste, _) if last => self.start(0),
                (_, true) if !last => self.start(self.index + 1),
                _ => {}
            }
        } else if self.saved_at.is_none_or(|t| t.elapsed().as_secs() >= 10) && state == State::Playing {
            self.keep_place(false);
        }
        self.playback.as_ref().is_some_and(|p| p.state() == State::Playing)
    }
}

impl Default for PlayerState {
    fn default() -> Self {
        Self::new()
    }
}

fn file_label(path: &PathBuf) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

impl Shell {
    /// Where the film is, when one plays.
    pub fn player_position(&self) -> Option<f64> {
        self.player.playback.as_ref().map(|p| p.position())
    }

    /// Whether a picture of the film has come to the stage.
    pub fn player_has_picture(&self) -> bool {
        self.player.image.is_some()
    }

    /// How many subtitle lines the film has.
    pub fn player_cues(&self) -> usize {
        self.player.cues.len()
    }

    fn player_do(me: &Entity<Shell>, app: &mut App, change: impl FnOnce(&mut PlayerState)) {
        me.update(app, |shell, cx| {
            change(&mut shell.player);
            cx.notify();
        });
    }

    /// Asks for files to play.
    pub(crate) fn choose_media(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.play_files(paths, cx)).ok();
            }
        })
        .detach();
    }

    /// Plays these files, one after the other; whatever was in the list is replaced.
    pub fn play_files(&mut self, files: Vec<PathBuf>, cx: &mut Context<Self>) {
        let playable: Vec<PathBuf> = files
            .into_iter()
            .filter(|p| p.file_name().is_some_and(|n| player_kind(&n.to_string_lossy(), "").is_some()))
            .collect();
        if playable.is_empty() {
            self.player.error = Some("Unter diesen Dateien ist nichts, was sich abspielen lässt.".into());
            cx.notify();
            return;
        }
        self.player.queue = playable;
        self.player.start(0);
        cx.notify();
    }

    /// The page: the stage, the controls and the list.
    pub(crate) fn player_page(&self, ui: Ui, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let p = &self.player;
        let mut page = div().flex().flex_col().gap(px(20.));
        if let Some(error) = &p.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let Some(playback) = &p.playback else {
            let me2 = me.clone();
            let mut ways = div().flex().flex_wrap().gap(px(10.));
            ways = ways.child(ui.button("medien-waehlen", "Datei wählen").primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.choose_media(cx))));
            return page
                .child(ui.heading("Abspielen"))
                .child(ui.prose("Filme und Musik von diesem Computer. Sondra spielt sie direkt von der Platte, ohne sie zu kopieren, und merkt sich, wo Sie aufgehört haben."))
                .child(ways)
                .child(self.player_queue(ui, cx))
                .into_any_element();
        };

        let position = playback.position();
        let duration = playback.duration().unwrap_or(0.0);
        let playing = playback.state() == State::Playing;
        let stage_height = (width * 9.0 / 16.0).clamp(240.0, 620.0);
        let name = p.current_path().map(file_label).unwrap_or_default();

        // The stage: the picture, and the words of the subtitle over its foot.
        let mut stage = div().relative().w_full().h(px(stage_height)).rounded(px(sondra_ui::radius::CARD)).bg(c.stage).overflow_hidden().flex().items_center().justify_center();
        stage = match (&p.image, playback.picture_size()) {
            (Some(image), Some(_)) => stage.child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Contain).size_full()),
            (None, Some(_)) => stage.child(div().text_color(c.stage_muted).child("Das Bild kommt …")),
            (_, None) => stage.child(div().flex().flex_col().items_center().gap(px(6.)).child(div().text_color(c.stage_ink).text_size(px(size::SUBHEADING)).child(name.clone())).child(div().text_color(c.stage_muted).child("Ton"))),
        };
        let lines: Vec<String> = cues_at(&p.cues, position).iter().map(|cue| cue.text.clone()).collect();
        if !lines.is_empty() {
            let px_size = match p.settings.caption_size {
                sondra_player::CaptionSize::Klein => 16.0,
                sondra_player::CaptionSize::Mittel => 22.0,
                sondra_player::CaptionSize::Gross => 30.0,
            };
            let mut caption = div().px(px(12.)).py(px(4.)).rounded(px(6.)).text_size(px(px_size)).text_color(gpui::white()).text_center().child(lines.join("\n"));
            if p.settings.caption_background {
                caption = caption.bg(gpui::hsla(0., 0., 0., 0.65));
            }
            stage = stage.child(div().absolute().bottom(px(18.)).left_0().w_full().flex().justify_center().child(caption));
        }

        // The controls.
        let toggle = {
            let me = me.clone();
            ui.button("abspielen-pause", if playing { "Pause" } else { "Abspielen" }).primary().on_click(move |_, app| Self::player_do(&me, app, |p| if let Some(pb) = p.playback.as_mut() { pb.toggle() }))
        };
        let mut controls = div().flex().flex_wrap().items_center().gap(px(10.));
        if p.queue.len() > 1 {
            let (prev, next) = (me.clone(), me.clone());
            let index = p.index;
            controls = controls.child(ui.button("vorige", "Zurück").small().disabled(index == 0).on_click(move |_, app| Self::player_do(&prev, app, move |p| p.start(index.saturating_sub(1)))));
            controls = controls.child(toggle);
            let last = index + 1 >= p.queue.len();
            controls = controls.child(ui.button("naechste", "Weiter").small().disabled(last).on_click(move |_, app| Self::player_do(&next, app, move |p| p.start(index + 1))));
        } else {
            controls = controls.child(toggle);
        }
        controls = controls.child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.prose).child(format!("{} / {}", clock(position), if duration > 0.0 { clock(duration) } else { "—".into() })));
        let rate_button = {
            let me = me.clone();
            let rate = playback.rate();
            ui.button("tempo", format!("Tempo: {}", rate_label(rate))).small().accessible_name(format!("Tempo ändern, jetzt {}", rate_label(rate))).on_click(move |_, app| {
                Self::player_do(&me, app, move |p| {
                    let next = RATES.iter().copied().find(|r| *r > rate + 1e-9).unwrap_or(RATES[0]);
                    p.settings.rate = next;
                    if let Some(pb) = p.playback.as_mut() {
                        let _ = pb.set_rate(next);
                    }
                    p.keep_settings();
                })
            })
        };
        let mute = {
            let me = me.clone();
            let muted = p.settings.muted;
            ui.chip("stumm", "Stumm", muted).on_click(move |_, app| {
                Self::player_do(&me, app, move |p| {
                    p.settings.muted = !muted;
                    if let Some(pb) = p.playback.as_mut() {
                        pb.set_muted(!muted);
                    }
                    p.keep_settings();
                })
            })
        };
        let volume = {
            let me = me.clone();
            ui.slider("lautstaerke", "Lautstärke", p.settings.volume as f32)
                .width(110.)
                .step(0.05)
                .says(format!("{} Prozent", (p.settings.volume * 100.0).round() as i32))
                .on_change(move |v, _, app| {
                    Self::player_do(&me, app, move |p| {
                        p.settings.volume = v as f64;
                        if let Some(pb) = p.playback.as_mut() {
                            pb.set_volume(v);
                        }
                        p.keep_settings();
                    })
                })
        };
        let seek = {
            let me = me.clone();
            ui.slider("zeitleiste", "Stelle im Film", if duration > 0.0 { (position / duration) as f32 } else { 0.0 })
                .step(10.0 / duration.max(10.0) as f32)
                .says(format!("{} von {}", minutes_seconds(position), minutes_seconds(duration)))
                .on_change(move |v, _, app| {
                    Self::player_do(&me, app, move |p| {
                        if let Some(pb) = p.playback.as_mut() {
                            let to = v as f64 * pb.duration().unwrap_or(0.0);
                            let _ = pb.seek(to);
                        }
                    })
                })
        };
        let bottom = div().flex().flex_wrap().items_center().gap(px(14.)).child(rate_button).child(mute).child(volume);
        page = page
            .child(div().flex().items_baseline().justify_between().gap(px(12.)).child(ui.heading("Abspielen")).child({
                let me = me.clone();
                ui.button("andere-datei", "Andere Datei wählen").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_media(cx)))
            }))
            .child(div().child(ui.value(name)))
            .child(stage)
            .child(seek)
            .child(div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(controls).child(bottom));
        page.child(self.player_queue(ui, cx)).into_any_element()
    }

    /// What is queued; a click plays that one.
    fn player_queue(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.player;
        if p.queue.len() < 2 {
            return div().into_any_element();
        }
        let me = cx.entity();
        let c = ui.c;
        let mut rows = div().flex().flex_col();
        for (n, path) in p.queue.iter().enumerate() {
            let me = me.clone();
            let current = n == p.index && p.playback.is_some();
            let label = file_label(path);
            let kind = path.file_name().and_then(|f| player_kind(&f.to_string_lossy(), "")).map_or("", |k| if k == Kind::Video { "Video" } else { "Ton" });
            let says: SharedString = format!("{}{}", kind, if current { " · läuft" } else { "" }).into();
            rows = rows.child(Line {
                colors: c,
                id: format!("liste-{n}").into(),
                name: label.clone().into(),
                says: says.clone(),
                first: n == 0,
                tile: None,
                selected: current,
                body: vec![
                    div().flex_1().min_w(px(0.)).child(ui.value(label)).into_any_element(),
                    div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(says).into_any_element(),
                ],
                on_open: std::rc::Rc::new(move |_, app| Self::player_do(&me, app, move |p| p.start(n))),
            });
        }
        div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Liste"))).child(rows).into_any_element()
    }
}
