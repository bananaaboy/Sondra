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
    pub(crate) fn session_header_button(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let n = self.session.files.len();
        if n == 0 {
            return None;
        }
        let me = cx.entity();
        let open = self.session.open;
        Some(
            ui.button("sitzung", format!("Dateien ({n})"))
                .small()
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
                .child(div().flex().flex_col().gap(px(4.)).child(ui.value(name.clone())).child(tools))
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
                        .child(ui.button(format!("sitzung-weg-{n}"), "Entfernen").small().ghost().accessible_name(format!("{name} aus der Sitzung nehmen")).on_click(move |_, app| away.update(app, |shell, cx| {
                            shell.session.remove(n);
                            cx.notify();
                        }))),
                );
            list = list.child(row);
        }
        let (keep, clear) = (me.clone(), me.clone());
        let keeping = self.session.keep;
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
            .child(ui.button("sitzung-leeren", "Alle entfernen").small().ghost().on_click(move |_, app| clear.update(app, |shell, cx| {
                shell.session.clear();
                cx.notify();
            })))
            .child(ui.hint(if keeping { "Beim nächsten Start wird die Liste angeboten, nie von selbst geladen. Die Dateien bleiben, wo sie sind." } else { "Die Dateien bleiben, wo sie sind; nichts wird kopiert." }));
        Some(div().flex().flex_col().gap(px(8.)).child(ui.subheading("Dateien der Sitzung")).child(list).child(foot).into_any_element())
    }
}
