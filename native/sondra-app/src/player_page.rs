//! The Abspielen page: a film or a song from a file on this computer, with the picture on a stage, the
//! controls under it and the list of what is queued. What is played, when the picture shows and how the
//! clock runs is `sondra-playback`; what is offered when, what is remembered and how the time reads is
//! `sondra-player` (checked against the website). This file sets it out.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, img, prelude::*, px, AnyElement, App, ClipboardItem, Context, Entity, FocusHandle, ImageSource, ObjectFit, PathPromptOptions, RenderImage, SharedString, Window};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_media::Ffmpeg;
use sondra_player::cues::{cues_at, parse_cues, Cue};
use sondra_player::{chapters_text, clock, mark_name, marks_for, minutes_seconds, neighbour_mark, save_marks, with_mark, Mark, player_kind, rate_label, remember_place, remembered_place, stem_of, Kind, Repeat, Settings, RATES};
use sondra_playback::{Playback, State};
use sondra_ui::{family, size, NoticeKind, Ui};

use crate::lines::Line;
use crate::nav::Panel;
use crate::shell::Shell;
use crate::store::FileStore;

const SETTINGS_KEY: &str = "sondra:abspielen";
const PLACES_KEY: &str = "sondra:abspielen:stellen";
const MARKS_KEY: &str = "sondra:abspielen:marken";

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
    /// The file seen playing short of 90 %: only then does the end of it count. On a switch to the next file
    /// the clock of the old one may still be read for a moment; without this every episode was ticked off the
    /// moment it began.
    armed: Option<String>,
    /// What this file ticked off on the Merkliste, and the entry as it was before.
    pub ticked: Option<Ticked>,
    /// The bookmarks of the file on the stage, in order of time.
    pub marks: Vec<Mark>,
    /// The window with the bookmarks is open.
    pub marks_open: bool,
    pub sleep: Option<Sleep>,
    pub sleep_open: bool,
    /// The film ended on „Ende des Titels“: it stays ended, the next one does not begin.
    stay_ended: bool,
    pub marks_first: FocusHandle,
    pub marks_last: FocusHandle,
}

/// The sleep timer: a moment on the clock, or the end of the title that plays.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Sleep {
    At { until: std::time::Instant, minutes: u32 },
    AtEnd,
}

pub struct Ticked {
    pub key: String,
    pub before: sondra_merk::Item,
    pub undone: bool,
}

impl PlayerState {
    pub fn new(cx: &mut Context<Shell>) -> PlayerState {
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
            armed: None,
            ticked: None,
            marks: Vec::new(),
            marks_open: false,
            sleep: None,
            sleep_open: false,
            stay_ended: false,
            marks_first: cx.focus_handle().tab_stop(true),
            marks_last: cx.focus_handle().tab_stop(true),
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
        self.marks_open = false;
        self.sleep_open = false;
        self.stay_ended = false;
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
                self.load_marks();
            }
            Err(e) => self.error = Some(e.to_string()),
        }
    }

    /// Pause or play; a film that has ended starts again.
    pub fn toggle(&mut self) {
        if let Some(p) = self.playback.as_mut() {
            p.toggle();
        }
    }

    /// A jump of this many seconds from where the film is.
    pub fn skip_by(&mut self, seconds: f64) {
        if let Some(p) = self.playback.as_mut() {
            let to = p.position() + seconds;
            let _ = p.seek(to);
        }
    }

    /// A step of the volume, 0 to 1 (and beyond up to the boost the settings allow later).
    pub fn volume_by(&mut self, step: f64) {
        self.settings.volume = (self.settings.volume + step).clamp(0.0, 1.0);
        self.settings.muted = false;
        let volume = self.settings.volume as f32;
        if let Some(p) = self.playback.as_mut() {
            p.set_muted(false);
            p.set_volume(volume);
        }
        self.keep_settings();
    }

    pub fn toggle_mute(&mut self) {
        self.settings.muted = !self.settings.muted;
        let muted = self.settings.muted;
        if let Some(p) = self.playback.as_mut() {
            p.set_muted(muted);
        }
        self.keep_settings();
    }

    /// A key of the player (Space, the arrows, M); `true` when it was one and has been taken.
    pub fn key(&mut self, key: &str) -> bool {
        if self.playback.is_none() {
            return false;
        }
        let skip = self.settings.skip;
        match key {
            "space" => self.toggle(),
            "left" => self.skip_by(-skip),
            "right" => self.skip_by(skip),
            "up" => self.volume_by(0.05),
            "down" => self.volume_by(-0.05),
            "m" => self.toggle_mute(),
            "b" => self.add_mark(),
            _ => return false,
        }
        true
    }

    fn file_key(&self) -> Option<(String, u64)> {
        let path = self.current_path()?;
        Some((path.file_name()?.to_string_lossy().into_owned(), std::fs::metadata(path).ok()?.len()))
    }

    fn load_marks(&mut self) {
        use sondra_merk::folder_memory::Store;
        self.marks.clear();
        let (Some((name, size)), Some(store)) = (self.file_key(), self.memory.as_ref()) else { return };
        self.marks = marks_for(store.get_item(MARKS_KEY).as_deref(), &name, size);
    }

    fn keep_marks(&mut self) {
        use sondra_merk::folder_memory::Store;
        let Some((name, size)) = self.file_key() else { return };
        let next = self.memory.as_ref().map(|store| save_marks(store.get_item(MARKS_KEY).as_deref(), &name, size, &self.marks));
        if let (Some(next), Some(store)) = (next, self.memory.as_mut()) {
            store.set_item(MARKS_KEY, next);
        }
    }

    /// Starts, changes or ends the sleep timer.
    pub fn set_sleep(&mut self, sleep: Option<Sleep>) {
        self.sleep = sleep;
        // A timer that is switched off must not leave the volume where its fade had put it.
        let volume = self.settings.volume as f32;
        if sleep.is_none() {
            if let Some(p) = self.playback.as_mut() {
                p.set_volume(volume);
            }
        }
    }

    /// A bookmark where the film is, unless one is there already (a second apart is the same place).
    pub fn add_mark(&mut self) {
        let Some(at) = self.playback.as_ref().map(|p| p.position()) else { return };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let luck = format!("{:04x}", now % 0xffff);
        let (marks, _) = with_mark(&self.marks, at, now, &luck);
        self.marks = marks;
        self.keep_marks();
    }

    /// The step to the next or previous bookmark (a step back lands on the one before, not the one just passed).
    pub fn jump_mark(&mut self, forward: bool) {
        let Some(time) = self.playback.as_ref().map(|p| p.position()) else { return };
        if let Some(at) = neighbour_mark(&self.marks, time, forward).map(|m| m.at) {
            if let Some(p) = self.playback.as_mut() {
                let _ = p.seek(at);
            }
        }
    }

    pub fn remove_mark(&mut self, id: &str) {
        self.marks.retain(|m| m.id != id);
        self.keep_marks();
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
        // The sleep timer: the volume goes down over the last ten seconds, then it stops and the volume comes back.
        if let Some(Sleep::At { until, .. }) = self.sleep {
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                playback.pause();
                playback.set_volume(self.settings.volume as f32);
                self.sleep = None;
            } else if left.as_secs_f64() < 10.0 {
                playback.set_volume(self.settings.volume as f32 * sondra_player::sleep_fade(left.as_secs_f64() * 1000.0) as f32);
            }
        }
        let state = if self.sleep.is_none() && state == State::Playing { playback.state() } else { state };
        if state != State::Ended {
            self.stay_ended = false;
        }
        if state == State::Ended && (self.sleep == Some(Sleep::AtEnd) || self.stay_ended) {
            // „Ende des Titels“ stops, instead of going on to the next.
            if self.sleep.take().is_some() {
                self.keep_place(true);
            }
            self.stay_ended = true;
            return false;
        }
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

fn file_label(path: &PathBuf) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}

/// The episode of the Merkliste the file on the stage is, with a key that tells one file and episode from
/// the next.
fn episode_of(state: &PlayerState, items: &[sondra_merk::Item]) -> Option<(sondra_merk::matching::EpisodeMatch, String)> {
    if !state.settings.merkliste {
        return None;
    }
    let name = state.current_path()?.file_name()?.to_string_lossy().into_owned();
    let found = sondra_merk::matching::match_episode(&name, items)?;
    let key = format!("{name}|{}|{}|{}", found.item, found.season, found.episode);
    Some((found, key))
}

impl Shell {
    /// Once a file has run to 90 %, its episode is ticked off on the Merkliste — once per file and episode,
    /// and only for a file seen short of 90 % first.
    pub(crate) fn player_merkliste_tick(&mut self) {
        let Some((found, key)) = episode_of(&self.player, &self.merk.items) else { return };
        let Some(playback) = self.player.playback.as_ref() else { return };
        let duration = playback.duration().unwrap_or(0.0);
        if duration <= 0.0 || self.player.ticked.as_ref().is_some_and(|t| t.key == key) {
            return;
        }
        if playback.position() / duration < sondra_merk::matching::SEEN_AT {
            self.player.armed = Some(key);
            return;
        }
        let Some(item) = self.merk.items.iter().find(|i| i.id == found.item) else { return };
        if self.player.armed.as_deref() != Some(key.as_str()) || sondra_merk::matching::already_seen(item, found.season, found.episode) {
            return;
        }
        if let Some(before) = self.merk.saw_episode(&found.item, found.season, found.episode) {
            self.player.ticked = Some(Ticked { key, before, undone: false });
        }
    }

    /// The line under the picture: which episode the file is and what happened to it on the list.
    fn player_merkliste_line(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (found, key) = episode_of(&self.player, &self.merk.items)?;
        let item = self.merk.items.iter().find(|i| i.id == found.item)?;
        let me = cx.entity();
        let c = ui.c;
        let place = if found.season == 0 { format!("Film {}", found.episode) } else { format!("Staffel {}, Folge {}", found.season, found.episode) };
        let mine = self.player.ticked.as_ref().filter(|t| t.key == key);
        let mut line = div().flex().flex_wrap().items_center().gap(px(10.)).text_size(px(size::SMALL)).text_color(c.prose);
        line = line.child(div().font_weight(gpui::FontWeight::SEMIBOLD).text_color(c.ink).child("Merkliste")).child({
            let (me, id) = (me.clone(), item.id.clone());
            ui.button("serie-oeffnen", item.title.clone()).small().ghost().accessible_name(format!("Serie „{}“ öffnen", item.title)).on_click(move |_, app| {
                let id = id.clone();
                me.update(app, |shell, cx| {
                    shell.merk.open = Some(id);
                    shell.go(Panel::Merkliste, cx);
                })
            })
        });
        line = line.child(format!("· {place}"));
        let mut said = format!("Merkliste · {} · {place}", item.title);
        let line = match mine {
            Some(t) if !t.undone => line.child("— abgehakt.").child({
                let me = me.clone();
                ui.button("abhaken-zurueck", "Rückgängig").small().on_click(move |_, app| {
                    me.update(app, |shell, cx| {
                        if let Some(t) = shell.player.ticked.as_mut() {
                            t.undone = true;
                            let before = t.before.clone();
                            shell.merk.put_back(before);
                        }
                        cx.notify();
                    })
                })
            }),
            Some(_) => line.child("— nicht abgehakt."),
            None if sondra_merk::matching::already_seen(item, found.season, found.episode) => line.child("— schon gesehen."),
            None => line.child(format!("— wird ab {} % abgehakt.", (sondra_merk::matching::SEEN_AT * 100.0).round() as i32)),
        };
        said.push_str(match mine {
            Some(t) if !t.undone => " — abgehakt.",
            Some(_) => " — nicht abgehakt.",
            None if sondra_merk::matching::already_seen(item, found.season, found.episode) => " — schon gesehen.",
            None => " — wird ab 90 % abgehakt.",
        });
        Some(sondra_a11y::accessible("abhaken-zeile", sondra_a11y::Role::Status, line).label(said).live().into_any_element())
    }

    /// Where the film is, when one plays.
    pub fn player_position(&self) -> Option<f64> {
        self.player.playback.as_ref().map(|p| p.position())
    }

    /// For tests: a sleep timer that runs out after this long.
    pub fn player_sleep_in(&mut self, after: std::time::Duration) {
        self.player.set_sleep(Some(Sleep::At { until: std::time::Instant::now() + after, minutes: 1 }));
    }

    /// Jumps to a place in the film that plays.
    pub fn player_seek(&mut self, seconds: f64) {
        if let Some(p) = self.player.playback.as_mut() {
            let _ = p.seek(seconds);
        }
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
        // Over an episode: the opening to skip, and in its credits the next one.
        let opening_len = episode_of(p, &self.merk.items)
            .and_then(|(found, _)| self.merk.items.iter().find(|i| i.id == found.item).and_then(|i| i.opening))
            .map_or(p.settings.opening, |o| o as f64);
        let video = playback.picture_size().is_some();
        let skip_opening = p.settings.skip_opening && video && sondra_player::opening_offered(position, duration, opening_len);
        let has_next = p.index + 1 < p.queue.len();
        let offer_next = p.settings.skip_opening && video && has_next && sondra_player::next_offered(position, duration);
        let stage_height = (width * 9.0 / 16.0).clamp(240.0, 620.0);
        let name = p.current_path().map(file_label).unwrap_or_default();

        // The stage: the picture, and the words of the subtitle over its foot.
        let mut stage = div().relative().w_full().h(px(stage_height)).rounded(px(sondra_ui::radius::CARD)).bg(c.stage).overflow_hidden().flex().items_center().justify_center();
        stage = match (&p.image, playback.picture_size()) {
            (Some(image), Some(_)) => stage.child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Contain).size_full()),
            (None, Some(_)) => stage.child(div().text_color(c.stage_muted).child("Das Bild kommt …")),
            (_, None) => stage.child(div().flex().flex_col().items_center().gap(px(6.)).child(div().text_color(c.stage_ink).text_size(px(size::SUBHEADING)).child(name.clone())).child(div().text_color(c.stage_muted).child("Ton"))),
        };
        if skip_opening || offer_next {
            let mut offers = div().absolute().right(px(16.)).top(px(16.)).flex().flex_col().items_end().gap(px(8.));
            if skip_opening {
                let me = me.clone();
                offers = offers.child(ui.button("vorspann-ueberspringen", "Vorspann überspringen").small().on_click(move |_, app| {
                    Self::player_do(&me, app, move |p| p.skip_by(opening_len))
                }));
            }
            if offer_next {
                let me = me.clone();
                let next = p.index + 1;
                offers = offers.child(ui.button("naechste-folge", "Nächste Folge").small().primary().on_click(move |_, app| Self::player_do(&me, app, move |p| p.start(next))));
            }
            stage = stage.child(offers);
        }
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
            ui.button("abspielen-pause", if playing { "Pause" } else { "Abspielen" }).accessible_name(if playing { "Pause" } else { "Wiedergabe starten" }).primary().on_click(move |_, app| Self::player_do(&me, app, |p| if let Some(pb) = p.playback.as_mut() { pb.toggle() }))
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
        let marks_button = {
            let me = me.clone();
            let n = p.marks.len();
            ui.button("lesezeichen", if n == 0 { "Lesezeichen".to_string() } else { format!("Lesezeichen ({n})") }).small().on_click(move |_, app| Self::player_do(&me, app, |p| p.marks_open = true))
        };
        let sleep_button = {
            let me = me.clone();
            let label = match p.sleep {
                Some(Sleep::At { minutes, .. }) => format!("Schlaf-Timer ({minutes} Min.)"),
                Some(Sleep::AtEnd) => "Schlaf-Timer (Ende des Titels)".to_string(),
                None => "Schlaf-Timer".to_string(),
            };
            ui.button("schlaf-timer", label).small().on_click(move |_, app| Self::player_do(&me, app, |p| p.sleep_open = true))
        };
        let bottom = div().flex().flex_wrap().items_center().gap(px(14.)).child(rate_button).child(marks_button).child(sleep_button).child(mute).child(volume);
        page = page
            .child(div().flex().items_baseline().justify_between().gap(px(12.)).child(ui.heading("Abspielen")).child({
                let me = me.clone();
                ui.button("andere-datei", "Andere Datei wählen").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_media(cx)))
            }))
            .child(div().child(ui.value(name)))
            .child(stage)
            .children(self.player_merkliste_line(ui, cx))
            .child(seek)
            .child(div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(controls).child(bottom));
        page.child(self.player_queue(ui, cx)).into_any_element()
    }

    /// The window with the bookmarks of the file: each jumps there, can go, and all of them can be copied as
    /// chapters for a description.
    pub(crate) fn player_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = &self.player;
        if p.sleep_open {
            let me = cx.entity();
            let mut options = div().flex().flex_wrap().gap(px(8.));
            let mut choices: Vec<(String, Option<Sleep>, bool)> = sondra_player::SLEEPS
                .iter()
                .map(|m| (format!("{m} Minuten"), Some(Sleep::At { until: std::time::Instant::now() + std::time::Duration::from_secs(*m as u64 * 60), minutes: *m as u32 }), matches!(p.sleep, Some(Sleep::At { minutes, .. }) if minutes as i64 == *m)))
                .collect();
            choices.push(("Ende des Titels".to_string(), Some(Sleep::AtEnd), p.sleep == Some(Sleep::AtEnd)));
            choices.push(("Aus".to_string(), None, p.sleep.is_none()));
            for (n, (label, sleep, on)) in choices.into_iter().enumerate() {
                let me = me.clone();
                let mut chip = ui.chip(format!("schlaf-{n}"), label, on);
                chip = chip.on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.set_sleep(sleep);
                    p.sleep_open = false;
                }));
                options = options.child(chip);
            }
            let close = me.clone();
            return Some(
                ui.dialog("schlaf-timer-fenster", "Schlaf-Timer")
                    .width(520.)
                    .child(ui.prose("Der Ton wird in den letzten zehn Sekunden leiser, dann hält die Wiedergabe an."))
                    .child(options)
                    .action(ui.button("schlaf-schliessen", "Schliessen").primary().on_click(move |_, app| Self::player_do(&close, app, |p| p.sleep_open = false)))
                    .on_close(move |_, app| Self::player_do(&me, app, |p| p.sleep_open = false))
                    .into_any_element(),
            );
        }
        if !p.marks_open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut list = div().flex().flex_col().max_h(px(280.));
        if p.marks.is_empty() {
            list = list.child(ui.prose("Noch keine Lesezeichen. Mit B setzen Sie eines dort, wo der Film gerade ist."));
        }
        for (n, mark) in p.marks.iter().enumerate() {
            let (go, away) = (me.clone(), me.clone());
            let (id, at) = (mark.id.clone(), mark.at);
            let name = mark_name(&p.marks, n);
            let says = format!("{} · {}", clock(mark.at), name);
            list = list.child(Line {
                colors: c,
                id: format!("marke-{n}").into(),
                name: name.clone().into(),
                says: says.clone().into(),
                first: n == 0,
                tile: None,
                selected: false,
                body: vec![
                    div().flex_1().min_w(px(0.)).child(ui.value(says)).into_any_element(),
                    ui.button(format!("marke-weg-{n}"), "Entfernen").small().accessible_name(format!("{name} entfernen")).on_click(move |_, app| {
                        let id = id.clone();
                        Self::player_do(&away, app, move |p| p.remove_mark(&id))
                    }).into_any_element(),
                ],
                on_open: std::rc::Rc::new(move |_, app| {
                    Self::player_do(&go, app, move |p| {
                        if let Some(pb) = p.playback.as_mut() {
                            let _ = pb.seek(at);
                        }
                        p.marks_open = false;
                    })
                }),
            });
        }
        let marks = p.marks.clone();
        let copy_me = me.clone();
        let close_me = me.clone();
        let (first, last) = (p.marks_first.clone(), p.marks_last.clone());
        Some(
            ui.dialog("lesezeichen-fenster", "Lesezeichen")
                .width(560.)
                .child(list)
                .action(
                    ui.button("kapitel-kopieren", "Als Kapitel kopieren")
                        .primary()
                        .focus_handle(first.clone())
                        .on_click(move |_, app| {
                            app.write_to_clipboard(ClipboardItem::new_string(chapters_text(&marks)));
                            let _ = &copy_me;
                        }),
                )
                .action(ui.button("lesezeichen-schliessen", "Schliessen").focus_handle(last.clone()).on_click(move |_, app| Self::player_do(&close_me, app, |p| p.marks_open = false)))
                .keeps_focus_between(first, last)
                .on_close(move |_, app| Self::player_do(&me, app, |p| p.marks_open = false))
                .into_any_element(),
        )
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
