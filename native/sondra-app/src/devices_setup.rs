//! What the Geräte page needs in the real program: the Google sign-in (the one the background service
//! uses, a client set up at build time — nothing of it in the source), this device's key at rest, and the
//! engine made from them. Where no Google client was set up, the page says so and nothing is offered.

use std::sync::Arc;

use sondra_devices::engine::{now_ms, Engine, OnOwnChange, Timing};
use sondra_devices::own::Own;
use sondra_devices::registry::Hardware;
use sondra_devices::rtc::{Config, IceServer};
use sondra_drive::keystore::{FileKeyStore, KeyStore};
use sondra_drive::{Account, ClientCredentials, DriveClient, Endpoints};

use crate::devices_page::Setup;
use crate::store::data_dir;

const CLIENT_ID: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("SONDRA_GOOGLE_CLIENT_SECRET");

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(windows))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// The name a device of this kind is given before the person chooses one.
fn default_name() -> &'static str {
    "PC"
}

/// The ICE servers the person put in, if any: none are built in, so a stranger's server never sees an
/// address. (The page for them is still to come; the file is read as the web app's settings are.)
fn servers() -> Vec<IceServer> {
    Vec::new()
}

/// A setup on this computer, or `None` where there is no folder to keep anything in.
pub fn production() -> Option<Setup> {
    let dir = data_dir()?;
    let client = match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() && !secret.is_empty() => Some(ClientCredentials { id: id.to_owned(), secret: secret.to_owned() }),
        _ => None,
    };
    let configured = client.is_some();
    let account = Arc::new(Account::new(client, Endpoints::default(), Box::new(FileKeyStore::new(dir.join("google-schluessel.bin")))));
    let identity = Arc::new(FileKeyStore::new(dir.join("geraet-schluessel.bin")));
    let (a1, a2, a3) = (account.clone(), account.clone(), account);
    let (i1, i2) = (identity.clone(), identity);
    Some(Setup {
        configured,
        signed_in: Arc::new(move || a1.connected()),
        sign_in: Arc::new(move || a2.connect(open_in_browser).map_err(|e| e.to_string())),
        start: Arc::new(move || {
            let own = Own::load(i1.as_ref()).unwrap_or_else(|| Own::create(default_name(), now_ms()));
            own.save(i1.as_ref()).map_err(|e| format!("Der Schlüssel dieses Geräts liess sich nicht ablegen: {e}"))?;
            let client = DriveClient::new(a3.clone(), Endpoints::default().api);
            let keep: OnOwnChange = {
                let store = i1.clone();
                let (secret, created) = (own.keys.secret_bytes(), own.created);
                Arc::new(move |name: &str, decided: bool| {
                    if let Some(keys) = sondra_devices::DeviceKeys::from_bytes(&secret) {
                        let _ = Own { keys, name: name.to_owned(), created, decided }.save(store.as_ref());
                    }
                })
            };
            Ok(Engine::start(
                client,
                own.keys,
                &own.name,
                own.created,
                Hardware { kind: "windows".into(), platform: "Windows-App".into(), caps: vec!["folder".into(), "text".into()] },
                Config { servers: servers(), loopback: false },
                Timing::default(),
                own.decided,
                Some(keep),
            ))
        }),
        forget: Arc::new(move || i2.clear()),
    })
}
