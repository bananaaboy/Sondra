//! Whether fetching is allowed right now.

use crate::config::{Config, KeepAwake};

/// What the computer reports at this moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conditions {
    /// Local hour, 0–23.
    pub hour: u8,
    pub on_ac: bool,
    pub metered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wait {
    OutsideWindow,
    OnBattery,
    MeteredConnection,
}

/// `Ok` when fetching may go on, otherwise why it has to wait.
pub fn allowed(config: &Config, now: Conditions) -> Result<(), Wait> {
    if let Some(window) = config.window {
        let inside = if window.from <= window.to {
            (window.from..window.to).contains(&now.hour)
        } else {
            now.hour >= window.from || now.hour < window.to
        };
        if window.from != window.to && !inside {
            return Err(Wait::OutsideWindow);
        }
    }
    if config.only_on_ac && !now.on_ac {
        return Err(Wait::OnBattery);
    }
    if config.only_unmetered && now.metered {
        return Err(Wait::MeteredConnection);
    }
    Ok(())
}

/// Whether the computer should be kept from sleeping right now. `busy` is
/// true while something is being fetched or about to be. Closing the lid is
/// not this service's to override: that stays Windows' setting.
pub fn keep_awake(config: &Config, busy: bool) -> bool {
    match config.keep_awake {
        KeepAwake::Off => false,
        KeepAwake::WhileFetching => busy,
        KeepAwake::Always => true,
    }
}
