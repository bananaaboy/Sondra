//! „Merkliste über Google Drive abgleichen“ (`syncMerklisteWithDrive` in `src/lib/googleDrive.ts`): the file
//! `Sondra/Merkliste/Sondra-Merkliste.sqlite` is the list every device of one account shares — this program,
//! the Windows app and the website. A round reads it (the older `….json` too), merges it into this device's
//! list (`merge_shared`: per series the side changed last wins, removals stay removed, pictures from files stay
//! on their device) and writes it back only when the file does not already hold exactly that — compared as
//! values with the file itself, never with what was written last.
//!
//! * off until chosen (`MerkDrive.json`, „an“); choosing it signs in when that is not done yet;
//! * a round a moment after each change, every three minutes to receive what another device wrote, and a
//!   failed one a minute later; rounds never overlap, and what is changed here during one is merged, not lost;
//! * a file that is no Merkliste is never written over.

use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use gpui::Context;
use sondra_drive::write::Mode;
use sondra_drive::DriveError;
use sondra_merk::folder_memory::Store;
use sondra_merk::merge::{merge_shared, shared_key, Removed};
use sondra_merk::model::Item;
use sondra_merk::normalize::Context as Ids;
use sondra_merk::sqlite::{holds_same, read_shared, write_sqlite, Snapshot};

use crate::drive_hub::{says, Drive};
use crate::shell::Shell;

const FILE: &str = "MerkDrive.json";
const FOLDERS: [&str; 2] = ["Sondra", "Merkliste"];
const SQLITE: &str = "Sondra-Merkliste.sqlite";
const LEGACY: &str = "Sondra-Merkliste.json";
const MIME: &str = "application/vnd.sqlite3";
const TICK: Duration = Duration::from_millis(1250);
const EVERY: Duration = Duration::from_secs(3 * 60);
const RETRY: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct MerkDrive {
    pub on: bool,
    pub running: bool,
    /// What the file holds after the last round.
    pub synced: Option<serde_json::Value>,
    pub pending: Option<serde_json::Value>,
    pub last: Option<Instant>,
    pub retry_after: Option<Instant>,
    /// The last round's words, for the line under the list.
    pub said: Option<String>,
}

impl MerkDrive {
    pub fn load() -> MerkDrive {
        let on = crate::store::FileStore::at_default(FILE).is_some_and(|s| s.get_item("an").as_deref() == Some("an"));
        MerkDrive { on, ..Default::default() }
    }
}

/// What a round came to.
#[derive(Debug)]
pub struct Round {
    pub items: Vec<Item>,
    pub removed: Removed,
    /// Series that came from the file or changed through it.
    pub received: usize,
    pub wrote: bool,
}

/// What can go wrong in a round, in words.
#[derive(Debug)]
pub enum Trouble {
    Drive(DriveError),
    /// The file is there and is no Merkliste: never written over.
    Unreadable(String),
}

impl Trouble {
    fn says(&self) -> String {
        match self {
            Trouble::Drive(e) => format!("Der Abgleich mit Google Drive ist gescheitert: {}", says(e)),
            Trouble::Unreadable(name) => format!("{name} in Google Drive ist keine Merkliste — Sondra schreibt nicht darüber."),
        }
    }
}

/// One round against Drive (away from the window).
pub fn round(drive: &Drive, items: &[Item], removed: &Removed) -> Result<Round, Trouble> {
    let client = drive.client();
    let found = client.folder_path(&FOLDERS).map_err(Trouble::Drive)?;
    let mut legacy = false;
    let mut file = None;
    if let Some(folder) = &found {
        file = client.find_file(folder, SQLITE).map_err(Trouble::Drive)?;
        if file.is_none() {
            file = client.find_file(folder, LEGACY).map_err(Trouble::Drive)?;
            legacy = file.is_some();
        }
    }
    let remote = match &file {
        Some(file) => {
            let bytes = client.download(&file.id).map_err(Trouble::Drive)?;
            Some(read_shared(&bytes, &mut Ids::system()).map_err(|_| Trouble::Unreadable(file.name.clone()))?)
        }
        None => None,
    };
    let (mut now_items, mut now_removed, mut received) = (items.to_vec(), removed.clone(), 0);
    if let Some(remote) = &remote {
        let (merged, merged_removed) = merge_shared(items, removed, &remote.items, &remote.removed);
        received = merged.iter().filter(|m| items.iter().find(|i| i.id == m.id).map(|i| i.updated_at) != Some(m.updated_at)).count();
        now_items = merged;
        now_removed = merged_removed;
    }
    let same = remote.as_ref().is_some_and(|r| !legacy && holds_same(r, &now_items, &now_removed));
    let mut wrote = false;
    if !same {
        let snapshot = Snapshot { items: now_items.clone(), removed: now_removed.clone(), app_state: remote.as_ref().map(|r| r.app_state.clone()).unwrap_or_default() };
        let bytes = write_sqlite(&snapshot).map_err(|e| Trouble::Drive(DriveError::Failed(e.to_string())))?;
        let staged = tempfile::Builder::new().prefix("merkliste-").suffix(".sqlite").tempfile().map_err(|e| Trouble::Drive(DriveError::Failed(e.to_string())))?;
        std::fs::write(staged.path(), bytes).map_err(|e| Trouble::Drive(DriveError::Failed(e.to_string())))?;
        let folder = client.ensure_path(&FOLDERS).map_err(Trouble::Drive)?;
        client.put_file(&folder, SQLITE, staged.path(), MIME, &BTreeMap::new(), Mode::Replace, &AtomicBool::new(false), |_, _| {}).map_err(Trouble::Drive)?;
        wrote = true;
    }
    Ok(Round { items: now_items, removed: now_removed, received, wrote })
}

fn clock() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

impl Shell {
    /// Starts the rounds: while on and signed in, a change goes to Drive after a moment, and now and then the file is read.
    pub(crate) fn start_merk_drive_rounds(window: &mut gpui::Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(TICK).await;
            if this.update(cx, |shell, cx| shell.merk_drive_tick(cx)).is_err() {
                break;
            }
        })
        .detach();
    }

    fn merk_drive_tick(&mut self, cx: &mut Context<Self>) {
        let d = &self.merk_drive;
        if !d.on || d.running || !self.drive.as_ref().is_some_and(|dr| (dr.connected)()) {
            return;
        }
        if d.retry_after.is_some_and(|t| Instant::now() < t) {
            return;
        }
        let key = shared_key(&self.merk.items, &self.merk.removed);
        let changed = d.synced.as_ref() != Some(&key);
        let due = d.last.is_none_or(|t| t.elapsed() >= EVERY);
        if changed {
            // Sent once the list has stood still for a tick (the first round does not wait).
            if d.pending.as_ref() == Some(&key) || d.last.is_none() {
                self.merk_drive_sync(cx);
            } else {
                self.merk_drive.pending = Some(key);
            }
        } else if due {
            self.merk_drive_sync(cx);
        }
    }

    /// The switch under „Mehr“. Turning it on signs in first when that is not done yet.
    pub fn set_merk_drive(&mut self, on: bool, cx: &mut Context<Self>) {
        self.merk_drive.on = on;
        if let Some(mut store) = crate::store::FileStore::at_default(FILE) {
            store.set_item("an", if on { "an" } else { "aus" }.to_string());
        }
        self.merk_drive.synced = None;
        self.merk_drive.last = None;
        self.merk_drive.retry_after = None;
        if !on {
            self.merk_drive.said = None;
        } else if self.drive.as_ref().is_some_and(|d| (d.connected)()) {
            self.merk_drive_sync(cx);
        } else {
            self.drive_sign_in(cx);
            self.merk_drive.said = Some("Für den Abgleich melden Sie sich bei Google an; danach geht es von selbst los.".into());
        }
        cx.notify();
    }

    /// One round with the file in Drive.
    pub fn merk_drive_sync(&mut self, cx: &mut Context<Self>) {
        let Some(drive) = self.drive.clone() else { return };
        if self.merk_drive.running || !(drive.connected)() {
            return;
        }
        self.merk_drive.running = true;
        let (items, removed) = (self.merk.items.clone(), self.merk.removed.clone());
        Self::in_background(cx, move || round(&drive, &items, &removed), |shell, answer, cx| {
            shell.merk_drive.running = false;
            shell.merk_drive.last = Some(Instant::now());
            match answer {
                Ok(done) => {
                    shell.merk_drive.retry_after = None;
                    // What changed here meanwhile is merged, not replaced.
                    let (merged, removed) = merge_shared(&shell.merk.items, &shell.merk.removed, &done.items, &done.removed);
                    let changed = shared_key(&merged, &removed) != shared_key(&shell.merk.items, &shell.merk.removed);
                    shell.merk.items = merged;
                    shell.merk.removed = removed;
                    if changed {
                        shell.merk.save();
                    }
                    shell.merk_drive.synced = Some(shared_key(&done.items, &done.removed));
                    shell.merk_drive.pending = None;
                    shell.merk_drive.said = Some(match (done.received, done.wrote) {
                        (0, false) => format!("Mit Google Drive im Gleichschritt (um {}).", clock()),
                        (0, true) => format!("In Google Drive abgeglichen um {} ({} Einträge).", clock(), done.items.len()),
                        (n, _) => format!("Aus Google Drive: {} {} neu oder geändert (um {}).", n, if n == 1 { "Serie" } else { "Serien" }, clock()),
                    });
                }
                Err(trouble) => {
                    shell.merk_drive.retry_after = Some(Instant::now() + RETRY);
                    shell.merk_drive.said = Some(trouble.says());
                }
            }
            cx.notify();
        });
        cx.notify();
    }

    /// For tests: whether a round is under way.
    pub fn merk_drive_running(&self) -> bool {
        self.merk_drive.running
    }

    /// For tests: what the last round said.
    pub fn merk_drive_said(&self) -> Option<String> {
        self.merk_drive.said.clone()
    }
}
