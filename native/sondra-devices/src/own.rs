//! This device's own identity at rest: its private key, the name it carries, when it joined and whether the
//! person said „ein anderes Gerät“ to the question after a reinstall. The key is the device (its id is the
//! key's hash), so it rests where the Drive sign-in rests — protected by Windows for the account that made
//! it, never in the clear there (`sondra_drive::keystore`).

use std::io;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde_json::{json, Value};
use sondra_drive::keystore::KeyStore;

use crate::identity::{clean_name, DeviceKeys};

pub struct Own {
    pub keys: DeviceKeys,
    pub name: String,
    /// Milliseconds since 1970.
    pub created: f64,
    pub decided: bool,
}

impl Own {
    /// A new identity: a new key, the name the person (or the kind of device) gives.
    pub fn create(name: &str, now: f64) -> Own {
        let clean = clean_name(name);
        Own { keys: DeviceKeys::generate(), name: if clean.is_empty() { "Computer".into() } else { clean }, created: now, decided: false }
    }

    /// What was kept; `None` where nothing was, or what is there cannot be read (then a new device is made,
    /// never a guessed one).
    pub fn load(store: &dyn KeyStore) -> Option<Own> {
        let raw: Value = serde_json::from_str(&store.load()?).ok()?;
        let keys = DeviceKeys::from_bytes(&STANDARD.decode(raw["key"].as_str()?).ok()?)?;
        Some(Own { keys, name: clean_name(raw["name"].as_str()?), created: raw["created"].as_f64()?, decided: raw["decided"].as_bool().unwrap_or(false) })
    }

    pub fn save(&self, store: &dyn KeyStore) -> io::Result<()> {
        let value = json!({ "v": 1, "key": STANDARD.encode(self.keys.secret_bytes()), "name": self.name, "created": self.created as i64, "decided": self.decided });
        store.save(&value.to_string())
    }
}
