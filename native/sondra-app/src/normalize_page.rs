//! The Lautstärke page: one sound, measured the broadcasters' way (K-weighted, gated, true peak), and
//! brought to a target — streaming, broadcast, podcast — without clipping. Measuring and the gain move
//! are `sondra-media`'s `loudness`, number for number the website's; this page reads the file through FFmpeg,
//! shows what was measured, and writes the result next to the source, never over it.

use std::path::PathBuf;

use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_media::audio::{decode_file, write_wav_f32};
use sondra_media::convert::{find_format, Settings};
use sondra_media::loudness::{apply_normalization, measure_loudness, LoudnessReport, NormalizationSettings, LOUDNESS_PRESETS};
use sondra_media::{Cancel, Ffmpeg};
use sondra_ui::{size, NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

pub struct NormalizeState {
    pub file: Option<PathBuf>,
    pub report: Option<LoudnessReport>,
    pub measuring: bool,
    /// The target chosen (id of `LOUDNESS_PRESETS`).
    pub preset: &'static str,
    pub format: &'static str,
    pub working: bool,
    pub made: Option<(PathBuf, String)>,
    pub error: Option<String>,
}

impl NormalizeState {
    pub fn new() -> NormalizeState {
        NormalizeState { file: None, report: None, measuring: false, preset: "streaming", format: "flac", working: false, made: None, error: None }
    }

    fn settings(&self) -> NormalizationSettings {
        let (_, _, lufs, ceiling) = LOUDNESS_PRESETS.iter().copied().find(|(id, ..)| *id == self.preset).unwrap_or(LOUDNESS_PRESETS[0]);
        NormalizationSettings { target_lufs: lufs, true_peak_ceiling_dbtp: ceiling, ..NormalizationSettings::default() }
    }
}

impl Default for NormalizeState {
    fn default() -> Self {
        Self::new()
    }
}

/// „-14,2“ — a number with its comma, and a real minus.
fn num(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return if value < 0.0 { "−∞".into() } else { "∞".into() };
    }
    let text = format!("{value:.digits$}").replace('.', ",");
    text.replacen('-', "−", 1)
}

impl Shell {
    pub(crate) fn choose_normalize_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.normalize_take(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Takes a file and measures it.
    pub fn normalize_take(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let n = &mut self.normalize;
        n.file = Some(path.clone());
        n.report = None;
        n.made = None;
        n.error = None;
        n.measuring = true;
        Self::in_background(
            cx,
            move || -> Result<LoudnessReport, String> {
                let ffmpeg = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let audio = decode_file(&ffmpeg, &path, None).map_err(|e| e.to_string())?;
                Ok(measure_loudness(&audio, &mut |_| {}))
            },
            |shell, answer, cx| {
                let n = &mut shell.normalize;
                n.measuring = false;
                match answer {
                    Ok(report) => n.report = Some(report),
                    Err(error) => n.error = Some(error),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    pub fn normalize_choose(&mut self, preset: &'static str, cx: &mut Context<Self>) {
        self.normalize.preset = preset;
        self.normalize.made = None;
        cx.notify();
    }

    /// Brings the sound to the target and writes it next to the source.
    pub(crate) fn start_normalize(&mut self, cx: &mut Context<Self>) {
        let n = &mut self.normalize;
        let (Some(file), Some(report)) = (n.file.clone(), n.report) else { return };
        if n.working {
            return;
        }
        n.working = true;
        n.error = None;
        let (settings, format_id) = (n.settings(), n.format);
        Self::in_background(
            cx,
            move || -> Result<(PathBuf, String), String> {
                let ffmpeg = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let audio = decode_file(&ffmpeg, &file, None).map_err(|e| e.to_string())?;
                let (out, plan) = apply_normalization(&audio, &report, &settings);
                let dir = file.parent().map(PathBuf::from).unwrap_or_default();
                let stem = format!("{} (angeglichen)", file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Ton".into()));
                // Written as floats, then encoded in the format chosen: nothing is lost on the way.
                let temp = dir.join(format!(".sondra-lautstaerke-{}.wav", std::process::id()));
                write_wav_f32(&temp, &out).map_err(|e| e.to_string())?;
                let convert = Settings { format_id: format_id.to_string(), ..Settings::default() };
                let result = sondra_media::run::convert_file(&ffmpeg, &temp, &dir, &stem, &convert, &Cancel::new(), &mut |_| {});
                let _ = std::fs::remove_file(&temp);
                let made = result.map_err(|e| e.message)?;
                let said = format!(
                    "{} dB{}{}",
                    if plan.applied_db >= 0.0 { format!("+{}", num(plan.applied_db, 1)) } else { num(plan.applied_db, 1) },
                    if plan.reduced_by_ceiling { format!(" (weniger als verlangt: die Spitze darf {} dBTP nicht überschreiten)", num(settings.true_peak_ceiling_dbtp, 1)) } else { String::new() },
                    if plan.limiter_engaged { ", Begrenzer war aktiv" } else { "" }
                );
                Ok((made.path, said))
            },
            |shell, answer, cx| {
                let n = &mut shell.normalize;
                n.working = false;
                match answer {
                    Ok(done) => n.made = Some(done),
                    Err(error) => n.error = Some(error),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The page.
    pub(crate) fn normalize_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me: Entity<Shell> = cx.entity();
        let c = ui.c;
        let n = &self.normalize;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Lautstärke angleichen"));
        page = page.child(ui.prose("Misst, wie laut ein Stück wirklich ist (nach EBU R128), und holt es auf das Maß, das Sie brauchen — ohne dass es übersteuert. Das Original bleibt, wie es ist; das Ergebnis liegt daneben."));
        if let Some(error) = &n.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let choose = {
            let me = me.clone();
            ui.button("lautstaerke-datei", if n.file.is_some() { "Andere Datei wählen" } else { "Datei wählen" }).disabled(n.measuring || n.working).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_normalize_file(cx)))
        };
        let mut head = div().flex().flex_wrap().items_center().gap(px(12.)).child(choose);
        if let Some(file) = &n.file {
            head = head.child(ui.value(file.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        page = page.child(head);
        if n.measuring {
            return page.child(ui.prose("Misst …")).into_any_element();
        }
        let Some(report) = n.report else { return page.into_any_element() };

        let facts = format!(
            "Jetzt: {} LUFS · Spitze {} dBTP · Dynamik {} LU · {} Minuten",
            num(report.integrated_lufs, 1),
            num(report.true_peak_dbtp, 1),
            num(report.loudness_range_lu, 1),
            num(report.duration_seconds / 60.0, 1)
        );
        page = page.child(div().p(px(16.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).child(ui.value(facts)));

        let mut targets = div().flex().flex_wrap().gap(px(6.));
        for (id, label, lufs, _) in LOUDNESS_PRESETS {
            let me = me.clone();
            targets = targets.child(ui.chip(format!("ziel-{id}"), label, n.preset == id).accessible_name(format!("Ziel {label}, {} LUFS", num(lufs, 0))).on_click(move |_, app| me.update(app, |shell, cx| shell.normalize_choose(id, cx))));
        }
        let mut formats = div().flex().flex_wrap().items_center().gap(px(6.)).child(ui.hint("Als:"));
        for id in ["flac", "wav", "mp3"] {
            let Some(format) = find_format(id) else { continue };
            let me = me.clone();
            formats = formats.child(ui.chip(format!("ausgabe-{id}"), format.label, n.format == id).on_click(move |_, app| {
                me.update(app, |shell, cx| {
                    shell.normalize.format = match id {
                        "wav" => "wav",
                        "mp3" => "mp3",
                        _ => "flac",
                    };
                    cx.notify();
                })
            }));
        }
        let settings = n.settings();
        let go = {
            let me = me.clone();
            ui.button("angleichen", if n.working { "Rechnet …".to_string() } else { format!("Auf {} LUFS bringen", num(settings.target_lufs, 0)) }).primary().disabled(n.working).on_click(move |_, app| me.update(app, |shell, cx| shell.start_normalize(cx)))
        };
        page = page.child(div().flex().flex_col().gap(px(10.)).child(ui.subheading("Ziel")).child(targets)).child(formats).child(div().flex().child(go));

        if let Some((path, said)) = &n.made {
            let (play, show) = (me.clone(), me.clone());
            let (p1, folder) = (path.clone(), path.parent().map(PathBuf::from));
            let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            page = page.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(ui.subheading("Fertig"))
                    .child(ui.value(name.clone()))
                    .child(div().text_size(px(size::SMALL)).text_color(c.prose).child(format!("Verändert um {said}")))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(ui.button("angeglichen-abspielen", "Abspielen").small().accessible_name(format!("{name} abspielen")).on_click(move |_, app| {
                                let p = p1.clone();
                                play.update(app, |shell, cx| {
                                    shell.go(Panel::Player, cx);
                                    shell.play_files(vec![p], cx);
                                })
                            }))
                            .child(ui.button("angeglichen-zeigen", "Im Ordner zeigen").small().on_click(move |_, app| {
                                if let Some(folder) = folder.clone() {
                                    show.update(app, |shell, cx| {
                                        shell.go(Panel::Folder, cx);
                                        shell.open_folder(folder, cx);
                                    })
                                }
                            })),
                    ),
            );
        }
        page.into_any_element()
    }
}
