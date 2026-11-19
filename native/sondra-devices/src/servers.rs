//! The server a person puts in for devices in different networks (`deviceServers.ts`). Between two networks
//! the devices find each other only with the help of a server that tells each its address (STUN) or, where
//! even that is not enough, carries the traffic (TURN). Sondra ships none — a stranger's server would see every
//! connection of everyone — so there is a field, empty, for one the person trusts or runs. The addresses are
//! kept on this device; a TURN password is not: it stays in memory until the program closes.

use crate::rtc::IceServer;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerSettings {
    /// `stun:host:3478` — an address, nothing secret.
    pub stun: String,
    /// `turn:host:3478` or `turns:…`.
    pub turn: String,
    pub user: String,
    /// In memory only.
    pub password: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Stun,
    Turn,
}

/// What is wrong with an address, in words; `None` when it is fine (or empty).
pub fn server_problem(address: &str, kind: Kind) -> Option<&'static str> {
    let text = address.trim();
    if text.is_empty() {
        return None;
    }
    if text.encode_utf16().count() > 200 {
        return Some("Die Adresse ist zu lang.");
    }
    let lower = text.to_lowercase();
    let schemes: &[&str] = match kind {
        Kind::Stun => &["stun:", "stuns:"],
        Kind::Turn => &["turn:", "turns:"],
    };
    let Some(scheme) = schemes.iter().find(|s| lower.starts_with(**s)) else {
        return Some(match kind {
            Kind::Stun => "Sie beginnt mit „stun:“, etwa stun:beispiel.de:3478.",
            Kind::Turn => "Sie beginnt mit „turn:“ oder „turns:“, etwa turn:beispiel.de:3478.",
        });
    };
    let rest = text[scheme.len()..].split('?').next().unwrap_or("");
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '[' | ']' | ':' | '-');
    if rest.is_empty() || !rest.chars().all(allowed) || rest.starts_with(':') {
        return Some("Nach dem Anfang folgt der Rechnername, wenn nötig mit :Port.");
    }
    None
}

/// The servers a connection is made with: nothing, until someone put something in.
pub fn ice_servers_for(settings: &ServerSettings) -> Vec<IceServer> {
    let mut servers = Vec::new();
    let stun = settings.stun.trim();
    if !stun.is_empty() && server_problem(stun, Kind::Stun).is_none() {
        servers.push(IceServer { urls: stun.to_owned(), username: None, credential: None });
    }
    let turn = settings.turn.trim();
    if !turn.is_empty() && server_problem(turn, Kind::Turn).is_none() {
        let login = !settings.user.is_empty();
        servers.push(IceServer { urls: turn.to_owned(), username: login.then(|| settings.user.clone()), credential: login.then(|| settings.password.clone()) });
    }
    servers
}
