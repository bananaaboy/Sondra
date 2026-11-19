//! The Tonart page: one piece of music, listened to — its key, its tempo, its chords, and on request its
//! melody, with the chords and the melody as MIDI files. The listening is `sondra-media`'s (chroma, key
//! profiles of Krumhansl and Kessler, YIN pitch), number for number the website's; this page reads the
//! file through FFmpeg, shows what was heard, and writes the MIDI files next to the source.

use std::path::PathBuf;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_media::audio::decode_file;
use sondra_media::chroma::chromagram;
use sondra_media::key::{estimate_chords, estimate_key, ChordSpan, KeyEstimate};
use sondra_media::midi::{chords_to_midi_notes, write_midi, MidiOptions};
use sondra_media::pitch::{midi_name, segment_notes, track_pitch, Note, SegmentOptions, TrackOptions};
use sondra_media::tempo::estimate_tempo;
use sondra_media::Ffmpeg;
use sondra_ui::{size, NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// What the listening found.
#[derive(Debug, Clone)]
pub struct Heard {
    pub key: KeyEstimate,
    pub chords: Vec<ChordSpan>,
    pub notes: Vec<Note>,
    pub bpm: f64,
    /// 0–1; below roughly 0.3 the tempo is a guess and the page says so.
    pub tempo_confidence: f64,
    /// Whether the melody was followed this time.
    pub followed: bool,
}

pub struct HarmonyState {
    pub file: Option<PathBuf>,
    pub working: bool,
    pub heard: Option<Heard>,
    /// The settings the result was made with, to see when it is out of date.
    pub made_with: Option<String>,
    pub chord_window: f64,
    pub follow: bool,
    pub clarity: f64,
    pub shortest: f64,
    /// Snap the note starts to this fraction of a beat; 0 is off.
    pub quantize: f64,
    pub exported: Vec<PathBuf>,
    pub error: Option<String>,
}

impl HarmonyState {
    pub fn new() -> HarmonyState {
        HarmonyState {
            file: None,
            working: false,
            heard: None,
            made_with: None,
            chord_window: 0.5,
            follow: true,
            clarity: 0.4,
            shortest: 0.06,
            quantize: 0.0,
            exported: Vec::new(),
            error: None,
        }
    }

    fn signature(&self) -> String {
        format!("{}|{}|{}|{}|{}", self.chord_window, self.follow, self.clarity, self.shortest, self.quantize)
    }
}

impl Default for HarmonyState {
    fn default() -> Self {
        Self::new()
    }
}

/// „120“ — a tempo as a whole number, as the website shows it.
fn bpm_label(bpm: f64) -> String {
    format!("{} BPM", bpm.round() as i64)
}

/// „1:05“ for a place in the piece.
fn place(seconds: f64) -> String {
    let whole = seconds.max(0.0) as u64;
    format!("{}:{:02}", whole / 60, whole % 60)
}

/// The listening itself, on the thread that is given to it.
pub fn listen(path: &PathBuf, settings: &HarmonyState) -> Result<Heard, String> {
    let ffmpeg = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
    let audio = decode_file(&ffmpeg, path, None).map_err(|e| e.to_string())?;
    if audio.frames() == 0 {
        return Err("In dieser Datei ist kein Ton.".into());
    }
    let tempo = estimate_tempo(&audio);
    let chroma = chromagram(&audio, 0.0);
    let key = estimate_key(&chroma);
    let chords = estimate_chords(&chroma, settings.chord_window, 0.55);
    let mut notes = Vec::new();
    if settings.follow {
        let frames = track_pitch(&audio, &TrackOptions::default(), &mut |_| {});
        notes = segment_notes(
            &audio,
            &frames,
            &SegmentOptions {
                minimum_clarity: settings.clarity,
                minimum_seconds: settings.shortest,
                quantize_seconds: if settings.quantize > 0.0 && tempo.bpm > 0.0 { 60.0 / tempo.bpm * settings.quantize } else { 0.0 },
            },
        );
    }
    Ok(Heard { key, chords, notes, bpm: tempo.bpm, tempo_confidence: tempo.confidence, followed: settings.follow })
}

impl Shell {
    pub(crate) fn choose_harmony_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.harmony_take(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// What has been heard, for tests and for the pages that want it.
    pub fn harmony_heard(&self) -> Option<&Heard> {
        self.harmony.heard.as_ref()
    }

    /// Takes a file and listens to it.
    pub fn harmony_take(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        self.harmony.file = Some(path);
        self.harmony.heard = None;
        self.harmony.exported.clear();
        self.harmony_listen(cx);
    }

    /// Listens (again) with the settings as they are.
    pub fn harmony_listen(&mut self, cx: &mut Context<Self>) {
        let h = &mut self.harmony;
        let Some(path) = h.file.clone() else { return };
        if h.working {
            return;
        }
        h.working = true;
        h.error = None;
        let signature = h.signature();
        let snapshot = HarmonyState { file: None, heard: None, made_with: None, exported: Vec::new(), error: None, ..HarmonyState::new() };
        let settings = HarmonyState { chord_window: h.chord_window, follow: h.follow, clarity: h.clarity, shortest: h.shortest, quantize: h.quantize, ..snapshot };
        Self::in_background(
            cx,
            move || listen(&path, &settings),
            move |shell, answer, cx| {
                let h = &mut shell.harmony;
                h.working = false;
                match answer {
                    Ok(heard) => {
                        h.heard = Some(heard);
                        h.made_with = Some(signature);
                    }
                    Err(error) => h.error = Some(error),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Writes the chords, the melody, or both together as a MIDI file next to the source.
    pub fn harmony_export(&mut self, what: Export, cx: &mut Context<Self>) {
        let h = &mut self.harmony;
        let (Some(file), Some(heard)) = (h.file.clone(), h.heard.clone()) else { return };
        let base = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "harmonie".into());
        let chord_notes = chords_to_midi_notes(&heard.chords);
        let (notes, suffix, track) = match what {
            Export::Chords => (chord_notes, "akkorde", format!("{base} Akkorde")),
            Export::Melody => (heard.notes.clone(), "melodie", format!("{base} Melodie")),
            Export::Both => {
                let mut all = chord_notes;
                all.extend(heard.notes.iter().copied());
                (all, "akkorde-melodie", format!("{base} Akkorde und Melodie"))
            }
        };
        if notes.is_empty() {
            h.error = Some("Dafür gibt es nichts zu schreiben.".into());
            cx.notify();
            return;
        }
        let bytes = write_midi(&notes, &MidiOptions { bpm: heard.bpm, track_name: Some(track) });
        let dir = file.parent().map(PathBuf::from).unwrap_or_default();
        let target = sondra_media::run::unique_path(&dir, &format!("{base}-{suffix}"), "mid");
        match std::fs::write(&target, bytes) {
            Ok(()) => h.exported.push(target),
            Err(e) => h.error = Some(format!("Die MIDI-Datei liess sich nicht schreiben: {e}")),
        }
        cx.notify();
    }

    /// The page.
    pub(crate) fn harmony_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me: Entity<Shell> = cx.entity();
        let c = ui.c;
        let h = &self.harmony;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Tonart und Akkorde"));
        page = page.child(ui.prose("Hört in ein Stück hinein und sagt, in welcher Tonart es steht, wie schnell es ist und welche Akkorde darin folgen — auf Wunsch auch die Melodie. Akkorde und Melodie lassen sich als MIDI-Datei in ein Musikprogramm mitnehmen."));
        if let Some(error) = &h.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let choose = {
            let me = me.clone();
            ui.button("harmonie-datei", if h.file.is_some() { "Andere Datei wählen" } else { "Datei wählen" }).disabled(h.working).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_harmony_file(cx)))
        };
        let mut head = div().flex().flex_wrap().items_center().gap(px(12.)).child(choose);
        if let Some(file) = &h.file {
            head = head.child(ui.value(file.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        page = page.child(head);

        // The settings.
        let mut windows = div().flex().flex_wrap().items_center().gap(px(6.));
        for (value, label) in [(0.25, "0,25 s"), (0.5, "0,5 s"), (1.0, "1 s"), (2.0, "2 s")] {
            let me = me.clone();
            windows = windows.child(ui.chip(format!("fenster-{label}"), label, (h.chord_window - value).abs() < 1e-9).accessible_name(format!("Akkordfenster {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.harmony.chord_window = value;
                cx.notify();
            })));
        }
        let follow = {
            let me = me.clone();
            let on = h.follow;
            ui.chip("melodie-verfolgen", "Melodie verfolgen", on).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.harmony.follow = !on;
                cx.notify();
            }))
        };
        let mut settings = div().flex().flex_col().gap(px(12.)).child(div().flex().flex_col().gap(px(6.)).child(ui.subheading("Akkordfenster")).child(windows).child(ui.hint("Kürzer folgt schnellen Wechseln, länger ist ruhiger."))).child(div().flex().child(follow));
        if h.follow {
            let mut clarity = div().flex().flex_wrap().gap(px(6.));
            for value in [0.3, 0.4, 0.5, 0.6, 0.7] {
                let me = me.clone();
                clarity = clarity.child(ui.chip(format!("klarheit-{value}"), format!("{value:.1}").replace('.', ","), (h.clarity - value).abs() < 1e-9).accessible_name(format!("Geforderte Klarheit {}", format!("{value:.1}").replace('.', ","))).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.harmony.clarity = value;
                    cx.notify();
                })));
            }
            let mut shortest = div().flex().flex_wrap().gap(px(6.));
            for (value, label) in [(0.03, "30 ms"), (0.06, "60 ms"), (0.12, "120 ms"), (0.2, "200 ms")] {
                let me = me.clone();
                shortest = shortest.child(ui.chip(format!("kuerzeste-{label}"), label, (h.shortest - value).abs() < 1e-9).accessible_name(format!("Kürzeste Note {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.harmony.shortest = value;
                    cx.notify();
                })));
            }
            let mut quantize = div().flex().flex_wrap().gap(px(6.));
            for (value, label) in [(0.0, "Aus"), (0.25, "1/16"), (0.5, "1/8"), (1.0, "1/4")] {
                let me = me.clone();
                quantize = quantize.child(ui.chip(format!("raster-{label}"), label, (h.quantize - value).abs() < 1e-9).accessible_name(format!("Auf Raster ziehen {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                    shell.harmony.quantize = value;
                    cx.notify();
                })));
            }
            settings = settings
                .child(div().flex().flex_col().gap(px(6.)).child(ui.subheading("Geforderte Klarheit")).child(clarity))
                .child(div().flex().flex_col().gap(px(6.)).child(ui.subheading("Kürzeste Note")).child(shortest))
                .child(div().flex().flex_col().gap(px(6.)).child(ui.subheading("Auf Raster ziehen")).child(quantize).child(ui.hint("Verschiebt Notenanfänge auf das Tempo-Raster.")));
        }
        page = page.child(settings);

        if h.file.is_some() {
            let stale = h.heard.is_some() && h.made_with.as_deref() != Some(h.signature().as_str());
            let go = {
                let me = me.clone();
                let label = if h.working { "Hört …" } else if h.heard.is_some() { if stale { "Neu berechnen" } else { "Noch einmal hören" } } else { "Analysieren" };
                ui.button("harmonie-analysieren", label).primary().disabled(h.working).on_click(move |_, app| me.update(app, |shell, cx| shell.harmony_listen(cx)))
            };
            page = page.child(div().flex().child(go));
        }
        if h.working {
            page = page.child(ui.prose("Hört in das Stück hinein. Bei einem langen Stück mit Melodie dauert das einen Moment."));
        }
        let Some(heard) = &h.heard else { return page.into_any_element() };

        // The answer: two numbers first.
        let stat = |label: &str, value: String| div().flex().flex_col().gap(px(2.)).child(ui.hint(label.to_string())).child(div().text_size(px(size::HEADING)).font_family(sondra_ui::family::VALUE).child(value));
        let mut stats = div().flex().flex_wrap().gap(px(32.)).p(px(16.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft);
        stats = stats.child(stat("Tonart", heard.key.label.clone())).child(stat("Camelot", heard.key.camelot.clone())).child(stat("Tempo", bpm_label(heard.bpm)));
        page = page.child(stats);
        if heard.tempo_confidence < 0.3 {
            page = page.child(ui.notice(NoticeKind::Info, "Das Tempo ist hier eher geraten: im Stück ist kein gleichmässiger Takt zu hören."));
        }
        let (alt, alt_camelot) = &heard.key.alternative;
        page = page.child(ui.prose(format!(
            "Sicherheit bei der Tonart: {} %. Am nächsten kommt {alt} ({alt_camelot}); parallele Dur- und Moll-Tonarten enthalten dieselben zwölf Töne, welche von beiden gilt, entscheidet der Schwerpunkt.",
            (heard.key.confidence * 100.0).round() as i64
        )));

        // The chords.
        let spans: Vec<&ChordSpan> = heard.chords.iter().filter(|s| s.root.is_some()).collect();
        let mut chords = div().flex().flex_col().gap(px(6.)).child(ui.subheading(format!("Akkorde · {}", spans.len())));
        if spans.is_empty() {
            chords = chords.child(ui.prose("Es sind keine klaren Akkorde zu hören."));
        } else {
            let mut list = div().flex().flex_col();
            for span in spans.iter().take(60) {
                list = list.child(
                    div()
                        .flex()
                        .gap(px(16.))
                        .py(px(3.))
                        .child(div().w(px(56.)).font_family(sondra_ui::family::VALUE).text_size(px(size::SMALL)).child(place(span.start_seconds)))
                        .child(div().child(span.label.clone())),
                );
            }
            if spans.len() > 60 {
                list = list.child(ui.hint(format!("… und {} weitere, alle in der MIDI-Datei", spans.len() - 60)));
            }
            chords = chords.child(list);
        }
        page = page.child(chords);

        // The melody.
        if heard.followed {
            let mut melody = div().flex().flex_col().gap(px(6.)).child(ui.subheading(format!("Melodie · {} Noten", heard.notes.len())));
            if heard.notes.is_empty() {
                melody = melody.child(ui.notice(NoticeKind::Info, "Keine einstimmige Melodie isoliert. Auf einem vollen Mix oder in akkordlastigen Abschnitten findet der Melodieverfolger keine einzelne Linie — nutzen Sie die Akkorde als MIDI, oder trennen Sie vorher im Reiter „Spuren“ den Gesang heraus."));
            } else {
                let low = heard.notes.iter().map(|n| n.midi).min().unwrap_or(0);
                let high = heard.notes.iter().map(|n| n.midi).max().unwrap_or(0);
                melody = melody.child(ui.prose(format!("Von {} bis {}, {}.", midi_name(low), midi_name(high), bpm_label(heard.bpm))));
            }
            page = page.child(melody);
        }

        // The MIDI files.
        let mut exports = div().flex().flex_wrap().gap(px(8.));
        let has_chords = !spans.is_empty();
        let has_notes = !heard.notes.is_empty();
        for (what, id, label, enabled) in [
            (Export::Chords, "midi-akkorde", "Akkorde als MIDI", has_chords),
            (Export::Melody, "midi-melodie", "Melodie als MIDI", has_notes),
            (Export::Both, "midi-beides", "Akkorde und Melodie zusammen als MIDI", has_chords && has_notes),
        ] {
            if !enabled {
                continue;
            }
            let me = me.clone();
            exports = exports.child(ui.button(id, label).small().on_click(move |_, app| me.update(app, |shell, cx| shell.harmony_export(what, cx))));
        }
        let mut out = div().flex().flex_col().gap(px(8.)).child(ui.subheading("Mitnehmen")).child(exports);
        for path in &h.exported {
            let folder = path.parent().map(PathBuf::from);
            let me = me.clone();
            out = out.child(
                div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.value(path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())).children(self.drive_button(&ui, format!("drive-{}", path.display()), path, &path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(), cx)).child(
                    ui.button(format!("zeigen-{}", path.display()), "Im Ordner zeigen").small().on_click(move |_, app| {
                        if let Some(folder) = folder.clone() {
                            me.update(app, |shell, cx| {
                                shell.go(Panel::Folder, cx);
                                shell.open_folder(folder, cx);
                            })
                        }
                    }),
                ),
            );
        }
        page.child(out).into_any_element()
    }
}

/// What to write as MIDI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Export {
    Chords,
    Melody,
    Both,
}
