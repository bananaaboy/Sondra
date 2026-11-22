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
/// The same key the web player keeps „Beim Minimieren pausieren“ under.
const MINIMIZE_KEY: &str = "sondra:pausieren-beim-minimieren";
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
    /// The tallest picture chosen for this film; the next film is as it is again.
    pub quality: Option<u32>,
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
    /// The window with the sound tracks, subtitles and their looks.
    pub tracks_open: bool,
    /// The window with the picture and the sound.
    pub look_open: bool,
    /// „Schleife A–B“: where it starts and, once set, where it goes back.
    pub loop_a: Option<f64>,
    pub loop_b: Option<f64>,
    /// How big the picture is: beside the list, wide, over the whole window, or over the whole screen.
    pub size: PlayerSize,
    /// „Beim Minimieren pausieren“: off until the person turns it on (kept on this device).
    pub pause_on_minimize: bool,
    /// When the window was asked to take the whole screen (`None`: it was not).
    pub screen: Option<std::time::Instant>,
    /// „Immer im Vordergrund“: the window stays above the others (the person's wish) and whether the system was told.
    pub pinned: bool,
    /// The little window of „Bild im Bild“ takes the pictures; the pictures it replaced are let go of in the main
    /// window as well, which drew them too.
    pub elsewhere: bool,
    pub retired: Vec<Arc<RenderImage>>,
    pub pin_told: bool,
    /// When the mouse or a key last asked for the controls.
    pub activity: std::time::Instant,
    track: usize,
    /// The subtitles of a file beside the film, and which source is shown.
    pub(crate) external_cues: Vec<Cue>,
    /// The name of a subtitle file chosen by hand.
    pub subtitle_name: Option<String>,
    /// The clock shows what is left, not what has run (a click on it).
    pub show_remaining: bool,
    /// What „Als Cover festlegen“ said.
    pub cover_said: Option<String>,
    /// The opening found by its sound in the file that plays, and for which file that was asked.
    pub intro_here: crate::player_intro::IntroHere,
    pub intro_file: Option<PathBuf>,
    /// „Vorspann erkennen“ at work, and what it said last.
    pub intro_step: Option<String>,
    pub intro_note: Option<String>,
    /// „Für diese Folge ausblenden“: the file whose opening button is hidden.
    pub intro_dismissed: Option<PathBuf>,
    /// The chapters the file carries.
    pub chapters: Vec<sondra_media::ffmpeg::Chapter>,
    pub subtitle: Subtitle,
    pub subtitle_error: Option<String>,
    /// The film ended on „Ende des Titels“: it stays ended, the next one does not begin.
    stay_ended: bool,
    pub marks_first: FocusHandle,
    pub marks_last: FocusHandle,
}

/// The four sizes of the picture. `Fill` is the window (Esc goes back), `Full` the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerSize {
    Normal,
    /// The cinema mode: the picture over the whole width of the page, the list out of the way.
    Kino,
    Fill,
    Full,
}

impl PlayerSize {
    /// The picture is all there is and the controls lie over it.
    pub fn immersive(self) -> bool {
        matches!(self, PlayerSize::Fill | PlayerSize::Full)
    }
}

/// How long the controls stay over a playing picture after the last touch of the mouse or a key.
pub const CONTROLS_SHOWN: std::time::Duration = std::time::Duration::from_secs(4);

/// The picture settings the playback understands.
/// The equalizer a settings value asks for.
fn equalizer_of(s: &sondra_player::Settings) -> sondra_playback::Equalizer {
    sondra_playback::Equalizer { on: s.eq_enabled, gains: [s.eq_band1, s.eq_band2, s.eq_band3, s.eq_band4, s.eq_band5] }
}

fn picture_of(settings: &sondra_player::Settings) -> sondra_playback::Picture {
    sondra_playback::Picture { brightness: settings.brightness, contrast: settings.contrast, saturation: settings.saturation, mirror: settings.mirror }
}

/// Where the words on the stage come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subtitle {
    Off,
    /// The file beside the film.
    File,
    /// A subtitle stream inside the film, by its number.
    Inside(u32),
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
            quality: None,
            memory: None,
            cues: Vec::new(),
            saved_at: None,
            armed: None,
            ticked: None,
            marks: Vec::new(),
            marks_open: false,
            sleep: None,
            sleep_open: false,
            tracks_open: false,
            look_open: false,
            loop_a: None,
            loop_b: None,
            size: PlayerSize::Normal,
            pause_on_minimize: false,
            screen: None,
            pinned: false,
            elsewhere: false,
            retired: Vec::new(),
            pin_told: false,
            activity: std::time::Instant::now(),
            track: 0,
            external_cues: Vec::new(),
            subtitle_name: None,
            show_remaining: false,
            cover_said: None,
            intro_here: crate::player_intro::IntroHere::Unknown,
            intro_file: None,
            intro_step: None,
            intro_note: None,
            intro_dismissed: None,
            chapters: Vec::new(),
            subtitle: Subtitle::Off,
            subtitle_error: None,
            stay_ended: false,
            marks_first: cx.focus_handle().tab_stop(true),
            marks_last: cx.focus_handle().tab_stop(true),
        }
    }

    /// Takes the settings and places the page remembered.
    pub fn remember_from(&mut self, store: FileStore) {
        use sondra_merk::folder_memory::Store;
        self.settings = Settings::from_json(store.get_item(SETTINGS_KEY).as_deref());
        self.pause_on_minimize = store.get_item(MINIMIZE_KEY).as_deref() == Some("true");
        self.memory = Some(store);
    }

    fn keep_settings(&mut self) {
        use sondra_merk::folder_memory::Store;
        let json = self.settings.to_json();
        if let Some(store) = self.memory.as_mut() {
            store.set_item(SETTINGS_KEY, json);
        }
    }

    pub(crate) fn current_path(&self) -> Option<&PathBuf> {
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
        self.external_cues.clear();
        self.subtitle_name = None;
        self.cover_said = None;
        self.chapters.clear();
        self.subtitle = Subtitle::Off;
        self.subtitle_error = None;
        self.tracks_open = false;
        self.look_open = false;
        self.loop_a = None;
        self.loop_b = None;
        self.track = 0;
        self.quality = None;
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
                playback.set_boost(self.settings.boost as f32);
                let _ = playback.set_night(self.settings.night);
                let _ = playback.set_karaoke(self.settings.karaoke);
                let _ = playback.set_equalizer(equalizer_of(&self.settings));
                let _ = playback.set_picture(picture_of(&self.settings));
                self.playback = Some(playback);
                self.load_subtitles(&path);
                self.load_marks();
                self.chapters = Ffmpeg::locate().map(|ff| ff.chapters(&path)).unwrap_or_default();
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

    /// „C“: subtitles off, or back on (the file beside the film first).
    pub fn toggle_captions(&mut self) {
        if self.subtitle == Subtitle::Off {
            if !self.external_cues.is_empty() {
                self.choose_subtitle(Subtitle::File);
            }
        } else {
            self.choose_subtitle(Subtitle::Off);
        }
    }

    /// One frame back or on, while paused (a 25th of a second).
    pub fn frame_step(&mut self, forward: bool) {
        if let Some(p) = self.playback.as_mut() {
            if p.state() == State::Playing {
                return;
            }
            let to = (p.position() + if forward { 0.04 } else { -0.04 }).max(0.0);
            let _ = p.seek(to);
        }
    }

    /// The next speed up or down (`RATES`).
    pub fn rate_step(&mut self, up: bool) {
        let now = self.settings.rate;
        let next = if up { RATES.iter().copied().find(|r| *r > now + 1e-9) } else { RATES.iter().rev().copied().find(|r| *r < now - 1e-9) };
        if let Some(rate) = next {
            self.settings.rate = rate;
            if let Some(p) = self.playback.as_mut() {
                let _ = p.set_rate(rate);
            }
            self.keep_settings();
        }
    }

    /// „Schleife A–B“: the first press sets A, the second B (and the film runs between them), the third ends it.
    pub fn loop_mark(&mut self) {
        let Some(at) = self.playback.as_ref().map(|p| p.position()) else { return };
        match (self.loop_a, self.loop_b) {
            (None, _) => self.loop_a = Some(at),
            (Some(a), None) if at > a + 0.5 => self.loop_b = Some(at),
            (Some(_), None) => self.loop_a = Some(at),
            (Some(_), Some(_)) => {
                self.loop_a = None;
                self.loop_b = None;
            }
        }
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
            // As on the website: J and L ten seconds, N and P the next and previous file, S the opening, C the
            // subtitles, 0–9 to a tenth of the film, „,“ and „.“ a frame when paused, „<“ and „>“ the speed.
            "j" => self.skip_by(-10.0),
            "l" => self.skip_by(10.0),
            "n" if self.index + 1 < self.queue.len() => self.start(self.index + 1),
            "p" if self.index > 0 => self.start(self.index - 1),
            "s" => self.skip_by(self.settings.opening),
            "c" => self.toggle_captions(),
            "," => self.frame_step(false),
            "." => self.frame_step(true),
            "<" => self.rate_step(false),
            ">" => self.rate_step(true),
            digit if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() => {
                let tenth = f64::from(digit.as_bytes()[0] - b'0') / 10.0;
                if let Some(p) = self.playback.as_mut() {
                    let to = p.duration().unwrap_or(0.0) * tenth;
                    let _ = p.seek(to);
                }
            }
            "t" => self.size = if self.size == PlayerSize::Kino { PlayerSize::Normal } else { PlayerSize::Kino },
            "w" => self.size = if self.size == PlayerSize::Fill { PlayerSize::Normal } else { PlayerSize::Fill },
            "f" => self.size = if self.size == PlayerSize::Full { PlayerSize::Normal } else { PlayerSize::Full },
            "escape" if self.size.immersive() && !(self.marks_open || self.sleep_open || self.tracks_open || self.look_open) => self.size = PlayerSize::Normal,
            _ => return false,
        }
        self.activity = std::time::Instant::now();
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

    /// A minimised window stops what plays, once; it does not begin again by itself when the window returns.
    pub fn pause_for_minimized(&mut self, minimized: bool) {
        if !(minimized && self.pause_on_minimize) {
            return;
        }
        if let Some(p) = self.playback.as_mut() {
            if p.state() == State::Playing {
                p.pause();
            }
        }
    }

    /// Puts the picture and sound settings onto what plays.
    fn apply_look(&mut self) {
        let (boost, night, karaoke, picture, eq) = (self.settings.boost as f32, self.settings.night, self.settings.karaoke, picture_of(&self.settings), equalizer_of(&self.settings));
        if let Some(p) = self.playback.as_mut() {
            p.set_boost(boost);
            let _ = p.set_night(night);
            let _ = p.set_karaoke(karaoke);
            let _ = p.set_equalizer(eq);
            let _ = p.set_picture(picture);
        }
        self.keep_settings();
    }

    /// Chooses where the subtitles come from; one inside the film is read out of it (FFmpeg hands it over as
    /// SubRip, a few kilobytes) and shown.
    pub fn choose_subtitle(&mut self, choice: Subtitle) {
        self.subtitle_error = None;
        match choice {
            Subtitle::Off => self.cues.clear(),
            Subtitle::File => self.cues = self.external_cues.clone(),
            Subtitle::Inside(index) => {
                let (Some(path), Some(ffmpeg)) = (self.current_path().cloned(), Ffmpeg::locate()) else { return };
                let out = std::process::Command::new(ffmpeg.program())
                    .args(["-v", "error", "-nostdin", "-i"])
                    .arg(&path)
                    .args(["-map", &format!("0:{index}"), "-f", "srt", "-"])
                    .stdin(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .output();
                match out {
                    Ok(out) if out.status.success() => {
                        self.cues = parse_cues(&String::from_utf8_lossy(&out.stdout));
                        if self.cues.is_empty() {
                            self.subtitle_error = Some("In diesem Untertitel steht kein Text, den Sondra anzeigen kann (Bild-Untertitel zeigt Sondra noch nicht).".into());
                        }
                    }
                    _ => {
                        self.cues.clear();
                        self.subtitle_error = Some("Der Untertitel liess sich nicht aus dem Film lesen.".into());
                    }
                }
            }
        }
        self.subtitle = choice;
    }

    /// Plays another sound track from where the film is now.
    pub fn choose_track(&mut self, track: usize) {
        if let Some(p) = self.playback.as_mut() {
            let _ = p.set_audio_track(track);
            self.track = track;
        }
    }

    /// The sound track that plays, by its place in the list.
    pub fn settings_track(&self) -> usize {
        self.track
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
                self.external_cues = parse_cues(&String::from_utf8_lossy(&bytes));
                self.cues = self.external_cues.clone();
                self.subtitle = Subtitle::File;
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
                        if self.elsewhere {
                            self.retired.push(old.clone());
                        }
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        let state = playback.state();
        // „Schleife A–B“: past B, back to A.
        if let (Some(a), Some(b)) = (self.loop_a, self.loop_b) {
            if state == State::Playing && playback.position() >= b {
                let _ = playback.seek(a);
            }
        }
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
    /// For tests: the names of the files in the list.
    pub fn player_queue_names(&self) -> Vec<String> {
        self.player.queue.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect()
    }

    pub fn player_position(&self) -> Option<f64> {
        self.player.playback.as_ref().map(|p| p.position())
    }

    /// For tests: a sleep timer that runs out after this long.
    pub fn player_sleep_in(&mut self, after: std::time::Duration) {
        self.player.set_sleep(Some(Sleep::At { until: std::time::Instant::now() + after, minutes: 1 }));
    }

    /// For tests: the window is taken to be minimised.
    pub fn player_minimized(&mut self, minimized: bool) {
        self.player.pause_for_minimized(minimized);
    }

    /// What plays now (the file's name), when something plays.
    pub fn player_playing_name(&self) -> Option<String> {
        let p = &self.player;
        let playback = p.playback.as_ref()?;
        (playback.state() == State::Playing).then(|| p.current_path().map(file_label).unwrap_or_default())
    }

    /// A choice kept on this device (the player's small store).
    pub fn player_setting(&self, key: &str) -> Option<String> {
        use sondra_merk::folder_memory::Store;
        self.player.memory.as_ref().and_then(|s| s.get_item(key))
    }

    pub fn player_set_setting(&mut self, key: &str, value: &str) {
        use sondra_merk::folder_memory::Store;
        if let Some(s) = self.player.memory.as_mut() {
            s.set_item(key, value.to_string());
        }
    }

    /// For tests: the size the picture has.
    pub fn player_size(&self) -> PlayerSize {
        self.player.size
    }

    /// For tests: as if the mouse and the keys had been quiet for this long.
    pub fn player_quiet_for(&mut self, quiet: std::time::Duration) {
        self.player.activity = std::time::Instant::now() - quiet;
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

    /// The small bar that tells a film goes on behind another tool: its name and place, pause, and the way back.
    /// Over the page's foot, from the lower edge; the one shadow of the design belongs to it, as to a popover.
    pub(crate) fn player_mini(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = &self.player;
        let playback = p.playback.as_ref()?;
        let c = ui.c;
        let me = cx.entity();
        let playing = playback.state() == State::Playing;
        let name = p.current_path().map(file_label).unwrap_or_default();
        let (position, duration) = (playback.position(), playback.duration().unwrap_or(0.0));
        let toggle = {
            let me = me.clone();
            ui.button("mini-pause", if playing { "Pause" } else { "Abspielen" }).accessible_name(if playing { "Pause" } else { "Wiedergabe starten" }).small().primary().on_click(move |_, app| Self::player_do(&me, app, |p| if let Some(pb) = p.playback.as_mut() { pb.toggle() }))
        };
        let back = {
            let me = me.clone();
            ui.button("mini-zurueck", "Zum Player").small().on_click(move |_, app| me.update(app, |shell, cx| shell.go(Panel::Player, cx)))
        };
        let bar = div()
            .absolute()
            .bottom(px(16.))
            .right(px(16.))
            .max_w(px(460.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .rounded(px(sondra_ui::radius::CARD))
            .bg(c.raised)
            .border_1()
            .border_color(c.line)
            .shadow(vec![gpui::BoxShadow { color: gpui::hsla(0., 0., 0., 0.2), offset: gpui::point(px(0.), px(8.)), blur_radius: px(24.), spread_radius: px(0.) }])
            .child(div().flex().items_baseline().justify_between().gap(px(12.)).child(div().truncate().child(ui.value(name))).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).child(format!("{} / {}", clock(position), if duration > 0.0 { clock(duration) } else { "—".into() }))))
            .child(ui.bar("mini-stelle", if duration > 0.0 { Some((position / duration) as f32) } else { None }, "Stelle im Film"))
            .child(div().flex().gap(px(8.)).child(toggle).child(back));
        Some(sondra_ui::motion::enter_floating(bar, "mini-leiste", (0.0, 16.0), std::time::Duration::ZERO, sondra_ui::motion::BASE))
    }

    /// Keeps the window's screen mode and the player's size in step. The player says what it wants
    /// (`PlayerSize::Full`); the window is asked once, and a window that left the screen mode on its own
    /// (the system's own key) takes the size back with it. The asking is not answered at once, so for a
    /// moment after it a window that is not yet full is not taken as having left.
    pub(crate) fn sync_fullscreen(&mut self, window: &mut Window) {
        let wants = self.player.size == PlayerSize::Full;
        match (wants, self.player.screen) {
            (true, None) => {
                if !window.is_fullscreen() {
                    window.toggle_fullscreen();
                }
                self.player.screen = Some(std::time::Instant::now());
            }
            (true, Some(since)) => {
                if !window.is_fullscreen() && since.elapsed() > std::time::Duration::from_millis(1500) {
                    self.player.size = PlayerSize::Normal;
                    self.player.screen = None;
                }
            }
            (false, Some(_)) => {
                if window.is_fullscreen() {
                    window.toggle_fullscreen();
                }
                self.player.screen = None;
            }
            (false, None) => {}
        }
    }

    /// The window stays above the others while the person wants it (a film in a corner, work beside it); told to
    /// the system only when that changes.
    pub(crate) fn sync_pinned(&mut self, window: &Window) {
        if self.player.pinned != self.player.pin_told {
            crate::system::set_always_on_top(window, self.player.pinned);
            self.player.pin_told = self.player.pinned;
        }
    }

    /// For tests: whether the window is to stay above the others.
    pub fn player_pinned(&self) -> bool {
        self.player.pinned
    }

    /// The page: the stage, the controls and the list.
    pub(crate) fn player_page(&self, ui: Ui, width: f32, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let p = &self.player;
        let mut page = div().flex().flex_col().gap(px(20.));
        if let Some(error) = &p.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let Some(playback) = &p.playback else {
            let me2 = me.clone();
            let c = ui.c;
            let mut ways = div().flex().flex_wrap().items_center().gap(px(10.));
            ways = ways.child(ui.button("medien-waehlen", "Dateien auswählen").primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.choose_media(cx))));
            let mut formats = div().flex().flex_wrap().gap(px(6.));
            for f in ["MP4", "MKV", "AVI", "MOV", "WEBM", "MP3", "FLAC", "WAV"] {
                formats = formats.child(div().px(px(10.)).py(px(3.)).rounded(px(sondra_ui::radius::PILL)).bg(c.panel_mid).font_family(sondra_ui::family::VALUE).text_size(px(sondra_ui::size::MICRO)).text_color(c.prose).child(f));
            }
            // What the player does, in three short blocks — each true of this program.
            let mut facts = div().flex().flex_wrap().gap(px(12.));
            for (title, text) in [
                ("Direkt von der Platte", "Kein Kopieren, kein Hochladen: auch riesige 4K-Filme und Mehrkanal-Ton beginnen sofort."),
                ("Untertitel von selbst", "Eine .srt- oder .vtt-Datei mit gleichem Namen im selben Ordner kommt mit; Spuren im Film lassen sich wählen."),
                ("Klang und Tempo", "Entzerrer mit Voreinstellungen, Nachtmodus, Karaoke, Tempo von 0,25× bis 3×, Lesezeichen und Schlaf-Timer."),
            ] {
                facts = facts.child(div().w(px(260.)).flex().flex_col().gap(px(4.)).p(px(14.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).child(ui.title(title)).child(div().w(px(232.)).child(ui.hint(text))));
            }
            return page
                .child(ui.page_head("Abspielen", "Filme und Musik von diesem Computer. Sondra spielt sie direkt von der Platte, ohne sie zu kopieren, und merkt sich, wo Sie aufgehört haben."))
                .child(ui.empty(
                    "abspielen-leer",
                    "Video oder Musik hierher ziehen",
                    "Mehrere Dateien werden zu einer Wiedergabeliste. Eine Untertitel-Datei mit gleichem Namen kommt von selbst mit.",
                    vec![formats.into_any_element(), ways.into_any_element()],
                ))
                .child(facts)
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
        // An opening found by its sound wins over the fixed length: offered while it plays, a jump to its end.
        let found = match p.intro_here {
            crate::player_intro::IntroHere::Found { start, end } => Some((start, end)),
            _ => None,
        };
        let finding = p.intro_here == crate::player_intro::IntroHere::Finding;
        let dismissed = p.intro_dismissed.is_some() && p.intro_dismissed.as_ref() == p.current_path();
        let skip_opening = p.settings.skip_opening && video && !dismissed && !finding && match found {
            Some((start, end)) => position >= start && position < end - 0.5,
            None => sondra_player::opening_offered(position, duration, opening_len),
        };
        let skip_to = found.map(|(_, end)| end);
        let has_next = p.index + 1 < p.queue.len();
        let offer_next = p.settings.skip_opening && video && has_next && sondra_player::next_offered(position, duration);
        let immersive = p.size.immersive();
        let stage_height = match p.size {
            PlayerSize::Kino => (height - 240.0).clamp(320.0, 900.0),
            _ => (width * 9.0 / 16.0).clamp(240.0, 620.0),
        };
        let name = p.current_path().map(file_label).unwrap_or_default();

        // The stage: the picture, and the words of the subtitle over its foot.
        let mut stage = div().id("buehne").relative().w_full().bg(c.stage).overflow_hidden().flex().items_center().justify_center();
        stage = if immersive { stage.size_full() } else { stage.h(px(stage_height)).rounded(px(sondra_ui::radius::CARD)) };
        stage = stage.on_mouse_move({
            let me = me.clone();
            move |_, _, app| me.update(app, |shell, cx| {
                shell.player.activity = std::time::Instant::now();
                cx.notify();
            })
        });
        stage = match (&p.image, playback.picture_size()) {
            (Some(image), Some(_)) => stage.child(img(ImageSource::Render(image.clone())).object_fit(match p.settings.fit { sondra_player::Fit::Contain => ObjectFit::Contain, sondra_player::Fit::Cover => ObjectFit::Cover, sondra_player::Fit::Fill => ObjectFit::Fill }).size_full()),
            (None, Some(_)) => stage.child(div().text_color(c.stage_muted).child("Das Bild kommt …")),
            (_, None) => {
                // A song: the visualizer behind its name, when it is switched on.
                let mut stage = stage;
                if p.settings.visualizer {
                    // A click on it goes on to the next look: bars, wave, ring.
                    let me = me.clone();
                    let next = match p.settings.visualizer_mode {
                        sondra_player::VisualizerMode::Bars => sondra_player::VisualizerMode::Wave,
                        sondra_player::VisualizerMode::Wave => sondra_player::VisualizerMode::Radial,
                        sondra_player::VisualizerMode::Radial => sondra_player::VisualizerMode::Bars,
                    };
                    stage = stage.child(crate::visualizer::visualizer(p.settings.visualizer_mode, playback.spectrum(), playing, c.stage_accent, c.stage_line)).child(
                        sondra_a11y::accessible(
                            "visualizer-wechseln",
                            sondra_a11y::Role::Button,
                            div().id("visualizer-wechseln").absolute().top_0().left_0().size_full().cursor_pointer().on_click({
                                let me = me.clone();
                                move |_, _, app| Self::player_do(&me, app, move |p| {
                                    p.settings.visualizer_mode = next;
                                    p.keep_settings();
                                })
                            }),
                        )
                        .label("Visualizer: nächste Darstellung")
                        .on_activate(move |_, app| Self::player_do(&me, app, move |p| {
                            p.settings.visualizer_mode = next;
                            p.keep_settings();
                        })),
                    );
                }
                stage.child(div().flex().flex_col().items_center().gap(px(6.)).child(div().text_color(c.stage_ink).text_size(px(size::SUBHEADING)).child(name.clone())).child(div().text_color(c.stage_muted).child("Ton")))
            }
        };
        // The changeover cue of a projection booth: in the last two seconds before „Nächste Folge“ is offered, a
        // ring in the picture's upper right corner flashes twice — the reel is about to end. It is gone the
        // moment the button comes. (The eight seconds ahead only bound the search for when the offer comes.)
        let cue_lead = 8.0;
        let cue = p.settings.skip_opening && video && has_next && !offer_next && duration > 0.0
            && sondra_player::next_offered(position + cue_lead, duration);
        if cue {
            let left = (0..=(cue_lead * 10.0) as i32).map(|step| step as f64 / 10.0).find(|ahead| sondra_player::next_offered(position + ahead, duration)).unwrap_or(cue_lead);
            // Two pulses of half a second, in the last two seconds before the offer.
            let lit = left <= 2.0 && (left * 2.0).floor() as i64 % 2 == 1;
            if lit {
                stage = stage.child(
                    div().absolute().right(px(20.)).top(px(18.)).size(px(18.)).rounded(px(sondra_ui::radius::PILL)).border_2().border_color(c.stage_accent).bg(gpui::Rgba { a: 0.4, ..c.stage_accent }),
                );
            }
        }
        if skip_opening || offer_next {
            let mut offers = div().absolute().right(px(16.)).top(px(16.)).flex().flex_col().items_end().gap(px(8.));
            if skip_opening {
                let me = me.clone();
                let left = skip_to.map_or(opening_len, |end| (end - position).max(0.0));
                let hide = me.clone();
                offers = offers.child(
                    div()
                        .flex()
                        .gap(px(4.))
                        .child(ui.button("vorspann-ueberspringen", format!("Vorspann überspringen · {}", sondra_player::clock(left))).small().accessible_name("Vorspann überspringen").on_click(move |_, app| {
                            Self::player_do(&me, app, move |p| match skip_to {
                                Some(end) => {
                                    if let Some(pb) = p.playback.as_mut() {
                                        let _ = pb.seek(end);
                                    }
                                }
                                None => p.skip_by(opening_len),
                            })
                        }))
                        .child(ui.button("vorspann-ausblenden", "×").small().ghost().accessible_name("Vorspann-Button für diese Folge ausblenden").on_click(move |_, app| {
                            Self::player_do(&hide, app, |p| p.intro_dismissed = p.current_path().cloned())
                        })),
                );
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
        {
            let me = me.clone();
            let remaining = p.show_remaining;
            controls = controls.child(ui.button("zeit", p.time_text(position, duration)).small().ghost().accessible_name(if remaining { "Restzeit — umschalten auf Laufzeit" } else { "Laufzeit — umschalten auf Restzeit" }).on_click(move |_, app| Self::player_do(&me, app, move |p| p.show_remaining = !remaining)));
        }
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
        // The chapters of the file: a tick on the bar where each begins, the one that plays named beside the clock.
        let seek = if p.chapters.len() > 1 && duration > 0.0 {
            let mut over = div().relative().flex_1().child(seek);
            for chapter in p.chapters.iter().skip(1) {
                over = over.child(div().absolute().top(px(2.)).bottom(px(2.)).w(px(2.)).left(gpui::relative((chapter.start / duration).clamp(0.0, 1.0) as f32)).bg(c.stage_accent));
            }
            over.into_any_element()
        } else {
            seek.into_any_element()
        };
        let chapter_now = p.chapters.iter().rev().find(|ch| position >= ch.start).filter(|_| p.chapters.len() > 1).map(|ch| ch.title.clone());
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
        let tracks_button = {
            let me = me.clone();
            ui.button("ton-untertitel", "Ton und Untertitel").small().on_click(move |_, app| Self::player_do(&me, app, |p| p.tracks_open = true))
        };
        let look_button = {
            let me = me.clone();
            ui.button("bild-ton", "Bild und Ton").small().on_click(move |_, app| Self::player_do(&me, app, |p| p.look_open = true))
        };
        let sizes = {
            let mut row = div().flex().gap(px(6.));
            for (size, id, label, name) in [
                (PlayerSize::Kino, "kino", "Kino", "Kinomodus (T)"),
                (PlayerSize::Fill, "fenster-fuellen", "Fenster füllen", "Bild über das ganze Fenster (W)"),
                (PlayerSize::Full, "vollbild", "Vollbild", "Vollbild (F)"),
            ] {
                let me = me.clone();
                let on = p.size == size;
                row = row.child(ui.chip(id, label, on).accessible_name(name).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.size = if on { PlayerSize::Normal } else { size };
                    p.activity = std::time::Instant::now();
                })));
            }
            row
        };
        let pin = {
            let me = me.clone();
            let on = p.pinned;
            ui.chip("immer-oben", "Immer im Vordergrund", on).accessible_name(if on { "Immer im Vordergrund beenden" } else { "Immer im Vordergrund" }).on_click(move |_, app| Self::player_do(&me, app, move |p| p.pinned = !on))
        };
        let pip = {
            let me = me.clone();
            let on = self.pip_open();
            ui.chip("bild-im-bild", "Bild im Bild", on).accessible_name(if on { "Bild im Bild beenden" } else { "Bild im Bild" }).on_click(move |_, app| me.update(app, |shell, cx| shell.pip_switch(cx)))
        };
        let mut bottom = div().flex().flex_wrap().items_center().gap(px(14.)).child(rate_button).child(tracks_button).child(look_button).child(marks_button).child(sleep_button).child(sizes).child(pin).child(pip).child(mute).child(volume);
        {
            let is_video = p.current_path().and_then(|f| f.file_name()).and_then(|f| player_kind(&f.to_string_lossy(), "")) == Some(Kind::Video);
            let (sound, film) = (me.clone(), me.clone());
            bottom = bottom.child(ui.button("im-ton-editor", "Im Ton-Editor öffnen").small().ghost().on_click(move |_, app| sound.update(app, |shell, cx| shell.player_open_in(crate::nav::Panel::Audio, cx))));
            if is_video {
                bottom = bottom.child(ui.button("im-video-editor", "Im Video-Editor öffnen").small().ghost().on_click(move |_, app| film.update(app, |shell, cx| shell.player_open_in(crate::nav::Panel::Video, cx))));
                if self.player_series().is_some() {
                    let me = me.clone();
                    bottom = bottom.child(ui.button("als-cover", "Als Cover festlegen").small().ghost().accessible_name("Dieses Bild als Cover der Serie auf der Merkliste festlegen").on_click(move |_, app| me.update(app, |shell, cx| shell.player_still_as_cover(cx))));
                }
            }
            if let Some(said) = &p.cover_said {
                bottom = bottom.child(ui.hint(said.clone()));
            }
            if let Some(title) = &chapter_now {
                bottom = bottom.child(ui.value(format!("Kapitel: {title}")));
            }
        }
        if immersive {
            // The picture is all there is. The controls lie over its foot and go when nobody asks for them.
            let dialogs = p.marks_open || p.sleep_open || p.tracks_open || p.look_open;
            let shown = !playing || dialogs || p.activity.elapsed() < CONTROLS_SHOWN;
            let mut stage = stage.child(div().absolute().top_0().left_0().size_full());
            if !shown {
                stage = stage.cursor(gpui::CursorStyle::None);
            }
            if shown {
                // Over black the controls are the dark ones, in whichever mode the page is.
                stage = stage.child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left_0()
                        .w_full()
                        .px(px(24.))
                        .py(px(16.))
                        .flex()
                        .flex_col()
                        .gap(px(12.))
                        .bg(gpui::hsla(0., 0., 0., 0.62))
                        .child(div().child(ui.value(name.clone())))
                        .child(seek)
                        .child(div().flex().flex_wrap().items_center().justify_between().gap(px(12.)).child(controls).child(bottom)),
                );
            }
            return stage.into_any_element();
        }
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
        if p.size == PlayerSize::Kino {
            return page.into_any_element();
        }
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
        if p.look_open {
            let me = cx.entity();
            let st = &p.settings;
            // One row of choices: a title and chips that each set one value.
            let steps = |ui: &Ui, title: &str, key: &'static str, values: &[(f64, &str)], now: f64, set: fn(&mut sondra_player::Settings, f64)| {
                let mut chips = div().flex().flex_wrap().gap(px(6.));
                for (v, label) in values {
                    let me = me.clone();
                    let v = *v;
                    chips = chips.child(ui.chip(format!("{key}-{label}"), label.to_string(), (now - v).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        set(&mut p.settings, v);
                        p.apply_look();
                    })));
                }
                div().flex().flex_col().gap(px(8.)).child(ui.title(title.to_string())).child(chips)
            };
            let percent = |from: f64, to: f64, step: f64| -> Vec<(f64, String)> {
                let mut out = Vec::new();
                let mut v = from;
                while v <= to + 1e-9 {
                    out.push((v, format!("{} %", (v * 100.0).round())));
                    v += step;
                }
                out
            };
            let light = percent(0.5, 1.5, 0.25);
            let light: Vec<(f64, &str)> = light.iter().map(|(v, l)| (*v, l.as_str())).collect();
            let contrast = percent(0.5, 1.5, 0.25);
            let contrast: Vec<(f64, &str)> = contrast.iter().map(|(v, l)| (*v, l.as_str())).collect();
            let colour = percent(0.0, 2.0, 0.5);
            let colour: Vec<(f64, &str)> = colour.iter().map(|(v, l)| (*v, l.as_str())).collect();
            let boost = [(1.0, "100 %"), (1.5, "150 %"), (2.0, "200 %"), (3.0, "300 %")];
            let mut body = div().flex().flex_col().gap(px(16.));
            // The fit.
            let mut fit = div().flex().flex_wrap().gap(px(6.));
            for (value, label) in [(sondra_player::Fit::Contain, "Einpassen"), (sondra_player::Fit::Cover, "Füllen"), (sondra_player::Fit::Fill, "Strecken")] {
                let me = me.clone();
                fit = fit.child(ui.chip(format!("passung-{label}"), label, st.fit == value).accessible_name(format!("Bildpassung {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.settings.fit = value;
                    p.keep_settings();
                })));
            }
            {
                let me = me.clone();
                let on = st.mirror;
                fit = fit.child(ui.chip("spiegeln", "Spiegeln", on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.settings.mirror = !on;
                    p.apply_look();
                })));
            }
            body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Bild")).child(fit));
            // The quality: a smaller picture is cheaper to carry to the window; the film goes on from where it is.
            let steps_here = p.playback.as_ref().map(|pb| pb.quality_steps()).unwrap_or_default();
            if !steps_here.is_empty() {
                let mut row = div().flex().flex_wrap().gap(px(6.));
                let mut choices: Vec<(Option<u32>, String)> = vec![(None, "Original".to_string())];
                choices.extend(steps_here.iter().map(|h| (Some(*h), format!("{h}p"))));
                for (value, label) in choices {
                    let me = me.clone();
                    row = row.child(ui.chip(format!("qualitaet-{label}"), label.clone(), p.quality == value).accessible_name(format!("Qualität {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        if let Some(pb) = p.playback.as_mut() {
                            let _ = pb.set_quality(value);
                        }
                        p.quality = value;
                    })));
                }
                body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Qualität")).child(row));
            }
            body = body.child(steps(&ui, "Helligkeit", "hell", &light, st.brightness, |s, v| s.brightness = v));
            body = body.child(steps(&ui, "Kontrast", "kontrast", &contrast, st.contrast, |s, v| s.contrast = v));
            body = body.child(steps(&ui, "Sättigung", "saettigung", &colour, st.saturation, |s, v| s.saturation = v));
            body = body.child(steps(&ui, "Verstärkung", "verstaerkung", &boost, st.boost, |s, v| s.boost = v));
            {
                let me = me.clone();
                let on = st.night;
                let (karaoke_me, karaoke_on) = (me.clone(), st.karaoke);
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(ui.title("Ton"))
                        .child(div().flex().flex_wrap().gap(px(6.)).child(
                            ui.chip("nachtmodus", "Nachtmodus: Leises lauter, Lautes leiser", on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                                p.settings.night = !on;
                                p.apply_look();
                            })),
                        ).child(
                            ui.chip("karaoke", "Karaoke: Stimme in der Mitte entfernen", karaoke_on).on_click(move |_, app| Self::player_do(&karaoke_me, app, move |p| {
                                p.settings.karaoke = !karaoke_on;
                                p.apply_look();
                            })),
                        )),
                );
            }
            // The visualizer belongs to a song's stage.
            if p.playback.as_ref().is_some_and(|pb| pb.picture_size().is_none()) {
                let mut row = div().flex().flex_wrap().gap(px(6.));
                let (on, mode) = (st.visualizer, st.visualizer_mode);
                {
                    let me = me.clone();
                    row = row.child(ui.chip("visualizer-an", "Visualizer", on).accessible_name("Visualizer zeigen").on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.visualizer = !on;
                        p.keep_settings();
                    })));
                }
                for (value, label) in [(sondra_player::VisualizerMode::Bars, "Balken"), (sondra_player::VisualizerMode::Wave, "Welle"), (sondra_player::VisualizerMode::Radial, "Ring")] {
                    let me = me.clone();
                    row = row.child(ui.chip(format!("visualizer-{label}"), label, on && mode == value).accessible_name(format!("Visualizer {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.visualizer = true;
                        p.settings.visualizer_mode = value;
                        p.keep_settings();
                    })));
                }
                body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Anzeige zum Ton")).child(row));
            }
            // The equalizer: five bands and the presets of the web player.
            {
                let mut presets = div().flex().flex_wrap().gap(px(6.));
                for (name, gains) in sondra_playback::EQ_PRESETS {
                    let me = me.clone();
                    let chosen = st.eq_preset == name;
                    presets = presets.child(ui.chip(format!("eq-{name}"), name, chosen).accessible_name(format!("Entzerrer: {name}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        let s = &mut p.settings;
                        [s.eq_band1, s.eq_band2, s.eq_band3, s.eq_band4, s.eq_band5] = gains;
                        s.eq_preset = name.to_string();
                        s.eq_enabled = true;
                        p.apply_look();
                    })));
                }
                let bands = [st.eq_band1, st.eq_band2, st.eq_band3, st.eq_band4, st.eq_band5];
                let mut sliders = div().flex().flex_col().gap(px(8.));
                for (n, ((label, hz), gain)) in sondra_playback::EQ_BANDS.iter().zip(bands).enumerate() {
                    let me = me.clone();
                    let shown = if gain.abs() < 1e-9 { "0 dB".to_string() } else { format!("{}{} dB", if gain > 0.0 { "+" } else { "−" }, format!("{}", gain.abs()).replace('.', ",")) };
                    sliders = sliders.child(ui.slider(format!("eq-band-{}", n + 1), format!("{label} ({hz} Hz)"), ((gain + 12.0) / 24.0) as f32).step(0.5 / 24.0).says(shown).on_change(move |frac, _, app| Self::player_do(&me, app, move |p| {
                        let gain = ((f64::from(frac) * 24.0 - 12.0) * 2.0).round() / 2.0;
                        let s = &mut p.settings;
                        match n {
                            0 => s.eq_band1 = gain,
                            1 => s.eq_band2 = gain,
                            2 => s.eq_band3 = gain,
                            3 => s.eq_band4 = gain,
                            _ => s.eq_band5 = gain,
                        }
                        s.eq_preset = "Eigene".to_string();
                        s.eq_enabled = true;
                        p.apply_look();
                    })));
                }
                let on = st.eq_enabled;
                let toggle = {
                    let me = me.clone();
                    ui.chip("entzerrer-an", "Entzerrer an", on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.eq_enabled = !on;
                        p.apply_look();
                    }))
                };
                body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Entzerrer")).child(div().flex().flex_wrap().gap(px(6.)).child(toggle)).child(presets).child(sliders));
            }
            {
                // „Wiedergabe“ as in the gear menu of the website: what happens at the end, how far the arrows
                // jump, the opening, ticking off on the Merkliste, a loop, and pausing when minimized.
                let toggle = |id: &'static str, label: &'static str, on: bool, change: fn(&mut PlayerState)| {
                    let me = me.clone();
                    ui.chip(id, label, on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        change(p);
                        p.keep_settings();
                    }))
                };
                let mut ends = div().flex().flex_wrap().gap(px(6.));
                ends = ends.child(toggle("automatisch-weiter", "Automatisch weiter", st.auto_next, |p| p.settings.auto_next = !p.settings.auto_next));
                for (repeat, id, label) in [(Repeat::Aus, "wiederholen-aus", "Anhalten am Ende"), (Repeat::Titel, "wiederholen-titel", "Titel wiederholen"), (Repeat::Liste, "wiederholen-liste", "Liste wiederholen")] {
                    let me = me.clone();
                    ends = ends.child(ui.chip(id, label, st.repeat == repeat).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.repeat = repeat;
                        p.keep_settings();
                    })));
                }
                let mut skips = div().flex().flex_wrap().gap(px(6.));
                for s in sondra_player::SKIPS {
                    let me = me.clone();
                    skips = skips.child(ui.chip(format!("sprung-{s}"), format!("{} s", s as i64), (st.skip - s).abs() < 1e-9).accessible_name(format!("Sprungweite {} Sekunden", s as i64)).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.skip = s;
                        p.keep_settings();
                    })));
                }
                let mut openings = div().flex().flex_wrap().gap(px(6.));
                for o in [60.0f64, 90.0, 120.0, 150.0] {
                    let me = me.clone();
                    let label = format!("{}:{:02}", o as i64 / 60, o as i64 % 60);
                    openings = openings.child(ui.chip(format!("vorspann-{o}"), label.clone(), (st.opening - o).abs() < 1e-9).accessible_name(format!("Feste Länge des Vorspanns {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        p.settings.opening = o;
                        p.keep_settings();
                    })));
                }
                let mut ab = div().flex().flex_wrap().items_center().gap(px(6.));
                let ab_text = match (p.loop_a, p.loop_b) {
                    (None, _) => "Schleife A–B: hier beginnen".to_string(),
                    (Some(a), None) => format!("A bei {} — hier enden", sondra_player::clock(a)),
                    (Some(a), Some(b)) => format!("Schleife {}–{} beenden", sondra_player::clock(a), sondra_player::clock(b)),
                };
                {
                    let me = me.clone();
                    ab = ab.child(ui.button("schleife-ab", ab_text).small().disabled(p.playback.is_none()).on_click(move |_, app| Self::player_do(&me, app, |p| p.loop_mark())));
                }
                let on = p.pause_on_minimize;
                let minimize = {
                    let me = me.clone();
                    ui.chip("minimieren-pausieren", "Beim Minimieren pausieren", on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                        use sondra_merk::folder_memory::Store;
                        p.pause_on_minimize = !on;
                        if let Some(store) = p.memory.as_mut() {
                            store.set_item(MINIMIZE_KEY, if on { "false".to_string() } else { "true".to_string() });
                        }
                    }))
                };
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .child(ui.title("Wiedergabe"))
                        .child(ui.hint("Nach dem Ende"))
                        .child(ends)
                        .child(ui.hint("Sprung mit ← → und den Pfeilknöpfen"))
                        .child(skips)
                        .child(ui.hint("Vorspann"))
                        .child(div().flex().flex_wrap().gap(px(6.)).child(toggle("vorspann-anbieten", "Vorspann überspringen anbieten", st.skip_opening, |p| p.settings.skip_opening = !p.settings.skip_opening)))
                        .child(ui.hint("Am Ton erkennen"))
                        .child(div().w(px(520.)).child(ui.prose(self.intro_status())))
                        .children(p.intro_note.clone().map(|note| div().w(px(520.)).child(ui.hint(note))))
                        .child({
                            let mut row = div().flex().flex_wrap().gap(px(6.));
                            if self.intro_series().is_some() && p.intro_step.is_none() {
                                match self.intro_partner() {
                                    Some(partner) => {
                                        let me = me.clone();
                                        let label = if self.intro_learned() > 0 { "Neuen Vorspann erkennen" } else { "Vorspann erkennen" };
                                        let with = partner.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                                        row = row.child(ui.button("vorspann-erkennen", label).small().accessible_name(format!("{label} — vergleicht mit „{with}“")).on_click(move |_, app| me.update(app, |shell, cx| shell.player_learn_intro(cx))));
                                    }
                                    None => {
                                        row = row.child(ui.hint(format!("{} eine zweite Folge der Serie in die Liste nehmen.", if self.intro_learned() > 0 { "Für einen neuen Vorspann" } else { "Dafür" })));
                                    }
                                }
                                let learned = self.intro_learned();
                                if learned > 0 {
                                    let me = me.clone();
                                    row = row.child(ui.button("vorspann-vergessen", if learned == 1 { "Erkannten Vorspann vergessen".to_string() } else { format!("{learned} erkannte Vorspänne vergessen") }).small().ghost().on_click(move |_, app| me.update(app, |shell, cx| shell.player_forget_intros(cx))));
                                }
                            }
                            row
                        })
                        .child(ui.hint("Feste Länge des Vorspanns (wenn nichts erkannt ist und die Serie keine eigene hat)"))
                        .child(openings)
                        .child(div().flex().flex_wrap().gap(px(6.)).child(toggle("merkliste-abhaken", "In der Merkliste abhaken", st.merkliste, |p| p.settings.merkliste = !p.settings.merkliste)).child(minimize))
                        .child(ab),
                );
            }
            let (close, reset) = (me.clone(), me.clone());
            return Some(
                ui.dialog("bild-ton-fenster", "Bild und Ton")
                    .width(560.)
                    .child(body)
                    .action(ui.button("bild-zuruecksetzen", "Zurücksetzen").on_click(move |_, app| Self::player_do(&reset, app, |p| {
                        let d = sondra_player::Settings::default();
                        p.settings.brightness = d.brightness;
                        p.settings.contrast = d.contrast;
                        p.settings.saturation = d.saturation;
                        p.settings.mirror = d.mirror;
                        p.settings.boost = d.boost;
                        p.settings.night = d.night;
                        p.settings.karaoke = d.karaoke;
                        p.settings.fit = d.fit;
                        p.settings.eq_band1 = d.eq_band1;
                        p.settings.eq_band2 = d.eq_band2;
                        p.settings.eq_band3 = d.eq_band3;
                        p.settings.eq_band4 = d.eq_band4;
                        p.settings.eq_band5 = d.eq_band5;
                        p.settings.eq_preset = d.eq_preset.clone();
                        p.settings.eq_enabled = d.eq_enabled;
                        p.apply_look();
                    })))
                    .action(ui.button("bild-schliessen", "Schliessen").primary().on_click(move |_, app| Self::player_do(&close, app, |p| p.look_open = false)))
                    .on_close(move |_, app| Self::player_do(&me, app, |p| p.look_open = false))
                    .into_any_element(),
            );
        }
        if p.tracks_open {
            let me = cx.entity();
            let playback = p.playback.as_ref()?;
            let mut body = div().flex().flex_col().gap(px(16.));
            // Sound tracks: only worth a choice when there is more than one.
            let tracks = playback.audio_tracks();
            if tracks.len() > 1 {
                let mut chips = div().flex().flex_wrap().gap(px(6.));
                for (n, track) in tracks.iter().enumerate() {
                    let me = me.clone();
                    let label = track.title.clone().or_else(|| track.language.clone()).unwrap_or_else(|| format!("Spur {}", n + 1));
                    chips = chips.child(ui.chip(format!("spur-{n}"), label.clone(), p.settings_track() == n).accessible_name(format!("Tonspur {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| p.choose_track(n))));
                }
                body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Tonspur")).child(chips));
            }
            // Subtitles: off, the file beside the film, the ones inside it.
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            {
                let me = me.clone();
                chips = chips.child(ui.chip("untertitel-aus", "Aus", p.subtitle == Subtitle::Off).accessible_name("Untertitel aus").on_click(move |_, app| Self::player_do(&me, app, |p| p.choose_subtitle(Subtitle::Off))));
            }
            if !p.external_cues.is_empty() {
                let me = me.clone();
                let label = p.subtitle_name.clone().unwrap_or_else(|| "Datei neben dem Film".into());
                chips = chips.child(ui.chip("untertitel-datei", label, p.subtitle == Subtitle::File).on_click(move |_, app| Self::player_do(&me, app, |p| p.choose_subtitle(Subtitle::File))));
            }
            {
                let me = me.clone();
                chips = chips.child(ui.button("untertitel-laden", "Datei laden …").small().ghost().accessible_name("Untertitel-Datei laden (.srt, .vtt)").on_click(move |_, app| me.update(app, |shell, cx| shell.player_choose_subtitle_file(cx))));
            }
            for stream in playback.probe().streams.iter().filter(|s| s.kind == "subtitle") {
                let me = me.clone();
                let index = stream.index;
                let label = stream.title.clone().or_else(|| stream.language.clone()).unwrap_or_else(|| format!("Eingebaut {index}"));
                chips = chips.child(ui.chip(format!("untertitel-{index}"), label.clone(), p.subtitle == Subtitle::Inside(index)).accessible_name(format!("Untertitel {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| p.choose_subtitle(Subtitle::Inside(index)))));
            }
            body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Untertitel")).child(chips));
            if let Some(error) = &p.subtitle_error {
                body = body.child(ui.notice(NoticeKind::Info, error.clone()));
            }
            // Their looks.
            let mut looks = div().flex().flex_wrap().items_center().gap(px(6.));
            for (size, label) in [(sondra_player::CaptionSize::Klein, "Klein"), (sondra_player::CaptionSize::Mittel, "Mittel"), (sondra_player::CaptionSize::Gross, "Gross")] {
                let me = me.clone();
                looks = looks.child(ui.chip(format!("schrift-{label}"), label, p.settings.caption_size == size).accessible_name(format!("Schriftgrösse {label}")).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.settings.caption_size = size;
                    p.keep_settings();
                })));
            }
            {
                let me = me.clone();
                let on = p.settings.caption_background;
                looks = looks.child(ui.chip("untertitel-grund", "Dunkler Grund", on).on_click(move |_, app| Self::player_do(&me, app, move |p| {
                    p.settings.caption_background = !on;
                    p.keep_settings();
                })));
            }
            body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.title("Schrift")).child(looks));
            let close = me.clone();
            return Some(
                ui.dialog("ton-untertitel-fenster", "Ton und Untertitel")
                    .width(560.)
                    .child(body)
                    .action(ui.button("ton-schliessen", "Schliessen").primary().on_click(move |_, app| Self::player_do(&close, app, |p| p.tracks_open = false)))
                    .on_close(move |_, app| Self::player_do(&me, app, |p| p.tracks_open = false))
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
                keys_pass: false,
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
        // The chapters the file brings, below its own bookmarks: a click goes there.
        if p.chapters.len() > 1 {
            list = list.child(div().pt(px(12.)).child(ui.subheading("Kapitel der Datei")));
            for (n, chapter) in p.chapters.iter().enumerate() {
                let (go, at) = (me.clone(), chapter.start);
                let says = format!("{} · {}", clock(chapter.start), chapter.title);
                list = list.child(Line {
                    colors: c,
                    id: format!("kapitel-{n}").into(),
                    name: chapter.title.clone().into(),
                    says: says.clone().into(),
                    first: false,
                    tile: None,
                    selected: false,
                    body: vec![div().flex_1().min_w(px(0.)).child(ui.value(says)).into_any_element()],
                    keys_pass: false,
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
                body: {
                    let mut body = vec![
                        div().flex_1().min_w(px(0.)).child(ui.value(label.clone())).into_any_element(),
                        div().flex_none().text_size(px(size::SMALL)).text_color(c.prose).child(says).into_any_element(),
                    ];
                    if n != p.index {
                        let (next, out) = (me.clone(), me.clone());
                        if n != p.index + 1 {
                            body.push(ui.button(format!("als-naechstes-{n}"), "Als Nächstes").small().ghost().accessible_name(format!("{label} als Nächstes")).on_click(move |_, app| Self::player_do(&next, app, move |p| p.queue_next(n))).into_any_element());
                        }
                        body.push(ui.button(format!("aus-liste-{n}"), "Entfernen").small().ghost().accessible_name(format!("{label} aus der Liste nehmen")).on_click(move |_, app| Self::player_do(&out, app, move |p| p.queue_remove(n))).into_any_element());
                    }
                    body
                },
                keys_pass: false,
                on_open: std::rc::Rc::new(move |_, app| Self::player_do(&me, app, move |p| p.start(n))),
            });
        }
        div().flex().flex_col().gap(px(10.)).child(div().pb(px(10.)).border_b_1().border_color(c.line).child(ui.subheading("Liste"))).child(rows).into_any_element()
    }
}
