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
        if let Ok(handle) = HasWindowHandle::window_handle(window) {
            if let RawWindowHandle::Win32(h) = handle.as_raw() {
                // SAFETY: the handle is of a window that is open for as long as this call runs.
                return unsafe { IsIconic(HWND(h.hwnd.get() as *mut _)) }.as_bool();
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}
