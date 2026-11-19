//! „In Discord zeigen“: what is being watched, as Discord's status — off until the person turns it on (kept on
//! this device), and sent once per change. The pipe and the protocol are `sondra-discord`; this decides what
//! the status says (`PlayerPanel.tsx` and `MerklistePanel.tsx` of the web app, word for word).

use serde_json::{json, Value};
use sondra_discord::{connect_local, Presence, DEFAULT_CLIENT_ID};

use crate::nav::Panel;
use crate::shell::Shell;

/// The key the web app's app keeps it under.
const KEY: &str = "sondra:discord-rpc";

#[derive(Default)]
pub struct DiscordState {
    pub on: bool,
    presence: Option<Presence>,
    last: Option<Value>,
    /// The moment the current file began, for the clock in the status.
    started: Option<(String, i64)>,
    /// Whether the saved choice has been read.
    loaded: bool,
}

impl Shell {
    /// The status the page the person is on calls for.
    fn discord_activity(&mut self) -> Option<Value> {
        let assets = |text: &str| json!({ "large_image": "sondra", "large_text": text });
        if let Some(name) = self.player_playing_name() {
            let now = chrono::Utc::now().timestamp();
            let start = match &self.discord.started {
                Some((n, t)) if *n == name => *t,
                _ => {
                    self.discord.started = Some((name.clone(), now));
                    now
                }
            };
            return Some(json!({ "details": "Wiedergabe", "state": name, "assets": assets("Sondra Player"), "timestamps": { "start": start } }));
        }
        self.discord.started = None;
        if self.panel() != Panel::Merkliste {
            return None;
        }
        let m = &self.merk;
        if let Some(item) = m.open.as_ref().and_then(|id| m.items.iter().find(|i| &i.id == id)) {
            let state = if item.season == 0 { format!("Film {}", item.episode.unwrap_or(1)) } else { format!("Staffel {} · Folge {}", item.season, item.episode.unwrap_or(1)) };
            return Some(json!({ "details": format!("Merkliste: {}", item.title), "state": state, "assets": assets(&item.title) }));
        }
        let watching = m.items.iter().filter(|i| i.status == sondra_merk::Status::Watching).count();
        let n = m.items.len();
        Some(json!({ "details": "Merkliste", "state": format!("{n} {} ({watching} aktiv)", if n == 1 { "Serie" } else { "Serien" }), "assets": assets("Sondra Studio") }))
    }

    /// Looks at what is on and tells Discord when it changed. Called with every draw; costs nothing when
    /// nothing changed or the person has not turned it on.
    pub(crate) fn update_discord(&mut self) {
        if !self.discord.loaded {
            self.discord.loaded = true;
            self.discord.on = self.player_setting(KEY).as_deref() == Some("true");
            if self.discord.on {
                self.discord_presence().set_enabled(true);
            }
        }
        if !self.discord.on {
            return;
        }
        let activity = self.discord_activity();
        if activity != self.discord.last {
            self.discord.last = activity.clone();
            self.discord_presence().set_activity(activity);
        }
    }

    fn discord_presence(&mut self) -> &Presence {
        self.discord.presence.get_or_insert_with(|| Presence::start(Box::new(connect_local), DEFAULT_CLIENT_ID, std::time::Duration::from_secs(30)))
    }

    /// Turns the status on or off (and remembers the choice).
    pub fn set_discord(&mut self, on: bool) {
        self.discord.on = on;
        self.discord.last = None;
        self.player_set_setting(KEY, if on { "true" } else { "false" });
        let presence = self.discord_presence();
        presence.set_enabled(on);
        if !on {
            self.discord.last = None;
        }
    }
}
