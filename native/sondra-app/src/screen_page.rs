//! Bildschirm aufnehmen (`ScreenPanel.tsx`): the screen or one window as a video, with the computer's sound
//! and/or the microphone. FFmpeg grabs the picture (`sondra_media::capture`), the app takes the sound and joins
//! it at the end. What the web app's pause does is not here: FFmpeg's grabber cannot be held and let go.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_audio::{open_input, open_loopback, Capture};
use sondra_media::capture::{input_args, Recorder, Source};
use sondra_media::Ffmpeg;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::shell::Shell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum What {
    Screen,
    Window(String),
}

struct Running {
    recorder: Recorder,
    stop: Arc<AtomicBool>,
    sound: Option<JoinHandle<Vec<(Vec<f32>, u32)>>>,
}

pub struct ScreenState {
    pub what: What,
    pub windows: Vec<String>,
    pub choosing_window: bool,
    pub system_sound: bool,
    pub microphone: bool,
    pub fps: u32,
    running: Option<Running>,
    pub busy: bool,
    pub error: Option<String>,
    pub made: Vec<PathBuf>,
    /// Instead of the screen: what FFmpeg is to read (tests bring a test pattern).
    input: Option<Vec<String>>,
    out_dir: Option<PathBuf>,
    ticking: bool,
}

impl ScreenState {
    pub fn new() -> ScreenState {
        ScreenState { what: What::Screen, windows: Vec::new(), choosing_window: false, system_sound: cfg!(windows), microphone: false, fps: 30, running: None, busy: false, error: None, made: Vec::new(), input: None, out_dir: None, ticking: false }
    }
}

impl Default for ScreenState {
    fn default() -> Self {
        Self::new()
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

impl Shell {
    /// For tests: what FFmpeg reads instead of the screen, and where the file goes.
    pub fn screen_with(&mut self, input: Vec<String>, out_dir: PathBuf) {
        self.screen.input = Some(input);
        self.screen.out_dir = Some(out_dir);
        self.screen.system_sound = false;
    }

    pub fn screen_recording(&self) -> bool {
        self.screen.running.is_some()
    }

    pub fn screen_made(&self) -> Vec<PathBuf> {
        self.screen.made.clone()
    }

    pub fn screen_busy(&self) -> bool {
        self.screen.busy
    }

    pub fn screen_error(&self) -> Option<String> {
        self.screen.error.clone()
    }

    fn screen_refresh(&mut self, cx: &mut Context<Self>) {
        self.screen.windows = crate::system::visible_windows();
        cx.notify();
    }

    pub fn screen_start(&mut self, cx: &mut Context<Self>) {
        let s = &mut self.screen;
        if s.running.is_some() || s.busy {
            return;
        }
        s.error = None;
        let Some(ffmpeg) = Ffmpeg::locate() else {
            s.error = Some("FFmpeg ist nicht da: ohne es lässt sich der Bildschirm nicht aufnehmen.".into());
            cx.notify();
            return;
        };
        let input = s.input.clone().unwrap_or_else(|| input_args(&match &s.what {
            What::Screen => Source::Screen,
            What::Window(title) => Source::Window(title.clone()),
        }, s.fps));
        let dir = std::env::temp_dir().join(format!("Sondra-Aufnahme-{}", std::process::id()));
        let recorder = match Recorder::start(&ffmpeg, &input, s.fps, &dir) {
            Ok(r) => r,
            Err(e) => {
                s.error = Some(e.to_string());
                cx.notify();
                return;
            }
        };
        // The sound is taken on a thread of its own (a sound stream belongs to the thread that opened it).
        let stop = Arc::new(AtomicBool::new(false));
        let (system, microphone) = (s.system_sound, s.microphone);
        let sound = (system || microphone).then(|| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut sources: Vec<Box<dyn Capture>> = Vec::new();
                if system {
                    if let Ok(m) = open_loopback() {
                        sources.push(Box::new(m));
                    }
                }
                if microphone {
                    if let Ok(m) = open_input(None) {
                        sources.push(Box::new(m));
                    }
                }
                let mut tracks: Vec<(Vec<f32>, u32)> = sources.iter().map(|c| (Vec::new(), c.rate())).collect();
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(50));
                    for (source, track) in sources.iter_mut().zip(tracks.iter_mut()) {
                        track.0.extend(source.take());
                    }
                }
                for (source, track) in sources.iter_mut().zip(tracks.iter_mut()) {
                    track.0.extend(source.take());
                }
                tracks
            })
        });
        s.running = Some(Running { recorder, stop, sound });
        self.screen_ticker(cx);
        cx.notify();
    }

    fn screen_ticker(&mut self, cx: &mut Context<Self>) {
        if self.screen.ticking {
            return;
        }
        self.screen.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let alive = this.update(cx, |shell, cx| {
                let s = &mut shell.screen;
                // A grabber that ended by itself (the window was closed) ends the recording, too.
                let ended = s.running.as_mut().is_some_and(|r| r.recorder.ended());
                if ended {
                    shell.screen_stop(cx);
                }
                cx.notify();
                let alive = shell.screen.running.is_some();
                if !alive {
                    shell.screen.ticking = false;
                }
                alive
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    /// Ends the recording and makes the file (in the background).
    pub fn screen_stop(&mut self, cx: &mut Context<Self>) {
        let Some(running) = self.screen.running.take() else { return };
        self.screen.busy = true;
        let dir = self.screen.out_dir.clone().unwrap_or_else(crate::store::downloads_dir);
        let out = dir.join(format!("Bildschirmaufnahme-{}.mp4", chrono::Local::now().format("%Y-%m-%d-%H%M%S")));
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                running.stop.store(true, Ordering::SeqCst);
                let tracks = running.sound.map(|t| t.join().unwrap_or_default()).unwrap_or_default();
                // A track that took nothing (no device) is left out.
                let tracks: Vec<(Vec<f32>, u32)> = tracks.into_iter().filter(|(samples, _)| !samples.is_empty()).collect();
                let ffmpeg = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                running.recorder.finish(&ffmpeg, &tracks, &out).map_err(|e| e.to_string())?;
                Ok(out)
            },
            |shell, answer, cx| {
                shell.screen.busy = false;
                match answer {
                    Ok(path) => shell.screen.made.insert(0, path),
                    Err(e) => shell.screen.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub(crate) fn screen_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.screen;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Bildschirm aufnehmen", "Der ganze Bildschirm oder ein Fenster als Video — auf Wunsch mit dem Ton des Rechners und mit dem Mikrofon. Die Aufnahme bleibt auf diesem Computer."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        // A recording under way has the whole width, on its tint; otherwise what to record is set in the
        // settings column and the work is the button that starts it.
        let mut block = div().flex().flex_col().gap(px(14.)).when(s.running.is_some(), |d| d.p(px(20.)).rounded(px(radius::CARD)).bg(c.panel_soft));
        let mut settings: Vec<AnyElement> = Vec::new();

        if let Some(running) = &s.running {
            let stop = me.clone();
            block = block
                .child(ui.title(format!("Nimmt auf · {}", clock(running.recorder.seconds()))))
                .child(ui.hint(match &s.what {
                    What::Screen => "Der ganze Bildschirm.".to_string(),
                    What::Window(title) => format!("Das Fenster „{title}“."),
                }))
                .child(div().flex().child(ui.button("aufnahme-beenden", "Aufnahme beenden").primary().on_click(move |_, app| stop.update(app, |sh, cx| sh.screen_stop(cx)))));
        } else if s.busy {
            block = block.child(ui.prose("Die Aufnahme wird abgeschlossen …"));
        } else {
            let mut side = div().flex().flex_col().gap(px(18.));
            let (whole, window, refresh) = (me.clone(), me.clone(), me.clone());
            side = side.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title("Was aufnehmen?"))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .child(ui.chip("aufnahme-schirm", "Ganzer Bildschirm", s.what == What::Screen).on_click(move |_, app| whole.update(app, |sh, cx| {
                                sh.screen.what = What::Screen;
                                sh.screen.choosing_window = false;
                                cx.notify();
                            })))
                            .child(ui.chip("aufnahme-fenster", "Ein Fenster", s.choosing_window || matches!(s.what, What::Window(_))).on_click(move |_, app| window.update(app, |sh, cx| {
                                sh.screen.choosing_window = true;
                                sh.screen_refresh(cx);
                            }))),
                    ),
            );
            if s.choosing_window || matches!(s.what, What::Window(_)) {
                let mut list = div().flex().flex_wrap().gap(px(6.));
                for (n, title) in s.windows.iter().enumerate() {
                    let me = me.clone();
                    let shown: String = if title.chars().count() > 50 { format!("{}…", title.chars().take(49).collect::<String>()) } else { title.clone() };
                    let chosen = s.what == What::Window(title.clone());
                    let t = title.clone();
                    list = list.child(ui.chip(format!("fenster-{n}"), shown, chosen).accessible_name(format!("Fenster {title}")).on_click(move |_, app| me.update(app, |sh, cx| {
                        sh.screen.what = What::Window(t.clone());
                        cx.notify();
                    })));
                }
                side = side.child(list);
                if s.windows.is_empty() {
                    side = side.child(ui.hint(if cfg!(windows) { "Kein Fenster gefunden. Öffnen Sie das Fenster und suchen Sie erneut." } else { "Fenster lassen sich nur unter Windows wählen." }));
                }
                side = side.child(div().flex().child(ui.button("fenster-suchen", "Erneut suchen").small().on_click(move |_, app| refresh.update(app, |sh, cx| sh.screen_refresh(cx)))));
            }
            let (system, mic, f30, f60) = (me.clone(), me.clone(), me.clone(), me.clone());
            side = side.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title("Ton"))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .child(ui.chip("ton-rechner", "Ton des Rechners", s.system_sound).on_click(move |_, app| system.update(app, |sh, cx| {
                                sh.screen.system_sound = !sh.screen.system_sound;
                                cx.notify();
                            })))
                            .child(ui.chip("ton-mikrofon", "Mikrofon", s.microphone).on_click(move |_, app| mic.update(app, |sh, cx| {
                                sh.screen.microphone = !sh.screen.microphone;
                                cx.notify();
                            }))),
                    ),
            );
            side = side.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.title("Bilder je Sekunde"))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .child(ui.chip("bilder-30", "30", s.fps == 30).on_click(move |_, app| f30.update(app, |sh, cx| {
                                sh.screen.fps = 30;
                                cx.notify();
                            })))
                            .child(ui.chip("bilder-60", "60", s.fps == 60).on_click(move |_, app| f60.update(app, |sh, cx| {
                                sh.screen.fps = 60;
                                cx.notify();
                            }))),
                    ),
            );
            settings.push(side.into_any_element());
            let start = me.clone();
            block = block.child(div().flex().child(ui.button("aufnahme-starten", "Aufnahme starten").primary().disabled(s.choosing_window && !matches!(s.what, What::Window(_))).on_click(move |_, app| start.update(app, |sh, cx| sh.screen_start(cx)))));
        }
        let mut work = div().flex().flex_col().gap(px(20.)).child(block);

        if !s.made.is_empty() {
            let mut list = div().flex().flex_col().gap(px(8.)).child(ui.subheading("Aufgenommen"));
            for (n, path) in s.made.iter().enumerate() {
                let (play, show) = (me.clone(), me.clone());
                let (p, folder) = (path.clone(), path.parent().map(PathBuf::from));
                list = list.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(10.))
                        .child(ui.value(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
                        .child(ui.button(format!("aufnahme-abspielen-{n}"), "Abspielen").small().on_click(move |_, app| {
                            let p = p.clone();
                            play.update(app, |sh, cx| {
                                sh.go(crate::nav::Panel::Player, cx);
                                sh.play_files(vec![p], cx);
                            })
                        }))
                        .children(self.drive_button(&ui, format!("aufnahme-drive-{n}"), path, &path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), cx))
                        .child(ui.button(format!("aufnahme-zeigen-{n}"), "Im Ordner zeigen").small().on_click(move |_, app| {
                            if let Some(folder) = folder.clone() {
                                show.update(app, |sh, cx| {
                                    sh.go(crate::nav::Panel::Folder, cx);
                                    sh.open_folder(folder, cx);
                                })
                            }
                        })),
                );
            }
            work = work.child(list);
        }
        page.child(ui.tool_body(settings, work)).into_any_element()
    }
}
