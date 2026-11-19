//! What the Geräte page needs in the real program: the Google sign-in (the one the background service
//! uses, a client set up at build time — nothing of it in the source), this device's key at rest, and the
//! engine made from them. Where no Google client was set up, the page says so and nothing is offered.

use std::sync::Arc;

use sondra_devices::engine::{now_ms, Engine, OnOwnChange, Timing};
use sondra_devices::own::Own;
use sondra_devices::registry::Hardware;
use sondra_devices::rtc::Config;
use sondra_devices::servers::{ice_servers_for, ServerSettings};
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

/// The addresses of the server the person put in, kept in the data folder (the web app keeps them in
/// `localStorage`, `sondra:geraete:server`). The password is never written.
fn load_servers() -> ServerSettings {
    let stored = crate::store::FileStore::at_default("Geraete.json").and_then(|s| sondra_merk::folder_memory::Store::get_item(&s, "server")).and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok());
    let text = |key: &str| stored.as_ref().and_then(|v| v[key].as_str()).unwrap_or("").to_owned();
    ServerSettings { stun: text("stun"), turn: text("turn"), user: text("user"), password: String::new() }
}

fn save_servers(settings: &ServerSettings) {
    if let Some(mut store) = crate::store::FileStore::at_default("Geraete.json") {
        let value = if settings.stun.is_empty() && settings.turn.is_empty() && settings.user.is_empty() { String::new() } else { serde_json::json!({ "stun": settings.stun, "turn": settings.turn, "user": settings.user }).to_string() };
        sondra_merk::folder_memory::Store::set_item(&mut store, "server", value);
    }
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
    let servers = Arc::new(std::sync::Mutex::new(load_servers()));
    let live = servers.clone();
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
                Hardware { kind: "windows".into(), platform: "Windows-App".into(), caps: vec!["folder".into(), "text".into(), "play".into()] },
                Config { servers: Vec::new(), live: Some({ let live = live.clone(); Arc::new(move || ice_servers_for(&live.lock().expect("lock"))) }), loopback: false, deaf: false },
                Timing::default(),
                own.decided,
                Some(keep),
            ))
        }),
        forget: Arc::new(move || i2.clear()),
        servers,
        keep_servers: Arc::new(save_servers),
    })
}
