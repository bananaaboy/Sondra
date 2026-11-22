//! The window „Google Drive“ (the website's `GoogleDrive.tsx`), behind the Drive button once signed in: how Sondra's
//! folder in Drive is ordered (`Projekte`, `Dateien/Ton·Video·Bilder·Andere`, `Heruntergeladen`, `Merkliste`), the
//! queue of what goes there — one after another, each with its state —, „Dateien der Sitzung nach Art hochladen“ and
//! „Projekt in Drive speichern“ (a project of the same name is replaced as a new version). The one sentence that this
//! leaves the device stands on `panel_cool`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_drive::write::Mode;
use sondra_ui::Ui;

use crate::drive_hub::{save, says, Line, Saved};
use crate::shell::Shell;

impl Shell {
    /// Sends files into Drive one after another (each into the folder of its kind); the queue shows each.
    pub fn drive_upload_all(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        let saves = self.drive_saves.clone();
        let paths: Vec<PathBuf> = paths.into_iter().filter(|p| !matches!(saves.get(p), Some(Line::Busy(_)))).collect();
        if paths.is_empty() {
            return;
        }
        for p in &paths {
            saves.set(p, Line::Busy(None));
        }
        cx.notify();
        let work = saves.clone();
        Self::in_background(
            cx,
            move || {
                let cancel = AtomicBool::new(false);
                for path in &paths {
                    let shown = path.clone();
                    let line = match save(&drive, path, &cancel, |sent, total| work.set(&shown, Line::Busy((total > 0).then_some(sent as f32 / total as f32)))) {
                        Ok(Saved::Done) => Line::Done,
                        Ok(Saved::Already) => Line::Already,
                        Err(why) => Line::Failed(why),
                    };
                    work.set(path, line);
                }
            },
            |_, _, cx| cx.notify(),
        );
    }

    /// „Projekt in Drive speichern“: the session as a `.sondra` file in `Sondra/Projekte`, over one of that name.
    pub fn drive_save_project(&mut self, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        if self.session.files.is_empty() {
            return;
        }
        let files = self.session.files.clone();
        let panel = self.panel().meta().id;
        let tool_states = self.session.tool_states.clone();
        let base = files[0].file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Sondra-Projekt".into());
        let shown = std::env::temp_dir().join("sondra-projekt").join(format!("{}.sondra", crate::drive_hub::safe_name(&base)));
        let saves = self.drive_saves.clone();
        saves.set(&shown, Line::Busy(None));
        cx.notify();
        let (work, target) = (saves.clone(), shown.clone());
        Self::in_background(
            cx,
            move || -> Result<(), String> {
                std::fs::create_dir_all(shown.parent().unwrap_or(std::path::Path::new("."))).map_err(|e| e.to_string())?;
                let date = crate::zip_ui::file_date(&files[0]);
                sondra_media::project::write_with(&shown, &files, panel, date, tool_states.as_ref())?;
                let client = drive.client();
                let folder = client.ensure_path(&["Sondra", "Projekte"]).map_err(|e| says(&e))?;
                let name = shown.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let cancel = AtomicBool::new(false);
                client.put_file(&folder, &name, &shown, "application/zip", &BTreeMap::new(), Mode::Replace, &cancel, |sent, total| work.set(&shown, Line::Busy((total > 0).then_some(sent as f32 / total as f32)))).map_err(|e| says(&e))?;
                Ok(())
            },
            move |_, result, cx| {
                saves.set(&target, match result {
                    Ok(()) => Line::Done,
                    Err(why) => Line::Failed(why),
                });
                cx.notify();
            },
        );
    }

    /// For tests: the queue, by name, in words.
    pub fn drive_queue_now(&self) -> Vec<(String, String)> {
        self.drive_saves.0.lock().expect("lock").iter().map(|(p, l)| (p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), line_words(l))).collect()
    }

    pub(crate) fn drive_window_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.drive_open {
            return None;
        }
        let c = ui.c;
        let me = cx.entity();
        let folders = [("Projekte", "Projekte der Sitzung (.sondra)"), ("Dateien / Ton · Video · Bilder · Andere", "was Sie mit „In Drive“ speichern, nach Art"), ("Heruntergeladen", "was „Herunterladen“ direkt in Drive legt"), ("Merkliste", "die Liste, wenn sie über Drive abgeglichen wird"), ("Serien", "eingeordnete Folgen, je Serie und Staffel")];
        let mut tree = div().flex().flex_col().gap(px(6.)).child(ui.subheading("Im Ordner „Sondra“"));
        for (name, what) in folders {
            tree = tree.child(div().flex().flex_wrap().items_baseline().gap(px(10.)).child(div().w(px(300.)).child(ui.value(name.to_string()))).child(ui.hint(what.to_string())));
        }
        let cool = div().p(px(12.)).rounded(px(sondra_ui::radius::CARD)).bg(c.panel_cool).child(ui.prose("Was Sie in Drive speichern, verlässt dieses Gerät und liegt bei Google. Sondra sieht dort nur, was es selbst ablegte."));

        let mut queue = div().flex().flex_col().gap(px(6.)).child(ui.subheading("Warteschlange"));
        let lines: Vec<(String, Line)> = self.drive_saves.0.lock().expect("lock").iter().map(|(p, l)| (p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), l.clone())).collect();
        if lines.is_empty() {
            queue = queue.child(ui.hint("Noch nichts gesendet."));
        }
        for (name, line) in lines {
            queue = queue.child(div().flex().flex_wrap().items_baseline().gap(px(10.)).child(div().w(px(300.)).child(ui.value(name))).child(ui.hint(line_words(&line))));
        }

        let session = self.session.files.clone();
        let mut actions = div().flex().flex_wrap().gap(px(8.));
        if !session.is_empty() {
            let (all, project) = (me.clone(), me.clone());
            let n = session.len();
            actions = actions
                .child(ui.button("drive-sitzung", format!("Dateien der Sitzung nach Art hochladen ({n})")).on_click(move |_, app| {
                    let files = session.clone();
                    all.update(app, |shell, cx| shell.drive_upload_all(files, cx))
                }))
                .child(ui.button("drive-projekt", "Projekt in Drive speichern").on_click(move |_, app| project.update(app, |shell, cx| shell.drive_save_project(cx))));
        } else {
            actions = actions.child(ui.hint("Mit Dateien in der Sitzung lassen sie sich hier nach Art hochladen oder als Projekt speichern."));
        }
        let (close, away) = (me.clone(), me.clone());
        Some(
            ui.dialog("google-drive", "Google Drive")
                .width(680.)
                .child(div().flex().flex_col().gap(px(16.)).child(tree).child(cool).child(actions).child(queue))
                .action(ui.button("drive-schliessen", "Schliessen").ghost().on_click(move |_, app| close.update(app, |shell, cx| {
                    shell.drive_open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |shell, cx| {
                    shell.drive_open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

/// A line of the queue in words.
pub fn line_words(line: &Line) -> String {
    match line {
        Line::Busy(None) => "wartet …".into(),
        Line::Busy(Some(f)) => format!("{} %", (f * 100.0).round()),
        Line::Done => "in Drive gespeichert".into(),
        Line::Already => "schon in Drive".into(),
        Line::Failed(why) => format!("nicht gespeichert: {why}"),
    }
}
