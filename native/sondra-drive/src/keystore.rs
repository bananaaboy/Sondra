//! Where the refresh token rests.
//!
//! On Windows it is encrypted with the account's own key (DPAPI), as the app does
//! with Electron's `safeStorage`: another Windows user, or a copy of the file on
//! another computer, cannot read it. Elsewhere — developing on Linux — it is a file
//! only its owner can read, and `lasting()` says that it is not the same promise.

use std::fs;
use std::io;
use std::path::PathBuf;

pub trait KeyStore: Send + Sync {
    fn load(&self) -> Option<String>;
    fn save(&self, token: &str) -> io::Result<()>;
    fn clear(&self);
    /// Whether the token is kept safely between runs.
    fn lasting(&self) -> bool;
}

/// The refresh token in a file in the service's data folder.
pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl KeyStore for FileKeyStore {
    fn load(&self) -> Option<String> {
        let bytes = fs::read(&self.path).ok()?;
        let plain = unprotect(&bytes)?;
        String::from_utf8(plain).ok().filter(|t| !t.is_empty())
    }

    fn save(&self, token: &str) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&self.path, protect(token.as_bytes())?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    fn clear(&self) {
        let _ = fs::remove_file(&self.path);
    }

    fn lasting(&self) -> bool {
        cfg!(windows)
    }
}

#[cfg(not(windows))]
fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(stored: &[u8]) -> Option<Vec<u8>> {
    Some(stored.to_vec())
}

#[cfg(windows)]
fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` points at `plain`, which outlives the call; `output` is filled by
    // the system and freed below with `LocalFree`, as the documentation asks.
    unsafe {
        CryptProtectData(&input, None, None, None, None, 0, &mut output)
            .map_err(|e| io::Error::other(e.to_string()))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(stored: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: stored.len() as u32,
        pbData: stored.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output).ok()?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Some(bytes)
    }
}

/// A store that keeps nothing: the sign-in lives until the program ends.
#[derive(Default)]
pub struct MemoryKeyStore(std::sync::Mutex<Option<String>>);

impl KeyStore for MemoryKeyStore {
    fn load(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn save(&self, token: &str) -> io::Result<()> {
        *self.0.lock().unwrap() = Some(token.to_owned());
        Ok(())
    }
    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
    fn lasting(&self) -> bool {
        false
    }
}
