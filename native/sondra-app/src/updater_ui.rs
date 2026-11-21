//! The update in the window: the rounds (twenty seconds after the start, then every six hours), the card that says a
//! newer version is ready, and the line in „Was ist neu“ with „Nach Updates suchen“. The work itself is `updater`.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_ui::Ui;

use crate::shell::Shell;
use crate::updater::{self, Status};

/// What the shell keeps of the update.
pub struct Updates {
    pub status: Status,
    /// Where to look; `None` when this is not the installed program.
    pub feed: Option<String>,
    /// The version to compare with.
    pub current: String,
    /// The person said „Später“ to the card of this version.
    pub dismissed: bool,
    /// Runs the setup (a test replaces it).
    pub run: fn(&Path) -> Result<(), String>,
    /// Ends Sondra after the setup started (a test does not want that).
    pub quit_after: bool,
    pub folder: PathBuf,
    pub cancel: Arc<AtomicBool>,
}

impl Default for Updates {
    fn default() -> Self {
        let feed = updater::feed();
        Updates {
            status: if feed.is_some() { Status::Idle } else { Status::Off },
            feed,
            current: crate::whats_new::app_version(),
            dismissed: false,
            run: updater::start_setup,
            quit_after: true,
            folder: updater::folder(),
            cancel: Arc::default(),
        }
    }
}

impl Shell {
    /// Starts the rounds, when this is the program that updates itself.
    pub(crate) fn start_update_rounds(window: &mut gpui::Window, cx: &mut Context<Self>) {
        if updater::feed().is_none() {
            return;
        }
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(updater::FIRST).await;
            loop {
                if this.update(cx, |shell, cx| shell.update_check(false, cx)).is_err() {
                    break;
                }
                cx.background_executor().timer(updater::EVERY).await;
            }
        })
        .detach();
    }

    /// Looks for a newer version; when there is one it is loaded in the background and checked. `asked` is true when a
    /// person pressed „Nach Updates suchen“ — then a look with nothing found says so, and a failure is shown.
    pub fn update_check(&mut self, asked: bool, cx: &mut Context<Self>) {
        let Some(feed) = self.update.feed.clone() else { return };
        if matches!(self.update.status, Status::Checking | Status::Downloading { .. } | Status::Ready { .. }) {
            return;
        }
        self.update.status = Status::Checking;
        self.update.dismissed = false;
        cx.notify();
        let (current, folder, cancel) = (self.update.current.clone(), self.update.folder.clone(), self.update.cancel.clone());
        cancel.store(false, std::sync::atomic::Ordering::Relaxed);
        Self::in_background(
            cx,
            move || match updater::check(&feed, &current)? {
                None => Ok::<_, String>(None),
                Some(latest) => {
                    let file = updater::pick(&latest.files, cfg!(target_arch = "aarch64")).cloned().ok_or("Keine Datei für diesen Prozessor.")?;
                    let path = updater::download(&feed, &file, &folder, &cancel, |_, _| {})?;
                    Ok(Some((latest.version, path)))
                }
            },
            move |shell, result, cx| {
                if let Ok(Some((version, _))) = &result {
                    shell.note(format!("Sondra {version} ist bereit"), "Die neue Fassung ist geladen und geprüft.", None);
                }
                shell.update.status = match result {
                    Ok(None) => Status::Current,
                    Ok(Some((version, file))) => Status::Ready { version, file },
                    // A look nobody asked for that fails stays quiet; the next round tries again.
                    Err(_) if !asked => Status::Idle,
                    Err(message) => Status::Failed(message),
                };
                cx.notify();
            },
        );
    }

    /// Installs the version that is ready: the setup runs silently, and Sondra ends so it can replace it.
    pub fn update_install(&mut self, cx: &mut Context<Self>) {
        let Status::Ready { file, .. } = self.update.status.clone() else { return };
        match (self.update.run)(&file) {
            Ok(()) => {
                if self.update.quit_after {
                    cx.quit();
                }
            }
            Err(message) => {
                self.update.status = Status::Failed(message);
                cx.notify();
            }
        }
    }

    /// The card that says a newer version is ready.
    pub(crate) fn update_card(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let Status::Ready { version, .. } = &self.update.status else { return None };
        if self.update.dismissed {
            return None;
        }
        let (now, later) = (cx.entity(), cx.entity());
        let c = ui.c;
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .max_w(px(420.))
                .rounded(px(sondra_ui::radius::CARD))
                .bg(c.raised)
                .border_1()
                .border_color(c.line)
                .shadow(vec![gpui::BoxShadow { color: gpui::hsla(0., 0., 0., 0.2), offset: gpui::point(px(0.), px(8.)), blur_radius: px(24.), spread_radius: px(0.) }])
                .child(ui.title(format!("Sondra {version} ist bereit")))
                .child(ui.hint("Die neue Fassung ist geladen und geprüft. Beim Aktualisieren fragt Windows um Erlaubnis, danach öffnet sich Sondra wieder."))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(ui.button("update-jetzt", "Jetzt aktualisieren").small().primary().accessible_name(format!("Auf {version} aktualisieren")).on_click(move |_, app| now.update(app, |shell, cx| shell.update_install(cx))))
                        .child(ui.button("update-spaeter", "Später").small().accessible_name("Update später").on_click(move |_, app| {
                            later.update(app, |shell, cx| {
                                shell.update.dismissed = true;
                                cx.notify();
                            })
                        })),
                )
                .into_any_element(),
        )
    }

    /// The line and the button at the top of „Was ist neu“.
    pub(crate) fn update_section(&self, ui: &Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        if matches!(self.update.status, Status::Off) {
            return None;
        }
        let me = cx.entity();
        let says = match &self.update.status {
            Status::Off | Status::Idle => "Sondra sucht von selbst nach einer neuen Fassung.".to_string(),
            Status::Checking => "Es wird nach einer neuen Fassung gesucht …".to_string(),
            Status::Current => format!("Sie haben die neueste Fassung ({}).", self.update.current),
            Status::Downloading { version, .. } => format!("Sondra {version} wird geladen …"),
            Status::Ready { version, .. } => format!("Sondra {version} ist geladen und geprüft."),
            Status::Failed(message) => format!("Aktualisieren geht gerade nicht: {message}"),
        };
        let button = match &self.update.status {
            Status::Ready { version, .. } => {
                let me = me.clone();
                ui.button("update-jetzt-neu", "Jetzt aktualisieren").small().primary().accessible_name(format!("Auf {version} aktualisieren")).on_click(move |_, app| me.update(app, |shell, cx| shell.update_install(cx)))
            }
            status => {
                let busy = matches!(status, Status::Checking | Status::Downloading { .. });
                ui.button("update-suchen", "Nach Updates suchen").small().disabled(busy).on_click(move |_, app| me.update(app, |shell, cx| shell.update_check(true, cx)))
            }
        };
        let line = div().flex().flex_wrap().items_center().gap(px(12.)).child(ui.prose(says)).child(button);
        // While the new version is loaded, how far it is.
        let bar = match &self.update.status {
            Status::Downloading { version, fraction } => Some(div().w(px(320.)).child(ui.bar("update-laden", *fraction, format!("Sondra {version}: geladen")))),
            _ => None,
        };
        Some(div().flex().flex_col().gap(px(6.)).pb(px(8.)).child(line).children(bar).into_any_element())
    }
}
