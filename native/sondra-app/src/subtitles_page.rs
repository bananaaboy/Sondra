//! The Untertitel page: a film or a recording, listened to by Whisper on this computer, becomes text,
//! subtitles (SRT, WebVTT) and a subtitle track in the film or burned into the picture. The sound never
//! leaves the computer; only the model comes from Hugging Face, once, and only when the person presses the
//! button that says so. The recognition is `sondra-speech` (whisper.cpp), the formats are the web app's.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gpui::{div, prelude::*, px, AnyElement, Context, PathPromptOptions};
use sondra_media::audio::{decode_file, mix_to_mono};
use sondra_media::Ffmpeg;
use sondra_speech::cues::{to_cues, to_srt, to_text, to_vtt};
use sondra_speech::engine::{Recognizer, SpeechError};
use sondra_speech::model::{fetch, is_present, model_by_id, path_of, FetchError, MODELS, SOURCE};
use sondra_speech::Segment;
use sondra_ui::{radius, NoticeKind, Ui};

use crate::shell::Shell;

pub const LANGUAGES: [(&str, &str); 14] = [
    ("auto", "Automatisch erkennen"),
    ("de", "Deutsch"),
    ("en", "Englisch"),
    ("fr", "Französisch"),
    ("it", "Italienisch"),
    ("es", "Spanisch"),
    ("pt", "Portugiesisch"),
    ("nl", "Niederländisch"),
    ("pl", "Polnisch"),
    ("tr", "Türkisch"),
    ("sq", "Albanisch"),
    ("sr", "Serbisch"),
    ("hr", "Kroatisch"),
    ("ta", "Tamil"),
];

/// What the worker thread says, read by the page twice a second or so.
#[derive(Default)]
pub struct Job {
    pub fetched: Option<(u64, u64)>,
    pub status: &'static str,
    pub share: f64,
    pub done_seconds: f64,
    pub segments: Vec<Segment>,
    pub finished: Option<Result<(), String>>,
}

pub struct SubtitlesState {
    pub path: Option<PathBuf>,
    pub model: &'static str,
    pub language: &'static str,
    /// Where the models are kept.
    pub models_dir: PathBuf,
    /// Where the model comes from; a test brings its own server.
    pub source: String,
    pub job: Option<Arc<Mutex<Job>>>,
    cancel: Arc<AtomicBool>,
    pub segments: Vec<Segment>,
    pub error: Option<String>,
    pub made: Vec<PathBuf>,
    pub writing: bool,
    ticking: bool,
}

impl SubtitlesState {
    pub fn new() -> SubtitlesState {
        SubtitlesState {
            path: None,
            model: MODELS[0].id,
            language: "auto",
            models_dir: crate::store::data_dir().map(|d| d.join("Modelle")).unwrap_or_else(|| PathBuf::from("Modelle")),
            source: SOURCE.to_owned(),
            job: None,
            cancel: Arc::new(AtomicBool::new(false)),
            segments: Vec::new(),
            error: None,
            made: Vec::new(),
            writing: false,
            ticking: false,
        }
    }
}

impl Default for SubtitlesState {
    fn default() -> Self {
        Self::new()
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0);
    format!("{}:{:02}", (s / 60.0).floor() as u64, (s % 60.0).floor() as u64)
}

fn megabytes(bytes: u64) -> String {
    format!("{:.0} MB", bytes as f64 / 1_000_000.0)
}

impl Shell {
    pub(crate) fn choose_subtitles_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.subtitles_take(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    pub fn subtitles_take(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let s = &mut self.subtitles;
        s.path = Some(path);
        s.segments.clear();
        s.made.clear();
        s.error = None;
        cx.notify();
    }

    /// For tests: where the models are, and where they would come from.
    pub fn subtitles_set_places(&mut self, dir: PathBuf, source: String) {
        self.subtitles.models_dir = dir;
        self.subtitles.source = source;
    }

    pub fn subtitles_set(&mut self, model: &'static str, language: &'static str, cx: &mut Context<Self>) {
        if self.subtitles.job.as_ref().is_some_and(|j| j.lock().unwrap().finished.is_none()) {
            return;
        }
        self.subtitles.model = model;
        self.subtitles.language = language;
        cx.notify();
    }

    fn subtitles_ticker(&mut self, cx: &mut Context<Self>) {
        if self.subtitles.ticking {
            return;
        }
        self.subtitles.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(150)).await;
            let alive = this.update(cx, |shell, cx| {
                let s = &mut shell.subtitles;
                let mut running = false;
                if let Some(job) = &s.job {
                    let j = job.lock().unwrap();
                    s.segments = j.segments.clone();
                    match &j.finished {
                        None => running = true,
                        Some(Err(e)) if !e.is_empty() => s.error = Some(e.clone()),
                        Some(_) => {}
                    }
                }
                if !running {
                    s.ticking = false;
                }
                cx.notify();
                running
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    /// „Modell laden“: only on the person's say-so.
    pub fn subtitles_fetch(&mut self, cx: &mut Context<Self>) {
        let s = &mut self.subtitles;
        if s.job.as_ref().is_some_and(|j| j.lock().unwrap().finished.is_none()) {
            return;
        }
        let model = model_by_id(s.model);
        let (dir, source) = (s.models_dir.clone(), s.source.clone());
        let job = Arc::new(Mutex::new(Job { status: "Lädt das Sprachmodell …", fetched: Some((0, model.bytes)), ..Default::default() }));
        s.job = Some(job.clone());
        s.cancel.store(false, Ordering::SeqCst);
        s.error = None;
        let cancel = s.cancel.clone();
        std::thread::spawn(move || {
            let j = job.clone();
            let result = fetch(&dir, &model, &source, &|| cancel.load(Ordering::SeqCst), &mut |done, total| j.lock().unwrap().fetched = Some((done, total)));
            let mut j = job.lock().unwrap();
            j.fetched = None;
            j.finished = Some(match result {
                Ok(_) => Ok(()),
                Err(FetchError::Cancelled) => Err(String::new()),
                Err(e) => Err(e.to_string()),
            });
        });
        self.subtitles_ticker(cx);
        cx.notify();
    }

    /// „Untertitel erzeugen“: the sound is read, listened to and turned into segments.
    pub fn subtitles_start(&mut self, cx: &mut Context<Self>) {
        let s = &mut self.subtitles;
        let Some(path) = s.path.clone() else { return };
        let model = model_by_id(s.model);
        if !is_present(&s.models_dir, &model) || s.job.as_ref().is_some_and(|j| j.lock().unwrap().finished.is_none()) {
            return;
        }
        let (model_path, language) = (path_of(&s.models_dir, &model), s.language);
        let job = Arc::new(Mutex::new(Job { status: "Liest den Ton …", ..Default::default() }));
        s.job = Some(job.clone());
        s.segments.clear();
        s.made.clear();
        s.error = None;
        s.cancel.store(false, Ordering::SeqCst);
        let cancel = s.cancel.clone();
        std::thread::spawn(move || {
            let work = || -> Result<Vec<Segment>, SpeechError> {
                let ff = Ffmpeg::locate().ok_or_else(|| SpeechError::Run("FFmpeg ist nicht da.".into()))?;
                // One channel at 16 kHz is what Whisper wants; FFmpeg's resampler brings it there.
                let audio = decode_file(&ff, &path, Some(16000)).map_err(|e| SpeechError::Run(e.to_string()))?;
                let samples = mix_to_mono(&audio);
                if cancel.load(Ordering::SeqCst) {
                    return Err(SpeechError::Cancelled);
                }
                job.lock().unwrap().status = "Öffnet das Sprachmodell …";
                let recognizer = Recognizer::load(&model_path)?;
                job.lock().unwrap().status = "Hört ab …";
                let (progress, partial) = (job.clone(), job.clone());
                recognizer.transcribe(&samples, language, &|| cancel.load(Ordering::SeqCst), &mut |share, done| {
                    let mut j = progress.lock().unwrap();
                    j.share = share;
                    j.done_seconds = done;
                }, &mut |segments| partial.lock().unwrap().segments = segments.to_vec())
            };
            let result = work();
            let mut j = job.lock().unwrap();
            match result {
                Ok(segments) => {
                    j.segments = segments;
                    j.finished = Some(Ok(()));
                }
                Err(SpeechError::Cancelled) => j.finished = Some(Err(String::new())),
                Err(e) => j.finished = Some(Err(e.to_string())),
            }
        });
        self.subtitles_ticker(cx);
        cx.notify();
    }

    pub fn subtitles_cancel(&mut self, cx: &mut Context<Self>) {
        self.subtitles.cancel.store(true, Ordering::SeqCst);
        cx.notify();
    }

    fn subtitles_stem(&self) -> String {
        self.subtitles.path.as_ref().and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untertitel".into())
    }

    /// Writes the text, the SRT or the VTT beside the file.
    pub fn subtitles_save(&mut self, kind: &'static str, cx: &mut Context<Self>) {
        let (Some(path), false) = (self.subtitles.path.clone(), self.subtitles.segments.is_empty()) else { return };
        let segments = self.subtitles.segments.clone();
        let (dir, stem) = (path.parent().map(PathBuf::from).unwrap_or_default(), self.subtitles_stem());
        let (text, ext) = match kind {
            "srt" => (to_srt(&segments), "srt"),
            "vtt" => (to_vtt(&segments), "vtt"),
            _ => (to_text(&segments), "txt"),
        };
        self.subtitles.writing = true;
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let target = sondra_media::run::unique_path(&dir, &stem, ext);
                std::fs::write(&target, text).map_err(|e| e.to_string())?;
                Ok(target)
            },
            |shell, answer, cx| {
                shell.subtitles.writing = false;
                match answer {
                    Ok(p) => shell.subtitles.made.push(p),
                    Err(e) => shell.subtitles.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The film again with the subtitles in it: as a track the player can switch off (`burn` false), or drawn
    /// into the picture. The film itself is never written over.
    pub fn subtitles_into_film(&mut self, burn: bool, cx: &mut Context<Self>) {
        let (Some(path), false) = (self.subtitles.path.clone(), self.subtitles.segments.is_empty()) else { return };
        let srt = to_srt(&self.subtitles.segments);
        let (dir, stem) = (path.parent().map(PathBuf::from).unwrap_or_default(), self.subtitles_stem());
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        self.subtitles.writing = true;
        self.subtitles.error = None;
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let temp = dir.join(format!(".sondra-untertitel-{}.srt", std::process::id()));
                std::fs::write(&temp, srt).map_err(|e| e.to_string())?;
                let (container, codec) = if ext == "mp4" || ext == "m4v" || ext == "mov" { (ext.as_str(), "mov_text") } else { ("mkv", "srt") };
                let target = sondra_media::run::unique_path(&dir, &format!("{stem} (mit Untertiteln)"), container);
                let mut cmd = std::process::Command::new(ff.program());
                cmd.args(["-v", "error", "-y", "-i"]).arg(&path);
                if burn {
                    // The filter wants a path without a drive colon or backslashes.
                    let spec = temp.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'");
                    cmd.arg("-vf").arg(format!("subtitles='{spec}'")).args(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy"]);
                } else {
                    cmd.arg("-i").arg(&temp).args(["-map", "0", "-map", "1:0", "-c", "copy", "-c:s", codec, "-metadata:s:s:0", "language=und"]);
                }
                cmd.arg(&target);
                let out = cmd.output().map_err(|e| e.to_string());
                let _ = std::fs::remove_file(&temp);
                let out = out?;
                if !out.status.success() {
                    let _ = std::fs::remove_file(&target);
                    let last = String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("").to_owned();
                    return Err(if burn { format!("Das Einbrennen hat nicht geklappt (dieser FFmpeg kann keine Untertitel zeichnen?). {last}") } else { format!("Die Spur liess sich nicht einbetten. {last}") });
                }
                Ok(target)
            },
            |shell, answer, cx| {
                shell.subtitles.writing = false;
                match answer {
                    Ok(p) => shell.subtitles.made.push(p),
                    Err(e) => shell.subtitles.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests.
    pub fn subtitles_segments(&self) -> &[Segment] {
        &self.subtitles.segments
    }
    pub fn subtitles_made(&self) -> &[PathBuf] {
        &self.subtitles.made
    }
    pub fn subtitles_running(&self) -> bool {
        self.subtitles.job.as_ref().is_some_and(|j| j.lock().unwrap().finished.is_none())
    }

    pub(crate) fn subtitles_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let s = &self.subtitles;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Untertitel", "Eine Spracherkennung auf diesem Computer hört einen Film oder eine Aufnahme ab und schreibt auf, was gesagt wird — als Text, als Untertitel-Datei oder direkt im Film. Der Ton verlässt den Computer nicht."));
        if let Some(error) = &s.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let running = self.subtitles_running();
        let job = s.job.as_ref().map(|j| {
            let j = j.lock().unwrap();
            (j.fetched, j.status, j.share, j.done_seconds, j.finished.is_none())
        });

        // The file.
        let pick = {
            let me = me.clone();
            let label = if s.path.is_some() { "Andere Datei" } else { "Datei wählen" };
            ui.button("untertitel-waehlen", label).primary_when(s.path.is_none()).disabled(running).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_subtitles_file(cx)))
        };
        let mut file = div().flex().flex_wrap().items_center().gap(px(12.)).child(pick);
        if let Some(path) = &s.path {
            file = file.child(ui.value(path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        let mut work = div().flex().flex_col().gap(px(20.)).child(file);

        // Model and language.
        let mut models = div().flex().flex_wrap().gap(px(6.));
        for m in MODELS {
            let me = me.clone();
            let language = s.language;
            models = models.child(ui.chip(format!("modell-{}", m.label), m.label, s.model == m.id).accessible_name(format!("Modell {}", m.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.subtitles_set(m.id, language, cx))));
        }
        let mut languages = div().flex().flex_wrap().gap(px(6.));
        for (code, label) in LANGUAGES {
            let me = me.clone();
            let model = s.model;
            languages = languages.child(ui.chip(format!("sprache-{code}"), label, s.language == code).accessible_name(format!("Sprache {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.subtitles_set(model, code, cx))));
        }
        let model = model_by_id(s.model);
        let settings = vec![ui.setting("Genauigkeit", models, Some(model.hint)), ui.setting("Sprache", languages, None)];
        if s.path.is_none() {
            work = work.child(ui.empty("untertitel-leer", "Noch keine Datei gewählt", "Ein Film oder eine Aufnahme wird auf diesem Computer abgehört. Genauigkeit und Sprache links gelten für die nächste Datei.", vec![]));
            return page.child(ui.tool_body(settings, work)).into_any_element();
        }

        let present = is_present(&s.models_dir, &model);
        let block = || div().flex().flex_col().gap(px(10.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        if !present {
            // The one thing that comes from outside, said where it happens.
            let me2 = me.clone();
            let mut b = block().child(ui.title("Das Sprachmodell fehlt noch")).child(ui.prose(format!("Es wird einmalig von Hugging Face geladen ({}); nur das Modell, nie Ihr Ton. Danach arbeitet alles ohne Netz.", megabytes(model.bytes))));
            if let Some((Some((done, total)), _, _, _, _)) = job {
                b = b.child(ui.bar("modell-laden", Some(done as f32 / total.max(1) as f32), "Das Sprachmodell wird geladen")).child(ui.hint(format!("{} von {}", megabytes(done), megabytes(total))));
                let me3 = me.clone();
                b = b.child(div().flex().child(ui.button("modell-abbrechen", "Abbrechen").small().on_click(move |_, app| me3.update(app, |shell, cx| shell.subtitles_cancel(cx)))));
            } else {
                b = b.child(div().flex().child(ui.button("modell-laden", format!("Modell laden ({})", megabytes(model.bytes))).primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.subtitles_fetch(cx)))));
            }
            return page.child(ui.tool_body(settings, work.child(b))).into_any_element();
        }

        // Start, progress, stop.
        let mut run = div().flex().flex_col().gap(px(10.));
        if let (Some((_, status, share, done, true)), true) = (job, running) {
            run = run.child(ui.prose(status)).child(ui.bar("untertitel-fortschritt", Some(share as f32), "Fortschritt")).child(ui.hint(format!("{} abgehört", clock(done))));
            let me2 = me.clone();
            run = run.child(div().flex().child(ui.button("untertitel-abbrechen", "Abbrechen").small().on_click(move |_, app| me2.update(app, |shell, cx| shell.subtitles_cancel(cx)))));
        } else {
            let me2 = me.clone();
            run = run.child(div().flex().child(ui.button("untertitel-erzeugen", if s.segments.is_empty() { "Untertitel erzeugen" } else { "Neu erzeugen" }).primary().on_click(move |_, app| me2.update(app, |shell, cx| shell.subtitles_start(cx)))));
        }
        work = work.child(run);

        // What was heard, as cues, as it comes.
        if !s.segments.is_empty() {
            let mut list = div().flex().flex_col().gap(px(4.));
            for cue in to_cues(&s.segments) {
                list = list.child(div().flex().gap(px(12.)).child(div().w(px(70.)).child(ui.value(clock(cue.start)))).child(div().flex_1().child(ui.prose(cue.text.replace('\n', " ")))));
            }
            work = work.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Gehört")).child(list));
            if !running {
                let save = |id: &'static str, label: &str, kind: &'static str| {
                    let me = me.clone();
                    ui.button(id, label.to_string()).small().disabled(s.writing).on_click(move |_, app| me.update(app, |shell, cx| shell.subtitles_save(kind, cx)))
                };
                let film = |id: &'static str, label: &str, burn: bool| {
                    let me = me.clone();
                    ui.button(id, label.to_string()).small().disabled(s.writing).on_click(move |_, app| me.update(app, |shell, cx| shell.subtitles_into_film(burn, cx)))
                };
                let mut out = div()
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(ui.subheading("Speichern"))
                    .child(div().flex().flex_wrap().gap(px(8.)).child(save("als-srt", "Als SRT", "srt")).child(save("als-vtt", "Als WebVTT", "vtt")).child(save("als-text", "Als Text", "txt")))
                    .child(div().flex().flex_wrap().gap(px(8.)).child(film("als-spur", "Als Spur im Film", false)).child(film("einbrennen", "Ins Bild einbrennen", true)))
                    .child(ui.hint("Die Spur lässt sich im Player ein- und ausschalten; eingebrannt ist die Schrift fest im Bild. Der Film selbst bleibt unverändert, es entsteht eine Kopie."));
                for path in &s.made {
                    out = out.child(self.written_row(&ui, path, cx));
                }
                work = work.child(out);
            }
        } else if let Some((_, _, _, _, false)) = job {
            if s.error.is_none() {
                work = work.child(ui.hint("Es war nichts zu hören, was sich aufschreiben liesse."));
            }
        }
        page.child(ui.tool_body(settings, work)).into_any_element()
    }
}
