//! What the system says about this person's wishes.

/// Whether the person turned animations off in the system (Windows: „Animationseffekte“). Then nothing
/// in Sondra moves on its own — a change is a change, without the way there.
pub fn prefers_reduced_motion() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::BOOL;
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
