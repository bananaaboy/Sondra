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
    /// Loudness (LUFS) or the peak (dBFS), as on the website.
    pub mode: sondra_media::loudness::Mode,
    /// The peak the result may reach, in dBTP (`None`: the target's own).
    pub ceiling: Option<f64>,
    pub prevent_clipping: bool,
    pub use_limiter: bool,
    /// The peak a „Spitzenpegel“ normalization aims at, in dBFS.
    pub peak_target: f64,
    /// „Mehrere Dateien auf einmal“: what was done with each.
    pub batch: Vec<(String, Result<(PathBuf, String), String>)>,
}

impl NormalizeState {
    pub fn new() -> NormalizeState {
        NormalizeState {
            file: None,
            report: None,
            measuring: false,
            preset: "streaming",
            format: "flac",
            working: false,
            made: None,
            error: None,
            mode: sondra_media::loudness::Mode::Lufs,
            ceiling: None,
            prevent_clipping: true,
            use_limiter: false,
            peak_target: -1.0,
            batch: Vec::new(),
        }
    }

    fn settings(&self) -> NormalizationSettings {
        let (_, _, lufs, ceiling) = LOUDNESS_PRESETS.iter().copied().find(|(id, ..)| *id == self.preset).unwrap_or(LOUDNESS_PRESETS[0]);
        NormalizationSettings {
            mode: self.mode,
            target_lufs: lufs,
            target_peak_dbfs: self.peak_target,
            true_peak_ceiling_dbtp: self.ceiling.unwrap_or(ceiling),
            prevent_clipping: self.prevent_clipping,
            use_limiter: self.use_limiter,
        }
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

/// Brings one file to the target and writes it beside itself, as `format_id`; says by how much (and why
/// less, or that the limiter worked). Measures first when no report is given.
pub fn normalize_one(file: &std::path::Path, report: Option<LoudnessReport>, settings: &NormalizationSettings, format_id: &str) -> Result<(PathBuf, String), String> {
    let ffmpeg = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
    let audio = decode_file(&ffmpeg, file, None).map_err(|e| e.to_string())?;
    let report = report.unwrap_or_else(|| measure_loudness(&audio, &mut |_| {}));
    let (out, plan) = apply_normalization(&audio, &report, settings);
    let dir = file.parent().map(PathBuf::from).unwrap_or_default();
    let stem = format!("{} (angeglichen)", file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Ton".into()));
    // Written as floats, then encoded in the format chosen: nothing is lost on the way.
    let temp = dir.join(format!(".sondra-lautstaerke-{}-{}.wav", std::process::id(), stem.len()));
    write_wav_f32(&temp, &out).map_err(|e| e.to_string())?;
    let convert = Settings { format_id: format_id.to_string(), ..Settings::default() };
    let result = sondra_media::run::convert_file(&ffmpeg, &temp, &dir, &stem, &convert, &Cancel::new(), &mut |_| {});
    let _ = std::fs::remove_file(&temp);
    let made = result.map_err(|e| e.message)?;
    let said = format!(
        "{} dB{}{}",
        if plan.applied_db >= 0.0 { format!("+{}", num(plan.applied_db, 1)) } else { num(plan.applied_db, 1) },
        if plan.reduced_by_ceiling { format!(" (weniger als verlangt: die Spitze darf {} dBTP nicht überschreiten)", num(settings.true_peak_ceiling_dbtp, 1)) } else { String::new() },
        if plan.limiter_engaged { ", Limiter hat eingegriffen" } else { "" }
    );
    Ok((made.path, said))
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
            move || normalize_one(&file, Some(report), &settings, format_id),
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
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Lautstärke angleichen", "Misst, wie laut ein Stück wirklich ist (nach EBU R128), und holt es auf das Maß, das Sie brauchen — ohne dass es übersteuert. Das Original bleibt, wie es ist; das Ergebnis liegt daneben."));
        if let Some(error) = &n.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let choose = {
            let me = me.clone();
            ui.button("lautstaerke-datei", if n.file.is_some() { "Andere Datei wählen" } else { "Datei wählen" }).primary_when(n.file.is_none()).disabled(n.measuring || n.working).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_normalize_file(cx)))
        };
        let mut head = div().flex().flex_wrap().items_center().gap(px(12.)).child(choose);
        if let Some(file) = &n.file {
            head = head.child(ui.value(file.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()));
        }
        let mut targets = div().flex().flex_wrap().gap(px(6.));
        for (id, label, lufs, _) in LOUDNESS_PRESETS {
            let me = me.clone();
            targets = targets.child(ui.chip(format!("ziel-{id}"), label, n.preset == id).accessible_name(format!("Ziel {label}, {} LUFS", num(lufs, 0))).on_click(move |_, app| me.update(app, |shell, cx| shell.normalize_choose(id, cx))));
        }
        let mut formats = div().flex().flex_wrap().items_center().gap(px(6.));
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
        // How it is measured and held: loudness or peak, the ceiling, pulling back or limiting.
        use sondra_media::loudness::Mode;
        let mut modes = div().flex().flex_wrap().gap(px(6.));
        for (mode, id, label) in [(Mode::Lufs, "messart-lufs", "Lautheit (LUFS)"), (Mode::Peak, "messart-spitze", "Spitzenpegel (dBFS)")] {
            let me = me.clone();
            modes = modes.child(ui.chip(id, label, n.mode == mode).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.normalize.mode = mode;
                shell.normalize.made = None;
                cx.notify();
            })));
        }
        let mut peaks = div().flex().flex_wrap().gap(px(6.));
        for v in [-0.1f64, -0.3, -1.0, -3.0] {
            let me = me.clone();
            peaks = peaks.child(ui.chip(format!("spitze-{v}"), format!("{} dBFS", num(v, 1)), (n.peak_target - v).abs() < 1e-9).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.normalize.peak_target = v;
                cx.notify();
            })));
        }
        let own_ceiling = LOUDNESS_PRESETS.iter().find(|(id, ..)| *id == n.preset).map_or(-1.0, |p| p.3);
        let mut ceilings = div().flex().flex_wrap().gap(px(6.));
        for v in [-0.1f64, -0.5, -1.0, -2.0] {
            let me = me.clone();
            let on = (n.ceiling.unwrap_or(own_ceiling) - v).abs() < 1e-9;
            ceilings = ceilings.child(ui.chip(format!("obergrenze-{v}"), format!("{} dBTP", num(v, 1)), on).accessible_name(format!("Obergrenze für Spitzen (True Peak) {} dBTP", num(v, 1))).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.normalize.ceiling = Some(v);
                cx.notify();
            })));
        }
        let guard = {
            let (a, b) = (me.clone(), me.clone());
            let (clip, limit) = (n.prevent_clipping, n.use_limiter);
            div()
                .flex()
                .flex_wrap()
                .gap(px(6.))
                .child(ui.chip("uebersteuerung", "Übersteuerung verhindern", clip).on_click(move |_, app| a.update(app, |shell, cx| {
                    shell.normalize.prevent_clipping = !clip;
                    cx.notify();
                })))
                .child(ui.chip("limiter", "Limiter statt zurücknehmen", limit).on_click(move |_, app| b.update(app, |shell, cx| {
                    shell.normalize.use_limiter = !limit;
                    cx.notify();
                })))
        };
        let batch = {
            let me = me.clone();
            div().flex().child(ui.button("mehrere-dateien", "Mehrere Dateien …").small().disabled(n.working || n.measuring).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_normalize_batch(cx))))
        };
        // The target and the format are settings: chosen before or after the measuring.
        let mut settings_col = vec![ui.setting("Messart", modes, None)];
        if n.mode == Mode::Lufs {
            settings_col.push(ui.setting("Ziel", targets, None));
        } else {
            settings_col.push(ui.setting("Spitze auf", peaks, None));
        }
        settings_col.push(ui.setting("Obergrenze für Spitzen (True Peak)", ceilings, None));
        settings_col.push(ui.setting("Wenn es zu laut wird", guard, Some(if n.use_limiter { "Hält den Zielwert genau und begrenzt nur die höchsten Spitzen." } else { "Nimmt die Verstärkung zurück, falls Spitzen sonst über die Obergrenze gingen." })));
        settings_col.push(ui.setting("Speichern als", formats, None));
        settings_col.push(ui.setting("Mehrere Dateien auf einmal", batch, Some("Jede gewählte Datei auf denselben Zielwert, jede neben ihr Original.")));
        let mut work = div().flex().flex_col().gap(px(20.)).child(head);
        if !n.batch.is_empty() {
            let mut list = div().flex().flex_col().gap(px(4.)).child(ui.subheading("Mehrere Dateien"));
            for (name, result) in &n.batch {
                list = list.child(ui.prose(match result {
                    Ok((path, said)) => format!("{name} → {} · {said}", path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()),
                    Err(e) => format!("{name}: nicht angeglichen — {e}"),
                }));
            }
            work = work.child(list);
        }
        if n.working && n.file.is_none() {
            work = work.child(ui.prose("Rechnet …"));
        }
        if n.measuring {
            return page.child(ui.tool_body(settings_col, work.child(ui.prose("Misst …")))).into_any_element();
        }
        let Some(report) = n.report else {
            if n.file.is_none() {
                work = work.child(ui.empty("lautstaerke-leer", "Noch keine Datei gewählt", "Gemessen wird gleich nach der Wahl, nach EBU R128. Ziel und Format links gelten dann.", vec![]));
            }
            return page.child(ui.tool_body(settings_col, work)).into_any_element();
        };

        // Every number the measurement gives, as on the website.
        let mut stats = div().flex().flex_wrap().gap(px(10.));
        for (label, value) in [
            ("Lautheit", format!("{} LUFS", num(report.integrated_lufs, 1))),
            ("True Peak", format!("{} dBTP", num(report.true_peak_dbtp, 1))),
            ("Sample Peak", format!("{} dBFS", num(report.sample_peak_dbfs, 1))),
            ("Loudness Range", format!("{} LU", num(report.loudness_range_lu, 1))),
            ("Kurzzeit max.", format!("{} LUFS", num(report.short_term_max_lufs, 1))),
            ("Momentan max.", format!("{} LUFS", num(report.momentary_max_lufs, 1))),
            ("Dauer", format!("{} Min.", num(report.duration_seconds / 60.0, 1))),
        ] {
            stats = stats.child(div().w(px(150.)).flex().flex_col().gap(px(2.)).p(px(12.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).child(ui.hint(label)).child(ui.value(value)));
        }
        work = work.child(stats);

        let settings = n.settings();
        let go = {
            let me = me.clone();
            let label = if n.working {
                "Rechnet …".to_string()
            } else if settings.mode == Mode::Peak {
                format!("Spitze auf {} dBFS bringen", num(settings.target_peak_dbfs, 1))
            } else {
                format!("Auf {} LUFS bringen", num(settings.target_lufs, 0))
            };
            ui.button("angleichen", label).primary().disabled(n.working).on_click(move |_, app| me.update(app, |shell, cx| shell.start_normalize(cx)))
        };
        work = work.child(div().flex().child(go));

        if let Some((path, said)) = &n.made {
            let (play, show) = (me.clone(), me.clone());
            let (p1, folder) = (path.clone(), path.parent().map(PathBuf::from));
            let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            work = work.child(
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
                            .children(self.drive_button(&ui, "angeglichen-drive".to_string(), path, &name, cx))
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
        page.child(ui.tool_body(settings_col, work)).into_any_element()
    }

    /// „Mehrere Dateien auf einmal“: each chosen file to the same target, one after the other.
    pub(crate) fn choose_normalize_batch(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.normalize_batch(paths, cx)).ok();
            }
        })
        .detach();
    }

    pub fn normalize_batch(&mut self, files: Vec<PathBuf>, cx: &mut Context<Self>) {
        let n = &mut self.normalize;
        if n.working || files.is_empty() {
            return;
        }
        n.working = true;
        n.error = None;
        n.batch.clear();
        let (settings, format_id) = (n.settings(), n.format);
        Self::in_background(
            cx,
            move || {
                files
                    .iter()
                    .map(|f| (f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), normalize_one(f, None, &settings, format_id)))
                    .collect::<Vec<_>>()
            },
            |shell, done, cx| {
                shell.normalize.working = false;
                let ok = done.iter().filter(|(_, r)| r.is_ok()).count();
                shell.normalize.batch = done;
                shell.note("Angeglichen", format!("{ok} {} angeglichen.", if ok == 1 { "Datei" } else { "Dateien" }), Some(Panel::Normalize));
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests: what the batch made.
    pub fn normalize_batch_result(&self) -> Vec<(String, Result<(PathBuf, String), String>)> {
        self.normalize.batch.clone()
    }
}
