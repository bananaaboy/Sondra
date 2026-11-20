use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use sondra_tray::{Handler, Tray};

struct Count(AtomicUsize);
impl Handler for Count {
    fn open(&self, _: bool) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn quit(&self) {}
}

#[cfg(not(windows))]
#[test]
fn where_there_is_no_tray_it_says_so() {
    assert!(Tray::start("Sondra", Arc::new(Count(AtomicUsize::new(0)))).is_none());
}

/// A tray icon is put in place, told something, and taken away again without a hang. A runner with no shell may
/// refuse the icon; then there is nothing to check, and that is no failure of the code.
#[cfg(windows)]
#[test]
fn the_icon_comes_and_goes_and_a_notification_can_be_posted() {
    let clicks = Arc::new(Count(AtomicUsize::new(0)));
    let Some(tray) = Tray::start("Sondra", clicks.clone()) else {
        eprintln!("no notification area here; nothing to check");
        return;
    };
    tray.notify("Neue Folge: Frieren", "Staffel 1, Folge 13 ist auf AniWorld erschienen.");
    std::thread::sleep(std::time::Duration::from_millis(300));
    let started = std::time::Instant::now();
    drop(tray);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "removing the icon hung");
    assert_eq!(clicks.0.load(Ordering::SeqCst), 0, "nobody clicked");
}
