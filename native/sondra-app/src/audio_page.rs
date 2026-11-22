//! The Ton page: one take on a waveform. Drag over it to choose a stretch, press play to hear the stretch
//! (or all of it), and let the tools work on the choice — cut, level, tone, noise, room — each one a step
//! in a history that can be walked back. Nothing is written until „Speichern“, and the file the sound came
//! from stays as it was. The edits are `sondra-media::editor` (and `edit`, `effects` underneath), the
//! same arithmetic as the web app's editor.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{canvas, div, prelude::*, px, AnyElement, Bounds, Context, MouseButton, PathPromptOptions, Pixels};
use sondra_media::audio::{decode_file, write_wav_f32};
use sondra_media::convert::Settings as ConvertSettings;
use sondra_media::editor::{Editor, Op};
use sondra_media::declick::ClickStrength;
use sondra_media::{Cancel, Ffmpeg};
use sondra_a11y::{accessible, Role};
use sondra_ui::{radius, NoticeKind, Ui};

use crate::clip_player::ClipPlayer;
use crate::shell::Shell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Cut,
    Level,
    Tone,
    Clean,
    Room,
    Pitch,
    Output,
    History,
}

const TOOLS: [(Tool, &str); 8] = [(Tool::Cut, "Schnitt"), (Tool::Level, "Pegel"), (Tool::Tone, "Klang"), (Tool::Clean, "Säubern"), (Tool::Room, "Raum"), (Tool::Pitch, "Tonhöhe und Tempo"), (Tool::Output, "Ausgabe"), (Tool::History, "Verlauf")];

pub struct AudioState {
    pub path: Option<PathBuf>,
    pub editor: Option<Editor>,
    /// The chosen stretch, in seconds, `from < to`.
    pub selection: Option<(f64, f64)>,
    pub tool: Tool,
    pub busy: Option<&'static str>,
    pub error: Option<String>,
    pub said: Option<String>,
    pub player: Option<ClipPlayer>,
    pub made: Vec<PathBuf>,
    /// Where the waveform was drawn last, to turn a press into a place on it.
    pub bounds: Rc<Cell<Bounds<Pixels>>>,
    /// Where a drag began, in seconds.
    anchor: Option<f64>,
    ticking: bool,
    /// How deep a saved WAV is.
    pub bits: sondra_media::audio::WavBits,
    /// The stretch the wave shows (zoomed in), `None` for all of it.
    pub view: Option<(f64, f64)>,
    /// „In Schleife spielen“.
    pub looping: bool,
    /// „Tempo klopfen“: the last taps.
    pub taps: Vec<std::time::Instant>,
}

impl AudioState {
    pub fn new() -> AudioState {
        AudioState { path: None, editor: None, selection: None, tool: Tool::Cut, busy: None, error: None, said: None, player: None, made: Vec::new(), bounds: Rc::new(Cell::new(Bounds::default())), anchor: None, ticking: false, bits: sondra_media::audio::WavBits::Pcm16, view: None, looping: false, taps: Vec::new() }
    }
}

impl Default for AudioState {
    fn default() -> Self {
        Self::new()
    }
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0);
    format!("{}:{:04.1}", (s / 60.0).floor() as u64, s % 60.0).replace('.', ",")
}

fn db(v: f64) -> String {
    format!("{v:.1}").replace('.', ",").replacen('-', "−", 1)
}

impl Shell {
    pub(crate) fn choose_audio_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.audio_open(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Reads a sound file whole and puts it on the waveform.
    pub fn audio_open(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        a.player = None;
        a.busy = Some("Liest den Ton …");
        a.error = None;
        let read = path.clone();
        Self::in_background(
            cx,
            move || -> Result<sondra_media::audio::AudioData, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                decode_file(&ff, &read, None).map_err(|e| e.to_string())
            },
            move |shell, answer, cx| {
                let a = &mut shell.audio;
                a.busy = None;
                match answer {
                    Ok(audio) => {
                        a.editor = Some(Editor::new(audio));
                        a.path = Some(path);
                        a.selection = None;
                        a.said = None;
                        a.made.clear();
                    }
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests and for the drop of a file: the sound itself.
    pub fn audio_load(&mut self, audio: sondra_media::audio::AudioData, name: PathBuf, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        a.editor = Some(Editor::new(audio));
        a.path = Some(name);
        a.selection = None;
        a.said = None;
        a.error = None;
        cx.notify();
    }

    fn audio_seconds(&self) -> f64 {
        self.audio.editor.as_ref().map_or(0.0, |e| e.audio().seconds())
    }

    /// Chooses a stretch (or, with `None`, nothing: then everything is meant).
    pub fn audio_select(&mut self, range: Option<(f64, f64)>, cx: &mut Context<Self>) {
        let total = self.audio_seconds();
        self.audio.selection = range.map(|(a, b)| (a.min(b).clamp(0.0, total), a.max(b).clamp(0.0, total))).filter(|(a, b)| b - a >= 0.001);
        cx.notify();
    }

    fn audio_at(&self, x: Pixels) -> f64 {
        let bounds = self.audio.bounds.get();
        let width: f32 = bounds.size.width.into();
        if width <= 0.0 {
            return 0.0;
        }
        let (left, x): (f32, f32) = (bounds.origin.x.into(), x.into());
        let (from, to) = self.audio_view();
        from + ((x - left) / width).clamp(0.0, 1.0) as f64 * (to - from)
    }

    /// The stretch the wave shows.
    pub fn audio_view(&self) -> (f64, f64) {
        let total = self.audio_seconds();
        self.audio.view.map(|(a, b)| (a.clamp(0.0, total), b.clamp(0.0, total))).filter(|(a, b)| b - a > 0.01).unwrap_or((0.0, total))
    }

    /// Zooms in (`factor` < 1) or out around a place; all of it again when it would show everything.
    pub fn audio_zoom(&mut self, factor: f64, around: Option<f64>, cx: &mut Context<Self>) {
        let total = self.audio_seconds();
        if total <= 0.0 {
            return;
        }
        let (from, to) = self.audio_view();
        let at = around.unwrap_or((from + to) / 2.0);
        let span = ((to - from) * factor).clamp(0.05_f64.min(total), total);
        if span >= total - 1e-9 {
            self.audio.view = None;
        } else {
            let share = if to > from { (at - from) / (to - from) } else { 0.5 };
            let start = (at - span * share).clamp(0.0, total - span);
            self.audio.view = Some((start, start + span));
        }
        cx.notify();
    }

    /// Moves a zoomed view sideways by a share of what it shows.
    pub fn audio_pan(&mut self, share: f64, cx: &mut Context<Self>) {
        let total = self.audio_seconds();
        let Some((from, to)) = self.audio.view else { return };
        let span = to - from;
        let start = (from + span * share).clamp(0.0, (total - span).max(0.0));
        self.audio.view = Some((start, start + span));
        cx.notify();
    }

    /// „Tempo klopfen“: the beats per minute of the last taps (at least four), or `None`.
    pub fn audio_tap(&mut self, cx: &mut Context<Self>) -> Option<f64> {
        let now = std::time::Instant::now();
        // A pause of over two seconds starts counting anew.
        if self.audio.taps.last().is_some_and(|t| now.duration_since(*t).as_secs_f64() > 2.0) {
            self.audio.taps.clear();
        }
        self.audio.taps.push(now);
        if self.audio.taps.len() > 12 {
            self.audio.taps.remove(0);
        }
        cx.notify();
        self.audio_bpm()
    }

    pub fn audio_bpm(&self) -> Option<f64> {
        let t = &self.audio.taps;
        if t.len() < 4 {
            return None;
        }
        let span = t.last()?.duration_since(*t.first()?).as_secs_f64();
        (span > 0.0).then(|| 60.0 * (t.len() - 1) as f64 / span)
    }

    /// „Datei zum Anhängen“: another file after this one.
    pub(crate) fn audio_choose_append(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.audio_append(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    pub fn audio_append(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let Some(ffmpeg) = sondra_media::ffmpeg::Ffmpeg::locate() else {
            self.audio.error = Some("FFmpeg ist nicht da.".into());
            cx.notify();
            return;
        };
        let rate = self.audio.editor.as_ref().map(|e| e.audio().sample_rate);
        self.audio.busy = Some("Liest die Datei zum Anhängen …");
        cx.notify();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Self::in_background(cx, move || sondra_media::audio::decode_file(&ffmpeg, &path, rate).map_err(|e| e.to_string()), move |shell, decoded, cx| {
            shell.audio.busy = None;
            match decoded.and_then(|audio| shell.audio.editor.as_mut().ok_or_else(|| "Es ist keine Datei offen.".to_string()).and_then(|e| e.append(&audio, &name))) {
                Ok(said) => {
                    shell.audio.said = Some(said);
                    shell.audio.error = None;
                    shell.audio.view = None;
                }
                Err(e) => shell.audio.error = Some(e),
            }
            cx.notify();
        });
    }

    /// „Zurück zum Original“.
    pub fn audio_reset(&mut self, cx: &mut Context<Self>) {
        if let Some(said) = self.audio.editor.as_mut().and_then(|e| e.reset()) {
            self.audio.said = Some(said);
            self.audio.selection = None;
            self.audio.view = None;
        }
        cx.notify();
    }

    /// The keys of the editor (as on the website): Space plays, Strg+Z/Strg+Umschalt+Z (or Strg+Y) undo
    /// and redo, Strg+X/C/V cut, copy, paste, Entf removes the selection, T taps the tempo.
    pub fn audio_key(&mut self, key: &str, control: bool, shift: bool, cx: &mut Context<Self>) -> bool {
        if self.audio.editor.is_none() {
            return false;
        }
        match (control, shift, key) {
            (false, false, "space") => self.audio_play(cx),
            (true, false, "z") => self.audio_undo(cx),
            (true, true, "z") | (true, false, "y") => self.audio_redo(cx),
            (true, false, "x") | (false, false, "delete") if self.audio.selection.is_some() => self.audio_do(Op::Cut, cx),
            (true, false, "c") if self.audio.selection.is_some() => self.audio_copy(cx),
            (true, false, "v") => self.audio_do(Op::Paste, cx),
            (false, false, "t") => {
                self.audio_tap(cx);
            }
            (false, false, "+") | (false, true, "=") => self.audio_zoom(0.5, None, cx),
            (false, false, "-") => self.audio_zoom(2.0, None, cx),
            _ => return false,
        }
        true
    }

    /// Does one edit away from the window, then puts the take back.
    pub fn audio_do(&mut self, op: Op, cx: &mut Context<Self>) {
        let a = &mut self.audio;
        if a.busy.is_some() {
            return;
        }
        let Some(mut editor) = a.editor.take() else { return };
        a.player = None;
        a.busy = Some("Rechnet …");
        a.error = None;
        let range = a.selection;
        Self::in_background(
            cx,
            move || {
                let said = editor.apply(op, range);
                (editor, said)
            },
            move |shell, (editor, said), cx| {
                let a = &mut shell.audio;
                a.busy = None;
                let total = editor.audio().seconds();
                a.editor = Some(editor);
                match said {
                    Ok(label) => {
                        a.said = Some(label);
                        // What was cut away is no longer there to be chosen; a choice past the end goes too.
                        if matches!(op, Op::Cut | Op::RemoveSilence { .. } | Op::Resample(_)) || a.selection.is_some_and(|(_, to)| to > total + 1e-9) {
                            a.selection = None;
                        }
                    }
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn audio_copy(&mut self, cx: &mut Context<Self>) {
        let range = self.audio.selection;
        if let Some(editor) = &mut self.audio.editor {
            match editor.copy(range) {
                Ok(said) => self.audio.said = Some(said),
                Err(e) => self.audio.error = Some(e),
            }
        }
        cx.notify();
    }

    pub fn audio_learn_noise(&mut self, cx: &mut Context<Self>) {
        let range = self.audio.selection;
        if let Some(editor) = &mut self.audio.editor {
            match editor.learn_noise(range) {
                Ok(said) => {
                    self.audio.said = Some(said);
                    self.audio.error = None;
                }
                Err(e) => self.audio.error = Some(e),
            }
        }
        cx.notify();
    }

    /// „Lokale KI“: the stretch to learn the noise from is found by the program, not chosen.
    pub fn audio_learn_noise_auto(&mut self, cx: &mut Context<Self>) {
        if let Some(editor) = &mut self.audio.editor {
            match editor.learn_noise_auto() {
                Ok((said, (from, to))) => {
                    self.audio.selection = Some((from, to));
                    self.audio.said = Some(said);
                    self.audio.error = None;
                }
                Err(e) => self.audio.error = Some(e),
            }
        }
        cx.notify();
    }

    pub fn audio_undo(&mut self, cx: &mut Context<Self>) {
        self.audio.player = None;
        if let Some(editor) = &mut self.audio.editor {
            if let Some(label) = editor.undo() {
                self.audio.said = Some(format!("Rückgängig: {label}"));
            }
        }
        cx.notify();
    }

    pub fn audio_redo(&mut self, cx: &mut Context<Self>) {
        self.audio.player = None;
        if let Some(editor) = &mut self.audio.editor {
            if let Some(label) = editor.redo() {
                self.audio.said = Some(format!("Wiederholt: {label}"));
            }
        }
        cx.notify();
    }

    /// Plays the chosen stretch, or all of it; the same button stops it.
    pub fn audio_play(&mut self, cx: &mut Context<Self>) {
        if self.audio.player.take().is_some() {
            cx.notify();
            return;
        }
        let Some(editor) = &self.audio.editor else { return };
        let (from, to) = self.audio.selection.unwrap_or((0.0, editor.audio().seconds()));
        self.audio.player = Some(ClipPlayer::start(editor.audio(), from, to));
        self.audio_start_ticker(cx);
        cx.notify();
    }

    fn audio_start_ticker(&mut self, cx: &mut Context<Self>) {
        if self.audio.ticking {
            return;
        }
        self.audio.ticking = true;
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(std::time::Duration::from_millis(80)).await;
            let alive = this.update(cx, |shell, cx| {
                if shell.audio.player.as_ref().is_some_and(ClipPlayer::finished) {
                    shell.audio.player = None;
                    // „In Schleife spielen“: the same stretch again.
                    if shell.audio.looping {
                        if let Some(editor) = &shell.audio.editor {
                            let (from, to) = shell.audio.selection.unwrap_or((0.0, editor.audio().seconds()));
                            shell.audio.player = Some(ClipPlayer::start(editor.audio(), from, to));
                        }
                    }
                }
                let alive = shell.audio.player.is_some();
                if !alive {
                    shell.audio.ticking = false;
                }
                cx.notify();
                alive
            });
            if !alive.unwrap_or(false) {
                break;
            }
        })
        .detach();
    }

    /// Writes the take beside the file it came from, as `format_id` says (wav, flac, mp3).
    pub fn audio_save(&mut self, format_id: &'static str, cx: &mut Context<Self>) {
        let (Some(editor), Some(path)) = (&self.audio.editor, self.audio.path.clone()) else { return };
        if self.audio.busy.is_some() {
            return;
        }
        let audio = editor.audio().clone();
        let bits = self.audio.bits;
        self.audio.busy = Some("Schreibt …");
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let dir = path.parent().map(PathBuf::from).unwrap_or_default();
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Ton".into());
                // A WAV is written as it is, at the depth chosen; FFmpeg is for the other formats.
                if format_id == "wav" {
                    let target = sondra_media::run::unique_path(&dir, &format!("{stem} (bearbeitet)"), "wav");
                    sondra_media::audio::write_wav(&target, &audio, bits).map_err(|e| e.to_string())?;
                    return Ok(target);
                }
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let temp = dir.join(format!(".sondra-ton-{}.wav", std::process::id()));
                write_wav_f32(&temp, &audio).map_err(|e| e.to_string())?;
                let out = sondra_media::run::convert_file(&ff, &temp, &dir, &format!("{stem} (bearbeitet)"), &ConvertSettings { format_id: format_id.into(), ..ConvertSettings::default() }, &Cancel::new(), &mut |_| {});
                let _ = std::fs::remove_file(&temp);
                out.map(|o| o.path).map_err(|e| e.message)
            },
            |shell, answer, cx| {
                let a = &mut shell.audio;
                a.busy = None;
                match answer {
                    Ok(path) => a.made.push(path),
                    Err(e) => a.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests: where the waveform was drawn.
    pub fn audio_bounds(&self) -> Bounds<Pixels> {
        self.audio.bounds.get()
    }

    /// For tests.
    pub fn audio_take(&self) -> Option<&sondra_media::audio::AudioData> {
        self.audio.editor.as_ref().map(Editor::audio)
    }
    pub fn audio_selection(&self) -> Option<(f64, f64)> {
        self.audio.selection
    }
    pub fn audio_made(&self) -> &[PathBuf] {
        &self.audio.made
    }
    pub fn audio_is_playing(&self) -> bool {
        self.audio.player.is_some()
    }

    pub(crate) fn audio_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me = cx.entity();
        let c = ui.c;
        let a = &self.audio;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Ton bearbeiten", "Ziehen Sie über die Welle, um eine Stelle zu wählen; die Werkzeuge gelten für sie, ohne Auswahl für die ganze Datei. Jeder Schritt steht im Verlauf und lässt sich zurücknehmen. Geschrieben wird erst mit „Speichern“, die Ausgangsdatei bleibt, wie sie war."));
        if let Some(error) = &a.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        if let Some(what) = a.busy {
            page = page.child(ui.prose(what));
        }
        let Some(editor) = &a.editor else {
            let pick = {
                let me = me.clone();
                ui.button("ton-waehlen", "Datei wählen").primary().disabled(a.busy.is_some()).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_audio_file(cx)))
            };
            return page.child(ui.stage_empty(pick, "Noch keine Datei gewählt. Danach steht die Welle hier, und die Werkzeuge darunter gelten für die gewählte Stelle oder das Ganze.")).into_any_element();
        };
        let audio = editor.audio();
        let total = audio.seconds();
        let name = a.path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let busy = a.busy.is_some();

        // The file, the transport, the history's two steps.
        let mut bar = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.title(name)).child(ui.value(format!("{} · {} Hz · {}", clock(total), audio.sample_rate, if audio.channels.len() == 1 { "Mono" } else { "Stereo" })));
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-abspielen", if a.player.is_some() { "Anhalten" } else if a.selection.is_some() { "Auswahl anhören" } else { "Anhören" }).primary().on_click(move |_, app| me.update(app, |shell, cx| shell.audio_play(cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-zurueck", "Rückgängig").small().disabled(busy || !editor.can_undo()).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_undo(cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-wieder", "Wiederholen").small().disabled(busy || !editor.can_redo()).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_redo(cx))));
        }
        {
            let me = me.clone();
            let on = a.looping;
            bar = bar.child(ui.chip("ton-schleife", "In Schleife spielen", on).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.audio.looping = !on;
                cx.notify();
            })));
        }
        {
            let (zin, zout) = (me.clone(), me.clone());
            bar = bar
                .child(ui.button("ton-hinein", "+").small().accessible_name("Hineinzoomen (oder Mausrad)").on_click(move |_, app| zin.update(app, |shell, cx| shell.audio_zoom(0.5, None, cx))))
                .child(ui.button("ton-heraus", "−").small().accessible_name("Herauszoomen").disabled(a.view.is_none()).on_click(move |_, app| zout.update(app, |shell, cx| shell.audio_zoom(2.0, None, cx))));
        }
        {
            let me = me.clone();
            bar = bar.child(ui.button("ton-andere", "Andere Datei").small().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_audio_file(cx))));
        }
        page = page.child(bar);

        // The waveform.
        let (view_from, view_to) = self.audio_view();
        let span = (view_to - view_from).max(1e-6);
        let peaks = if a.view.is_some() { editor.peaks_in(view_from, view_to, 480) } else { editor.peaks(480) };
        let mut columns = div().relative().flex().items_center().h(px(160.)).w_full().rounded(px(sondra_ui::radius::CARD)).overflow_hidden().bg(c.stage);
        for (lo, hi) in &peaks {
            let up = (hi * 62.0).max(1.0);
            let down = (-lo * 62.0).max(1.0);
            columns = columns.child(div().flex_1().flex().flex_col().items_center().justify_center().child(div().w_full().h(px(up)).bg(c.stage_ink).mb(px(0.))).child(div().w_full().h(px(down)).bg(c.stage_ink)));
        }
        let measure = a.bounds.clone();
        columns = columns.child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full());
        if let Some((from, to)) = a.selection {
            // In the view's terms, cut to what is in view.
            let (f, t) = (((from - view_from) / span).clamp(0.0, 1.0), ((to - view_from) / span).clamp(0.0, 1.0));
            if t > f {
                columns = columns.child(div().absolute().top_0().bottom_0().left(gpui::relative(f as f32)).w(gpui::relative((t - f) as f32)).bg(c.stage_accent).opacity(0.35));
            }
        }
        if let Some(player) = &a.player {
            let at = (player.position() - view_from) / span;
            if (0.0..=1.0).contains(&at) {
                columns = columns.child(div().absolute().top_0().bottom_0().left(gpui::relative(at as f32)).w(px(2.)).bg(c.stage_accent));
            }
        }
        let _ = total;
        let (down, drag, up) = (me.clone(), me.clone(), me.clone());
        let stage = div()
            .id("welle")
            .cursor_crosshair()
            .on_mouse_down(MouseButton::Left, move |event, _, app| {
                let x = event.position.x;
                down.update(app, |shell, cx| {
                    let at = shell.audio_at(x);
                    shell.audio.anchor = Some(at);
                    shell.audio_select(None, cx);
                })
            })
            .on_mouse_move(move |event, _, app| {
                if event.pressed_button == Some(MouseButton::Left) {
                    let x = event.position.x;
                    drag.update(app, |shell, cx| {
                        if let Some(anchor) = shell.audio.anchor {
                            let at = shell.audio_at(x);
                            shell.audio_select(Some((anchor, at)), cx);
                        }
                    })
                }
            })
            .on_mouse_up(MouseButton::Left, move |_, _, app| up.update(app, |shell, _| shell.audio.anchor = None))
            // The wheel zooms around the pointer; with Shift it moves the view sideways.
            .on_scroll_wheel({
                let me = me.clone();
                move |event, _, app| {
                    let lines: f32 = match event.delta {
                        gpui::ScrollDelta::Lines(l) => if l.y != 0.0 { l.y } else { l.x },
                        gpui::ScrollDelta::Pixels(p) => f32::from(if p.y != px(0.) { p.y } else { p.x }) / 40.0,
                    };
                    if lines == 0.0 {
                        return;
                    }
                    let (x, shift) = (event.position.x, event.modifiers.shift);
                    me.update(app, |shell, cx| {
                        if shift {
                            shell.audio_pan(-(lines as f64) * 0.1, cx);
                        } else {
                            let at = shell.audio_at(x);
                            shell.audio_zoom(if lines > 0.0 { 0.8 } else { 1.25 }, Some(at), cx);
                        }
                    })
                }
            })
            .child(columns);
        let says = match a.selection {
            Some((from, to)) => format!("Auswahl {} bis {} ({} s)", clock(from), clock(to), db(to - from).replace(" ", "")),
            None => "Keine Auswahl: gilt für die ganze Datei".into(),
        };
        page = page.child(accessible("welle", Role::Group, stage).label("Wellenform").value(says.clone()));
        let mut selection_row = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.hint(says));
        {
            let me = me.clone();
            selection_row = selection_row.child(ui.button("alles-waehlen", "Alles auswählen").small().on_click(move |_, app| me.update(app, |shell, cx| {
                let total = shell.audio_seconds();
                shell.audio_select(Some((0.0, total)), cx)
            })));
        }
        if a.selection.is_some() {
            let me = me.clone();
            selection_row = selection_row.child(ui.button("auswahl-aufheben", "Auswahl aufheben").small().on_click(move |_, app| me.update(app, |shell, cx| shell.audio_select(None, cx))));
        }
        page = page.child(selection_row);
        if let Some(said) = &a.said {
            page = page.child(ui.hint(format!("● {said}")));
        }

        // The tools.
        let mut tabs = div().flex().flex_wrap().gap(px(6.));
        for (tool, label) in TOOLS {
            let me = me.clone();
            tabs = tabs.child(ui.chip(format!("werkzeug-{label}"), label, a.tool == tool).accessible_name(format!("Werkzeug {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.audio.tool = tool;
                cx.notify();
            })));
        }
        let tabs_row = tabs;
        let op = |id: String, label: String, op: Op| {
            let me = me.clone();
            ui.button(id, label.clone()).small().accessible_name(label).disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_do(op, cx)))
        };
        let group = |title: &str, items: Vec<gpui::AnyElement>| div().flex().flex_col().gap(px(8.)).child(ui.title(title.to_string())).child(div().flex().flex_wrap().gap(px(8.)).children(items));
        let mut panel = div().flex().flex_col().gap(px(16.)).p(px(16.)).rounded(px(radius::CARD)).bg(c.panel_soft);
        match a.tool {
            Tool::Cut => {
                let me2 = me.clone();
                let copy = ui.button("kopieren", "Kopieren").small().disabled(busy || a.selection.is_none()).on_click(move |_, app| me2.update(app, |shell, cx| shell.audio_copy(cx)));
                panel = panel
                    .child(group("Auswahl", vec![
                        op("ausschneiden".into(), "Ausschneiden".into(), Op::Cut).into_any_element(),
                        copy.into_any_element(),
                        op("einfuegen".into(), "Einfügen".into(), Op::Paste).disabled(busy || !editor.has_clipboard()).into_any_element(),
                        op("verdoppeln".into(), "Verdoppeln".into(), Op::Duplicate).into_any_element(),
                        op("stumm".into(), "Stumm schalten".into(), Op::Mute).into_any_element(),
                    ]))
                    .child(group("Ganze Datei", vec![
                        op("stille-einfuegen-halb".into(), "0,5 s Stille einfügen".into(), Op::InsertSilence(0.5)).into_any_element(),
                        op("stille-einfuegen".into(), "1 s Stille einfügen".into(), Op::InsertSilence(1.0)).into_any_element(),
                        op("ausschnitt-behalten".into(), "Ausschnitt behalten".into(), Op::Keep).disabled(busy || a.selection.is_none()).into_any_element(),
                        op("stille-entfernen".into(), "Stille entfernen (−45 dB)".into(), Op::RemoveSilence { threshold_db: -45.0 }).into_any_element(),
                        op("stille-aggressiv".into(), "Stille entfernen, aggressiv (−25 dB)".into(), Op::RemoveSilence { threshold_db: -25.0 }).into_any_element(),
                        op("stille-nur".into(), "Nur echte Stille (−60 dB)".into(), Op::RemoveSilence { threshold_db: -60.0 }).into_any_element(),
                        {
                            let me = me.clone();
                            ui.button("datei-anhaengen", "Datei anhängen …").small().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_choose_append(cx))).into_any_element()
                        },
                        {
                            let me = me.clone();
                            ui.button("zum-original", "Zurück zum Original").small().ghost().disabled(busy || !editor.can_undo()).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_reset(cx))).into_any_element()
                        },
                        op("rueckwaerts".into(), "Rückwärts drehen".into(), Op::Reverse).into_any_element(),
                    ]));
            }
            Tool::Level => {
                panel = panel
                    .child(group("Pegel ändern", [-6.0, -3.0, 3.0, 6.0].iter().map(|g| op(format!("pegel-{g}"), format!("{} dB", db(*g)), Op::Gain(*g)).into_any_element()).collect()))
                    .child(group("Normalisieren auf die lauteste Stelle", [-1.0, -0.3].iter().map(|g| op(format!("normalisieren-{g}"), format!("{} dBFS", db(*g)), Op::NormalizePeak(*g)).into_any_element()).collect()))
                    .child(group("Blenden", vec![op("einblenden".into(), "Einblenden".into(), Op::FadeIn).into_any_element(), op("ausblenden".into(), "Ausblenden".into(), Op::FadeOut).into_any_element()]));
            }
            Tool::Tone => {
                panel = panel
                    .child(group("Tiefen entfernen (Hochpass)", [80.0, 120.0, 200.0].iter().map(|hz| op(format!("hochpass-{hz}"), format!("unter {hz:.0} Hz"), Op::Highpass(*hz)).into_any_element()).collect()))
                    .child(group("Höhen entfernen (Tiefpass)", [4000.0, 8000.0, 12000.0].iter().map(|hz| op(format!("tiefpass-{hz}"), format!("über {:.0} kHz", hz / 1000.0), Op::Lowpass(*hz)).into_any_element()).collect()))
                    .child(group("Bässe und Höhen", vec![
                        op("waermer".into(), "Wärmer (Bässe +3, Höhen −2)".into(), Op::Tone { bass_db: 3.0, treble_db: -2.0 }).into_any_element(),
                        op("heller".into(), "Heller (Bässe −2, Höhen +3)".into(), Op::Tone { bass_db: -2.0, treble_db: 3.0 }).into_any_element(),
                        op("praesenz".into(), "Dünner (Bässe −6)".into(), Op::Tone { bass_db: -6.0, treble_db: 0.0 }).into_any_element(),
                    ]))
                    .child(group("Dynamik", vec![
                        op("kompressor-sanft".into(), "Kompressor sanft (3:1 ab −24 dB)".into(), Op::Compress { threshold_db: -24.0, ratio: 3.0 }).into_any_element(),
                        op("kompressor-stark".into(), "Kompressor stark (6:1 ab −30 dB)".into(), Op::Compress { threshold_db: -30.0, ratio: 6.0 }).into_any_element(),
                    ]));
            }
            Tool::Clean => {
                let me2 = me.clone();
                let learn = ui.button("rauschen-lernen", if editor.has_noise_profile() { "Rauschen neu lernen" } else { "Rauschen lernen" }).small().disabled(busy || a.selection.is_none()).on_click(move |_, app| me2.update(app, |shell, cx| shell.audio_learn_noise(cx)));
                panel = panel
                    .child(ui.prose("Wählen Sie eine Stelle, an der nur das Rauschen zu hören ist (mindestens eine Fünftelsekunde), und lassen Sie es lernen — oder lassen Sie Sondra die ruhigste Stelle selbst suchen („Lokale KI“, rechnet auf diesem Gerät). Danach lässt es sich abziehen — in der Auswahl oder überall."))
                    .child(group("Rauschen", vec![learn.into_any_element(), {
                        let me3 = me.clone();
                        ui.button("rauschen-lokale-ki", "Lokale KI").small().disabled(busy).accessible_name("Rauschprofil automatisch erkennen und lernen").on_click(move |_, app| me3.update(app, |shell, cx| shell.audio_learn_noise_auto(cx))).into_any_element()
                    }]))
                    .child(group("Rauschen entfernen, bis zu", [6.0, 12.0, 18.0].iter().map(|d| op(format!("rauschen-{d}"), format!("{} dB", db(*d).replace('−', "")), Op::RemoveNoise { max_cut_db: *d }).disabled(busy || !editor.has_noise_profile()).into_any_element()).collect()))
                    .child(ui.prose("Klicks und Knackser: alte Platten, Kabelknacken, Schmatzen am Mikrofon. Schläge und Konsonanten bleiben. Gesucht wird in der ganzen Datei."))
                    .child(group("Klicks entfernen", [("sanft", "Sanft", ClickStrength::Soft), ("mittel", "Mittel", ClickStrength::Medium), ("stark", "Stark", ClickStrength::Strong)].iter().map(|(id, label, strength)| op(format!("klicks-{id}"), label.to_string(), Op::RemoveClicks(*strength)).into_any_element()).collect()))
                    .child(group("Sonst", vec![op("gleichspannung".into(), "Gleichspannung entfernen".into(), Op::RemoveDc).into_any_element()]));
            }
            Tool::Room => {
                panel = panel
                    .child(ui.prose("Echo und Hall klingen über das Ende der Stelle hinaus nach."))
                    .child(group("Echo", vec![
                        op("echo-kurz".into(), "Kurz (150 ms)".into(), Op::Echo { delay_ms: 150.0, feedback: 0.4, mix: 0.4 }).into_any_element(),
                        op("echo-lang".into(), "Lang (350 ms)".into(), Op::Echo { delay_ms: 350.0, feedback: 0.5, mix: 0.5 }).into_any_element(),
                    ]))
                    .child(group("Hall", [0.8, 1.5, 3.0].iter().map(|s| op(format!("hall-{s}"), format!("{} s", format!("{s}").replace('.', ",")), Op::Reverb { seconds: *s, mix: 0.5 }).into_any_element()).collect()));
            }
            Tool::Pitch => {
                panel = panel
                    .child(ui.prose("Gilt für die Auswahl, ohne Auswahl für die ganze Datei. Die Länge bleibt bei der Tonhöhe, die Tonhöhe beim Tempo — gerechnet wird mit dem Phasenvocoder, wie auf der Website."))
                    .child(group("Tonhöhe", [-12.0, -7.0, -5.0, -2.0, -1.0, 1.0, 2.0, 5.0, 7.0, 12.0].iter().map(|n: &f64| {
                        let label = format!("{}{} Halbtöne", if *n > 0.0 { "+" } else { "−" }, n.abs());
                        op(format!("tonhoehe-{n}"), label, Op::Pitch(*n)).into_any_element()
                    }).collect()))
                    .child(group("Tempo", [0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2.0].iter().map(|t: &f64| op(format!("tempo-{t}"), format!("{}×", format!("{t}").replace('.', ",")), Op::Tempo(*t)).into_any_element()).collect()))
                    .child({
                        let me = me.clone();
                        let bpm = self.audio_bpm().map_or("Im Takt tippen, oder T auf der Tastatur.".to_string(), |b| format!("Etwa {} BPM", b.round() as i64));
                        div().flex().flex_col().gap(px(8.)).child(ui.title("Tempo klopfen")).child(div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.button("tempo-tippen", "Tippen").small().on_click(move |_, app| me.update(app, |shell, cx| {
                            shell.audio_tap(cx);
                        }))).child(ui.value(bpm)))
                    });
            }
            Tool::Output => {
                let save = |format_id: &'static str, label: &str| {
                    let me = me.clone();
                    ui.button(format!("speichern-{format_id}"), label.to_string()).small().primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.audio_save(format_id, cx)))
                };
                panel = panel
                    .child(group("Bittiefe der WAV", [(sondra_media::audio::WavBits::Pcm16, "16 bit"), (sondra_media::audio::WavBits::Pcm24, "24 bit"), (sondra_media::audio::WavBits::Float32, "32 Float")].iter().map(|(bits, label)| {
                        let me = me.clone();
                        let bits = *bits;
                        ui.chip(format!("bittiefe-{label}"), label.to_string(), self.audio.bits == bits).on_click(move |_, app| me.update(app, |shell, cx| {
                            shell.audio.bits = bits;
                            cx.notify();
                        })).into_any_element()
                    }).collect()))
                    .child(group("Kanäle", vec![
                        op("mono".into(), "Zu Mono mischen".into(), Op::ToMono).into_any_element(),
                        op("stereo".into(), "Zu Stereo verdoppeln".into(), Op::ToStereo).into_any_element(),
                        op("tauschen".into(), "Links und rechts tauschen".into(), Op::Swap).into_any_element(),
                    ]))
                    .child(group("Abtastrate", [22050u32, 44100, 48000].iter().map(|r| op(format!("rate-{r}"), format!("{r} Hz"), Op::Resample(*r)).into_any_element()).collect()))
                    .child(group("Speichern", vec![save("wav", "Als WAV speichern").into_any_element(), save("flac", "Als FLAC speichern").into_any_element(), save("mp3", "Als MP3 speichern").into_any_element()]));
                for path in &a.made {
                    panel = panel.child(self.written_row(&ui, path, cx));
                }
            }
            Tool::History => {
                let history = editor.history();
                if history.is_empty() {
                    panel = panel.child(ui.prose("Noch nichts geändert."));
                }
                for (i, entry) in history.iter().enumerate() {
                    panel = panel.child(ui.prose(format!("{}. {}", i + 1, entry.label)));
                }
            }
        }
        // The tools of the editor on the tint under the wave: the rail of jobs, then the one that is open.
        page.child(div().flex().flex_col().gap(px(16.)).p(px(16.)).rounded(px(sondra_ui::radius::CARD)).bg(ui.c.panel_soft).child(tabs_row).child(panel)).into_any_element()
    }
}
