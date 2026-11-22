//! The Bilder page: a picture turned, mirrored, cropped, scaled, coloured, softened or sharpened, and written
//! as WebP, JPEG or PNG — one picture with a stage that shows what will be written, or many at once. The
//! operations are `sondra-media::image_ops` (the web app's order and arithmetic, FFmpeg's filters); the
//! stage and the file come out of one function, so the preview does not lie.
//!
//! Not yet as on the website: the crop is chosen by ratio and centred (the free rectangle with handles to
//! drag is open), results are written beside their sources instead of into a ZIP.

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use gpui::{canvas, div, img, prelude::*, px, AnyElement, Bounds, Context, Entity, ImageSource, ObjectFit, PathPromptOptions, Pixels, RenderImage};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_media::image_ops::{mirror_rect, output_size, process_file, render_bgra, rect_for_aspect, rotate_rect, size_of, Format, ImageOps, Made, ASPECTS};
use sondra_media::Ffmpeg;
use sondra_ui::{NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Crop,
    Turn,
    Size,
    Colour,
    Sharpen,
    Save,
    Batch,
}

impl Tool {
    const ALL: [(Tool, &'static str); 7] = [
        (Tool::Crop, "Ausschnitt"),
        (Tool::Turn, "Drehen"),
        (Tool::Size, "Größe"),
        (Tool::Colour, "Farbe"),
        (Tool::Sharpen, "Schärfe"),
        (Tool::Save, "Speichern"),
        (Tool::Batch, "Viele"),
    ];
}

pub struct ImagesState {
    pub files: Vec<PathBuf>,
    pub active: usize,
    pub dims: Option<(u32, u32)>,
    pub ops: ImageOps,
    pub aspect: &'static str,
    pub tool: Tool,
    pub preview: Option<Arc<RenderImage>>,
    /// Pictures the window should let go of (it frees them at the next draw).
    pub trash: Vec<Arc<RenderImage>>,
    /// Which request is the latest; an older answer is dropped.
    generation: u64,
    pub previewing: bool,
    pub made: Vec<Made>,
    pub working: bool,
    pub error: Option<String>,
    /// The stage and the picture on it as drawn last, and what a press on the crop took hold of.
    pub stage_bounds: Rc<Cell<Bounds<Pixels>>>,
    pub crop_bounds: Rc<Cell<Bounds<Pixels>>>,
    pub crop_drag: Option<sondra_media::crop_drag::Drag>,
    /// „Rückgängig“ and „Wiederholen“ over the settings.
    pub history: crate::ops_history::OpsHistory<ImageOps>,
    /// „Vergleichen“: the stage shows the original.
    pub compare: bool,
}

impl ImagesState {
    pub fn new() -> ImagesState {
        ImagesState {
            files: Vec::new(),
            active: 0,
            dims: None,
            ops: ImageOps::default(),
            aspect: "free",
            tool: Tool::Crop,
            preview: None,
            trash: Vec::new(),
            generation: 0,
            previewing: false,
            made: Vec::new(),
            working: false,
            error: None,
            stage_bounds: Rc::new(Cell::new(Bounds::default())),
            crop_bounds: Rc::new(Cell::new(Bounds::default())),
            crop_drag: None,
            history: Default::default(),
            compare: false,
        }
    }

    pub fn current(&self) -> Option<&PathBuf> {
        self.files.get(self.active)
    }
}

impl Default for ImagesState {
    fn default() -> Self {
        Self::new()
    }
}

/// The largest side of the preview, in pixels.
const PREVIEW: u32 = 1100;

impl Shell {
    pub(crate) fn choose_images(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.images_take(paths, cx)).ok();
            }
        })
        .detach();
    }

    /// Takes pictures; the first is opened.
    pub fn images_take(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() {
            return;
        }
        let i = &mut self.images;
        i.files = paths;
        i.active = 0;
        i.made.clear();
        i.error = None;
        i.ops = ImageOps::default();
        i.aspect = "free";
        self.images_open_active(cx);
    }

    fn images_open_active(&mut self, cx: &mut Context<Self>) {
        let i = &mut self.images;
        i.dims = None;
        let Some(path) = i.current().cloned() else { return };
        i.ops.crop = None;
        i.aspect = "free";
        match Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string()).and_then(|ff| size_of(&ff, &path).map_err(|e| e.to_string())) {
            Ok(dims) => {
                i.dims = Some(dims);
                i.error = None;
            }
            Err(e) => i.error = Some(e),
        }
        self.images_preview(cx);
    }

    pub fn images_pick(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.images.files.len() {
            self.images.active = index;
            self.images.made.clear();
            self.images_open_active(cx);
        }
    }

    /// Makes the stage's picture anew, in the background; the latest asked-for one wins.
    pub fn images_preview(&mut self, cx: &mut Context<Self>) {
        let i = &mut self.images;
        let (Some(path), Some((w, h))) = (i.current().cloned(), i.dims) else {
            cx.notify();
            return;
        };
        i.generation += 1;
        let generation = i.generation;
        i.previewing = true;
        // While the crop is drawn the picture is shown whole, with the crop on it.
        let mut ops = if i.compare { ImageOps { format: i.ops.format, quality: i.ops.quality, ..ImageOps::default() } } else { i.ops.clone() };
        if i.tool == Tool::Crop {
            ops.crop = None;
        }
        Self::in_background(
            cx,
            move || -> Result<(u32, u32, Vec<u8>), String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                render_bgra(&ff, &path, w, h, &ops, PREVIEW)
            },
            move |shell, answer, cx| {
                let i = &mut shell.images;
                if i.generation != generation {
                    return;
                }
                i.previewing = false;
                match answer {
                    Ok((pw, ph, bgra)) => {
                        if let Some(buffer) = RgbaImage::from_raw(pw, ph, bgra) {
                            let new = Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)]));
                            if let Some(old) = i.preview.replace(new) {
                                i.trash.push(old);
                            }
                        }
                    }
                    Err(e) => i.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// A press on the crop: takes hold of a handle, the middle, or starts a new rectangle.
    pub(crate) fn images_crop_down(&mut self, bounds: Bounds<Pixels>, at: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        let Some((x, y)) = crate::crop_ui::fractions(bounds, at) else { return };
        let (wp, hp): (f32, f32) = (bounds.size.width.into(), bounds.size.height.into());
        let rect = self.images.ops.crop.unwrap_or(sondra_media::image_ops::FULL_RECT);
        self.images.crop_drag = Some(crate::crop_ui::begin(&rect, x, y, f64::from(wp), f64::from(hp)));
        self.images_crop_move(bounds, at, cx);
    }

    /// The pointer moves with the button down: the rectangle follows, kept to the ratio when one is chosen.
    pub(crate) fn images_crop_move(&mut self, bounds: Bounds<Pixels>, at: gpui::Point<Pixels>, cx: &mut Context<Self>) {
        let (Some(drag), Some((x, y)), Some((w, h))) = (self.images.crop_drag, crate::crop_ui::fractions(bounds, at), self.images.dims) else { return };
        let (fw, fh) = sondra_media::image_ops::rotated_size(w, h, self.images.ops.rotate);
        let ratio = ASPECTS.iter().find(|(id, _, _)| *id == self.images.aspect).and_then(|(_, _, r)| *r);
        let rect = sondra_media::crop_drag::drag_rect(&drag, x, y, ratio, f64::from(fw) / f64::from(fh.max(1)));
        // The whole picture is no crop at all.
        self.images.ops.crop = if crate::crop_ui::is_full(&rect) { None } else { Some(rect) };
        self.images.made.clear();
        cx.notify();
    }

    /// For tests: where the crop picture was drawn.
    pub fn images_crop_bounds(&self) -> Bounds<Pixels> {
        self.images.crop_bounds.get()
    }

    /// For tests: the crop as it is.
    pub fn images_crop(&self) -> Option<sondra_media::image_ops::Rect> {
        self.images.ops.crop
    }

    pub(crate) fn images_patch(&mut self, change: impl FnOnce(&mut ImagesState), cx: &mut Context<Self>) {
        change(&mut self.images);
        self.images.made.clear();
        self.images_preview(cx);
    }

    /// Writes the active picture (or all of them) beside their sources.
    pub fn images_save(&mut self, all: bool, cx: &mut Context<Self>) {
        let i = &mut self.images;
        if i.working || i.files.is_empty() {
            return;
        }
        i.working = true;
        i.error = None;
        i.made.clear();
        let jobs: Vec<(PathBuf, ImageOps)> = if all {
            // The crop is a rectangle drawn on one picture; everything else goes for all.
            i.files.iter().enumerate().map(|(n, p)| (p.clone(), if n == i.active { i.ops.clone() } else { ImageOps { crop: None, ..i.ops.clone() } })).collect()
        } else {
            i.current().map(|p| vec![(p.clone(), i.ops.clone())]).unwrap_or_default()
        };
        Self::in_background(
            cx,
            move || -> Result<Vec<Made>, String> {
                let ff = Ffmpeg::locate().ok_or("FFmpeg ist nicht da.".to_string())?;
                let mut made = Vec::new();
                for (path, ops) in jobs {
                    let dir = path.parent().map(PathBuf::from).unwrap_or_default();
                    let stem = format!("{} (bearbeitet)", path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Bild".into()));
                    made.push(process_file(&ff, &path, &dir, &stem, &ops).map_err(|e| format!("{}: {e}", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))?);
                }
                Ok(made)
            },
            |shell, answer, cx| {
                let i = &mut shell.images;
                i.working = false;
                match answer {
                    Ok(made) => i.made = made,
                    Err(e) => i.error = Some(e),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// For tests: what the stage shows, as its size (`None` while there is none).
    pub fn images_preview_size(&self) -> Option<(u32, u32)> {
        self.images.preview.as_ref().map(|p| {
            let s = p.size(0);
            (s.width.0 as u32, s.height.0 as u32)
        })
    }

    /// For tests: the operations as they are.
    /// One step back in the settings.
    pub fn images_undo(&mut self, cx: &mut Context<Self>) {
        let now = self.images.ops.clone();
        if let Some(back) = self.images.history.undo(&now) {
            self.images.ops = back;
            self.images.made.clear();
            self.images_preview(cx);
        }
    }

    pub fn images_redo(&mut self, cx: &mut Context<Self>) {
        let now = self.images.ops.clone();
        if let Some(next) = self.images.history.redo(&now) {
            self.images.ops = next;
            self.images.made.clear();
            self.images_preview(cx);
        }
    }

    pub fn images_ops(&self) -> &ImageOps {
        &self.images.ops
    }

    /// For tests: where the written pictures are.
    pub fn images_made(&self) -> &[Made] {
        &self.images.made
    }

    pub(crate) fn images_page(&self, ui: Ui, cx: &mut Context<Self>) -> AnyElement {
        let me: Entity<Shell> = cx.entity();
        let c = ui.c;
        let i = &self.images;
        let mut page = div().flex().flex_col().gap(px(20.)).child(ui.page_head("Bilder", "Drehen, zuschneiden, verkleinern, Farbe und Schärfe einstellen und als WebP, JPEG oder PNG speichern. Die Bühne zeigt, was geschrieben wird. Das Original bleibt, wie es ist; das Ergebnis liegt daneben."));
        if let Some(error) = &i.error {
            page = page.child(ui.notice(NoticeKind::Warning, error.clone()));
        }
        let choose = {
            let me = me.clone();
            ui.button("bilder-waehlen", if i.files.is_empty() { "Bilder wählen" } else { "Andere Bilder wählen" }).primary().on_click(move |_, app| me.update(app, |shell, cx| shell.choose_images(cx)))
        };
        if let Some(path) = i.current() {
            i.history.observe(&path.to_string_lossy(), &i.ops, i.crop_drag.is_none());
        }
        let (undo, redo, compare, uncrop) = (me.clone(), me.clone(), me.clone(), me.clone());
        let mut tools = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(12.))
            .child(choose);
        if !i.files.is_empty() {
            let on = i.compare;
            tools = tools
                .child(ui.button("bild-rueckgaengig", "Rückgängig").small().accessible_name("Rückgängig (Strg+Z)").disabled(!i.history.can_undo()).on_click(move |_, app| undo.update(app, |shell, cx| shell.images_undo(cx))))
                .child(ui.button("bild-wiederholen", "Wiederholen").small().accessible_name("Wiederholen (Strg+Umschalt+Z)").disabled(!i.history.can_redo()).on_click(move |_, app| redo.update(app, |shell, cx| shell.images_redo(cx))))
                .child(ui.chip("bild-vergleichen", "Vergleichen", on).accessible_name("Mit dem Original vergleichen").on_click(move |_, app| compare.update(app, |shell, cx| {
                    shell.images.compare = !on;
                    shell.images_preview(cx);
                })))
                .child(ui.button("ausschnitt-aufheben", "Ausschnitt aufheben").small().ghost().disabled(i.ops.crop.is_none()).on_click(move |_, app| uncrop.update(app, |shell, cx| shell.images_patch(|s| s.ops.crop = None, cx))));
        }
        page = page.child(tools);
        let (Some(path), Some((w, h))) = (i.current(), i.dims) else {
            if i.files.is_empty() {
                page = page.child(ui.empty("bilder-leer", "Noch kein Bild gewählt", "Danach steht es hier auf der Bühne, die Werkzeuge rechts daneben. Mehrere Bilder bekommen dieselben Schritte.", vec![]));
            }
            return page.into_any_element();
        };
        let ops = &i.ops;
        let (ow, oh) = output_size(w, h, ops);

        // The stage.
        let mut stage = div().relative().w_full().h(px(460.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_soft).overflow_hidden().flex().items_center().justify_center();
        let measure_stage = i.stage_bounds.clone();
        stage = stage.child(canvas(move |b, _, _| measure_stage.set(b), |_, _, _, _| {}).absolute().top_0().left_0().size_full());
        stage = match &i.preview {
            Some(image) if i.tool == Tool::Crop => {
                // The picture whole, at the size it fits the stage, with the crop drawn on it.
                let (fw, fh) = sondra_media::image_ops::rotated_size(w, h, ops.rotate);
                let aspect = f64::from(fw) / f64::from(fh.max(1));
                let (stage_w, stage_h): (f32, f32) = (i.stage_bounds.get().size.width.into(), 460.0);
                let stage_w = if stage_w > 1.0 { stage_w } else { 10_000.0 };
                let (dw, dh) = if f64::from(stage_w / stage_h) > aspect { ((f64::from(stage_h) * aspect) as f32, stage_h) } else { (stage_w, (f64::from(stage_w) / aspect) as f32) };
                let rect = ops.crop.unwrap_or(sondra_media::image_ops::FULL_RECT);
                let handlers = crate::crop_ui::Handlers {
                    down: {
                        let me = me.clone();
                        Rc::new(move |b, at, app| me.update(app, |shell, cx| shell.images_crop_down(b, at, cx)))
                    },
                    drag: {
                        let me = me.clone();
                        Rc::new(move |b, at, app| me.update(app, |shell, cx| shell.images_crop_move(b, at, cx)))
                    },
                    up: {
                        let me = me.clone();
                        Rc::new(move |app| me.update(app, |shell, _| shell.images.crop_drag = None))
                    },
                };
                stage.child(div().relative().w(px(dw)).h(px(dh)).child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Fill).size_full()).child(crate::crop_ui::overlay(c, rect, i.crop_bounds.clone(), handlers)))
            }
            Some(image) => stage.child(img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Contain).size_full()),
            None => stage.child(div().text_color(c.prose).child("Das Bild kommt …")),
        };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let caption = div().flex().flex_wrap().items_baseline().gap(px(12.)).child(ui.value(name)).child(ui.hint(format!("{w} × {h} px → {ow} × {oh} px{}", if i.previewing { " · rechnet …" } else { "" })));

        // The tools.
        let mut rail = div().flex().flex_wrap().gap(px(6.));
        for (tool, label) in Tool::ALL {
            if tool == Tool::Batch && i.files.len() < 2 {
                continue;
            }
            let me = me.clone();
            rail = rail.child(ui.chip(format!("werkzeug-{label}"), label, i.tool == tool).accessible_name(format!("Werkzeug {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                let was = shell.images.tool == Tool::Crop;
                shell.images.tool = tool;
                shell.images.crop_drag = None;
                if was != (tool == Tool::Crop) {
                    shell.images_preview(cx);
                } else {
                    cx.notify();
                }
            })));
        }
        let steps = |title: &str, key: &'static str, values: Vec<(f64, String)>, now: f64, set: fn(&mut ImageOps, f64)| {
            let mut chips = div().flex().flex_wrap().gap(px(6.));
            for (v, label) in values {
                let me = me.clone();
                chips = chips.child(ui.chip(format!("{key}-{label}"), label.clone(), (now - v).abs() < 1e-9).accessible_name(format!("{title} {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.images_patch(move |s| set(&mut s.ops, v), cx))));
            }
            div().flex().flex_col().gap(px(8.)).child(ui.subheading(title.to_string())).child(chips)
        };
        let percent = |from: f64, to: f64, step: f64| -> Vec<(f64, String)> {
            let mut out = Vec::new();
            let mut v = from;
            while v <= to + 1e-9 {
                out.push((v, format!("{} %", (v * 100.0).round())));
                v += step;
            }
            out
        };
        let mut panel = div().flex().flex_col().gap(px(16.));
        match i.tool {
            Tool::Crop => {
                let mut ratios = div().flex().flex_wrap().gap(px(6.));
                for (id, label, ratio) in ASPECTS {
                    let me = me.clone();
                    ratios = ratios.child(ui.chip(format!("seite-{id}"), label, i.aspect == id).accessible_name(format!("Seitenverhältnis {label}")).on_click(move |_, app| me.update(app, |shell, cx| {
                        shell.images_patch(
                            move |s| {
                                s.aspect = id;
                                let (fw, fh) = sondra_media::image_ops::rotated_size(w, h, s.ops.rotate);
                                s.ops.crop = match ratio {
                                    None => None,
                                    Some(_) => Some(rect_for_aspect(ratio, f64::from(fw) / f64::from(fh), None)),
                                };
                            },
                            cx,
                        )
                    })));
                }
                let reset = me.clone();
                panel = panel.child(ui.prose("Ziehen Sie im Bild ein Rechteck auf. An den Griffen lässt es sich anpassen, in der Mitte verschieben; mit einem Seitenverhältnis bleibt es in Form."));
                panel = panel.child(ui.subheading("Seitenverhältnis")).child(ratios);
                panel = panel.child(div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.hint(match ops.crop {
                    Some(r) => format!("Ausschnitt: {} × {} px.", ((f64::from(sondra_media::image_ops::rotated_size(w, h, ops.rotate).0) * r.width).round()) as u32, ((f64::from(sondra_media::image_ops::rotated_size(w, h, ops.rotate).1) * r.height).round()) as u32),
                    None => "Das ganze Bild.".to_string(),
                })).child(ui.button("bild-ausschnitt-aufheben", "Ganzes Bild").small().disabled(ops.crop.is_none()).on_click(move |_, app| reset.update(app, |shell, cx| shell.images_patch(|s| {
                    s.ops.crop = None;
                    s.aspect = "free";
                }, cx)))));
            }
            Tool::Turn => {
                let (left, right) = (me.clone(), me.clone());
                let (hflip, vflip) = (me.clone(), me.clone());
                panel = panel
                    .child(div().flex().flex_wrap().gap(px(8.)).child(ui.button("links-drehen", "Nach links drehen").small().on_click(move |_, app| left.update(app, |shell, cx| shell.images_patch(|s| turn(s, 270), cx)))).child(ui.button("rechts-drehen", "Nach rechts drehen").small().on_click(move |_, app| right.update(app, |shell, cx| shell.images_patch(|s| turn(s, 90), cx)))))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .child(ui.chip("waagrecht", "Waagrecht spiegeln", ops.flip_h).on_click(move |_, app| hflip.update(app, |shell, cx| shell.images_patch(|s| flip(s, 'h'), cx))))
                            .child(ui.chip("senkrecht", "Senkrecht spiegeln", ops.flip_v).on_click(move |_, app| vflip.update(app, |shell, cx| shell.images_patch(|s| flip(s, 'v'), cx)))),
                    );
            }
            Tool::Size => {
                let presets = vec![(0.0, "Original".to_string()), (3840.0, "4K".into()), (1920.0, "1920".into()), (1280.0, "1280".into()), (800.0, "800".into()), (400.0, "400".into())];
                panel = panel.child(steps("Breite", "breite", presets, f64::from(ops.width), |o, v| o.width = v as u32));
                let mut note = format!("{ow} × {oh} px");
                if ow > sondra_media::image_ops::rotated_size(w, h, ops.rotate).0 {
                    note.push_str(" — grösser als die Quelle, das erfindet keine Details dazu.");
                }
                panel = panel.child(div().p(px(12.)).rounded(px(sondra_ui::radius::NAV)).bg(c.panel_soft).child(ui.value(note)));
            }
            Tool::Colour => {
                panel = panel
                    .child(steps("Helligkeit", "hell", percent(0.5, 1.5, 0.25), ops.brightness, |o, v| o.brightness = v))
                    .child(steps("Kontrast", "kontrast", percent(0.5, 1.5, 0.25), ops.contrast, |o, v| o.contrast = v))
                    .child(steps("Sättigung", "saettigung", percent(0.0, 2.0, 0.5), ops.saturation, |o, v| o.saturation = v));
            }
            Tool::Sharpen => {
                panel = panel
                    .child(steps("Schärfen", "schaerfen", vec![(0.0, "Aus".into()), (0.25, "25 %".into()), (0.5, "50 %".into()), (0.75, "75 %".into()), (1.0, "100 %".into())], ops.sharpen, |o, v| o.sharpen = v))
                    .child(steps("Weichzeichnen", "weich", vec![(0.0, "Aus".into()), (1.0, "1 px".into()), (2.0, "2 px".into()), (4.0, "4 px".into()), (8.0, "8 px".into())], ops.blur, |o, v| o.blur = v));
            }
            Tool::Save => {
                let mut formats = div().flex().flex_wrap().gap(px(6.));
                for (format, label, _, _, _) in Format::ALL {
                    let me = me.clone();
                    formats = formats.child(ui.chip(format!("format-{label}"), label, ops.format == format).accessible_name(format!("Format {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.images_patch(move |s| s.ops.format = format, cx))));
                }
                panel = panel.child(ui.subheading("Format")).child(formats).child(ui.hint(ops.format.hint()));
                if ops.format.lossy() {
                    panel = panel.child(steps("Qualität", "qualitaet", (3..=10).map(|n| (f64::from(n) / 10.0, format!("{} %", n * 10))).collect(), (ops.quality * 10.0).round() / 10.0, |o, v| o.quality = v));
                } else {
                    panel = panel.child(ui.prose("PNG ist verlustfrei — es gibt nichts einzustellen."));
                }
                panel = panel.child(ui.hint(if ops.format == Format::Jpeg { "JPEG kann keine Transparenz: durchsichtige Stellen werden weiss." } else { "Durchsichtige Stellen bleiben durchsichtig." }));
                let save = {
                    let me = me.clone();
                    ui.button("bild-speichern", if i.working { "Schreibt …" } else { "Datei speichern" }).primary().disabled(i.working).on_click(move |_, app| me.update(app, |shell, cx| shell.images_save(false, cx)))
                };
                panel = panel.child(div().flex().child(save));
            }
            Tool::Batch => {
                panel = panel.child(ui.prose("Grösse, Drehung, Farbe und Format gelten für alle Bilder, der Ausschnitt nur für das gewählte — er ist ein Rechteck auf einem bestimmten Bild."));
                let mut list = div().flex().flex_col().gap(px(4.));
                for (n, file) in i.files.iter().enumerate() {
                    let me = me.clone();
                    let label = file.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
                    list = list.child(ui.chip(format!("bild-{n}"), label.clone(), n == i.active).accessible_name(format!("Bild {label}")).on_click(move |_, app| me.update(app, |shell, cx| shell.images_pick(n, cx))));
                }
                let all = {
                    let me = me.clone();
                    ui.button("alle-verarbeiten", if i.working { "Läuft …".to_string() } else { format!("Alle {} verarbeiten", i.files.len()) }).primary().disabled(i.working).on_click(move |_, app| me.update(app, |shell, cx| shell.images_save(true, cx)))
                };
                panel = panel.child(list).child(div().flex().child(all));
            }
        }
        let mut reset = div().flex();
        {
            let me = me.clone();
            let untouched = *ops == ImageOps { format: ops.format, quality: ops.quality, ..ImageOps::default() };
            reset = reset.child(ui.button("alles-zuruecksetzen", "Alles zurücksetzen").small().disabled(untouched).on_click(move |_, app| me.update(app, |shell, cx| shell.images_patch(|s| {
                s.ops = ImageOps { format: s.ops.format, quality: s.ops.quality, ..ImageOps::default() };
                s.aspect = "free";
            }, cx))));
        }

        // What was written.
        let mut done = div().flex().flex_col().gap(px(8.));
        for made in &i.made {
            let folder = made.path.parent().map(PathBuf::from);
            let me = me.clone();
            let name = made.path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            done = done.child(
                div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.value(name.clone())).child(ui.hint(format!("{} × {} px · {}", made.width, made.height, sondra_merk::format::format_bytes(made.bytes as f64, 1)))).children(self.drive_button(&ui, format!("drive-{}", made.path.display()), &made.path, &name, cx)).child(
                    ui.button(format!("zeigen-{}", made.path.display()), "Im Ordner zeigen").small().accessible_name(format!("{name} im Ordner zeigen")).on_click(move |_, app| {
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
        let controls = div().flex().flex_col().gap(px(16.)).child(rail).child(panel).child(reset).child(done);
        page.child(caption).child(ui.stage_body(stage, controls)).into_any_element()
    }
}

/// Turns the picture a quarter clockwise (90) or counter-clockwise (270); the crop turns with it.
fn turn(s: &mut ImagesState, by: u16) {
    s.ops.rotate = (s.ops.rotate + by) % 360;
    if let Some(r) = s.ops.crop {
        s.ops.crop = Some(rotate_rect(r, by));
    }
}

fn flip(s: &mut ImagesState, axis: char) {
    if axis == 'h' {
        s.ops.flip_h = !s.ops.flip_h;
    } else {
        s.ops.flip_v = !s.ops.flip_v;
    }
    if let Some(r) = s.ops.crop {
        s.ops.crop = Some(mirror_rect(r, axis));
    }
}

