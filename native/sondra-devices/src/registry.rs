//! The account's devices in Drive: each device's signed record, and the post between them. A port of
//! the rounds in `src/lib/devices.ts` (`refreshList`, `readPost`, `post`, `cleanUp`, `dropEntry`,
//! `adoptFormer`), so the apps and this one are devices of one account.
//!
//! Drive knows no rights finer than the account, so nothing here believes a file because it is
//! there: a record counts only when its signature holds (`pick_devices`), a message only when
//! `open_message` lets it through. Each device writes only its own record.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;
use sondra_drive::{notes_query, DriveClient, DriveError, Found, TokenSource};

use crate::identity::{
    open_message, pick_devices, random_id, seal_message, sign_record, unique_name, DeviceKeys,
    MessageProblem, RecordFields,
};

const REGISTRY: [&str; 2] = ["Sondra", "Geräte"];
const POST: [&str; 3] = ["Sondra", "Geräte", "Post"];

/// Seen within this counts as „offen“.
pub const ONLINE_WITHIN: f64 = 3.0 * 60_000.0;
/// Devices not seen for this long are not listed.
pub const FORGET_AFTER: f64 = 60.0 * 24.0 * 60.0 * 60_000.0;
/// How often the list is read and this device's own record written again.
pub const LIST_EVERY: f64 = 30_000.0;
pub const BEAT_EVERY: f64 = 2.0 * 60_000.0;
/// Offered for two weeks after joining: a reinstall is noticed in its first days.
const FORMER_WITHIN: f64 = 14.0 * 24.0 * 60.0 * 60_000.0;
/// Offers and handovers nobody took go after a day.
const LEFTOVER_AFTER: f64 = 24.0 * 60.0 * 60_000.0;

pub fn is_online(device: &Value, now: f64) -> bool {
    now - device["seen"].as_f64().unwrap_or(0.0) < ONLINE_WITHIN
}

/// A message that came through every check.
#[derive(Debug, Clone, PartialEq)]
pub struct Incoming {
    pub id: String,
    pub from: String,
    pub kind: String,
    pub transfer: String,
    pub body: Value,
}

/// What this device is, as its record says it.
#[derive(Debug, Clone)]
pub struct Hardware {
    /// `windows`, `android` or `browser`.
    pub kind: String,
    pub platform: String,
    pub caps: Vec<String>,
}

pub struct Registry<T: TokenSource> {
    client: DriveClient<T>,
    keys: DeviceKeys,
    id: String,
    pub name: String,
    pub created: f64,
    pub decided: bool,
    pub file_id: Option<String>,
    hardware: Hardware,
    /// Opened already: a message is acted on once.
    seen: HashSet<String>,
    /// File id → what was read, so an unchanged record is not fetched again.
    cache: HashMap<String, (Option<String>, Value)>,
    /// The other devices of the account.
    pub devices: Vec<Value>,
    /// Entries that may be this device before a reinstall.
    pub former: Vec<Value>,
    /// This device's record as Drive holds it.
    pub me: Option<Value>,
    pub last_list: f64,
    pub last_beat: f64,
    cleaned: bool,
}

impl<T: TokenSource> Registry<T> {
    pub fn new(client: DriveClient<T>, keys: DeviceKeys, name: &str, created: f64, hardware: Hardware) -> Self {
        let id = keys.id();
        Self {
            client,
            keys,
            id,
            name: name.to_owned(),
            created,
            decided: false,
            file_id: None,
            hardware,
            seen: HashSet::new(),
            cache: HashMap::new(),
            devices: vec![],
            former: vec![],
            me: None,
            last_list: 0.0,
            last_beat: 0.0,
            cleaned: false,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn client(&self) -> &DriveClient<T> {
        &self.client
    }

    fn read_json(&mut self, found: &Found) -> Option<Value> {
        let modified = found.file.modified_time.clone();
        if let Some((m, raw)) = self.cache.get(&found.file.id) {
            if *m == modified {
                return Some(raw.clone());
            }
        }
        let bytes = self.client.download(&found.file.id).ok()?;
        let raw: Value = serde_json::from_slice(&bytes).ok()?;
        self.cache.insert(found.file.id.clone(), (modified, raw.clone()));
        Some(raw)
    }

    fn fields(&self, now: f64) -> RecordFields {
        RecordFields {
            name: self.name.clone(),
            kind: self.hardware.kind.clone(),
            platform: self.hardware.platform.clone(),
            created: self.created,
            seen: now,
            caps: self.hardware.caps.clone(),
        }
    }

    fn same_caps(a: Option<&Value>, b: &[String]) -> bool {
        let mut mine: Vec<&str> = a
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let mut other: Vec<&str> = b.iter().map(String::as_str).collect();
        mine.sort_unstable();
        other.sort_unstable();
        mine == other
    }

    /// The account's devices, and this one's own record put right where it is not.
    pub fn refresh_list(&mut self, now: f64, mut beat: bool) -> Result<(), DriveError> {
        let found = self.client.search(&notes_query("sondraArt", "geraet"))?;
        let mut raws = vec![];
        let mut mine: Vec<Found> = vec![];
        for entry in found {
            if entry.notes.get("sondraGeraet").map(String::as_str) == Some(self.id.as_str()) {
                mine.push(entry);
                continue;
            }
            // Unreadable is the same as not there.
            if let Some(raw) = self.read_json(&entry) {
                raws.push(raw);
            }
        }
        let others: Vec<Value> = pick_devices(&raws)
            .into_iter()
            .filter(|d| d["id"].as_str() != Some(self.id.as_str()) && now - d["seen"].as_f64().unwrap_or(0.0) < FORGET_AFTER)
            .collect();

        // A name another device carried first is given up here, never taken from it.
        let lower = |s: &str| s.to_lowercase();
        let clash = others.iter().any(|d| {
            lower(d["name"].as_str().unwrap_or_default()) == lower(&self.name) && d["created"].as_f64().unwrap_or(0.0) < self.created
        });
        if clash {
            let names: Vec<String> = others.iter().filter_map(|d| d["name"].as_str().map(str::to_owned)).collect();
            self.name = unique_name(&self.name, &names);
            beat = true;
        }

        // This device's file: the one it knows, or one it finds; copies go.
        let keep = mine
            .iter()
            .position(|f| Some(&f.file.id) == self.file_id.as_ref())
            .unwrap_or(0);
        let mut file = if mine.is_empty() { None } else { Some(mine.remove(keep)) };
        for copy in &mine {
            let _ = self.client.remove(&copy.file.id);
        }
        let mut current: Option<Value> = None;
        if let (Some(f), false) = (&file, beat) {
            if let Some(raw) = self.read_json(f) {
                if let Some(believed) = pick_devices(&[raw]).into_iter().next() {
                    if believed["id"].as_str() == Some(self.id.as_str())
                        && believed["name"].as_str() == Some(self.name.as_str())
                        && believed["platform"].as_str() == Some(self.hardware.platform.as_str())
                        && Self::same_caps(believed.get("caps"), &self.hardware.caps)
                    {
                        current = Some(believed);
                    }
                }
            }
        }
        let current = match current {
            Some(c) => c,
            None => {
                let record = sign_record(&self.keys, &self.fields(now));
                let bytes = record.to_string().into_bytes();
                let written = match &file {
                    Some(f) => self.client.rewrite(&f.file.id, &bytes, "application/json")?,
                    None => {
                        let folder = self.client.ensure_path(&REGISTRY)?;
                        let notes = BTreeMap::from([
                            ("sondraArt".to_owned(), "geraet".to_owned()),
                            ("sondraGeraet".to_owned(), self.id.clone()),
                        ]);
                        self.client.create(&folder, &format!("Gerät-{}.json", self.id), &bytes, "application/json", &notes)?
                    }
                };
                self.cache.insert(written.id.clone(), (written.modified_time.clone(), record.clone()));
                file = Some(Found { file: written, notes: BTreeMap::new() });
                self.last_beat = now;
                record
            }
        };
        self.file_id = file.map(|f| f.file.id);
        self.former = if self.decided || now - self.created > FORMER_WITHIN {
            vec![]
        } else {
            others
                .iter()
                .filter(|d| {
                    d["kind"] == current["kind"]
                        && d["platform"] == current["platform"]
                        && d["created"].as_f64().unwrap_or(0.0) < self.created
                        && !is_online(d, now)
                })
                .cloned()
                .collect()
        };
        self.devices = others;
        self.me = Some(current);
        self.last_list = now;
        Ok(())
    }

    /// Messages for this device: each opened once, then deleted, believed or not.
    pub fn read_post(&mut self, now: f64) -> Result<Vec<Incoming>, DriveError> {
        let mut out = vec![];
        for entry in self.client.search(&notes_query("sondraAn", &self.id))? {
            let raw: Value = self
                .client
                .download(&entry.file.id)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            // Read is read: a message for this device goes, believed or not.
            let _ = self.client.remove(&entry.file.id);
            let mut opened = self.open(&raw, now);
            if opened == Err(MessageProblem::UnknownSender) {
                // A device that joined a moment ago: the list once more, then again.
                self.refresh_list(now, false)?;
                opened = self.open(&raw, now);
            }
            let Ok(m) = opened else { continue };
            let id = m["id"].as_str().unwrap_or_default().to_owned();
            self.seen.insert(id.clone());
            out.push(Incoming {
                id,
                from: m["from"].as_str().unwrap_or_default().to_owned(),
                kind: m["type"].as_str().unwrap_or_default().to_owned(),
                transfer: m["transfer"].as_str().unwrap_or_default().to_owned(),
                body: m["body"].clone(),
            });
        }
        Ok(out)
    }

    fn open(&self, raw: &Value, now: f64) -> Result<Value, MessageProblem> {
        let seen = &self.seen;
        open_message(raw, &self.id, &self.devices, now, &|id| seen.contains(id))
    }

    /// A message to another device, signed by this one.
    pub fn post(&self, to: &str, kind: &str, transfer: &str, body: Value, now: f64) -> Result<(), DriveError> {
        let id = random_id();
        let message = seal_message(&self.keys, &id, &self.id, to, now, kind, transfer, body);
        let folder = self.client.ensure_path(&POST)?;
        let notes = BTreeMap::from([("sondraAn".to_owned(), to.to_owned()), ("sondraVon".to_owned(), self.id.clone())]);
        self.client
            .create(&folder, &format!("{kind}-{id}.json"), message.to_string().as_bytes(), "application/json", &notes)?;
        Ok(())
    }

    /// Offers and handovers this device left that nobody took: gone after a day. Once per run.
    pub fn clean_up(&mut self, now: f64, modified_ms: &dyn Fn(&str) -> Option<f64>) -> Result<(), DriveError> {
        if self.cleaned {
            return Ok(());
        }
        self.cleaned = true;
        for entry in self.client.search(&notes_query("sondraVon", &self.id))? {
            let old = entry
                .file
                .modified_time
                .as_deref()
                .and_then(modified_ms)
                .is_some_and(|t| t < now - LEFTOVER_AFTER);
            if old {
                let _ = self.client.remove(&entry.file.id);
            }
        }
        Ok(())
    }

    /// A new name for this device, made unique among the others'.
    pub fn rename(&mut self, wanted: &str, now: f64) -> Result<String, DriveError> {
        let names: Vec<String> = self.devices.iter().filter_map(|d| d["name"].as_str().map(str::to_owned)).collect();
        self.name = unique_name(wanted, &names);
        self.refresh_list(now, true)?;
        Ok(self.name.clone())
    }

    /// Deletes a device's entry in Drive, and every copy of it.
    fn drop_entry(&mut self, id: &str) -> Result<(), DriveError> {
        for entry in self.client.search(&notes_query("sondraGeraet", id))? {
            self.client.remove(&entry.file.id)?;
            self.cache.remove(&entry.file.id);
        }
        Ok(())
    }

    /// „Das war dieses Gerät“: after a reinstall the old entry is this device under a lost key.
    /// It goes, and this device takes its name.
    pub fn adopt_former(&mut self, id: &str, now: f64) -> Result<(), DriveError> {
        let Some(former) = self.former.iter().find(|d| d["id"].as_str() == Some(id)).cloned() else {
            return Ok(());
        };
        if is_online(&former, now) {
            return Ok(());
        }
        self.drop_entry(id)?;
        let names: Vec<String> = self
            .devices
            .iter()
            .filter(|d| d["id"].as_str() != Some(id))
            .filter_map(|d| d["name"].as_str().map(str::to_owned))
            .collect();
        self.name = unique_name(former["name"].as_str().unwrap_or_default(), &names);
        self.decided = true;
        self.devices.retain(|d| d["id"].as_str() != Some(id));
        self.former.clear();
        self.refresh_list(now, true)
    }

    /// „Nein, ein anderes Gerät“: the old entries stay, and the question is not asked again.
    pub fn dismiss_former(&mut self) {
        self.decided = true;
        self.former.clear();
    }

    /// Takes an entry off the list that is not open now. Safe for a device still in use: it writes its
    /// entry again on its next round and is back.
    pub fn remove_device(&mut self, id: &str, now: f64) -> Result<(), DriveError> {
        let Some(device) = self.devices.iter().find(|d| d["id"].as_str() == Some(id)) else {
            return Ok(());
        };
        if is_online(device, now) {
            return Ok(());
        }
        self.drop_entry(id)?;
        self.devices.retain(|d| d["id"].as_str() != Some(id));
        self.former.retain(|d| d["id"].as_str() != Some(id));
        Ok(())
    }
}
