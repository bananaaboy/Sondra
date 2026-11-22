//! The Mikrofon page: switch the microphone on and watch its level, record two takes — the room, then the
//! voice — and let `sondra-media::mic` set the chain for what the recording is for; every step says what it
//! did and with which numbers. The takes stay on this computer, nothing is sent anywhere, and nothing
//! touches the device: a program cannot turn a microphone's input gain, so that part is advice.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context, PathPromptOptions};
use sondra_audio::{input_devices, open_input, output_devices, Capture};
use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::mic::{calibrate, profile_for, Calibration, Purpose, Tone, PURPOSES};
use sondra_media::Ffmpeg;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// Opens a microphone by name (the default for `None`). A test brings its own.
pub type OpenMic = Arc<dyn Fn(Option<&str>) -> Result<Box<dyn Capture>, String>>;
pub type ListMics = Arc<dyn Fn() -> Vec<String>>;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Phase {
    Idle,
    /// The silent take: how many seconds are in.
    Noise,
    Speech,
    Working,
    /// A sample to listen to (up to 15 s).
    Probe,
}

pub struct MicState {
    pub open: OpenMic,
    pub list: ListMics,
    pub capture: Option<Box<dyn Capture>>,
    pub device: Option<String>,
    pub purpose: Purpose,
    pub level: f32,
    /// The loudest in the last moments, so that a clip is not missed between two looks.
    pub peak: f32,
    pub phase: Phase,
    pub take: Vec<f32>,
    pub noise: Vec<f32>,
    pub rate: u32,
    pub noise_seconds: f64,
    pub speech_seconds: f64,
    pub result: Option<Arc<Calibration>>,
    pub error: Option<String>,
    pub made: Vec<PathBuf>,
    pub applying: bool,
    ticking: bool,
    /// The output devices, and the one chosen (`None`: the system's default).
    pub outputs: ListMics,
    pub output: Option<String>,
    pub tone_said: Option<String>,
    pub probe: Option<AudioData>,
    /// „Ein-Klick-Sprachverbesserung (KI)“ for the sample; on, as on the website.
    pub enhance_probe: bool,
    pub listening: Option<(crate::clip_player::ClipPlayer, crate::mic_more::Listening)>,
    pub one_click: bool,
    /// What the last move into the session said.
    pub said: Option<String>,
    /// „Mithören“.
    pub monitor: Option<crate::mic_more::Monitor>,
}

impl MicState {
    pub fn new() -> MicState {
        MicState {
            open: Arc::new(|name| open_input(name).map(|m| Box::new(m) as Box<dyn Capture>).map_err(|e| e.to_string())),
            list: Arc::new(input_devices),
            capture: None,
            device: None,
            purpose: Purpose::Podcast,
            level: 0.0,
            peak: 0.0,
            phase: Phase::Idle,
            take: Vec::new(),
            noise: Vec::new(),
            rate: 48000,
            noise_seconds: 5.0,
            speech_seconds: 8.0,
            result: None,
            error: None,
            made: Vec::new(),
            applying: false,
            ticking: false,
            outputs: Arc::new(output_devices),
            output: sondra_audio::chosen_output_device(),
            tone_said: None,
            probe: None,
            enhance_probe: true,
            listening: None,
            one_click: false,
            said: None,
            monitor: None,
        }
    }
}

impl Default for MicState {
    fn default() -> Self {
        Self::new()
    }
}

/// „−14,0 dB“ with a real minus and a comma.
fn db(value: f64) -> String {
    if value <= -199.0 {
        return "−∞ dB".into();
    }
    format!("{} dB", format!("{value:.1}").replace('.', ",").replacen('-', "−", 1))
}

impl Shell {
    /// Hands the page another way to find and open microphones (a test, or a recorder of another kind).
    pub fn mic_with(&mut self, open: OpenMic, list: ListMics) {
        self.mic.open = open;
        self.mic.list = list;
    }

    /// „Mikrofon einschalten“ — and, when another device is chosen, the same again.
    pub fn mic_enable(&mut self, device: Option<String>, cx: &mut Context<Self>) {
        self.mic.error = None;
        self.mic.capture = None;
        match (self.mic.open)(device.as_deref()) {
            Ok(capture) => {
                self.mic.rate = capture.rate();
                self.mic.device = Some(capture.name());
                self.mic.capture = Some(capture);
                self.mic.phase = Phase::Idle;
                self.mic.level = 0.0;
                self.mic.peak = 0.0;
                self.mic_start_ticker(cx);
            }
            Err(e) => self.mic.error = Some(e),
        }
        cx.notify();
    }

    /// „Mikrofon ausschalten“: the device is let go of, here as in the web app.
    pub fn mic_disable(&mut self, cx: &mut Context<Self>) {
        self.mic.capture = None;
        self.mic.listening = None;
        self.mic.monitor = None;
        self.mic.phase = Phase::Idle;
        self.mic.take.clear();
        self.mic.level = 0.0;
        self.mic.peak = 0.0;
        cx.notify();
    }

    fn mic_start_ticker(&mut self, cx: &mut Context<Self>) {
        if self.mic.ticking {
            return;
        }
        self.mic.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
            let alive = this.update(cx, |shell, cx| {
                shell.mic_tick(cx);
                if shell.mic.capture.is_none() {
                    shell.mic.ticking = false;
                }
                shell.mic.capture.is_some()
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    /// One look at the microphone: the level, and what the running take has gathered.
    pub fn mic_tick(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mic;
        let Some(capture) = m.capture.as_mut() else { return };
        let level = capture.level();
        m.level = level;
        m.peak = if level >= m.peak { level } else { (m.peak - 0.03).max(level) };
        let data = capture.take();
        if let Some(monitor) = &m.monitor {
            monitor.feed(&data);
        }
        let rate = f64::from(m.rate);
        match m.phase {
            Phase::Noise | Phase::Speech => {
                m.take.extend(data);
                let wanted = if m.phase == Phase::Noise { m.noise_seconds } else { m.speech_seconds };
                if m.take.len() as f64 / rate >= wanted {
                    let take = std::mem::take(&mut m.take);
                    if m.phase == Phase::Noise {
                        m.noise = take;
                        m.phase = Phase::Speech;
                    } else {
                        m.phase = Phase::Working;
                        self.mic_calibrate(take, cx);
                    }
                }
            }
            Phase::Probe => {
                m.take.extend(data);
                if m.take.len() as f64 / rate >= crate::mic_more::PROBE_SECONDS {
                    self.mic_probe_done(cx);
                }
            }
            _ => {}
        }
        cx.notify();
    }

    /// „Für Podcast einstellen“: the room first.
    pub fn mic_begin(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mic;
        if m.capture.is_none() || m.phase != Phase::Idle {
            return;
        }
        if let Some(capture) = m.capture.as_mut() {
            let _ = capture.take();
        }
        m.take.clear();
        m.result = None;
        m.made.clear();
        m.error = None;
        m.phase = Phase::Noise;
        cx.notify();
    }

    fn mic_calibrate(&mut self, speech: Vec<f32>, cx: &mut Context<Self>) {
        let (noise, rate, purpose) = (self.mic.noise.clone(), self.mic.rate, self.mic.purpose);
        Self::in_background(
            cx,
            move || calibrate(&noise, &speech, rate, purpose),
            |shell, answer, cx| {
                let m = &mut shell.mic;
                m.phase = Phase::Idle;
                match answer {
                    Ok(done) => m.result = Some(Arc::new(done)),
                    Err(e) => m.error = Some(e),
                }
                cx.notify();
            },
        );
    }

    pub fn mic_purpose(&mut self, purpose: Purpose, cx: &mut Context<Self>) {
        if self.mic.phase == Phase::Idle {
            self.mic.purpose = purpose;
            self.mic.result = None;
            cx.notify();
        }
    }

    fn mic_folder() -> PathBuf {
        crate::store::downloads_dir()
    }

    /// Writes before and after next to each other and says where.
    pub fn mic_save(&mut self, cx: &mut Context<Self>) {
        let Some(result) = self.mic.result.clone() else { return };
        let label = profile_for(self.mic.purpose).label;
        let dir = Self::mic_folder();
        Self::in_background(
            cx,
            move || -> Result<Vec<PathBuf>, String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let one = |audio: &AudioData, name: String| -> Result<PathBuf, String> {
                    let path = sondra_media::run::unique_path(&dir, &name, "wav");
                    write_wav_f32(&path, audio).map_err(|e| e.to_string())?;
                    Ok(path)
                };
                Ok(vec![one(&result.processed, format!("Mikrofon-Probe ({label}, verbessert)"))?, one(&result.raw, format!("Mikrofon-Probe ({label}, Original)"))?])
            },
            |shell, answer, cx| {
                match answer {
                    Ok(paths) => shell.mic.made = paths,
                    Err(e) => shell.mic.error = Some(e),
                }
                cx.notify();
            },
        );
    }

    /// Plays the processed or the raw take in the player, for the before-and-after.
    pub fn mic_listen(&mut self, processed: bool, cx: &mut Context<Self>) {
        let Some(result) = self.mic.result.clone() else { return };
        let audio = if processed { result.processed.clone() } else { result.raw.clone() };
        let path = std::env::temp_dir().join("sondra-mikrofon").join(if processed { "Probe (verbessert).wav" } else { "Probe (Original).wav" });
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = write_wav_f32(&path, &audio) {
            self.mic.error = Some(e.to_string());
            cx.notify();
            return;
        }
        self.go(Panel::Player, cx);
        self.play_files(vec![path], cx);
    }

    pub(crate) fn mic_choose_recording(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.mic_apply(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// The same chain on any recording from this microphone and room, written beside it.
    pub fn mic_apply(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(result) = self.mic.result.clone() else { return };
        if self.mic.applying {
            return;
        }
        self.mic.applying = true;
        self.mic.error = None;
        let rate = self.mic.rate;
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let audio = decode_file(&ff, &path, Some(rate)).map_err(|e| e.to_string())?;
                let cleaned = result.apply(&audio)?;
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Aufnahme".into());
                let target = sondra_media::run::unique_path(path.parent().unwrap_or(std::path::Path::new(".")), &format!("{stem} (verbessert)"), "wav");
                write_wav_f32(&target, &cleaned).map_err(|e| e.to_string())?;
                Ok(target)
            },
            |shell, answer, cx| {
                shell.mic.applying = false;
                match answer {
                    Ok(path) => shell.mic.made.push(path),
                    Err(e) => shell.mic.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// How long the two takes run (a test makes them short).
    pub fn mic_set_seconds(&mut self, noise: f64, speech: f64) {
        self.mic.noise_seconds = noise;
        self.mic.speech_seconds = speech;
    }

    /// For tests.
    pub fn mic_result(&self) -> Option<Arc<Calibration>> {
        self.mic.result.clone()
    }
    pub fn mic_made(&self) -> &[PathBuf] {
        &self.mic.made
    }

    pub(crate) fn mic_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let m = &self.mic;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Mikrofon testen und einstellen", "Zwei kurze Aufnahmen — erst der Raum, dann Ihre Stimme — genügen: Sondra misst Rauschen, Brummen und Pegel und stellt die Kette für Ihren Zweck ein. Die Aufnahmen bleiben auf diesem Computer. Nichts wird gesendet."));
        if let Some(error) = &m.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        // What the recording is for: a setting, chosen before or after the microphone is on.
        let profile = profile_for(m.purpose);
        let mut chips = div().flex().flex_wrap().gap(px(6.));
        for p in PURPOSES {
            let me = me.clone();
            chips = chips.child(ui.chip(format!("zweck-{}", p.label), p.label, p.id == m.purpose).accessible_name(format!("Zweck {}", p.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.mic_purpose(p.id, cx))));
        }
        let purpose = ui.setting("Wofür ist die Aufnahme?", chips, Some(profile.hint));
        if m.capture.is_none() {
            let button = {
                let me = me.clone();
                ui.button("mikrofon-einschalten", "Mikrofon einschalten").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.mic_enable(None, cx)))
            };
            let mut work = div().flex().flex_col().gap(px(20.)).child(ui.empty("mikrofon-leer", "Mikrofon einschalten", "Es wird erst auf diesen Knopf geöffnet und beim Verlassen des Werkzeugs wieder freigegeben. Zwei kurze Aufnahmen genügen.", vec![button.into_any_element()]));
            if let Some(said) = &m.said {
                work = work.child(ui.notice(NoticeKind::Info, said.clone()));
            }
            work = work.child(self.mic_one_click_block(&ui, cx));
            let output = self.mic_output_block(&ui, cx);
            return page.child(ui.tool_body(vec![purpose, output], work)).into_any_element();
        }

        // The device and its level.
        let devices = (m.list)();
        let mut device = div().flex().flex_col().gap(px(10.)).child(ui.title("Mikrofon")).child(ui.value(m.device.clone().unwrap_or_default()));
        if devices.len() > 1 {
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            for name in devices {
                let me = me.clone();
                let selected = m.device.as_deref() == Some(name.as_str());
                let n = name.clone();
                chips = chips.child(ui.chip(format!("mikrofon-{name}"), name.clone(), selected).accessible_name(format!("Mikrofon {name}")).on_click(move |_, app| {
                    let n = n.clone();
                    me.update(app, |shell, cx| shell.mic_enable(Some(n), cx))
                }));
            }
            device = device.child(chips);
        }
        device = device.child(ui.bar("pegel", Some(m.level), "Pegel"));
        {
            let me = me.clone();
            let on = m.monitor.is_some();
            device = device.child(div().flex().flex_col().gap(px(4.)).child(div().flex().child(ui.chip("mithoeren", "Mithören", on).accessible_name("Mithören: sich selbst über den Ausgang hören").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_set_monitor(!on, cx))))).child(ui.hint("Sich selbst über den Ausgang hören. Nur mit Kopfhörern — über Lautsprecher pfeift es.")));
        }
        if m.peak >= 0.98 {
            device = device.child(ui.notice(NoticeKind::Warning, "Übersteuert: Der Pegel ist am Anschlag. Den Eingangspegel am Mikrofon oder in Windows etwas senken."));
        }
        {
            let me = me.clone();
            device = device.child(div().flex().child(ui.button("mikrofon-ausschalten", "Mikrofon ausschalten").small().on_click(move |_, app| me.update(app, |shell, cx| shell.mic_disable(cx)))));
        }
        let output = self.mic_output_block(&ui, cx);
        let settings = vec![device.into_any_element(), output, purpose];
        let mut work = div().flex().flex_col().gap(px(20.));
        if let Some(said) = &m.said {
            work = work.child(ui.notice(NoticeKind::Info, said.clone()));
        }


        // The takes.
        let seconds = |len: usize| len as f64 / f64::from(m.rate);
        match m.phase {
            Phase::Idle => {
                let me = me.clone();
                let label = if m.result.is_some() { "Neu einstellen".to_string() } else { format!("Für {} einstellen", profile.label) };
                work = work.child(div().flex().child(ui.button("einstellen", label).primary_when(m.result.is_none()).on_click(move |_, app| me.update(app, |shell, cx| shell.mic_begin(cx)))));
            }
            Phase::Noise => {
                work = work.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .p(px(16.))
                        .rounded(px(radius::CARD))
                        .bg(c.panel_soft)
                        .child(ui.title("Jetzt bitte ruhig sein"))
                        .child(ui.prose("Nicht sprechen, nicht tippen, die Maus ruhen lassen. Gemessen wird, wie der Raum klingt, wenn niemand etwas sagt."))
                        .child(ui.bar("aufnahme-ruhe", Some((seconds(m.take.len()) / m.noise_seconds) as f32), "Aufnahme des Raums")),
                );
            }
            Phase::Speech => {
                let verb = match m.purpose {
                    Purpose::Instrument => "Jetzt spielen",
                    Purpose::Vocals => "Jetzt singen",
                    _ => "Jetzt sprechen",
                };
                work = work.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .p(px(16.))
                        .rounded(px(radius::CARD))
                        .bg(c.panel_soft)
                        .child(ui.title(verb))
                        .child(ui.prose(profile.prompt))
                        .child(ui.bar("aufnahme-stimme", Some((seconds(m.take.len()) / m.speech_seconds) as f32), "Aufnahme der Stimme")),
                );
            }
            Phase::Working => work = work.child(ui.prose("Rechnet …")),
            Phase::Probe => {}
        }
        if matches!(m.phase, Phase::Idle | Phase::Probe) {
            work = work.child(self.mic_probe_block(&ui, cx));
        }

        if let Some(done) = &m.result {
            let written: Vec<AnyElement> = m.made.iter().map(|path| self.written_row(&ui, path, cx)).collect();
            work = work.child(result_block(ui, &me, m, done, written));
        }
        work = work.child(self.mic_one_click_block(&ui, cx));
        page.child(ui.tool_body(settings, work)).into_any_element()
    }
}

fn result_block(ui: Ui, me: &gpui::Entity<Shell>, m: &MicState, done: &Calibration, written: Vec<AnyElement>) -> AnyElement {
    let c = ui.c;
    let mut block = div().flex().flex_col().gap(px(18.));
    let row = |label: &str, value: String| div().flex().justify_between().gap(px(12.)).py(px(6.)).border_t_1().border_color(c.line).child(ui.prose(label.to_string())).child(ui.value(value));
    block = block.child(
        div()
            .flex()
            .flex_col()
            .child(ui.subheading("Vorher und nachher"))
            .child(row("Rauschen im Raum", format!("{} → {}", db(done.before.noise_floor_db), db(done.after.noise_floor_db))))
            .child(row("Stimme", format!("{} → {}", db(done.before.speech_db), db(done.after.speech_db))))
            .child(row("Abstand Stimme zu Rauschen", format!("{} → {}", db(done.before.snr_db), db(done.after.snr_db))))
            .child(row("Lautheit", format!("{} LUFS", format!("{:.1}", done.after.lufs).replace('.', ",").replacen('-', "−", 1))))
            .child(row("Spitzenpegel", format!("{} → {} TP", db(done.before.peak_db), format!("{:.1} dBTP", done.after.true_peak_dbtp).replace('.', ",").replacen('-', "−", 1)))),
    );
    for advice in &done.advice {
        block = block.child(ui.notice(if advice.tone == Tone::Warn { NoticeKind::Warning } else { NoticeKind::Info }, format!("{}: {}", advice.title, advice.text)));
    }
    let mut steps = div().flex().flex_col().gap(px(10.)).child(ui.subheading("Was gemacht wurde"));
    for step in &done.steps {
        steps = steps.child(div().flex().flex_col().gap(px(2.)).child(ui.title(step.title.clone())).child(ui.prose(step.detail.clone())));
    }
    block = block.child(steps);

    let busy = m.applying;
    let mut buttons = div().flex().flex_wrap().gap(px(8.));
    {
        let me = me.clone();
        buttons = buttons.child(ui.button("vorher-hoeren", "Vorher anhören").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_listen(false, cx))));
    }
    {
        let me = me.clone();
        buttons = buttons.child(ui.button("nachher-hoeren", "Nachher anhören").primary().on_click(move |_, app| me.update(app, |shell, cx| shell.mic_listen(true, cx))));
    }
    {
        let me = me.clone();
        buttons = buttons.child(ui.button("probe-speichern", "Als WAV speichern").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_save(cx))));
    }
    {
        let me = me.clone();
        buttons = buttons.child(ui.button("einstellung-in-sitzung", "In die Sitzung").accessible_name("Verbesserte Aufnahme in die Sitzung").on_click(move |_, app| me.update(app, |shell, cx| shell.mic_processed_to_session(cx))));
    }
    {
        let me = me.clone();
        buttons = buttons.child(ui.button("auf-aufnahme", if busy { "Verbessert …" } else { "Auf eine Aufnahme anwenden" }).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mic_choose_recording(cx))));
    }
    block = block.child(buttons);
    for row in written {
        block = block.child(row);
    }
    block.into_any_element()
}
