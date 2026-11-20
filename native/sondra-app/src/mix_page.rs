//! The Mischen page: a voice over music, and the music steps back whenever someone speaks. The mixing is
//! `sondra-media::duck` (`duck.ts`, number for number); this page reads both files through FFmpeg, mixes
//! again on every change of a setting (a few hundred milliseconds for a five-minute piece), shows when the
//! voice was heard and where the music went down, and writes WAV files beside the sources.

use std::path::PathBuf;
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_media::audio::{decode_file, write_wav_f32, AudioData};
use sondra_media::convert::Settings as ConvertSettings;
use sondra_media::duck::{mix_with_ducking, DuckReport, DuckSettings};
use sondra_media::{Cancel, Ffmpeg};
use sondra_ui::{size, NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// Both files, read.
pub struct Decoded {
    pub voice: AudioData,
    pub music: AudioData,
}

pub struct Mixed {
    pub audio: AudioData,
    pub voice_db: Vec<f32>,
    pub gain_db: Vec<f32>,
    pub report: DuckReport,
}

pub struct MixState {
    pub voice: Option<PathBuf>,
    pub music: Option<PathBuf>,
    pub settings: DuckSettings,
    pub decoded: Option<Arc<Decoded>>,
    pub mixed: Option<Mixed>,
    pub reading: bool,
    pub mixing: bool,
    pub writing: bool,
    pub made: Vec<PathBuf>,
    pub error: Option<String>,
    /// Which mix is the latest asked for; an older answer is dropped.
    generation: u64,
    /// Whether the voice file is a video (then the mix can go under its picture).
    pub video: bool,
}

impl MixState {
    pub fn new() -> MixState {
        MixState { voice: None, music: None, settings: DuckSettings::default(), decoded: None, mixed: None, reading: false, mixing: false, writing: false, made: Vec::new(), error: None, generation: 0, video: false }
    }
}

impl Default for MixState {
    fn default() -> Self {
        Self::new()
    }
}

/// „−14,0 dB“ with a real minus and a comma.
fn db(value: f64) -> String {
    let text = format!("{value:.1}").replace('.', ",");
    format!("{} dB", text.replacen('-', "−", 1))
}

fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn stem_of(path: &PathBuf) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Mischung".into())
}

impl Shell {
    pub(crate) fn choose_mix_file(&mut self, voice: bool, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.mix_take(voice, path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Takes the voice (or the music); with both there, they are read and mixed.
    pub fn mix_take(&mut self, voice: bool, path: PathBuf, cx: &mut Context<Self>) {
        let m = &mut self.mix;
        if voice {
            m.video = Ffmpeg::locate().and_then(|ff| ff.probe(&path).ok()).is_some_and(|p| p.streams.iter().any(|s| s.kind == "video" && !s.attached_picture));
            m.voice = Some(path);
        } else {
            m.music = Some(path);
        }
        m.decoded = None;
        m.mixed = None;
        m.made.clear();
        m.error = None;
        self.mix_read(cx);
    }

    fn mix_read(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mix;
        let (Some(voice), Some(music)) = (m.voice.clone(), m.music.clone()) else {
            cx.notify();
            return;
        };
        m.reading = true;
        Self::in_background(
            cx,
            move || -> Result<Decoded, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let v = decode_file(&ff, &voice, None).map_err(|e| format!("Stimme: {e}"))?;
                // The music at the voice's rate: FFmpeg's resampler does what the web app does inside.
                let mu = decode_file(&ff, &music, Some(v.sample_rate)).map_err(|e| format!("Musik: {e}"))?;
                Ok(Decoded { voice: v, music: mu })
            },
            |shell, answer, cx| {
                let m = &mut shell.mix;
                m.reading = false;
                match answer {
                    Ok(d) => {
                        m.decoded = Some(Arc::new(d));
                        shell.mix_run(cx);
                    }
                    Err(e) => {
                        m.error = Some(e);
                        cx.notify();
                    }
                }
            },
        );
        cx.notify();
    }

    /// Mixes anew with the settings as they are.
    pub fn mix_run(&mut self, cx: &mut Context<Self>) {
        let m = &mut self.mix;
        let Some(decoded) = m.decoded.clone() else { return };
        m.generation += 1;
        let generation = m.generation;
        m.mixing = true;
        let settings = m.settings;
        Self::in_background(
            cx,
            move || {
                let r = mix_with_ducking(&decoded.voice, &decoded.music, &settings);
                Mixed { audio: r.audio, voice_db: r.voice_db, gain_db: r.music_gain_db, report: r.report }
            },
            move |shell, mixed, cx| {
                let m = &mut shell.mix;
                if m.generation != generation {
                    return;
                }
                m.mixing = false;
                m.mixed = Some(mixed);
                cx.notify();
            },
        );
        cx.notify();
    }

    fn mix_patch(&mut self, change: impl FnOnce(&mut DuckSettings), cx: &mut Context<Self>) {
        change(&mut self.mix.settings);
        self.mix.made.clear();
        self.mix_run(cx);
    }

    /// Writes the mix as a 24-bit WAV beside the voice.
    pub fn mix_save(&mut self, cx: &mut Context<Self>) {
        self.mix_write(Write::Wav, cx);
    }

    pub(crate) fn mix_write(&mut self, what: Write, cx: &mut Context<Self>) {
        let m = &mut self.mix;
        let (Some(voice), Some(decoded)) = (m.voice.clone(), m.decoded.clone()) else { return };
        if m.writing {
            return;
        }
        m.writing = true;
        m.error = None;
        let settings = m.settings;
        let mixed_audio = m.mixed.as_ref().map(|x| x.audio.clone());
        Self::in_background(
            cx,
            move || -> Result<Vec<PathBuf>, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let dir = voice.parent().map(PathBuf::from).unwrap_or_default();
                let stem = stem_of(&voice);
                let wav = |audio: &AudioData, dir: &std::path::Path, name: &str| -> Result<PathBuf, String> {
                    let temp = dir.join(format!(".sondra-mischen-{}.wav", std::process::id()));
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                    write_wav_f32(&temp, audio).map_err(|e| e.to_string())?;
                    let result = sondra_media::run::convert_file(&ff, &temp, dir, name, &ConvertSettings { format_id: "wav".into(), ..ConvertSettings::default() }, &Cancel::new(), &mut |_| {});
                    let _ = std::fs::remove_file(&temp);
                    result.map(|o| o.path).map_err(|e| e.message)
                };
                match what {
                    Write::Wav => {
                        let audio = mixed_audio.ok_or("Es ist noch nichts gemischt.".to_string())?;
                        Ok(vec![wav(&audio, &dir, &format!("{stem} (gemischt)"))?])
                    }
                    Write::Stems => {
                        let audio = mixed_audio.ok_or("Es ist noch nichts gemischt.".to_string())?;
                        let folder = dir.join(format!("{stem}-spuren"));
                        Ok(vec![
                            wav(&decoded.voice, &folder, "01_Stimme_Roh")?,
                            wav(&decoded.music, &folder, "02_Musik_Bearbeitet")?,
                            wav(&audio, &folder, "03_Master_Geduckt")?,
                        ])
                    }
                    Write::UnderVideo => {
                        // Under a video the music neither comes before the voice nor rings out after it, so that
                        // the picture and the voice stay together.
                        let tight = DuckSettings { lead_in: 0.0, tail: 0.0, ..settings };
                        let r = mix_with_ducking(&decoded.voice, &decoded.music, &tight);
                        let temp = dir.join(format!(".sondra-mischen-video-{}.wav", std::process::id()));
                        write_wav_f32(&temp, &r.audio).map_err(|e| e.to_string())?;
                        let target = sondra_media::run::unique_path(&dir, &format!("{stem} (gemischt)"), "mp4");
                        let out = std::process::Command::new(ff.program())
                            .args(["-v", "error", "-y", "-i"])
                            .arg(&voice)
                            .arg("-i")
                            .arg(&temp)
                            .args(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart"])
                            .arg(&target)
                            .output()
                            .map_err(|e| e.to_string());
                        let _ = std::fs::remove_file(&temp);
                        let out = out?;
                        if !out.status.success() {
                            return Err(format!("Das Video liess sich nicht schreiben. {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
                        }
                        Ok(vec![target])
                    }
                }
            },
            |shell, answer, cx| {
                let m = &mut shell.mix;
                m.writing = false;
                match answer {
                    Ok(paths) => m.made = paths,
                    Err(e) => m.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests: what was mixed.
    pub fn mix_report(&self) -> Option<DuckReport> {
        self.mix.mixed.as_ref().map(|m| m.report)
    }

    /// For tests: where the written files are.
    pub fn mix_made(&self) -> &[PathBuf] {
        &self.mix.made
    }

    pub(crate) fn mix_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me: Entity<Shell> = cx.entity();
        let c = ui.c;
        let m = &self.mix;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Stimme und Musik mischen", "Legt eine Stimme über Musik. Sobald jemand spricht, tritt die Musik von selbst zurück und kommt danach wieder. Die Originale bleiben, wie sie sind; die Mischung liegt neben der Stimme."));
        if let Some(error) = &m.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        // The next file to choose is the page's one action: the voice first, then the music.
        let pick = |id: &'static str, label: &str, file: &Option<PathBuf>, voice: bool, next: bool| {
            let me = me.clone();
            let button = ui.button(id, if file.is_some() { format!("{label} ändern") } else { format!("{label} wählen") }).accessible_name(if file.is_some() { format!("{label} ändern") } else { format!("{label} wählen") }).primary_when(next).disabled(m.reading || m.writing).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_mix_file(voice, cx)));
            let mut row = div().flex().flex_wrap().items_center().gap(px(12.)).child(button);
            if let Some(f) = file {
                row = row.child(ui.value(f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
            }
            row
        };
        let files = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(pick("stimme-waehlen", "Stimme", &m.voice, true, m.voice.is_none()))
            .child(pick("musik-waehlen", "Musik", &m.music, false, m.voice.is_some() && m.music.is_none()));
        let s = &m.settings;
        let steps = |title: &str, key: &'static str, values: Vec<(f64, String)>, now: f64, set: fn(&mut DuckSettings, f64)| {
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            for (v, label) in values {
                let me = me.clone();
                chips = chips.child(ui.chip(format!("{key}-{label}"), label.clone(), (now - v).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.mix_patch(move |d| set(d, v), cx))));
            }
            div().flex().flex_col().gap(px(8.)).child(ui.title(title.to_string())).child(chips)
        };
        let dbs = |values: &[f64]| -> Vec<(f64, String)> { values.iter().map(|v| (*v, db(*v))).collect() };
        let secs = |values: &[f64]| -> Vec<(f64, String)> { values.iter().map(|v| (*v, format!("{} s", format!("{v}").replace('.', ",")))).collect() };
        let ms = |values: &[f64]| -> Vec<(f64, String)> { values.iter().map(|v| (*v, format!("{v} ms"))).collect() };
        let loop_chip = {
            let me = me.clone();
            let on = s.loop_music;
            ui.chip("musik-wiederholen", "Musik wiederholen", on).on_click(move |_, app| me.update(app, |shell, cx| shell.mix_patch(move |d| d.loop_music = !on, cx)))
        };
        let settings_col = div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .child(steps("Musikpegel", "musikpegel", dbs(&[-24.0, -18.0, -14.0, -10.0, -6.0, 0.0]), s.music_db, |d, v| d.music_db = v))
            .child(steps("Beim Sprechen leiser um", "absenkung", [6.0, 9.0, 12.0, 15.0, 18.0, 24.0].iter().map(|v| (*v, db(*v).replace('−', ""))).collect(), s.duck_db, |d, v| d.duck_db = v))
            .child(steps("Sprach-Empfindlichkeit", "empfindlichkeit", [0.25f64, 0.5, 0.75, 1.0].iter().map(|v| (*v, format!("{} %", (v * 100.0).round() as i64))).collect(), s.sensitivity, |d, v| d.sensitivity = v))
            .child(steps("Wird leiser in", "attack", ms(&[60.0, 120.0, 250.0, 400.0]), s.attack_ms, |d, v| d.attack_ms = v))
            .child(steps("Kommt zurück in", "release", ms(&[300.0, 600.0, 1000.0, 2000.0]), s.release_ms, |d, v| d.release_ms = v))
            .child(steps("Musik vor Sprachbeginn", "vorlauf", secs(&[0.0, 1.0, 2.0, 4.0]), s.lead_in, |d, v| d.lead_in = v))
            .child(steps("Ausklang nach Sprache", "ausklang", secs(&[0.0, 1.5, 3.0, 6.0]), s.tail, |d, v| d.tail = v))
            .child(div().flex().flex_col().gap(px(6.)).child(div().flex().child(loop_chip)).child(ui.setting_note("Wiederholt die Musik, falls sie kürzer als die Stimme ist.")));

        let settings = vec![settings_col.into_any_element()];
        if m.reading {
            return page.child(ui.tool_body(settings, div().flex().flex_col().gap(px(20.)).child(files).child(ui.prose("Liest den Ton …")))).into_any_element();
        }
        if m.voice.is_none() || m.music.is_none() {
            return page.child(ui.tool_body(settings, div().flex().flex_col().gap(px(20.)).child(files).child(ui.hint("Mit beiden Dateien beginnt das Mischen. Was links eingestellt ist, gilt dann.")))).into_any_element();
        }
        let mut result = div().flex().flex_col().gap(px(14.)).child(files);
        if let Some(mixed) = &m.mixed {
            let r = &mixed.report;
            result = result.child(div().flex().items_baseline().justify_between().gap(px(12.)).child(ui.subheading("Mischung")).child(ui.value(clock(r.total_seconds))));
            result = result.child(graph(ui, mixed));
            let row = |label: &str, value: String| div().flex().justify_between().gap(px(12.)).py(px(6.)).border_t_1().border_color(c.line).child(div().child(label.to_string())).child(ui.value(value));
            result = result
                .child(row("Stimme erkannt", format!("{} von {} · ab {}FS", clock(r.speech_seconds), clock(r.voice_seconds), db(r.threshold_db))))
                .child(row("Musik", format!("{}, beim Sprechen {}", db(s.music_db), db(s.music_db - s.duck_db))))
                .child(row("Übergänge", format!("leiser in {} ms, zurück in {} ms", s.attack_ms, s.release_ms)))
                .child(row("Spitze", if r.trim_db > 0.0 { format!("−1,0 dBFS · um {} zurückgenommen", db(r.trim_db)) } else { format!("{}FS", db(r.peak_db)) }));
            let busy = m.writing || m.mixing;
            let mut buttons = div().flex().flex_wrap().gap(px(8.));
            {
                let me = me.clone();
                buttons = buttons.child(ui.button("mischung-speichern", if m.writing { "Schreibt …" } else { "Als WAV speichern" }).primary().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mix_save(cx))));
            }
            if m.video {
                let me = me.clone();
                buttons = buttons.child(ui.button("unter-das-video", "Unter das Video legen").disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mix_write(Write::UnderVideo, cx))));
            }
            {
                let me = me.clone();
                buttons = buttons.child(ui.button("einzelspuren", "Einzelspuren speichern").disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.mix_write(Write::Stems, cx))));
            }
            result = result.child(buttons);
            if m.video {
                result = result.child(ui.hint("Unter dem Video ohne „Musik vor Sprachbeginn“ und „Ausklang“, damit Bild und Stimme zusammenbleiben."));
            }
        } else if m.mixing {
            result = result.child(ui.prose("Mischt …"));
        }
        for path in &m.made {
            let (play, show) = (me.clone(), me.clone());
            let (p, folder) = (path.clone(), path.parent().map(PathBuf::from));
            let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            result = result.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .child(ui.value(name.clone()))
                    .child(ui.button(format!("abspielen-{}", path.display()), "Abspielen").small().accessible_name(format!("{name} abspielen")).on_click(move |_, app| {
                        let p = p.clone();
                        play.update(app, |shell, cx| {
                            shell.go(Panel::Player, cx);
                            shell.play_files(vec![p], cx);
                        })
                    }))
                    .children(self.drive_button(&ui, format!("drive-{}", path.display()), &path, &name, cx)).child(ui.button(format!("zeigen-{}", path.display()), "Im Ordner zeigen").small().accessible_name(format!("{name} im Ordner zeigen")).on_click(move |_, app| {
                        if let Some(folder) = folder.clone() {
                            show.update(app, |shell, cx| {
                                shell.go(Panel::Folder, cx);
                                shell.open_folder(folder, cx);
                            })
                        }
                    })),
            );
        }
        page.child(ui.tool_body(settings, result)).into_any_element()
    }
}

/// What to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Write {
    Wav,
    Stems,
    UnderVideo,
}

/// The level of the voice and the gain of the music over time, in columns of equal width: the voice as a
/// bar (louder is higher), the music as a bar that is lower where it stepped back.
fn graph(ui: Ui, mixed: &Mixed) -> AnyElement {
    let c = ui.c;
    const COLUMNS: usize = 120;
    let n = mixed.gain_db.len().max(1);
    let per = n.div_ceil(COLUMNS).max(1);
    let (mut voice, mut music) = (div().h(px(40.)).flex().items_end().gap(px(1.)), div().h(px(40.)).flex().items_end().gap(px(1.)));
    let min_gain = mixed.gain_db.iter().copied().fold(f32::MAX, f32::min).min(0.0) as f64;
    let max_gain = mixed.gain_db.iter().copied().fold(f32::MIN, f32::max).max(min_gain as f32 + 1.0) as f64;
    for start in (0..n).step_by(per) {
        let end = (start + per).min(n);
        let loud = mixed.voice_db[start..end].iter().copied().fold(-100f32, f32::max) as f64;
        let gain = mixed.gain_db[start..end].iter().map(|g| f64::from(*g)).sum::<f64>() / (end - start) as f64;
        let vh = (((loud + 60.0) / 60.0).clamp(0.0, 1.0) * 40.0).max(1.0);
        let mh = (((gain - min_gain) / (max_gain - min_gain)).clamp(0.0, 1.0) * 38.0) + 2.0;
        voice = voice.child(div().flex_1().h(px(vh as f32)).bg(c.ink));
        music = music.child(div().flex_1().h(px(mh as f32)).bg(c.faint));
    }
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(div().text_size(px(size::SMALL)).child("Stimme"))
        .child(voice)
        .child(div().text_size(px(size::SMALL)).child("Musik: wo sie zurücktritt, sinkt der Balken"))
        .child(music)
        .into_any_element()
}
