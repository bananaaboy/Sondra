//! Google Drive for the pages that save a result there („In Drive“): one sign-in for the whole program (the one the
//! Geräte page uses, a client set up at build time), the folders below „Sondra“ by kind (`Dateien/Ton`, `Video`,
//! `Bilder`, `Andere`) and the upload of `sondra-drive` (small in one request, big in pieces, the same file not sent
//! twice). The work runs away from the window; the page shows its state on the button's line.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use sondra_devices::files::mime_of;
use sondra_drive::keystore::FileKeyStore;
use sondra_drive::write::{Mode, Put};
use sondra_drive::{Account, ClientCredentials, DriveClient, DriveError, Endpoints, TokenSource};

use crate::store::data_dir;

const CLIENT_ID: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_SECRET");

pub type Tokens = Arc<dyn TokenSource + Send + Sync>;

/// What the program has of Drive: where, with which tokens, how to sign in, and whether it is.
#[derive(Clone)]
pub struct Drive {
    pub api: String,
    pub tokens: Tokens,
    pub configured: bool,
    pub connected: Arc<dyn Fn() -> bool + Send + Sync>,
    /// Signs in through the system browser and waits for the answer (a click starts it).
    pub sign_in: Arc<dyn Fn() -> Result<(), String> + Send + Sync>,
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(windows))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// The one account of this program, or `None` where there is no folder to keep a key in.
pub fn account() -> Option<Arc<Account>> {
    static ACCOUNT: OnceLock<Option<Arc<Account>>> = OnceLock::new();
    ACCOUNT
        .get_or_init(|| {
            let dir = data_dir()?;
            let client = match (CLIENT_ID, CLIENT_SECRET) {
                (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Some(ClientCredentials { id: id.to_owned(), secret: secret.to_owned() }),
                _ => None,
            };
            Some(Arc::new(Account::new(client, Endpoints::default(), Box::new(FileKeyStore::new(dir.join("google-schluessel.bin"))))))
        })
        .clone()
}

impl Drive {
    /// The real one; `None` where nothing can be kept.
    pub fn production() -> Option<Drive> {
        let account = account()?;
        let (a1, a2) = (account.clone(), account.clone());
        Some(Drive {
            api: Endpoints::default().api,
            tokens: account.clone(),
            configured: account.configured(),
            connected: Arc::new(move || a1.connected()),
            sign_in: Arc::new(move || a2.connect(open_in_browser).map_err(|e| says(&e))),
        })
    }

    pub(crate) fn client(&self) -> DriveClient<Tokens> {
        DriveClient::new(self.tokens.clone(), self.api.clone())
    }
}

/// A Drive error in the words of the page.
pub fn says(error: &DriveError) -> String {
    match error {
        DriveError::NotConfigured => "Google Drive ist in dieser Fassung nicht eingerichtet.".into(),
        DriveError::Unauthorized => "Bei Google Drive ist die Anmeldung abgelaufen. Bitte noch einmal anmelden.".into(),
        DriveError::Offline(_) => "Google Drive ist gerade nicht erreichbar.".into(),
        DriveError::Denied => "Sie haben Sondra den Zugriff auf Drive nicht erlaubt.".into(),
        DriveError::Timeout => "Die Anmeldung bei Google hat zu lange gedauert.".into(),
        DriveError::Cancelled => "Abgebrochen.".into(),
        DriveError::Scope => "Sondra darf in Drive keine Dateien ablegen. Bitte neu anmelden und alles erlauben.".into(),
        other => format!("Drive sagt: {other}"),
    }
}

/// The folder a file goes to by what it is: `Sondra/Dateien/<Ton | Video | Bilder | Andere>`.
pub fn folder_path(name: &str) -> [&'static str; 3] {
    let mime = mime_of(name);
    let kind = if mime.starts_with("audio/") {
        "Ton"
    } else if mime.starts_with("video/") {
        "Video"
    } else if mime.starts_with("image/") {
        "Bilder"
    } else {
        "Andere"
    };
    ["Sondra", "Dateien", kind]
}

/// How a save ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    /// Put there now.
    Done,
    /// A file of that name and size was there already.
    Already,
}

/// Puts one file into its folder in Drive: signs in first when that is needed (a person pressed the button, so the
/// browser may open), then sends it. `progress` gets (sent, total).
pub fn save(drive: &Drive, path: &Path, cancel: &AtomicBool, progress: impl FnMut(u64, u64)) -> Result<Saved, String> {
    if !(drive.connected)() {
        (drive.sign_in)()?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).ok_or("Die Datei hat keinen Namen.")?;
    let client = drive.client();
    let folder = client.ensure_path(&folder_path(&name)).map_err(|e| says(&e))?;
    let notes: BTreeMap<String, String> = BTreeMap::new();
    match client.put_file(&folder, &name, path, mime_of(&name), &notes, Mode::SkipSame, cancel, progress).map_err(|e| says(&e))? {
        Put::Same(_) => Ok(Saved::Already),
        Put::Made(_) | Put::Replaced(_) => Ok(Saved::Done),
    }
}

/// Where each file of a page stands: waiting, a percent, done, already there, or why not.
#[derive(Debug, Clone, PartialEq)]
pub enum Line {
    Busy(Option<f32>),
    Done,
    Already,
    Failed(String),
}

/// The state of the saves, by path, shared with the threads that do the work.
#[derive(Clone, Default)]
pub struct Saves(pub Arc<Mutex<BTreeMap<PathBuf, Line>>>);

impl Saves {
    pub fn get(&self, path: &Path) -> Option<Line> {
        self.0.lock().expect("lock").get(path).cloned()
    }
    pub fn set(&self, path: &Path, line: Line) {
        self.0.lock().expect("lock").insert(path.to_path_buf(), line);
    }
}

impl crate::shell::Shell {
    /// Saves a file into Drive in the background; the line of the button tells how it goes.
    pub fn save_to_drive(&mut self, path: PathBuf, cx: &mut gpui::Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        let saves = self.drive_saves.clone();
        if matches!(saves.get(&path), Some(Line::Busy(_))) {
            return;
        }
        saves.set(&path, Line::Busy(None));
        cx.notify();
        let (work, result) = (saves.clone(), saves);
        let target = path.clone();
        Self::in_background(
            cx,
            move || {
                let cancel = AtomicBool::new(false);
                let shown = path.clone();
                save(&drive, &path, &cancel, |sent, total| work.set(&shown, Line::Busy((total > 0).then_some(sent as f32 / total as f32))))
            },
            move |_, outcome, cx| {
                let shown = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                match &outcome {
                    Ok(Saved::Done) => crate::protocol::note("drive", format!("{shown} in Drive gespeichert")),
                    Ok(Saved::Already) => crate::protocol::note("drive", format!("{shown} war schon in Drive")),
                    Err(why) => crate::protocol::warn("drive", format!("{shown}: {why}")),
                }
                result.set(
                    &target,
                    match outcome {
                        Ok(Saved::Done) => Line::Done,
                        Ok(Saved::Already) => Line::Already,
                        Err(why) => Line::Failed(why),
                    },
                );
                cx.notify();
            },
        );
    }
}

impl crate::shell::Shell {
    /// For tests: a Drive that is somewhere else (a stand-in), signed in.
    pub fn set_drive_for_test(&mut self, drive: Drive) {
        self.drive = Some(drive);
    }
}

impl crate::shell::Shell {
    /// The „In Drive“ button of a result, with its state in its words; `None` where no Google client is built in.
    /// „In Drive“ and, beside it, „An „Gerät““ for every device that is open now (`DeviceSendButton` on the website):
    /// the ways a result leaves this computer, each only where it can.
    pub(crate) fn drive_button(&self, ui: &sondra_ui::Ui, id: String, path: &Path, name: &str, cx: &mut gpui::Context<Self>) -> Vec<gpui::AnyElement> {
        use gpui::IntoElement;
        let mut out: Vec<gpui::AnyElement> = self.drive_only_button(ui, id.clone(), path, name, cx).map(|b| b.into_any_element()).into_iter().collect();
        for (device, device_name) in self.folder_devices().into_iter().take(3) {
            let (me, target, to) = (cx.entity(), path.to_path_buf(), device.clone());
            out.push(
                ui.button(format!("{id}-geraet-{device}"), format!("An „{device_name}“"))
                    .small()
                    .ghost()
                    .accessible_name(format!("{name} an {device_name} senden"))
                    .on_click(move |_, app| {
                        let (p, to) = (target.clone(), to.clone());
                        me.update(app, |shell, cx| shell.devices_send_paths(&to, vec![p], false, cx))
                    })
                    .into_any_element(),
            );
        }
        out
    }

    fn drive_only_button(&self, ui: &sondra_ui::Ui, id: String, path: &Path, name: &str, cx: &mut gpui::Context<Self>) -> Option<sondra_ui::Button> {
        if !self.drive.as_ref().is_some_and(|d| d.configured) {
            return None;
        }
        let (me, target) = (cx.entity(), path.to_path_buf());
        let state = self.drive_saves.get(path);
        let (label, busy) = match &state {
            Some(Line::Busy(Some(f))) => (format!("Drive {} %", (f * 100.0).round() as i32), true),
            Some(Line::Busy(None)) => ("Drive …".to_string(), true),
            Some(Line::Done) => ("In Drive gespeichert".to_string(), false),
            Some(Line::Already) => ("Schon in Drive".to_string(), false),
            Some(Line::Failed(_)) => ("Erneut versuchen".to_string(), false),
            None => ("In Drive".to_string(), false),
        };
        Some(ui.button(id, label).small().disabled(busy).accessible_name(format!("{name} in Drive speichern")).on_click(move |_, app| {
            let p = target.clone();
            me.update(app, |shell, cx| shell.save_to_drive(p, cx))
        }))
    }

    /// The sentence under a result when Drive refused it.
    pub(crate) fn drive_failure(&self, path: &Path) -> Option<String> {
        match self.drive_saves.get(path) {
            Some(Line::Failed(why)) => Some(format!("Drive: {why}")),
            _ => None,
        }
    }
}

impl crate::shell::Shell {
    /// The button in the header: „Drive anmelden“ while signed out (the click opens the browser), a quiet „Drive“ once
    /// signed in. Not there where no Google client is built in.
    pub(crate) fn drive_header_button(&self, ui: &sondra_ui::Ui, compact: bool, cx: &mut gpui::Context<Self>) -> Option<gpui::AnyElement> {
        // A build without Google's credentials has no Drive. It says so where Drive would stand, instead of
        // every Drive feature vanishing without a word (as it did in the native builds of the CI).
        let Some(drive) = self.drive.as_ref().filter(|d| d.configured) else {
            let item = ui
                .rack_item("drive-kopf", "Drive nicht eingerichtet", false)
                .icon(Some(sondra_ui::ui_icon("drive")))
                .compact(compact)
                .disabled(true)
                .accessible_name("Google Drive ist in dieser Fassung nicht eingerichtet");
            return Some(gpui::IntoElement::into_any_element(item));
        };
        let me = cx.entity();
        let connected = (drive.connected)();
        let label = if self.drive_signing {
            "Drive: Anmeldung im Browser …"
        } else if connected {
            "Drive"
        } else {
            "Drive anmelden"
        };
        let name = if connected { "Google Drive ist verbunden".to_string() } else { self.drive_error.clone().map_or("Bei Google Drive anmelden".to_string(), |e| format!("Bei Google Drive anmelden. {e}")) };
        let item = ui.rack_item("drive-kopf", label, false).icon(Some(sondra_ui::ui_icon("drive"))).compact(compact).accessible_name(name);
        // Connected, or the browser already asked: nothing to press, the line only says so.
        let item = item.disabled(self.drive_signing || connected).on_click(move |_, app| me.update(app, |shell, cx| shell.drive_sign_in(cx)));
        Some(gpui::IntoElement::into_any_element(item))
    }

    /// Signs in to Google through the system browser, away from the window.
    pub fn drive_sign_in(&mut self, cx: &mut gpui::Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        if self.drive_signing {
            return;
        }
        self.drive_signing = true;
        self.drive_error = None;
        cx.notify();
        Self::in_background(
            cx,
            move || (drive.sign_in)(),
            |shell, result, cx| {
                shell.drive_signing = false;
                shell.drive_error = result.err();
                cx.notify();
            },
        );
    }
}

impl crate::shell::Shell {
    /// A written file as a line: its path, and „In Drive“ beside it where Drive is set up (with the reason when it failed).
    pub(crate) fn written_row(&self, ui: &sondra_ui::Ui, path: &Path, cx: &mut gpui::Context<Self>) -> gpui::AnyElement {
        use gpui::{div, prelude::*, px};
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut row = div().flex().flex_wrap().items_center().gap(px(10.)).child(ui.value(path.display().to_string()));
        row = row.children(self.drive_button(ui, format!("drive-{}", path.display()), path, &name, cx));
        if let Some(why) = self.drive_failure(path) {
            row = row.child(ui.hint(why));
        }
        row.into_any_element()
    }
}

/// A file name that is safe on every file system (what Windows refuses is replaced).
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() { "datei".to_string() } else { trimmed.to_string() }
}
