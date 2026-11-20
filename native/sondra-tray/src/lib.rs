//! A tray icon with system notifications. On Windows the icon sits in the notification area while the program
//! runs; a notification is a balloon on it (Windows 10 and 11 show it as a toast). A click on the icon or on
//! the notification brings the program forward; a right click opens a small menu: open, quit. Elsewhere
//! nothing happens and `start` says so.

use std::sync::Arc;

/// What the tray asks of the program.
pub trait Handler: Send + Sync + 'static {
    /// The icon was clicked or „Sondra öffnen“ chosen (`false`), or a notification was clicked (`true`).
    fn open(&self, from_notification: bool);
    /// „Beenden“ was chosen.
    fn quit(&self);
}

/// Brings a window forward (restored if it was minimised) by its native handle; any thread may call it. Quiet
/// where there is no such call.
pub fn bring_forward(handle: isize) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};
        let hwnd = HWND(handle as *mut _);
        // SAFETY: the handle is of the program's main window, which lives as long as the program.
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
        }
    }
    #[cfg(not(windows))]
    let _ = handle;
}

pub struct Tray {
    #[cfg(windows)]
    inner: imp::Inner,
}

impl Tray {
    /// Puts the icon in place. `None` where there is no tray (not Windows, or no shell running).
    pub fn start(tooltip: &str, handler: Arc<dyn Handler>) -> Option<Tray> {
        #[cfg(windows)]
        {
            imp::Inner::start(tooltip, handler).map(|inner| Tray { inner })
        }
        #[cfg(not(windows))]
        {
            let _ = (tooltip, handler);
            None
        }
    }

    /// Shows a notification: a title and a line, at most 63 and 255 characters.
    pub fn notify(&self, title: &str, text: &str) {
        #[cfg(windows)]
        self.inner.notify(title, text);
        #[cfg(not(windows))]
        let _ = (title, text);
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{mpsc, Arc, Mutex, OnceLock};
    use std::thread::JoinHandle;

    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{ExtractIconW, Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW};
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, LoadIconW, PostMessageW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, TrackPopupMenu, TranslateMessage, CW_USEDEFAULT, HICON, HWND_MESSAGE, IDI_APPLICATION, MF_STRING, MSG, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WM_APP, WM_CLOSE, WM_DESTROY,
        WM_LBUTTONUP, WM_RBUTTONUP, WNDCLASSW, WS_OVERLAPPED,
    };

    const CALLBACK: u32 = WM_APP + 1;
    const SHOW: u32 = WM_APP + 2;
    /// A click on the notification (`NIN_BALLOONUSERCLICK`).
    const BALLOON_CLICK: u32 = 0x0405;
    const ID_OPEN: usize = 1;
    const ID_QUIT: usize = 2;

    struct Shared {
        handler: Arc<dyn Handler>,
        pending: Mutex<Vec<(String, String)>>,
    }
    use super::Handler;

    /// The window procedure has no closure to carry state; one tray lives in a program.
    static SHARED: OnceLock<Shared> = OnceLock::new();
    static TIP: Mutex<String> = Mutex::new(String::new());

    pub struct Inner {
        hwnd: Arc<AtomicIsize>,
        thread: Option<JoinHandle<()>>,
    }

    fn fill<const N: usize>(into: &mut [u16; N], text: &str) {
        let mut n = 0;
        for unit in text.encode_utf16().take(N - 1) {
            into[n] = unit;
            n += 1;
        }
        into[n] = 0;
    }

    fn data(hwnd: HWND) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW { cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32, hWnd: hwnd, uID: 1, ..Default::default() }
    }

    fn icon() -> HICON {
        // The program's own icon (the first in the .exe); the system's plain one when there is none.
        if let Ok(exe) = std::env::current_exe() {
            let wide: Vec<u16> = exe.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: `wide` is a NUL-terminated string that lives for the call.
            let found = unsafe { ExtractIconW(GetModuleHandleW(PCWSTR::null()).ok().map(Into::into), PCWSTR(wide.as_ptr()), 0) };
            if !found.is_invalid() && found.0 as isize != 1 {
                return found;
            }
        }
        // SAFETY: a stock icon id and no module.
        unsafe { LoadIconW(None, IDI_APPLICATION) }.unwrap_or_default()
    }

    unsafe extern "system" fn proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        match message {
            CALLBACK => {
                let event = (lparam.0 as u32) & 0xFFFF;
                if let Some(shared) = SHARED.get() {
                    match event {
                        WM_LBUTTONUP => shared.handler.open(false),
                        BALLOON_CLICK => shared.handler.open(true),
                        WM_RBUTTONUP => menu(hwnd, shared),
                        _ => {}
                    }
                }
                LRESULT(0)
            }
            SHOW => {
                if let Some(shared) = SHARED.get() {
                    let next = shared.pending.lock().unwrap().pop();
                    if let Some((title, text)) = next {
                        let mut d = data(hwnd);
                        d.uFlags = NIF_INFO;
                        d.dwInfoFlags = NIIF_INFO;
                        fill(&mut d.szInfoTitle, &title);
                        fill(&mut d.szInfo, &text);
                        // SAFETY: `d` is filled in whole.
                        let _ = unsafe { Shell_NotifyIconW(NIM_MODIFY, &d) };
                    }
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                let d = data(hwnd);
                // SAFETY: the same identity the icon was added with.
                let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &d) };
                // SAFETY: ends this thread's message loop.
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            // SAFETY: the defaults of a window nobody sees.
            _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
        }
    }

    fn menu(hwnd: HWND, shared: &Shared) {
        // SAFETY: a popup menu made, shown, and destroyed here; the window is this thread's.
        unsafe {
            let Ok(menu) = CreatePopupMenu() else { return };
            let _ = AppendMenuW(menu, MF_STRING, ID_OPEN, w!("Sondra öffnen"));
            let _ = AppendMenuW(menu, MF_STRING, ID_QUIT, w!("Beenden"));
            let mut at = Default::default();
            let _ = GetCursorPos(&mut at);
            // Without this the menu does not close when the person clicks elsewhere.
            let _ = SetForegroundWindow(hwnd);
            let chosen = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, at.x, at.y, None, hwnd, None);
            let _ = DestroyMenu(menu);
            match chosen.0 as usize {
                ID_OPEN => shared.handler.open(false),
                ID_QUIT => shared.handler.quit(),
                _ => {}
            }
        }
    }

    impl Inner {
        pub fn start(tooltip: &str, handler: Arc<dyn Handler>) -> Option<Inner> {
            if SHARED.set(Shared { handler, pending: Mutex::new(Vec::new()) }).is_err() {
                return None;
            }
            *TIP.lock().unwrap() = tooltip.to_owned();
            let hwnd = Arc::new(AtomicIsize::new(0));
            let (ready_tx, ready_rx) = mpsc::channel::<bool>();
            let seen = hwnd.clone();
            let thread = std::thread::spawn(move || {
                // SAFETY: the window class and the window belong to this thread, which also runs their messages.
                unsafe {
                    let instance = GetModuleHandleW(PCWSTR::null()).ok();
                    let class = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: instance.map(Into::into).unwrap_or_default(), lpszClassName: w!("SondraTray"), ..Default::default() };
                    RegisterClassW(&class);
                    let window = CreateWindowExW(WINDOW_EX_STYLE(0), w!("SondraTray"), w!("Sondra"), WS_OVERLAPPED, CW_USEDEFAULT, CW_USEDEFAULT, 0, 0, Some(HWND_MESSAGE), None, instance.map(Into::into), None);
                    let Ok(window) = window else {
                        let _ = ready_tx.send(false);
                        return;
                    };
                    let mut d = data(window);
                    d.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
                    d.uCallbackMessage = CALLBACK;
                    d.hIcon = icon();
                    fill(&mut d.szTip, &TIP.lock().unwrap());
                    if !Shell_NotifyIconW(NIM_ADD, &d).as_bool() {
                        let _ = DestroyWindow(window);
                        let _ = ready_tx.send(false);
                        return;
                    }
                    seen.store(window.0 as isize, Ordering::SeqCst);
                    let _ = ready_tx.send(true);
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
            });
            if ready_rx.recv().ok()? {
                Some(Inner { hwnd, thread: Some(thread) })
            } else {
                let _ = thread.join();
                None
            }
        }

        pub fn notify(&self, title: &str, text: &str) {
            if let Some(shared) = SHARED.get() {
                shared.pending.lock().unwrap().insert(0, (title.chars().take(63).collect(), text.chars().take(255).collect()));
            }
            let hwnd = HWND(self.hwnd.load(Ordering::SeqCst) as *mut _);
            // SAFETY: posting to a window of another thread is what this call is for.
            let _ = unsafe { PostMessageW(Some(hwnd), SHOW, WPARAM(0), LPARAM(0)) };
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            let hwnd = HWND(self.hwnd.load(Ordering::SeqCst) as *mut _);
            // SAFETY: asks the window to close itself on its own thread.
            let _ = unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}
