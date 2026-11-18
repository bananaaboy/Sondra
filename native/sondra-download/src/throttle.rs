//! One bandwidth limit for the whole download, however many connections share it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::{Cancel, DownloadError};

pub struct Throttle {
    /// Bytes per second; `None` is no limit.
    rate: Option<u64>,
    /// When the next byte may be taken.
    free_at: Mutex<Instant>,
}

impl Throttle {
    pub fn new(kib_per_second: Option<u32>) -> Self {
        Self {
            rate: kib_per_second
                .filter(|k| *k > 0)
                .map(|k| u64::from(k) * 1024),
            free_at: Mutex::new(Instant::now()),
        }
    }

    /// Accounts for `bytes` just received and waits until that many are due, so the average stays at
    /// the limit. Wakes up for a cancel.
    pub fn take(&self, bytes: u64, cancel: &Cancel) -> Result<(), DownloadError> {
        let Some(rate) = self.rate else { return Ok(()) };
        let due = {
            let mut free_at = self.free_at.lock().expect("lock");
            let now = Instant::now();
            // No credit is saved up for a slow moment: the limit is a ceiling, not an average over a day.
            let start = (*free_at).max(now.checked_sub(Duration::from_millis(250)).unwrap_or(now));
            let due = start + Duration::from_secs_f64(bytes as f64 / rate as f64);
            *free_at = due;
            due
        };
        while Instant::now() < due {
            cancel.check()?;
            let left = due.saturating_duration_since(Instant::now());
            std::thread::sleep(left.min(Duration::from_millis(100)));
        }
        Ok(())
    }
}
