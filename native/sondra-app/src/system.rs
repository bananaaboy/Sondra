//! What the system says about this person's wishes.

/// Whether the person turned animations off in the system (Windows: „Animationseffekte“). Then nothing
/// in Sondra moves on its own — a change is a change, without the way there.
pub fn prefers_reduced_motion() -> bool {
    #[cfg(windows)]
    {
        use windows::core::BOOL;
        use windows::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        };
        let mut on = BOOL(1);
        // SAFETY: the pointer is to a live BOOL, which is what this action writes.
        let asked = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                Some(&mut on as *mut BOOL as *mut _),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            )
        };
        asked.is_ok() && !on.as_bool()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Whether the window is minimised. GPUI 0.2 does not say; Windows does, by the window handle.
pub fn is_minimized(window: &gpui::Window) -> bool {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::IsIconic;
        // A window of GPUI's test platform is no real window and answers with a panic; it is not minimised.
        let handle = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| HasWindowHandle::window_handle(window).ok().map(|h| h.as_raw())));
        if let Ok(Some(RawWindowHandle::Win32(h))) = handle {
            // SAFETY: the handle is of a window that is open for as long as this call runs.
            return unsafe { IsIconic(HWND(h.hwnd.get() as *mut _)) }.as_bool();
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// The taskbar button flashes until the window is brought forward: something waits for the person (a new episode, a
/// device that offers files) and the window is behind others or minimised. Quiet where the platform has no such call.
pub fn flash_taskbar(window: &gpui::Window) {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO, FLASHW_TIMERNOFG, FLASHW_TRAY};
        let handle = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| HasWindowHandle::window_handle(window).ok().map(|h| h.as_raw())));
        if let Ok(Some(RawWindowHandle::Win32(h))) = handle {
            let info = FLASHWINFO { cbSize: std::mem::size_of::<FLASHWINFO>() as u32, hwnd: HWND(h.hwnd.get() as *mut _), dwFlags: FLASHW_TRAY | FLASHW_TIMERNOFG, uCount: 0, dwTimeout: 0 };
            // SAFETY: `info` is filled in whole and the handle is of a window that is open for as long as this call runs.
            let _ = unsafe { FlashWindowEx(&info) };
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
    }
}

/// Keeps the screen and the system awake while a download runs (`true`), and lets them sleep again
/// (`false`). Windows keeps this per thread, so it must be called from the same thread every time — the
/// window's.
pub fn keep_awake(on: bool) {
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
        // SAFETY: the call only sets flags for the calling thread.
        unsafe {
            if on {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
            } else {
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = on;
    }
}

/// The soft chime of a finished download, on the sound card; nothing where there is none. The sound card
/// is opened on a thread of its own and let go once the sound has been heard.
pub fn play_chime() {
    use std::sync::atomic::AtomicBool;

    use sondra_audio::{chime::chime_samples, Output};
    std::thread::spawn(|| {
        let out = Output::open(2.0);
        let shared = out.shared();
        let (rate, channels) = (shared.rate(), shared.channels());
        let mut interleaved = Vec::new();
        for v in chime_samples(rate) {
            for _ in 0..channels {
                interleaved.push(v);
            }
        }
        shared.push(&interleaved, &AtomicBool::new(false));
        std::thread::sleep(std::time::Duration::from_millis(900));
        drop(out);
    });
}

/// The titles of the windows that can be recorded: visible, not minimised, with a name. (Windows only.)
pub fn visible_windows() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible};

        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            // SAFETY: `lparam` is the address of the vector `visible_windows` keeps for the length of the call.
            let titles = unsafe { &mut *(lparam.0 as *mut Vec<String>) };
            if unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool() {
                let len = unsafe { GetWindowTextLengthW(hwnd) };
                if len > 0 {
                    let mut buffer = vec![0u16; len as usize + 1];
                    let got = unsafe { GetWindowTextW(hwnd, &mut buffer) };
                    if got > 0 {
                        let title = String::from_utf16_lossy(&buffer[..got as usize]);
                        if title != "Program Manager" && !titles.contains(&title) {
                            titles.push(title);
                        }
                    }
                }
            }
            BOOL(1)
        }

        let mut titles: Vec<String> = Vec::new();
        // SAFETY: the callback only reads window titles and writes into `titles`, which outlives the call.
        let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut titles as *mut Vec<String> as isize)) };
        titles
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}
