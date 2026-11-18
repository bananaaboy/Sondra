//! The computer under the service: the Recycle Bin, the clock and the power cord, a metered
//! connection, keeping the machine awake, starting with Windows.
//!
//! Windows is what these are for; elsewhere they stand in just well enough for the service to run
//! and be tested during development (UTC for the hour, always on mains power, never metered, no
//! autostart).

use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sondra_core::schedule::Conditions;
use sondra_daemon::ports::{Host, Trash};

/// Files go to the Recycle Bin, never straight away.
pub struct SystemTrash;

impl Trash for SystemTrash {
    fn trash(&self, path: &Path) -> io::Result<()> {
        trash::delete(path).map_err(|e| io::Error::other(e.to_string()))
    }
}

/// The clock and what the computer is plugged into.
pub struct SystemHost;

impl Host for SystemHost {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    }

    fn conditions(&self) -> Conditions {
        Conditions {
            hour: imp::local_hour(),
            on_ac: imp::on_ac(),
            metered: imp::metered(),
        }
    }
}

/// Keeps the computer from going to sleep for as long as it is held. The lid is Windows' to decide.
/// Held and dropped on the same thread (that is how Windows counts it).
pub struct AwakeGuard {
    _private: (),
}

impl AwakeGuard {
    pub fn new() -> Self {
        imp::keep_awake(true);
        Self { _private: () }
    }
}

impl Default for AwakeGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for AwakeGuard {
    fn drop(&mut self) {
        imp::keep_awake(false);
    }
}

/// Starting with Windows: one value under the current user's `Run` key, nothing for other users.
pub mod autostart {
    use std::io;

    /// The key's value is the command line to run at sign-in.
    pub fn enable(name: &str, command: &str) -> io::Result<()> {
        super::imp::autostart_set(name, Some(command))
    }

    pub fn disable(name: &str) -> io::Result<()> {
        super::imp::autostart_set(name, None)
    }

    pub fn is_enabled(name: &str) -> bool {
        super::imp::autostart_get(name).is_some()
    }

    /// What `enable` stored, if anything.
    pub fn command(name: &str) -> Option<String> {
        super::imp::autostart_get(name)
    }
}

#[cfg(windows)]
mod imp {
    use std::io;

    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Networking::Connectivity::{NetworkCostType, NetworkInformation};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Com::CoIncrementMTAUsage;
    use windows::Win32::System::Power::{
        GetSystemPowerStatus, SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
        SYSTEM_POWER_STATUS,
    };
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };
    use windows::Win32::System::SystemInformation::GetLocalTime;

    pub(super) fn local_hour() -> u8 {
        // SAFETY: a plain query of the clock.
        unsafe { GetLocalTime() }.wHour as u8
    }

    pub(super) fn on_ac() -> bool {
        let mut status = SYSTEM_POWER_STATUS::default();
        // SAFETY: `status` is a valid out-parameter.
        if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
            return true;
        }
        // 1 = mains, 0 = battery, 255 = unknown. A computer that does not say is not held back.
        status.ACLineStatus != 0
    }

    pub(super) fn metered() -> bool {
        // WinRT wants an apartment; this one lasts for the whole process and covers every thread.
        // SAFETY: no arguments; the cookie is deliberately never given back.
        let _ = unsafe { CoIncrementMTAUsage() };
        let cost = NetworkInformation::GetInternetConnectionProfile()
            .and_then(|profile| profile.GetConnectionCost());
        match cost.and_then(|c| c.NetworkCostType()) {
            Ok(kind) => kind == NetworkCostType::Fixed || kind == NetworkCostType::Variable,
            // No profile (offline) or no answer: not "metered"; being offline is the fetcher's problem.
            Err(_) => false,
        }
    }

    pub(super) fn keep_awake(on: bool) {
        let flags = if on {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // SAFETY: a plain call; the state belongs to this thread.
        unsafe { SetThreadExecutionState(flags) };
    }

    const RUN: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\Run");

    pub(super) fn autostart_set(name: &str, command: Option<&str>) -> io::Result<()> {
        let name = HSTRING::from(name);
        match command {
            Some(command) => {
                let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
                // SAFETY: `wide` outlives the call; the byte length includes the terminator.
                let error = unsafe {
                    RegSetKeyValueW(
                        HKEY_CURRENT_USER,
                        RUN,
                        &name,
                        REG_SZ.0,
                        Some(wide.as_ptr().cast()),
                        (wide.len() * 2) as u32,
                    )
                };
                if error == ERROR_SUCCESS {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(error.0 as i32))
                }
            }
            None => {
                // SAFETY: plain strings.
                let error = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN, &name) };
                if error == ERROR_SUCCESS || error == ERROR_FILE_NOT_FOUND {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(error.0 as i32))
                }
            }
        }
    }

    pub(super) fn autostart_get(name: &str) -> Option<String> {
        let name = HSTRING::from(name);
        let mut size = 0u32;
        // SAFETY: first asks how large the value is.
        let error = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                RUN,
                &name,
                RRF_RT_REG_SZ,
                None,
                None,
                Some(&mut size),
            )
        };
        if error != ERROR_SUCCESS || size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        // SAFETY: `buffer` holds `size` bytes.
        let error = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                RUN,
                &name,
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if error != ERROR_SUCCESS {
            return None;
        }
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }
}

#[cfg(not(windows))]
mod imp {
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};

    pub(super) fn local_hour() -> u8 {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        ((seconds / 3600) % 24) as u8
    }
    pub(super) fn on_ac() -> bool {
        true
    }
    pub(super) fn metered() -> bool {
        false
    }
    pub(super) fn keep_awake(_on: bool) {}
    pub(super) fn autostart_set(_name: &str, _command: Option<&str>) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Autostart gibt es nur unter Windows",
        ))
    }
    pub(super) fn autostart_get(_name: &str) -> Option<String> {
        None
    }
}
