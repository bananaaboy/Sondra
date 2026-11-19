//! The Video page: a video cut, turned, cropped, coloured, sped up or slowed, faded, and written as MP4, WebM,
//! GIF or WebP — in one pass of FFmpeg, as the web app does it (`sondra-media::video_ops` builds the very
//! same command line). The stage shows a still of what will be written at the place chosen on the slider;
//! the cut is set from that place. Also: the sound pulled out, a still saved, another soundtrack put under.
//!
//! Not yet as on the website: a playing preview with the changes (the stage is a still), the draggable
//! crop rectangle (a ratio, centred) and the timeline with handles (the cut is set at the slider's place).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use gpui::{div, img, prelude::*, px, AnyElement, Context, Entity, ImageSource, ObjectFit, PathPromptOptions, RenderImage};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_media::image_ops::{mirror_rect, rect_for_aspect, rotate_rect, Rect, ASPECTS};
use sondra_media::video_ops::{build_audio_extraction, build_audio_replacement, build_frame_grab, build_video_job, cropped_size, preview_filters, to_fixed, Container, CropBox, VideoOps, VIDEO_LOOKS, VIDEO_PRESETS};
use sondra_media::{Cancel, Ffmpeg, Progress};
use sondra_ui::{family, size, NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VTool {
    Cut,
    Turn,
    Crop,
    Speed,
    Colour,
    Sound,
    Save,
}

impl VTool {
    const ALL: [(VTool, &'static str); 7] = [
        (VTool::Cut, "Schnitt"),
        (VTool::Turn, "Drehen"),
        (VTool::Crop, "Ausschnitt"),
        (VTool::Speed, "Tempo"),
        (VTool::Colour, "Bild"),
        (VTool::Sound, "Ton und Blenden"),
        (VTool::Save, "Speichern"),
    ];
}

pub struct VRun {
    pub progress: Arc<Mutex<Progress>>,
    pub cancel: Cancel,
    pub what: String,
}

pub struct VideoState {
    pub file: Option<PathBuf>,
    pub duration: f64,
    pub source: Option<(u32, u32)>,
    pub has_audio: bool,
    pub ops: VideoOps,
    pub aspect: &'static str,
    pub tool: VTool,
    /// The place on the slider, in seconds.
    pub position: f64,
    pub frame: Option<Arc<RenderImage>>,
    pub trash: Vec<Arc<RenderImage>>,
    generation: u64,
    pub run: Option<VRun>,
    pub made: Vec<PathBuf>,
    pub error: Option<String>,
}

impl VideoState {
    pub fn new() -> VideoState {
        VideoState { file: None, duration: 0.0, source: None, has_audio: false, ops: VideoOps::default(), aspect: "free", tool: VTool::Cut, position: 0.0, frame: None, trash: Vec::new(), generation: 0, run: None, made: Vec::new(), error: None }
    }
}

impl Default for VideoState {
    fn default() -> Self {
        Self::new()
    }
}

fn clock(seconds: f64) -> String {
    let t = seconds.max(0.0);
    let whole = t as u64;
    format!("{}:{:02}{}", whole / 60, whole % 60, if t.fract() >= 0.05 { format!(",{}", ((t.fract() * 10.0).floor() as u64).min(9)) } else { String::new() })
}

fn to_box(r: Rect) -> CropBox {
    CropBox { x: r.x, y: r.y, width: r.width, height: r.height }
}
fn to_rect(c: CropBox) -> Rect {
    Rect { x: c.x, y: c.y, width: c.width, height: c.height }
}

/// The largest side of the still.
const STILL: u32 = 960;

impl Shell {
    pub(crate) fn choose_video(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.video_take(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Opens a video: its length and size are read, and the first still is made.
    pub fn video_take(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let v = &mut self.video;
        *v = VideoState { tool: v.tool, ..VideoState::new() };
        let probe = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string()).and_then(|ff| ff.probe(&path).map_err(|e| e.to_string()));
        match probe {
            Ok(p) => match p.streams.iter().find(|s| s.kind == "video" && !s.attached_picture && s.width.is_some()) {
                Some(stream) => {
                    v.source = stream.width.zip(stream.height).map(|(w, h)| (w as u32, h as u32));
                    v.duration = p.duration.unwrap_or(0.0);
                    v.has_audio = p.streams.iter().any(|s| s.kind == "audio");
                    v.file = Some(path);
                    // A first look a little way in: the very first frame is often black.
                    v.position = (v.duration * 0.05).min(2.0);
                }
                None => v.error = Some("In dieser Datei ist kein Bild — für Ton gibt es den Ton-Editor.".into()),
            },
            Err(e) => v.error = Some(e),
        }
        self.video_still(cx);
    }

    /// Makes the stage's still anew, in the background; the latest asked-for one wins.
    pub fn video_still(&mut self, cx: &mut Context<Self>) {
        let v = &mut self.video;
        let (Some(path), Some((w, h))) = (v.file.clone(), v.source) else {
            cx.notify();
            return;
        };
        v.generation += 1;
        let generation = v.generation;
        let ops = v.ops.clone();
        let at = v.position;
        Self::in_background(
            cx,
            move || -> Result<(u32, u32, Vec<u8>), String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let (cw, ch) = cropped_size(w, h, &ops);
                let f = (f64::from(STILL) / f64::from(cw.max(ch))).min(1.0);
                let (pw, ph) = (((f64::from(cw) * f).round().max(1.0)) as u32, ((f64::from(ch) * f).round().max(1.0)) as u32);
                let mut chain = preview_filters(&ops);
                chain.push(format!("scale={pw}:{ph}"));
                chain.push("format=bgra".into());
                let out = Command::new(ff.program())
                    .args(["-v", "error", "-nostdin", "-ss", &to_fixed(at, 3), "-i"])
                    .arg(&path)
                    .args(["-vf", &chain.join(","), "-frames:v", "1", "-f", "rawvideo", "-"])
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() || out.stdout.len() != (pw * ph * 4) as usize {
                    return Err(format!("Das Standbild liess sich nicht rechnen. {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")));
                }
                Ok((pw, ph, out.stdout))
            },
            move |shell, answer, cx| {
                let v = &mut shell.video;
                if v.generation != generation {
                    return;
                }
                match answer {
                    Ok((pw, ph, bgra)) => {
                        if let Some(buffer) = RgbaImage::from_raw(pw, ph, bgra) {
                            let new = Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)]));
                            if let Some(old) = v.frame.replace(new) {
                                v.trash.push(old);
                            }
                        }
                    }
                    Err(e) => v.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    fn video_patch(&mut self, change: impl FnOnce(&mut VideoState), cx: &mut Context<Self>) {
        change(&mut self.video);
        self.video.made.clear();
        self.video_still(cx);
    }

    /// Where the file goes: beside the source, `stem (suffix).ext`.
    fn video_target(&self, suffix: &str, ext: &str) -> Option<PathBuf> {
        let file = self.video.file.as_ref()?;
        let dir = file.parent()?;
        let stem = file.file_stem()?.to_string_lossy().into_owned();
        Some(sondra_media::run::unique_path(dir, &format!("{stem}{suffix}"), ext))
    }

    /// Runs FFmpeg with these arguments (the input among them), writing to `target`, with progress.
    fn video_run(&mut self, what: &str, args: Vec<String>, target: PathBuf, length: Option<f64>, cx: &mut Context<Self>) {
        let v = &mut self.video;
        if v.run.is_some() {
            return;
        }
        v.error = None;
        v.made.clear();
        let progress = Arc::new(Mutex::new(Progress::default()));
        let cancel = Cancel::new();
        v.run = Some(VRun { progress: progress.clone(), cancel: cancel.clone(), what: what.to_string() });
        Self::in_background(
            cx,
            move || -> Result<PathBuf, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let dir = target.parent().map(PathBuf::from).unwrap_or_default();
                let ext = target.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
                let temp = dir.join(format!(".sondra-video-{}.{ext}", std::process::id()));
                let _ = std::fs::remove_file(&temp);
                let mut all = args;
                all.push(temp.to_string_lossy().into_owned());
                match ff.run(&all, length, &cancel, &mut |p| *progress.lock().expect("lock") = p) {
                    Ok(()) => {}
                    Err(sondra_media::MediaError::Cancelled) => {
                        let _ = std::fs::remove_file(&temp);
                        return Err("Abgebrochen.".into());
                    }
                    Err(e) => {
                        let _ = std::fs::remove_file(&temp);
                        return Err(match e {
                            sondra_media::MediaError::Failed { tail, .. } => format!("Das hat nicht geklappt. {}", tail.lines().last().unwrap_or("")),
                            other => other.to_string(),
                        });
                    }
                }
                if std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0) == 0 {
                    let _ = std::fs::remove_file(&temp);
                    return Err("FFmpeg hat eine leere Datei geschrieben.".into());
                }
                std::fs::rename(&temp, &target).map_err(|e| e.to_string())?;
                Ok(target)
            },
            |shell, answer, cx| {
                let v = &mut shell.video;
                v.run = None;
                match answer {
                    Ok(path) => v.made = vec![path],
                    Err(e) => v.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Writes the edited video.
    pub fn video_save(&mut self, cx: &mut Context<Self>) {
        let v = &self.video;
        let Some(file) = v.file.clone() else { return };
        let job = build_video_job(&v.ops, &file.to_string_lossy(), v.duration, v.source);
        let Some(target) = self.video_target(" (bearbeitet)", job.extension) else { return };
        let ops = &self.video.ops;
        let end = if ops.end > 0.0 { ops.end } else { self.video.duration };
        let length = ((end - ops.start).max(0.01)) / ops.speed.max(0.01);
        self.video_run("Schreibt das Video", job.args, target, Some(length), cx);
    }

    /// Pulls the sound out (`copy`, `wav`, `mp3`, `flac`).
    pub fn video_extract(&mut self, format: &str, cx: &mut Context<Self>) {
        let Some(file) = self.video.file.clone() else { return };
        let job = build_audio_extraction(&file.to_string_lossy(), format);
        let Some(target) = self.video_target(" (Ton)", job.extension) else { return };
        let length = Some(self.video.duration);
        self.video_run("Zieht den Ton heraus", job.args, target, length, cx);
    }

    /// Saves the picture at the slider's place as a PNG.
    pub fn video_grab(&mut self, cx: &mut Context<Self>) {
        let Some(file) = self.video.file.clone() else { return };
        let job = build_frame_grab(&file.to_string_lossy(), self.video.position);
        let Some(target) = self.video_target(&format!(" (Standbild {})", clock(self.video.position).replace(':', "-")), job.extension) else { return };
        self.video_run("Speichert das Standbild", job.args, target, None, cx);
    }

    /// Puts another soundtrack under the picture.
    pub fn video_replace_sound(&mut self, audio: PathBuf, cx: &mut Context<Self>) {
        let Some(file) = self.video.file.clone() else { return };
        let job = build_audio_replacement(&file.to_string_lossy(), &audio.to_string_lossy());
        let Some(target) = self.video_target(" (neuer Ton)", job.extension) else { return };
        let length = Some(self.video.duration);
        self.video_run("Legt den Ton unter", job.args, target, length, cx);
    }

    fn choose_replacement_sound(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| shell.video_replace_sound(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// For tests: the settings as they are.
    pub fn video_ops(&self) -> &VideoOps {
        &self.video.ops
    }

    /// For tests: where the written files are.
    pub fn video_made(&self) -> &[PathBuf] {
        &self.video.made
    }

    /// For tests: whether the stage has a still.
    pub fn video_has_still(&self) -> bool {
        self.video.frame.is_some()
    }

    /// For tests: the place on the slider.
    pub fn video_set_position(&mut self, seconds: f64, cx: &mut Context<Self>) {
        self.video_patch(|v| v.position = seconds.clamp(0.0, v.duration), cx);
    }

    pub(crate) fn video_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me: Entity<Shell> = cx.entity();
        let c = ui.c;
        let v = &self.video;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.heading("Video bearbeiten"));
        page = page.child(ui.prose("Schneiden, drehen, zuschneiden, Farbe, Tempo und Blenden einstellen und als MP4, WebM, GIF oder WebP speichern — in einem Durchgang. Die Bühne zeigt ein Standbild von dem, was geschrieben wird. Das Original bleibt, wie es ist; das Ergebnis liegt daneben."));
        if let Some(error) = &v.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let choose = {
            let me = me.clone();
            ui.button("video-waehlen", if v.file.is_some() { "Anderes Video wählen" } else { "Video wählen" }).primary().disabled(v.run.is_some()).on_click(move |_, app| me.update(app, |shell, cx| shell.choose_video(cx)))
        };
        page = page.child(div().flex().flex_wrap().items_center().gap(px(12.)).child(choose));
        let (Some(file), Some((w, h))) = (&v.file, v.source) else { return page.into_any_element() };
        let ops = &v.ops;

        // The stage and its slider.
        let mut stage = div().relative().w_full().h(px(420.)).rounded(px(sondra_ui::radius::CARD)).bg(c.stage).overflow_hidden().flex().items_center().justify_center();
        stage = match &v.frame {
            Some(image) => stage.child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Contain).size_full()),
            None => stage.child(div().text_color(c.stage_muted).child("Das Bild kommt …")),
        };
        let seek = {
            let me = me.clone();
            let duration = v.duration.max(0.001);
            ui.slider("video-stelle", "Stelle im Video", (v.position / duration) as f32).step((1.0 / duration.max(10.0)) as f32).says(format!("{} von {}", clock(v.position), clock(v.duration))).on_change(move |frac, _, app| {
                me.update(app, |shell, cx| shell.video_set_position(f64::from(frac) * shell.video.duration, cx))
            })
        };
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let end = if ops.end > 0.0 { ops.end } else { v.duration };
        let kept = ((end - ops.start).max(0.0)) / ops.speed.max(0.01);
        let caption = div().flex().flex_wrap().items_baseline().gap(px(12.)).child(ui.value(name)).child(ui.hint(format!("{w} × {h} px · {} · Ergebnis {}", clock(v.duration), clock(kept))));

        // The tools.
        let mut rail = div().flex().flex_wrap().gap(px(6.));
        for (tool, label) in VTool::ALL {
            let me = me.clone();
            rail = rail.child(ui.chip(format!("vwerkzeug-{label}"), label, v.tool == tool).accessible_name(format!("Werkzeug {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.video.tool = tool;
                cx.notify();
            })));
        }
        let steps = |title: &str, key: &'static str, values: Vec<(f64, String)>, now: f64, set: fn(&mut VideoOps, f64)| {
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            for (val, label) in values {
                let me = me.clone();
                chips = chips.child(ui.chip(format!("{key}-{label}"), label.clone(), (now - val).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| set(&mut s.ops, val), cx))));
            }
            div().flex().flex_col().gap(px(8.)).child(ui.subheading(title.to_string())).child(chips)
        };
        let toggle = |id: &'static str, label: &str, on: bool, set: fn(&mut VideoOps, bool)| {
            let me = me.clone();
            ui.chip(id, label.to_string(), on).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| set(&mut s.ops, !on), cx)))
        };
        let mut panel = div().flex().flex_col().gap(px(16.));
        match v.tool {
            VTool::Cut => {
                let (a, b, all) = (me.clone(), me.clone(), me.clone());
                panel = panel
                    .child(ui.prose("Fahren Sie mit der Stelle unter dem Bild an den Anfang und setzen Sie ihn, dann ans Ende."))
                    .child(div().flex().flex_wrap().gap(px(8.)).child(ui.button("anfang-hier", format!("Anfang hier ({})", clock(ops.start))).small().on_click(move |_, app| a.update(app, |shell, cx| shell.video_patch(|s| {
                        s.ops.start = s.position;
                        if s.ops.end > 0.0 && s.ops.end <= s.ops.start {
                            s.ops.end = 0.0;
                        }
                    }, cx)))).child(ui.button("ende-hier", format!("Ende hier ({})", if ops.end > 0.0 { clock(ops.end) } else { "Ende".into() })).small().on_click(move |_, app| b.update(app, |shell, cx| shell.video_patch(|s| {
                        if s.position > s.ops.start {
                            s.ops.end = s.position;
                        }
                    }, cx)))))
                    .child(ui.button("ganzes-video", "Ganzes Video").small().disabled(ops.start == 0.0 && ops.end == 0.0).on_click(move |_, app| all.update(app, |shell, cx| shell.video_patch(|s| {
                        s.ops.start = 0.0;
                        s.ops.end = 0.0;
                    }, cx))))
                    .child(ui.hint(if ops.start > 0.0 || ops.end > 0.0 { format!("Bleibt: {} bis {} ({} lang).", clock(ops.start), clock(end), clock((end - ops.start).max(0.0))) } else { "Das ganze Video bleibt.".to_string() }));
            }
            VTool::Turn => {
                let (left, right, hf, vf) = (me.clone(), me.clone(), me.clone(), me.clone());
                panel = panel
                    .child(div().flex().flex_wrap().gap(px(8.)).child(ui.button("v-links-drehen", "Nach links drehen").small().on_click(move |_, app| left.update(app, |shell, cx| shell.video_patch(|s| turn(s, 270), cx)))).child(ui.button("v-rechts-drehen", "Nach rechts drehen").small().on_click(move |_, app| right.update(app, |shell, cx| shell.video_patch(|s| turn(s, 90), cx)))))
                    .child(div().flex().flex_wrap().gap(px(6.)).child(ui.chip("v-waagrecht", "Waagrecht spiegeln", ops.flip_h).on_click(move |_, app| hf.update(app, |shell, cx| shell.video_patch(|s| flip(s, 'h'), cx)))).child(ui.chip("v-senkrecht", "Senkrecht spiegeln", ops.flip_v).on_click(move |_, app| vf.update(app, |shell, cx| shell.video_patch(|s| flip(s, 'v'), cx)))));
            }
            VTool::Crop => {
                let mut ratios = div().flex().flex_wrap().gap(px(6.));
                for (id, label, ratio) in ASPECTS {
                    let me = me.clone();
                    ratios = ratios.child(ui.chip(format!("vseite-{id}"), label, v.aspect == id).accessible_name(format!("Seitenverhältnis {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| {
                        s.aspect = id;
                        let (fw, fh) = if s.ops.rotate == 90 || s.ops.rotate == 270 { (h, w) } else { (w, h) };
                        s.ops.crop = ratio.map(|_| to_box(rect_for_aspect(ratio, f64::from(fw) / f64::from(fh), None)));
                    }, cx))));
                }
                let (cw, ch) = cropped_size(w, h, ops);
                panel = panel.child(ui.subheading("Seitenverhältnis")).child(ratios).child(ui.hint(if ops.crop.is_some() { format!("Ausschnitt: {cw} × {ch} px, in der Mitte.") } else { "Das ganze Bild.".to_string() }));
            }
            VTool::Speed => {
                panel = panel.child(steps("Tempo", "vtempo", [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 4.0].iter().map(|x| (*x, format!("{}×", format!("{x}").replace('.', ",")))).collect(), ops.speed, |o, x| o.speed = x)).child(toggle("v-rueckwaerts", "Rückwärts", ops.reverse, |o, on| o.reverse = on));
            }
            VTool::Colour => {
                let mut looks = div().flex().flex_wrap().gap(px(6.));
                for (look, _, label) in VIDEO_LOOKS {
                    let me = me.clone();
                    looks = looks.child(ui.chip(format!("look-{label}"), label, ops.look == look).accessible_name(format!("Look {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| s.ops.look = look, cx))));
                }
                panel = panel
                    .child(steps("Helligkeit", "vhell", [-0.2, -0.1, 0.0, 0.1, 0.2].iter().map(|x| (*x, format!("{:+}", (x * 100.0_f64).round() as i64).replace('+', "+"))).collect(), ops.brightness, |o, x| o.brightness = x))
                    .child(steps("Kontrast", "vkontrast", [0.7, 0.85, 1.0, 1.15, 1.3].iter().map(|x| (*x, format!("{} %", (x * 100.0_f64).round() as i64))).collect(), ops.contrast, |o, x| o.contrast = x))
                    .child(steps("Sättigung", "vsaettigung", [0.0, 0.5, 1.0, 1.5, 2.0].iter().map(|x| (*x, format!("{} %", (x * 100.0_f64).round() as i64))).collect(), ops.saturation, |o, x| o.saturation = x))
                    .child(div().flex().flex_col().gap(px(8.)).child(ui.subheading("Look")).child(looks))
                    .child(div().flex().flex_wrap().gap(px(6.)).child(toggle("v-schaerfen", "Schärfen", ops.sharpen, |o, on| o.sharpen = on)).child(toggle("v-entrauschen", "Entrauschen", ops.denoise, |o, on| o.denoise = on)).child(toggle("v-stabilisieren", "Stabilisieren", ops.stabilize, |o, on| o.stabilize = on)));
            }
            VTool::Sound => {
                let secs = |xs: &[f64]| -> Vec<(f64, String)> { xs.iter().map(|x| (*x, if *x == 0.0 { "Aus".to_string() } else { format!("{} s", format!("{x}").replace('.', ",")) })).collect() };
                panel = panel
                    .child(steps("Einblenden", "einblenden", secs(&[0.0, 0.5, 1.0, 2.0]), ops.fade_in, |o, x| o.fade_in = x))
                    .child(steps("Ausblenden", "ausblenden", secs(&[0.0, 0.5, 1.0, 2.0]), ops.fade_out, |o, x| o.fade_out = x))
                    .child(steps("Lautstärke", "vlautstaerke", [-12.0, -6.0, 0.0, 3.0, 6.0].iter().map(|x| (*x, if *x == 0.0 { "0 dB".to_string() } else { format!("{:+} dB", x).replace('-', "−") })).collect(), ops.volume_db, |o, x| o.volume_db = x))
                    .child(div().flex().flex_wrap().gap(px(6.)).child(toggle("v-lautheit", "Auf −16 LUFS bringen", ops.loudnorm, |o, on| o.loudnorm = on)).child(toggle("v-stumm", "Ohne Ton", ops.mute, |o, on| o.mute = on)));
                if !v.has_audio {
                    panel = panel.child(ui.hint("Dieses Video hat keinen Ton."));
                }
            }
            VTool::Save => {
                let mut containers = div().flex().flex_wrap().gap(px(6.));
                for (container, label) in [(Container::Mp4, "MP4"), (Container::Webm, "WebM"), (Container::Gif, "GIF"), (Container::Webp, "WebP")] {
                    let me = me.clone();
                    containers = containers.child(ui.chip(format!("behaelter-{label}"), label, ops.container == container).accessible_name(format!("Format {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| s.ops.container = container, cx))));
                }
                panel = panel.child(ui.subheading("Format")).child(containers);
                if matches!(ops.container, Container::Mp4 | Container::Webm) {
                    let mut presets = div().flex().flex_wrap().gap(px(6.));
                    for p in VIDEO_PRESETS {
                        let me = me.clone();
                        let id = p.id;
                        presets = presets.child(ui.chip(format!("voreinstellung-{id}"), p.label, ops.preset == id).accessible_name(format!("Qualität {}", p.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(move |s| s.ops.preset = id.to_string(), cx))));
                    }
                    let hint = VIDEO_PRESETS.iter().find(|p| p.id == ops.preset).map_or("", |p| p.hint);
                    panel = panel.child(ui.subheading("Qualität")).child(presets).child(ui.hint(hint));
                } else {
                    panel = panel
                        .child(steps("Bilder je Sekunde", "bps", [8.0, 10.0, 12.0, 15.0, 24.0].iter().map(|x| (*x, format!("{x}"))).collect(), ops.fps, |o, x| o.fps = x))
                        .child(steps("Breite", "vbreite", [240.0, 320.0, 480.0, 640.0].iter().map(|x| (*x, format!("{x} px"))).collect(), ops.width, |o, x| o.width = x));
                }
                let busy = v.run.is_some();
                let (save, grab, replace) = (me.clone(), me.clone(), me.clone());
                panel = panel.child(div().flex().flex_wrap().gap(px(8.)).child(ui.button("video-speichern", "Video speichern").primary().disabled(busy).on_click(move |_, app| save.update(app, |shell, cx| shell.video_save(cx)))).child(ui.button("standbild-speichern", "Standbild speichern").small().disabled(busy).on_click(move |_, app| grab.update(app, |shell, cx| shell.video_grab(cx)))));
                let mut sound = div().flex().flex_wrap().items_center().gap(px(8.)).child(ui.hint("Ton herausziehen:"));
                if v.has_audio {
                    for (format, label) in [("copy", "Unverändert"), ("wav", "WAV"), ("mp3", "MP3"), ("flac", "FLAC")] {
                        let me = me.clone();
                        sound = sound.child(ui.button(format!("ton-{format}"), label).small().disabled(busy).accessible_name(format!("Ton als {label} herausziehen")).on_click(move |_, app| me.update(app, |shell, cx| shell.video_extract(format, cx))));
                    }
                }
                sound = sound.child(ui.button("anderen-ton", "Anderen Ton unterlegen …").small().disabled(busy).on_click(move |_, app| replace.update(app, |shell, cx| shell.choose_replacement_sound(cx))));
                panel = panel.child(sound);
            }
        }
        let mut reset = div().flex();
        {
            let me = me.clone();
            let untouched = *ops == VideoOps { container: ops.container, preset: ops.preset.clone(), fps: ops.fps, width: ops.width, ..VideoOps::default() };
            reset = reset.child(ui.button("v-zuruecksetzen", "Alles zurücksetzen").small().disabled(untouched).on_click(move |_, app| me.update(app, |shell, cx| shell.video_patch(|s| {
                s.ops = VideoOps { container: s.ops.container, preset: s.ops.preset.clone(), fps: s.ops.fps, width: s.ops.width, ..VideoOps::default() };
                s.aspect = "free";
            }, cx))));
        }

        // Progress, and what was written.
        let mut status = div().flex().flex_col().gap(px(8.));
        if let Some(run) = &v.run {
            let p = *run.progress.lock().expect("lock");
            let cancel = run.cancel.clone();
            status = status.child(ui.bar("video-fortschritt", p.fraction.map(|f| f as f32), run.what.clone())).child(div().flex().flex_wrap().items_center().gap(px(12.)).child(div().font_family(family::VALUE).text_size(px(size::SMALL)).child(p.speed.map_or(String::new(), |x| format!("{x:.1}× so schnell wie abgespielt")))).child(ui.button("video-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.cancel())));
        }
        for path in &v.made {
            let (play, show) = (me.clone(), me.clone());
            let (p, folder) = (path.clone(), path.parent().map(PathBuf::from));
            let name = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            let size = std::fs::metadata(path).map(|m| sondra_merk::format::format_bytes(m.len() as f64, 1)).unwrap_or_default();
            status = status.child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(10.))
                    .child(ui.value(name.clone()))
                    .child(ui.hint(size))
                    .child(ui.button(format!("vabspielen-{}", path.display()), "Abspielen").small().accessible_name(format!("{name} abspielen")).on_click(move |_, app| {
                        let p = p.clone();
                        play.update(app, |shell, cx| {
                            shell.go(Panel::Player, cx);
                            shell.play_files(vec![p], cx);
                        })
                    }))
                    .child(ui.button(format!("vzeigen-{}", path.display()), "Im Ordner zeigen").small().accessible_name(format!("{name} im Ordner zeigen")).on_click(move |_, app| {
                        if let Some(folder) = folder.clone() {
                            show.update(app, |shell, cx| {
                                shell.go(Panel::Folder, cx);
                                shell.open_folder(folder, cx);
                            })
                        }
                    })),
            );
        }
        let stage_col = div().flex_1().min_w(px(360.)).flex().flex_col().gap(px(12.)).child(stage).child(seek).child(status);
        let controls = div().w(px(380.)).flex_none().flex().flex_col().gap(px(16.)).child(rail).child(panel).child(reset);
        page.child(caption).child(div().flex().flex_wrap().items_start().gap(px(24.)).child(stage_col).child(controls)).into_any_element()
    }
}

/// Turns the picture a quarter (90 clockwise, 270 counter-clockwise); the crop turns with it.
fn turn(s: &mut VideoState, by: u16) {
    s.ops.rotate = (s.ops.rotate + by) % 360;
    if let Some(c) = s.ops.crop {
        s.ops.crop = Some(to_box(rotate_rect(to_rect(c), by)));
    }
}

fn flip(s: &mut VideoState, axis: char) {
    if axis == 'h' {
        s.ops.flip_h = !s.ops.flip_h;
    } else {
        s.ops.flip_v = !s.ops.flip_v;
    }
    if let Some(c) = s.ops.crop {
        s.ops.crop = Some(to_box(mirror_rect(to_rect(c), axis)));
    }
}

