//! Handy spiegeln (`PhoneMirrorPanel.tsx`): the screen of an Android phone on this computer, with the mouse
//! and the keyboard wired to it. What scrcpy does, with the explaining done on the page: five steps to get a
//! phone ready, one button to connect, then the screen as a block of the page. The way to the phone — USB,
//! ADB, the scrcpy server, H.264 through FFmpeg — is `sondra-mirror`, tested against a stand-in phone; it has
//! never run against a real one.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::{canvas, div, img, point, prelude::*, px, AnyElement, Bounds, Context, FocusHandle, ImageSource, Modifiers, MouseButton, ObjectFit, Pixels, RenderImage, ScrollDelta};
use image::{Frame as ImageFrame, RgbaImage};
use sha2::{Digest, Sha256};
use smallvec::smallvec;
use sondra_a11y::{accessible, Role};
use sondra_media::Ffmpeg;
use sondra_mirror::adb::Link;
use sondra_mirror::control::TouchAction;
use sondra_mirror::decode::Frame;
use sondra_mirror::key::AdbKey;
use sondra_mirror::options::Quality;
use sondra_mirror::session::{AudioState, KeyboardMode, Options, PhoneKey, Session, Step};
use sondra_mirror::usb::{list_phones, PhoneInfo, UsbLink};
use sondra_mirror::MirrorError;
use sondra_ui::{radius, size, NoticeKind, Ui};

use crate::shell::Shell;

/// The scrcpy server as shipped (never fetched from anywhere), and the sum it must have.
const SERVER: &[u8] = include_bytes!("../../../src/assets/scrcpy/scrcpy-server-v3.3.3.jar");
const SERVER_SHA256: &str = "7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0";

/// Opens the cable to the phone with this id; `None`: the first one there is.
pub type Opener = Arc<dyn Fn(Option<&str>) -> Result<Arc<dyn Link>, MirrorError> + Send + Sync>;

const STEPS: [(&str, &str, &str); 5] = [
    ("Am Handy", "Entwickleroptionen einschalten", "Einstellungen → „Über das Telefon“ → siebenmal auf „Build-Nummer“ tippen (bei Samsung unter „Softwareinformationen“). Das Handy meldet: „Sie sind jetzt Entwickler“."),
    ("Am Handy", "USB-Debugging einschalten", "Einstellungen → System → Entwickleroptionen → „USB-Debugging“. Ohne diesen Schalter sieht Sondra das Handy nicht."),
    ("Am Handy", "Mit einem Datenkabel anschliessen", "Ein reines Ladekabel überträgt keine Daten. Fragt das Handy nach dem USB-Modus, wählen Sie „Dateien übertragen“."),
    ("Hier", "Auf „Handy verbinden“ klicken", "Sondra zeigt das angeschlossene Handy. Sind es mehrere, wählen Sie eines."),
    ("Am Handy", "Zulassen", "Das Handy fragt „USB-Debugging zulassen?“. Haken bei „Immer von diesem Computer zulassen“ setzen, dann „Zulassen“. Danach erscheint das Bild."),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Connecting(Step),
    Running,
    Ended(String),
    Failed(String),
}

struct Connecting {
    step: Step,
    result: Option<Result<(Session, Receiver<Frame>, Receiver<Vec<f32>>), MirrorError>>,
}

struct SoundOut {
    stop: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
}

pub struct PhoneState {
    pub quality: Quality,
    pub sound: bool,
    pub muted: bool,
    pub phones: Vec<PhoneInfo>,
    pub chosen: usize,
    pub phase: Phase,
    session: Option<Arc<Session>>,
    pub(crate) image: Option<Arc<RenderImage>>,
    last: Option<Frame>,
    frames: Option<Receiver<Frame>>,
    connecting: Option<Arc<Mutex<Connecting>>>,
    out: Option<SoundOut>,
    pub said: Option<String>,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    focus: FocusHandle,
    /// Whether keys go to the phone (a click on the screen takes them, Ctrl+Alt+Esc gives them back).
    captured: bool,
    held: Modifiers,
    /// Whether a finger is down: one press is one touch, however often it is told.
    touching: bool,
    opener: Opener,
    key: Option<Arc<AdbKey>>,
    key_file: Option<PathBuf>,
    ffmpeg: Option<PathBuf>,
    ticking: bool,
}

impl PhoneState {
    pub fn new(cx: &mut Context<Shell>) -> PhoneState {
        let opener: Opener = Arc::new(|id| {
            let phones = list_phones();
            let chosen = match id {
                Some(id) => phones.into_iter().find(|p| p.id == id),
                None => phones.into_iter().next(),
            };
            let phone = chosen.ok_or_else(|| MirrorError::Usb("Es ist kein Handy angeschlossen, das USB-Debugging anbietet.".into()))?;
            Ok(Arc::new(UsbLink::open(&phone.id)?) as Arc<dyn Link>)
        });
        PhoneState {
            quality: Quality::Smooth,
            sound: true,
            muted: false,
            phones: Vec::new(),
            chosen: 0,
            phase: Phase::Idle,
            session: None,
            image: None,
            last: None,
            frames: None,
            connecting: None,
            out: None,
            said: None,
            bounds: Rc::new(Cell::new(Bounds::default())),
            focus: cx.focus_handle().tab_stop(true),
            captured: false,
            held: Modifiers::default(),
            touching: false,
            opener,
            key: None,
            key_file: crate::store::data_dir().map(|d| d.join("adb-schluessel.der")),
            ffmpeg: Ffmpeg::locate().map(|f| f.program().to_path_buf()),
            ticking: false,
        }
    }
}

/// Where the picture of the screen was last drawn, for turning a place on the window into a place on the phone.
fn share_at(bounds: Bounds<Pixels>, x: Pixels, y: Pixels) -> (f64, f64) {
    let (left, top): (f32, f32) = (bounds.origin.x.into(), bounds.origin.y.into());
    let (w, h): (f32, f32) = (bounds.size.width.into(), bounds.size.height.into());
    if w <= 0.0 || h <= 0.0 {
        return (0.0, 0.0);
    }
    let (x, y): (f32, f32) = (x.into(), y.into());
    (f64::from(((x - left) / w).clamp(0.0, 1.0)), f64::from(((y - top) / h).clamp(0.0, 1.0)))
}

/// The key of this computer's keyboard as its place on the keyboard (`KeyboardEvent.code`).
pub fn code_of(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        return Some(match first {
            'a'..='z' => format!("Key{}", first.to_ascii_uppercase()),
            '0'..='9' => format!("Digit{first}"),
            '-' => "Minus".into(),
            '=' => "Equal".into(),
            '[' => "BracketLeft".into(),
            ']' => "BracketRight".into(),
            '\\' => "Backslash".into(),
            ';' => "Semicolon".into(),
            '\'' => "Quote".into(),
            '`' => "Backquote".into(),
            ',' => "Comma".into(),
            '.' => "Period".into(),
            '/' => "Slash".into(),
            _ => return None,
        });
    }
    Some(
        match key {
            "enter" => "Enter",
            "escape" => "Escape",
            "backspace" => "Backspace",
            "tab" => "Tab",
            "space" => "Space",
            "delete" => "Delete",
            "insert" => "Insert",
            "left" => "ArrowLeft",
            "right" => "ArrowRight",
            "up" => "ArrowUp",
            "down" => "ArrowDown",
            "home" => "Home",
            "end" => "End",
            "pageup" => "PageUp",
            "pagedown" => "PageDown",
            f if f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (1..=12).contains(&n)) => return Some(f.to_uppercase()),
            _ => return None,
        }
        .to_owned(),
    )
}

/// Linear resampling of interleaved stereo from 48 kHz to the sound card's rate, block after block.
struct Resampler {
    ratio: f64,
    position: f64,
    last: [f32; 2],
}

impl Resampler {
    fn new(from: u32, to: u32) -> Resampler {
        Resampler { ratio: f64::from(from) / f64::from(to), position: 0.0, last: [0.0; 2] }
    }

    fn run(&mut self, block: &[f32]) -> Vec<f32> {
        let frames = block.len() / 2;
        let mut out = Vec::new();
        // `position` counts input frames from the one before the block (the carried `last`).
        while self.position < frames as f64 {
            let at = self.position;
            let i = at.floor() as isize;
            let frac = (at - at.floor()) as f32;
            for c in 0..2 {
                let a = if i < 0 { self.last[c] } else { block[i as usize * 2 + c] };
                let b = block.get(((i + 1) as usize) * 2 + c).copied().unwrap_or(a);
                out.push(a + (b - a) * frac);
            }
            self.position += self.ratio;
        }
        self.position -= frames as f64;
        if frames > 0 {
            self.last = [block[(frames - 1) * 2], block[(frames - 1) * 2 + 1]];
        }
        out
    }
}

impl Shell {
    /// For tests: where the cable comes from, the key, and which FFmpeg.
    pub fn phone_with(&mut self, opener: Opener, key: AdbKey, ffmpeg: Option<PathBuf>) {
        self.phone.opener = opener;
        self.phone.key = Some(Arc::new(key));
        if ffmpeg.is_some() {
            self.phone.ffmpeg = ffmpeg;
        }
    }

    pub fn phone_phase(&self) -> Phase {
        self.phone.phase.clone()
    }

    pub fn phone_has_picture(&self) -> bool {
        self.phone.image.is_some()
    }

    pub fn phone_session(&self) -> Option<Arc<Session>> {
        self.phone.session.clone()
    }

    /// For tests: where the screen was last drawn.
    pub fn phone_bounds(&self) -> Bounds<Pixels> {
        self.phone.bounds.get()
    }

    pub fn phone_search(&mut self, cx: &mut Context<Self>) {
        self.phone.phones = list_phones();
        self.phone.chosen = self.phone.chosen.min(self.phone.phones.len().saturating_sub(1));
        cx.notify();
    }

    /// Connects. Called from a click.
    pub fn phone_connect(&mut self, cx: &mut Context<Self>) {
        let p = &mut self.phone;
        if matches!(p.phase, Phase::Connecting(_) | Phase::Running) {
            return;
        }
        let Some(ffmpeg) = p.ffmpeg.clone() else {
            p.phase = Phase::Failed("FFmpeg ist nicht da: ohne es lässt sich das Bild des Handys nicht entschlüsseln.".into());
            cx.notify();
            return;
        };
        // The server file is the one that was shipped, or nothing runs on the phone.
        if format!("{:x}", Sha256::digest(SERVER)) != SERVER_SHA256 {
            p.phase = Phase::Failed("Die mitgelieferte Datei für das Handy ist beschädigt. Laden Sie Sondra neu; bleibt es so, melden Sie es bitte.".into());
            cx.notify();
            return;
        }
        p.phase = Phase::Connecting(Step::Connect);
        p.said = None;
        p.image = None;
        let state = Arc::new(Mutex::new(Connecting { step: Step::Connect, result: None }));
        p.connecting = Some(state.clone());
        let (opener, id) = (p.opener.clone(), p.phones.get(p.chosen).map(|ph| ph.id.clone()));
        let (key, key_file) = (p.key.clone(), p.key_file.clone());
        let (quality, sound) = (p.quality, p.sound);
        std::thread::spawn(move || {
            let outcome = (|| {
                let key = match key {
                    Some(k) => k,
                    None => Arc::new(match &key_file {
                        Some(file) => AdbKey::load_or_create(file),
                        None => AdbKey::generate(),
                    }),
                };
                let link = opener(id.as_deref())?;
                let (frames_tx, frames) = channel();
                let (samples_tx, samples) = channel();
                let options = Options { quality, sound, ffmpeg, server: SERVER.to_vec(), allow_within: Duration::from_secs(60) };
                let progress = state.clone();
                let session = Session::start(link, &key, options, &mut |step| progress.lock().expect("lock").step = step, frames_tx, samples_tx)?;
                Ok((session, frames, samples))
            })();
            state.lock().expect("lock").result = Some(outcome);
        });
        self.phone_ticker(cx);
        cx.notify();
    }

    fn phone_ticker(&mut self, cx: &mut Context<Self>) {
        if self.phone.ticking {
            return;
        }
        self.phone.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(30)).await;
            let alive = this.update(cx, |shell, cx| {
                let alive = shell.phone_step();
                cx.notify();
                if !alive {
                    shell.phone.ticking = false;
                }
                alive
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    /// One turn of the clock: the way the connection has come, the newest picture, the end. Whether it goes on.
    fn phone_step(&mut self) -> bool {
        let p = &mut self.phone;
        if let Some(connecting) = p.connecting.clone() {
            let mut c = connecting.lock().expect("lock");
            match c.result.take() {
                None => {
                    p.phase = Phase::Connecting(c.step);
                    return true;
                }
                Some(Err(error)) => {
                    p.phase = Phase::Failed(error.to_string());
                    p.connecting = None;
                    return false;
                }
                Some(Ok((session, frames, samples))) => {
                    p.connecting = None;
                    p.phase = Phase::Running;
                    p.session = Some(Arc::new(session));
                    p.frames = Some(frames);
                    p.captured = true;
                    p.out = Some(start_sound(samples));
                    self.pending_focus = Some(self.phone.focus.clone());
                }
            }
        }
        let p = &mut self.phone;
        if let Some(frames) = &p.frames {
            let mut newest = None;
            while let Ok(frame) = frames.try_recv() {
                newest = Some(frame);
            }
            if let Some(frame) = newest {
                p.last = Some(frame);
                p.image = p.last.as_ref().and_then(to_image);
            }
        }
        if let Some(session) = &p.session {
            if let Some(reason) = session.closed() {
                p.phase = Phase::Ended(reason);
                self.phone_release();
                return false;
            }
        }
        matches!(self.phone.phase, Phase::Running | Phase::Connecting(_))
    }

    fn phone_release(&mut self) {
        let p = &mut self.phone;
        if let Some(out) = p.out.take() {
            out.stop.store(true, Ordering::SeqCst);
        }
        if let Some(session) = p.session.take() {
            session.stop();
        }
        p.frames = None;
        p.captured = false;
    }

    pub fn phone_stop(&mut self, cx: &mut Context<Self>) {
        if self.phone.session.is_some() {
            self.phone_release();
            self.phone.phase = Phase::Ended("Beendet.".into());
        }
        cx.notify();
    }

    fn phone_screenshot(&mut self, cx: &mut Context<Self>) {
        let Some(frame) = self.phone.last.clone() else { return };
        let dir = crate::store::downloads_dir();
        let name = format!("Handy-Bildschirmfoto-{}.png", chrono::Local::now().format("%Y-%m-%d-%H%M%S"));
        let saved = (|| -> Option<PathBuf> {
            std::fs::create_dir_all(&dir).ok()?;
            let path = dir.join(&name);
            RgbaImage::from_raw(frame.width, frame.height, frame.rgba)?.save(&path).ok()?;
            Some(path)
        })();
        self.phone.said = Some(match saved {
            Some(path) => format!("Gespeichert: {}", path.display()),
            None => "Das Bildschirmfoto liess sich nicht speichern.".into(),
        });
        cx.notify();
    }

    fn phone_key(&mut self, key: PhoneKey) {
        if let Some(session) = &self.phone.session {
            let _ = session.key(key);
        }
    }

    /// Presses and lets go of the keys of this computer's keyboard on the phone.
    fn phone_send_key(&mut self, key: &str, typed: Option<&str>, down: bool, mods: &Modifiers) {
        let Some(session) = self.phone.session.clone() else { return };
        if !self.phone.captured {
            return;
        }
        if let Some(code) = code_of(key) {
            let _ = session.send_key(&code, typed.unwrap_or(key), down, mods.control, mods.alt, mods.platform);
        }
    }

    fn phone_modifiers(&mut self, now: Modifiers) {
        let Some(session) = self.phone.session.clone() else { return };
        let before = self.phone.held;
        self.phone.held = now;
        if !self.phone.captured {
            return;
        }
        for (was, is, code) in [(before.control, now.control, "ControlLeft"), (before.shift, now.shift, "ShiftLeft"), (before.alt, now.alt, "AltLeft"), (before.platform, now.platform, "MetaLeft")] {
            if was != is {
                let _ = session.send_key(code, code, is, now.control, now.alt, now.platform);
            }
        }
    }

    pub(crate) fn phone_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let p = &self.phone;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Handy spiegeln", "Der Bildschirm Ihres Android-Handys auf diesem Computer — mit Ton, Maus und Tastatur. Es geht über das USB-Kabel; nichts verlässt den Computer."));

        let done = match &p.phase {
            Phase::Idle | Phase::Failed(_) => 3,
            Phase::Connecting(Step::Allow) | Phase::Connecting(_) => 4,
            Phase::Running | Phase::Ended(_) => 5,
        };
        let mut steps = div().flex().flex_col().gap(px(14.));
        for (n, (where_, title, text)) in STEPS.iter().enumerate() {
            let finished = n < done;
            steps = steps.child(
                div()
                    .flex()
                    .gap(px(12.))
                    .child(div().w(px(28.)).h(px(28.)).flex_none().rounded(px(radius::PILL)).flex().items_center().justify_center().bg(if finished { c.ink } else { c.panel_mid }).text_color(if finished { c.canvas } else { c.prose }).child(if finished { "✓".to_string() } else { (n + 1).to_string() }))
                    .child(div().flex().flex_col().gap(px(2.)).child(ui.hint(*where_)).child(ui.title(*title)).child(ui.prose(*text))),
            );
        }

        // The block on the right: the connection, or the screen.
        let mut block = div().flex().flex_col().flex_none().w(px(580.)).gap(px(14.)).p(px(20.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        match &p.phase {
            Phase::Running => {
                let session = p.session.clone();
                let (w, h) = session.as_ref().map_or((9, 16), |s| s.size());
                let aspect = w as f32 / h.max(1) as f32;
                let mut shown_h = 640.0f32;
                let mut shown_w = shown_h * aspect;
                if shown_w > 520.0 {
                    shown_w = 520.0;
                    shown_h = shown_w / aspect;
                }
                let name = session.as_ref().map_or(String::new(), |s| s.device_name.clone());
                let (stop, shot, mute) = (me.clone(), me.clone(), me.clone());
                let muted = p.muted;
                let sound_on = session.as_ref().is_some_and(|s| s.audio() == AudioState::On);
                let mut top = div().flex().flex_wrap().items_center().justify_between().gap(px(10.)).child(ui.title(name.clone()));
                let mut tools = div().flex().flex_wrap().gap(px(8.));
                if sound_on {
                    tools = tools.child(ui.button("handy-ton", if muted { "Ton einschalten" } else { "Ton aus" }).small().on_click(move |_, app| mute.update(app, |sh, cx| {
                        sh.phone.muted = !sh.phone.muted;
                        if let Some(out) = &sh.phone.out {
                            out.muted.store(sh.phone.muted, Ordering::SeqCst);
                        }
                        cx.notify();
                    })));
                }
                tools = tools.child(ui.button("handy-foto", "Bildschirmfoto").small().on_click(move |_, app| shot.update(app, |sh, cx| sh.phone_screenshot(cx)))).child(ui.button("handy-beenden", "Beenden").small().on_click(move |_, app| stop.update(app, |sh, cx| sh.phone_stop(cx))));
                top = top.child(tools);
                block = block.child(top);

                // The picture, with the mouse on it.
                let measure = p.bounds.clone();
                let (down, drag, up, wheel) = (me.clone(), me.clone(), me.clone(), me.clone());
                let (bd, bm, bu, bw) = (p.bounds.clone(), p.bounds.clone(), p.bounds.clone(), p.bounds.clone());
                let key_down = me.clone();
                let key_up = me.clone();
                let mods_changed = me.clone();
                let mut screen = div()
                    .id("handy-bild")
                    .track_focus(&p.focus)
                    .relative()
                    .w(px(shown_w))
                    .h(px(shown_h))
                    .bg(gpui::black())
                    .cursor_pointer()
                    .on_mouse_down(MouseButton::Left, move |e, window, app| {
                        let (x, y) = share_at(bd.get(), e.position.x, e.position.y);
                        let _ = window;
                        down.update(app, |sh, cx| {
                            sh.phone.captured = true;
                            if !sh.phone.touching {
                                sh.phone.touching = true;
                                if let Some(s) = &sh.phone.session {
                                    let _ = s.touch(TouchAction::Down, x, y);
                                }
                            }
                            cx.notify();
                        });
                    })
                    .on_mouse_move(move |e, _, app| {
                        if e.pressed_button == Some(MouseButton::Left) {
                            let (x, y) = share_at(bm.get(), e.position.x, e.position.y);
                            drag.update(app, |sh, _| {
                                if let (true, Some(s)) = (sh.phone.touching, &sh.phone.session) {
                                    let _ = s.touch(TouchAction::Move, x, y);
                                }
                            });
                        }
                    })
                    .on_mouse_up(MouseButton::Left, move |e, _, app| {
                        let (x, y) = share_at(bu.get(), e.position.x, e.position.y);
                        up.update(app, |sh, _| {
                            if std::mem::take(&mut sh.phone.touching) {
                                if let Some(s) = &sh.phone.session {
                                    let _ = s.touch(TouchAction::Up, x, y);
                                }
                            }
                        });
                    })
                    .on_mouse_down(MouseButton::Right, {
                        let back = me.clone();
                        move |_, _, app| back.update(app, |sh, _| sh.phone_key(PhoneKey::Back))
                    })
                    .on_mouse_down(MouseButton::Middle, {
                        let home = me.clone();
                        move |_, _, app| home.update(app, |sh, _| sh.phone_key(PhoneKey::Home))
                    })
                    .on_scroll_wheel(move |e, window, app| {
                        let (x, y) = share_at(bw.get(), e.position.x, e.position.y);
                        let lines: f32 = match e.delta {
                            ScrollDelta::Lines(l) => l.y,
                            ScrollDelta::Pixels(px_) => f32::from(px_.y) / 40.0,
                        };
                        let _ = window;
                        // A turn of the wheel upwards scrolls the page down (the content moves up the finger).
                        wheel.update(app, |sh, _| {
                            if let Some(s) = &sh.phone.session {
                                let _ = s.scroll(x, y, 0.0, -f64::from(lines));
                            }
                        });
                    })
                    .on_key_down(move |e, _, app| {
                        let k = &e.keystroke;
                        // Ctrl+Alt+Esc gives the keyboard back to this computer.
                        if k.key == "escape" && k.modifiers.control && k.modifiers.alt {
                            key_down.update(app, |sh, cx| {
                                if let Some(s) = &sh.phone.session {
                                    let _ = s.release_keys();
                                }
                                sh.phone.captured = false;
                                cx.notify();
                            });
                            return;
                        }
                        let (key, typed, mods) = (k.key.clone(), k.key_char.clone(), k.modifiers);
                        key_down.update(app, |sh, _| {
                            if sh.phone.captured {
                                sh.phone_send_key(&key, typed.as_deref(), true, &mods);
                            }
                        });
                        app.stop_propagation();
                    })
                    .on_key_up(move |e, _, app| {
                        let (key, mods) = (e.keystroke.key.clone(), e.keystroke.modifiers);
                        key_up.update(app, |sh, _| sh.phone_send_key(&key, None, false, &mods));
                    })
                    .on_modifiers_changed(move |e, _, app| {
                        let mods = e.modifiers;
                        mods_changed.update(app, |sh, _| sh.phone_modifiers(mods));
                    })
                    .child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full());
                if let Some(image) = &p.image {
                    screen = screen.child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Fill).size_full());
                }
                block = block.child(accessible("handy-bild-zugang", Role::Group, screen).label(format!("Bildschirm von {name}")).description(format!("{w} mal {h} Bildpunkte. Mit der Maus bedienen: Linksklick tippt, Rechtsklick geht zurück, Mittelklick zum Startbildschirm.")).focus(&p.focus));

                // The phone's own keys.
                let mut keys = div().flex().flex_wrap().gap(px(8.));
                for (id, label, key) in [("zurueck", "Zurück", PhoneKey::Back), ("start", "Startbildschirm", PhoneKey::Home), ("uebersicht", "Übersicht", PhoneKey::Recents), ("leiser", "Leiser", PhoneKey::VolumeDown), ("lauter", "Lauter", PhoneKey::VolumeUp), ("ein-aus", "Ein/Aus", PhoneKey::Power)] {
                    let me = me.clone();
                    keys = keys.child(ui.button(format!("handy-{id}"), label).small().on_click(move |_, app| me.update(app, |sh, _| sh.phone_key(key))));
                }
                let notes = me.clone();
                keys = keys.child(ui.button("handy-mitteilungen", "Mitteilungen").small().on_click(move |_, app| notes.update(app, |sh, _| {
                    if let Some(s) = &sh.phone.session {
                        let _ = s.open_notifications();
                    }
                })));
                block = block.child(keys);
                let keyboard = match session.as_ref().map(|s| s.keyboard()) {
                    Some(KeyboardMode::Uhid) => "Die Tastatur dieses Computers ist am Handy eine USB-Tastatur (die Belegung bestimmt das Handy: y und z können vertauscht sein).",
                    _ => "Das Handy nimmt keine USB-Tastatur an: es gehen Text und die wichtigsten Tasten.",
                };
                block = block.child(ui.hint(if p.captured { format!("{keyboard} Strg+Alt+Esc gibt die Tastatur zurück.") } else { "Klicken Sie ins Bild, damit die Tastatur zum Handy geht.".into() }));
                if let Some(s) = session.as_ref() {
                    if s.audio() == AudioState::Unavailable {
                        block = block.child(ui.hint("Dieses Handy gibt keinen Ton heraus (Android 11 oder neuer ist nötig)."));
                    }
                }
            }
            other => {
                // Not connected: the picture of the way, the phones, the choices, the button.
                if let Phase::Failed(why) | Phase::Ended(why) = other {
                    block = block.child(ui.notice(if matches!(other, Phase::Failed(_)) { NoticeKind::Warning } else { NoticeKind::Info }, why.clone()));
                }
                if let Phase::Connecting(step) = other {
                    let text = match step {
                        Step::Connect => "Verbindung zum Handy wird aufgebaut",
                        Step::Allow => "Tippen Sie jetzt am Handy auf „Zulassen“",
                        Step::Push => "Das Programm für das Bild wird aufs Handy gelegt",
                        Step::Start => "Das Bild wird gestartet",
                    };
                    block = block.child(ui.notice(NoticeKind::Info, text));
                } else {
                    if p.phones.is_empty() {
                        block = block.child(ui.prose("Kein Handy erkannt. Schliessen Sie es an, schalten Sie USB-Debugging ein und suchen Sie erneut."));
                    } else {
                        let mut chips = div().flex().flex_wrap().gap(px(6.));
                        for (n, phone) in p.phones.iter().enumerate() {
                            let me = me.clone();
                            chips = chips.child(ui.chip(format!("handy-wahl-{n}"), phone.name.clone(), n == p.chosen).accessible_name(format!("Handy {}", phone.name)).on_click(move |_, app| me.update(app, |sh, cx| {
                                sh.phone.chosen = n;
                                cx.notify();
                            })));
                        }
                        block = block.child(div().flex().flex_col().gap(px(6.)).child(ui.subheading("Angeschlossen")).child(chips));
                    }
                    let (smooth, sharp, snd) = (me.clone(), me.clone(), me.clone());
                    block = block.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .child(ui.chip("handy-fluessig", "Flüssig", p.quality == Quality::Smooth).on_click(move |_, app| smooth.update(app, |sh, cx| {
                                sh.phone.quality = Quality::Smooth;
                                cx.notify();
                            })))
                            .child(ui.chip("handy-scharf", "Scharf", p.quality == Quality::Sharp).on_click(move |_, app| sharp.update(app, |sh, cx| {
                                sh.phone.quality = Quality::Sharp;
                                cx.notify();
                            })))
                            .child(ui.chip("handy-ton-uebertragen", "Ton übertragen", p.sound).on_click(move |_, app| snd.update(app, |sh, cx| {
                                sh.phone.sound = !sh.phone.sound;
                                cx.notify();
                            }))),
                    );
                    block = block.child(ui.hint("„Flüssig“ kappt die längere Bildkante auf 1280 Punkte und eignet sich für jeden Computer; „Scharf“ nimmt die volle Grösse des Handys. Das Handy ist während der Übertragung stumm, wenn der Ton übertragen wird."));
                    let (connect, search) = (me.clone(), me.clone());
                    block = block.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.))
                            .child(ui.button("handy-verbinden", "Handy verbinden").primary().on_click(move |_, app| connect.update(app, |sh, cx| sh.phone_connect(cx))))
                            .child(ui.button("handy-suchen", "Erneut suchen").on_click(move |_, app| search.update(app, |sh, cx| sh.phone_search(cx)))),
                    );
                }
            }
        }
        if let Some(said) = &p.said {
            block = block.child(ui.notice(NoticeKind::Info, said.clone()));
        }

        page = page.child(div().flex().flex_wrap().items_start().gap(px(32.)).child(div().flex().flex_col().flex_none().w(px(420.)).gap(px(4.)).child(ui.subheading("So geht es")).child(steps)).child(block));
        let _ = size::SMALL;
        let _ = point(px(0.), px(0.));
        page.into_any_element()
    }
}

fn to_image(frame: &Frame) -> Option<Arc<RenderImage>> {
    // The window's pictures are blue, green, red, alpha.
    let mut bgra = frame.rgba.clone();
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let buffer = RgbaImage::from_raw(frame.width, frame.height, bgra)?;
    Some(Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)])))
}

/// The phone's sound on the speakers: a thread that takes the samples, brings them to the sound card's rate and
/// queues them; what is more than 0.4 s late is dropped, so the sound stays with the picture.
fn start_sound(samples: Receiver<Vec<f32>>) -> SoundOut {
    let stop = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let (s, m) = (stop.clone(), muted.clone());
    std::thread::spawn(move || {
        let out = sondra_audio::Output::open(1.0);
        let shared = out.shared();
        let channels = shared.channels();
        let mut resampler = Resampler::new(48_000, shared.rate());
        while !s.load(Ordering::SeqCst) {
            let Ok(block) = samples.recv_timeout(Duration::from_millis(100)) else { continue };
            if m.load(Ordering::SeqCst) || shared.buffered() > 0.4 {
                continue;
            }
            let rate_matched = if shared.rate() == 48_000 { block } else { resampler.run(&block) };
            let mut interleaved = Vec::with_capacity(rate_matched.len() / 2 * channels);
            for frame in rate_matched.chunks_exact(2) {
                match channels {
                    1 => interleaved.push((frame[0] + frame[1]) / 2.0),
                    2 => interleaved.extend_from_slice(frame),
                    n => {
                        interleaved.extend_from_slice(frame);
                        interleaved.extend(std::iter::repeat(0.0).take(n - 2));
                    }
                }
            }
            shared.push(&interleaved, &s);
        }
    });
    SoundOut { stop, muted }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_named_by_their_place() {
        assert_eq!(code_of("a").as_deref(), Some("KeyA"));
        assert_eq!(code_of("7").as_deref(), Some("Digit7"));
        assert_eq!(code_of("enter").as_deref(), Some("Enter"));
        assert_eq!(code_of("left").as_deref(), Some("ArrowLeft"));
        assert_eq!(code_of("f12").as_deref(), Some("F12"));
        assert_eq!(code_of("f13"), None);
        assert_eq!(code_of("-").as_deref(), Some("Minus"));
        assert_eq!(code_of("ä"), None);
        assert_eq!(code_of("kaum"), None);
    }

    #[test]
    fn resampling_keeps_the_length_in_time_and_the_shape() {
        let mut r = Resampler::new(48_000, 44_100);
        let block: Vec<f32> = (0..960).flat_map(|i| [i as f32 / 960.0, -(i as f32) / 960.0]).collect();
        let mut total = 0;
        for _ in 0..50 {
            total += r.run(&block).len() / 2;
        }
        // 50 blocks of 960 frames at 48 kHz are one second: 44 100 frames at the other rate (give or take one).
        assert!((total as i64 - 44_100).abs() <= 2, "{total}");
        let mut r = Resampler::new(48_000, 48_000);
        assert_eq!(r.run(&block).len(), block.len());
    }
}
