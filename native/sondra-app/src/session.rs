//! The session: the files the person has chosen or dropped, in an order, ready to be handed to a tool. The files
//! stay where they are on the disk — nothing is copied into the program, so nothing is renamed or changed here
//! either (renaming is the Ordner page's and the system's work). Kept on this device only when the person says so,
//! and then only offered at the next start, never loaded by itself.

use std::path::{Path, PathBuf};

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_merk::folder::{kind_from_mime, AssetKind};
use sondra_merk::folder_memory::Store;
use sondra_ui::{NoticeKind, Ui};

use crate::nav::Panel;
use crate::shell::Shell;
use crate::store::FileStore;

const KEEP: &str = "behalten";
const FILES: &str = "dateien";

#[derive(Default)]
pub struct Session {
    pub files: Vec<PathBuf>,
    /// „Sitzung auf diesem Gerät behalten“.
    pub keep: bool,
    /// The list of files is unfolded under the header.
    pub open: bool,
    /// What the last session held, offered at the start.
    pub offer: Option<Vec<PathBuf>>,
    /// What the last save or open of a project said.
    pub said: Option<Result<String, String>>,
    /// „Alle als ZIP speichern“ is being written.
    pub zipping: bool,
    /// The file whose name is being changed (its place in the list), and what was wrong with the last name typed.
    pub renaming: Option<usize>,
    pub rename_problem: Option<String>,
    /// The tool states of the website project that was opened last, carried into the next project written.
    tool_states: Option<serde_json::Value>,
    store: Option<FileStore>,
}

pub fn kind_of(path: &Path) -> AssetKind {
    kind_from_mime("", &path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// Which kinds of file a tool takes from the session; empty for a tool that takes none.
pub fn accepts(panel: Panel) -> &'static [AssetKind] {
    use AssetKind::{Audio, Image, Video};
    match panel {
        Panel::Converter => &[Video, Audio, Image],
        Panel::Images => &[Image],
        Panel::Video => &[Video],
        Panel::Subtitles => &[Video, Audio],
        Panel::Audio | Panel::Normalize => &[Audio, Video],
        Panel::Mix | Panel::Stems | Panel::Sampler | Panel::Harmony => &[Audio],
        Panel::Player => &[Video, Audio],
        _ => &[],
    }
}

/// A new name for a file: the stem as typed, the ending kept (`renamedFile` in `src/lib/format.ts`). Refused, not quietly
/// changed, when Windows would refuse it — the person sees why and what to type instead.
pub fn renamed_file(stem: &str, previous: &str) -> Result<String, String> {
    let collapsed = stem.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = collapsed.trim().trim_end_matches(['.', ' ']).to_string();
    if clean.is_empty() {
        return Err("Der Name darf nicht leer sein.".into());
    }
    if let Some(bad) = clean.chars().find(|c| "\\/:*?\"<>|".contains(*c) || (*c as u32) < 0x20) {
        return Err(if (bad as u32) < 0x20 { "Steuerzeichen gehen nicht in einem Dateinamen.".into() } else { format!("„{bad}“ geht nicht — Windows erlaubt \\ / : * ? \" < > | nicht in Dateinamen.") });
    }
    let lower = clean.to_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") || ((lower.starts_with("com") || lower.starts_with("lpt")) && lower.len() == 4 && lower.ends_with(|c: char| ('1'..='9').contains(&c)));
    if reserved {
        return Err(format!("„{clean}“ ist unter Windows ein reservierter Name."));
    }
    // The ending of the old name: a dot and up to eight characters without spaces or dots, after at least one.
    let extension = previous.rfind('.').filter(|i| *i > 0).map(|i| &previous[i..]).filter(|e| (2..=9).contains(&e.chars().count()) && !e[1..].contains(['.', '/', '\\']) && !e.contains(char::is_whitespace)).unwrap_or("");
    let name = format!("{clean}{extension}");
    if name.chars().count() > 200 {
        return Err("Höchstens 200 Zeichen.".into());
    }
    Ok(name)
}

impl Session {
    fn save(&mut self) {
        let Some(store) = self.store.as_mut() else { return };
        store.set_item(KEEP, if self.keep { "an" } else { "aus" }.to_string());
        let list: Vec<String> = if self.keep { self.files.iter().map(|p| p.to_string_lossy().into_owned()).collect() } else { vec![] };
        store.set_item(FILES, serde_json::to_string(&list).unwrap_or_default());
    }

    pub fn add(&mut self, paths: Vec<PathBuf>) {
        for path in paths {
            if path.is_file() && !self.files.contains(&path) {
                self.files.push(path);
            }
        }
        self.save();
    }

    fn remove(&mut self, index: usize) {
        if index < self.files.len() {
            self.files.remove(index);
        }
        if self.files.is_empty() {
            self.open = false;
        }
        self.save();
    }

    fn shift(&mut self, index: usize, up: bool) {
        let other = if up { index.checked_sub(1) } else { Some(index + 1) };
        if let Some(other) = other.filter(|o| *o < self.files.len() && index < self.files.len()) {
            self.files.swap(index, other);
            self.save();
        }
    }

    fn clear(&mut self) {
        self.files.clear();
        self.open = false;
        self.save();
    }
}

impl Shell {
    /// Reads what an earlier start kept: if the person asked for it, the last session is offered, not loaded.
    pub fn open_session_memory(&mut self, store: FileStore, cx: &mut Context<Self>) {
        let keep = store.get_item(KEEP).as_deref() == Some("an");
        self.session.keep = keep;
        if keep {
            let list: Vec<String> = store.get_item(FILES).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let there: Vec<PathBuf> = list.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
            if !there.is_empty() {
                self.session.offer = Some(there);
            }
        }
        self.session.store = Some(store);
        cx.notify();
    }

    pub fn session_files(&self) -> Vec<PathBuf> {
        self.session.files.clone()
    }

    pub fn session_offer(&self) -> Option<Vec<PathBuf>> {
        self.session.offer.clone()
    }

    pub fn session_add(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if !paths.is_empty() {
            crate::protocol::note("sitzung", format!("{} in die Sitzung übernommen", paths.iter().map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect::<Vec<_>>().join(", ")));
            self.session.add(paths);
            cx.notify();
        }
    }

    /// Hands files of the session to a tool and goes there: all that suit it for a tool that takes a list, the first
    /// that suits for one that takes a file. `only` limits it to one file of the list.
    pub fn session_hand_over(&mut self, panel: Panel, only: Option<usize>, cx: &mut Context<Self>) {
        let fits: Vec<PathBuf> = self
            .session
            .files
            .iter()
            .enumerate()
            .filter(|(n, p)| only.is_none_or(|o| o == *n) && accepts(panel).contains(&kind_of(p)))
            .map(|(_, p)| p.clone())
            .collect();
        let Some(first) = fits.first().cloned() else {
            self.go(panel, cx);
            return;
        };
        self.go(panel, cx);
        match panel {
            Panel::Converter => self.convert_take(fits, cx),
            Panel::Images => self.images_take(fits, cx),
            Panel::Player => self.play_files(fits, cx),
            Panel::Video => self.video_take(first, cx),
            Panel::Subtitles => self.subtitles_take(first, cx),
            Panel::Audio => self.audio_open(first, cx),
            Panel::Normalize => self.normalize_take(first, cx),
            Panel::Mix => self.mix_take(true, first, cx),
            Panel::Stems => self.stems_open(first, cx),
            Panel::Sampler => self.sampler_open(first, cx),
            Panel::Harmony => self.harmony_take(first, cx),
            _ => {}
        }
    }

    /// The line at the top: the last session is there again, if the person wants it.
    pub(crate) fn session_offer_line(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let files = self.session.offer.as_ref()?;
        let (yes, no) = (cx.entity(), cx.entity());
        let said = if files.len() == 1 { "Letzte Sitzung: 1 Datei".to_string() } else { format!("Letzte Sitzung: {} Dateien", files.len()) };
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .child(ui.notice(NoticeKind::Info, said))
                .child(ui.button("sitzung-zurueck", "Wiederherstellen").small().on_click(move |_, app| {
                    yes.update(app, |shell, cx| {
                        if let Some(files) = shell.session.offer.take() {
                            shell.session.add(files);
                            shell.session.open = true;
                        }
                        cx.notify();
                    })
                }))
                .child(ui.button("sitzung-verwerfen", "Verwerfen").small().ghost().on_click(move |_, app| {
                    no.update(app, |shell, cx| {
                        shell.session.offer = None;
                        shell.session.save();
                        cx.notify();
                    })
                }))
                .into_any_element(),
        )
    }

    /// „Dateien (3)“ in the header, when there are files: it opens the list below.
    pub(crate) fn session_header_button(&self, ui: &Ui, compact: bool, cx: &mut Context<Self>) -> Option<AnyElement> {
        let n = self.session.files.len();
        if n == 0 {
            return None;
        }
        let me = cx.entity();
        let open = self.session.open;
        Some(
            ui.rack_item("sitzung", format!("Dateien ({n})"), open)
                .icon(Some(sondra_ui::ui_icon("dateien")))
                .compact(compact)
                .accessible_name(if open { format!("Dateien der Sitzung, {n}, schließen") } else { format!("Dateien der Sitzung, {n}") })
                .on_click(move |_, app| {
                    me.update(app, |shell, cx| {
                        shell.session.open = !shell.session.open;
                        cx.notify();
                    })
                })
                .into_any_element(),
        )
    }

    /// The field for a new name, with its buttons and what was wrong with the last name typed.
    fn session_rename_editor(&self, ui: &Ui, cx: &mut Context<Self>) -> AnyElement {
        let (save, cancel) = (cx.entity(), cx.entity());
        let mut editor = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .child(div().w(px(280.)).child(self.session_rename.clone()))
                    .child(ui.button("sitzung-name-speichern", "Speichern").small().primary().on_click(move |_, app| save.update(app, |shell, cx| shell.session_commit_rename(cx))))
                    .child(ui.button("sitzung-name-lassen", "Abbrechen").small().on_click(move |_, app| cancel.update(app, |shell, cx| shell.session_cancel_rename(cx)))),
            );
        if let Some(problem) = &self.session.rename_problem {
            editor = editor.child(ui.notice(NoticeKind::Warning, problem.clone()));
        }
        editor.into_any_element()
    }

    /// What the last save or open of a project said, as a line.
    pub(crate) fn session_said_line(&self, ui: &Ui) -> Option<AnyElement> {
        match self.session.said.as_ref()? {
            Ok(text) => Some(ui.prose(text.clone()).into_any_element()),
            Err(text) => Some(ui.notice(NoticeKind::Warning, text.clone()).into_any_element()),
        }
    }

    /// The files of the session, one line each: the order, the way out, and the tools that take it.
    pub(crate) fn session_panel(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.session.open || self.session.files.is_empty() {
            return None;
        }
        let c = ui.c;
        let me = cx.entity();
        let mut list = div().flex().flex_col();
        for (n, path) in self.session.files.iter().enumerate() {
            let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let kind = kind_of(path);
            let mut tools = div().flex().flex_wrap().gap(px(6.));
            for meta in crate::nav::PANELS.iter().filter(|m| accepts(m.panel).contains(&kind) && m.panel != Panel::Player) {
                let (me, panel) = (me.clone(), meta.panel);
                tools = tools.child(ui.chip(format!("sitzung-{n}-{}", meta.id), meta.label, false).accessible_name(format!("{name} in {} öffnen", meta.label)).on_click(move |_, app| me.update(app, |shell, cx| shell.session_hand_over(panel, Some(n), cx))));
            }
            if accepts(Panel::Player).contains(&kind) {
                let me = me.clone();
                tools = tools.child(ui.chip(format!("sitzung-{n}-abspielen"), "Abspielen", false).accessible_name(format!("{name} abspielen")).on_click(move |_, app| me.update(app, |shell, cx| shell.session_hand_over(Panel::Player, Some(n), cx))));
            }
            let (up, down, away) = (me.clone(), me.clone(), me.clone());
            let row = div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(10.))
                .py(px(8.))
                .border_t_1()
                .border_color(c.line)
                .child(div().flex().flex_col().gap(px(4.)).child(if self.session.renaming == Some(n) { self.session_rename_editor(&ui, cx) } else { ui.value(name.clone()).into_any_element() }).child(tools))
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .child(ui.button(format!("sitzung-hoch-{n}"), "Hoch").small().ghost().disabled(n == 0).accessible_name(format!("{name} nach oben")).on_click(move |_, app| up.update(app, |shell, cx| {
                            shell.session.shift(n, true);
                            cx.notify();
                        })))
                        .child(ui.button(format!("sitzung-runter-{n}"), "Runter").small().ghost().disabled(n + 1 == self.session.files.len()).accessible_name(format!("{name} nach unten")).on_click(move |_, app| down.update(app, |shell, cx| {
                            shell.session.shift(n, false);
                            cx.notify();
                        })))
                        .child(ui.button(format!("sitzung-umbenennen-{n}"), "Umbenennen").small().ghost().accessible_name(format!("{name} umbenennen")).on_click({
                            let me = me.clone();
                            move |_, app| me.update(app, |shell, cx| shell.session_start_rename(n, cx))
                        }))
                        .child(ui.button(format!("sitzung-weg-{n}"), "Entfernen").small().ghost().accessible_name(format!("{name} aus der Sitzung nehmen")).on_click(move |_, app| away.update(app, |shell, cx| {
                            shell.session.remove(n);
                            cx.notify();
                        }))),
                );
            list = list.child(row);
        }
        let (keep, clear) = (me.clone(), me.clone());
        let keeping = self.session.keep;
        let total: u64 = self.session.files.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
        let n = self.session.files.len();
        let more = {
            let (add, zip) = (me.clone(), me.clone());
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .child(ui.button("sitzung-weitere", "Weitere Datei öffnen").small().on_click(move |_, app| add.update(app, |shell, cx| shell.session_choose_more(cx))))
                .child(div().w(px(220.)).child(self.session_zip.clone()))
                .child(ui.button("sitzung-zip", format!("Alle {n} als ZIP speichern")).small().disabled(self.session.zipping).on_click(move |_, app| zip.update(app, |shell, cx| shell.session_zip(cx))))
                .child(ui.hint(format!("{} {} · {} auf diesem Gerät, nichts davon gesendet", n, if n == 1 { "Datei" } else { "Dateien" }, sondra_merk::format::format_bytes(total as f64, 1))))
        };
        let foot = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(10.))
            .child(ui.chip("sitzung-behalten", "Sitzung auf diesem Gerät behalten", keeping).on_click(move |_, app| keep.update(app, |shell, cx| {
                shell.session.keep = !shell.session.keep;
                shell.session.save();
                cx.notify();
            })))
            .child(ui.button("sitzung-projekt", "Als Projekt speichern").small().accessible_name("Die Sitzung als Projektdatei speichern").on_click({
                let me = me.clone();
                move |_, app| me.update(app, |shell, cx| shell.session_save_project(cx))
            }))
            .child(ui.button("sitzung-leeren", "Alles verwerfen").small().ghost().accessible_name("Alles verwerfen: die Sitzung leeren").on_click(move |_, app| clear.update(app, |shell, cx| {
                shell.session.clear();
                shell.session.said = None;
                cx.notify();
            })))
            .child(ui.hint(if keeping { "Beim nächsten Start wird die Liste angeboten, nie von selbst geladen. Die Dateien bleiben, wo sie sind." } else { "Die Dateien bleiben, wo sie sind; nichts wird kopiert." }));
        let mut panel = div().flex().flex_col().gap(px(8.)).child(ui.subheading("Dateien der Sitzung")).child(list).child(more).child(foot);
        panel = panel.children(self.session_said_line(&ui));
        Some(panel.into_any_element())
    }
}

impl Shell {
    /// The name of file `index` goes into the field, ready to be changed.
    pub fn session_start_rename(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(path) = self.session.files.get(index) else { return };
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let stem = match name.rfind('.') {
            Some(i) if i > 0 && name.len() - i <= 9 => name[..i].to_string(),
            _ => name,
        };
        self.session_rename.update(cx, |field, cx| field.set_text(stem, cx));
        self.session.renaming = Some(index);
        self.session.rename_problem = None;
        cx.notify();
    }

    pub fn session_cancel_rename(&mut self, cx: &mut Context<Self>) {
        self.session.renaming = None;
        self.session.rename_problem = None;
        cx.notify();
    }

    /// Renames the file on the disk where it lies (the ending stays), if Windows would take the name and no other
    /// file has it. The list follows; nothing else of the session changes.
    pub fn session_commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(index) = self.session.renaming else { return };
        let Some(path) = self.session.files.get(index).cloned() else { return };
        let typed = self.session_rename.read(cx).text().to_string();
        let previous = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let outcome = renamed_file(&typed, &previous).and_then(|name| {
            if name == previous {
                return Ok(None);
            }
            let target = path.with_file_name(&name);
            // Another file with that name — but the same file under another spelling of the same letters is fine.
            if target.exists() && !previous.eq_ignore_ascii_case(&name) {
                return Err(format!("Es gibt schon eine Datei „{name}“ in diesem Ordner."));
            }
            std::fs::rename(&path, &target).map_err(|e| format!("Das Umbenennen ging nicht: {e}"))?;
            Ok(Some(target))
        });
        match outcome {
            Ok(target) => {
                if let Some(target) = target {
                    self.session.files[index] = target;
                    self.session.save();
                }
                self.session.renaming = None;
                self.session.rename_problem = None;
            }
            Err(problem) => self.session.rename_problem = Some(problem),
        }
        cx.notify();
    }
}

/* Projects: the session as a `.sondra` file the website opens, and the website's projects opened here ------------- */

impl Shell {
    /// Writes the files of the session as a project in the folder for what Sondra makes, never over one that is there.
    pub fn session_save_project(&mut self, cx: &mut Context<Self>) {
        if self.session.files.is_empty() {
            return;
        }
        let files = self.session.files.clone();
        let panel = self.panel().meta().id;
        let tool_states = self.session.tool_states.clone();
        let dir = crate::store::downloads_dir();
        let base = files[0].file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Sondra-Projekt".into());
        self.session.said = None;
        Self::in_background(
            cx,
            move || -> Result<(PathBuf, usize), String> {
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let out = sondra_media::run::unique_path(&dir, &base, "sondra");
                let date = crate::zip_ui::file_date(&files[0]);
                let n = sondra_media::project::write_with(&out, &files, panel, date, tool_states.as_ref())?;
                Ok((out, n))
            },
            |shell, result, cx| {
                shell.session.said = Some(result.map(|(path, n)| format!("Projekt gespeichert: {} ({n} {})", path.display(), if n == 1 { "Datei" } else { "Dateien" })));
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Opens a `.sondra` project of the website (or of this program): its files are put in a folder of their own
    /// beside Sondra's data, the session holds them, and the tool that was open is opened.
    pub fn session_open_project(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let target = crate::store::data_dir().unwrap_or_else(std::env::temp_dir).join("Projekte");
        self.session.said = None;
        Self::in_background(
            cx,
            move || -> Result<(Vec<PathBuf>, Option<String>, Option<serde_json::Value>), String> {
                let bytes = std::fs::read(&path).map_err(|e| format!("{name}: {e}"))?;
                let project = sondra_media::project::read(&bytes, &name)?;
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Projekt".into());
                let folder = unique_dir(&target, &sondra_media::project::entry_safe(&stem));
                std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                let mut files = Vec::new();
                for (n, asset) in project.assets.iter().enumerate() {
                    let file = folder.join(format!("{}", sondra_media::project::entry_safe(&asset.name)));
                    let file = if file.exists() { folder.join(format!("{n}_{}", sondra_media::project::entry_safe(&asset.name))) } else { file };
                    std::fs::write(&file, &asset.bytes).map_err(|e| e.to_string())?;
                    files.push(file);
                }
                Ok((files, project.panel, project.tool_states))
            },
            |shell, result, cx| {
                match result {
                    Ok((files, panel, tool_states)) => {
                        let n = files.len();
                        shell.session.tool_states = tool_states;
                        shell.session.add(files);
                        shell.session.open = n > 0;
                        shell.session.said = Some(Ok(format!("Projekt geöffnet: {n} {}", if n == 1 { "Datei" } else { "Dateien" })));
                        if let Some(panel) = panel.as_deref().and_then(Panel::from_id).filter(|p| *p != Panel::Start) {
                            shell.go(panel, cx);
                        }
                    }
                    Err(e) => shell.session.said = Some(Err(e)),
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    /// The file dialog for „Projekt öffnen“.
    pub fn session_choose_project(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = answer.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |shell, cx| shell.session_open_project(path, cx)).ok();
                }
            }
        })
        .detach();
    }

    /// For tests: what the last save or open said.
    pub fn session_said(&self) -> Option<Result<String, String>> {
        self.session.said.clone()
    }
}

fn unique_dir(parent: &Path, stem: &str) -> PathBuf {
    let first = parent.join(stem);
    if !first.exists() {
        return first;
    }
    (2..).map(|n| parent.join(format!("{stem} ({n})"))).find(|p| !p.exists()).expect("a free name")
}

impl Shell {
    /// For tests: the field with the ZIP's name.
    pub fn session_zip_field(&self) -> gpui::Entity<sondra_ui::TextField> {
        self.session_zip.clone()
    }

    /// „Weitere Datei öffnen“: more files into the session, chosen in the system's dialog.
    pub(crate) fn session_choose_more(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(gpui::PathPromptOptions { files: true, directories: false, multiple: true, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                this.update(cx, |shell, cx| shell.session_add(paths, cx)).ok();
            }
        })
        .detach();
    }

    /// „Alle n als ZIP speichern“: the files of the session in one ZIP where downloads go, under the name typed (else
    /// „Sondra-Sitzung“); two files of the same name both go in.
    pub fn session_zip(&mut self, cx: &mut Context<Self>) {
        if self.session.files.is_empty() || self.session.zipping {
            return;
        }
        let typed = self.session_zip.read(cx).text().trim().to_string();
        let suggestion = if typed.is_empty() { "Sondra-Sitzung".to_string() } else { crate::drive_hub::safe_name(&typed) };
        let mut used: std::collections::BTreeSet<String> = Default::default();
        let files: Vec<(String, PathBuf)> = self
            .session
            .files
            .iter()
            .map(|path| {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Datei".into());
                let inside = sondra_devices::transfer::free_name(&name, &|candidate| used.contains(candidate));
                used.insert(inside.clone());
                (inside, path.clone())
            })
            .collect();
        self.session.zipping = true;
        cx.notify();
        let dir = crate::store::downloads_dir();
        let _ = std::fs::create_dir_all(&dir);
        Self::pack_in_background(cx, files, dir, suggestion, |shell, result, cx| {
            shell.session.zipping = false;
            match &result {
                Ok((path, _)) => crate::protocol::note("sitzung", format!("Als ZIP gespeichert: {}", path.display())),
                Err(e) => crate::protocol::warn("sitzung", e.clone()),
            }
            shell.session.said = Some(result.map(|(path, bytes)| format!("ZIP gespeichert: {} · {}", path.display(), sondra_merk::format::format_bytes(bytes as f64, 1))));
            cx.notify();
        });
    }
}
