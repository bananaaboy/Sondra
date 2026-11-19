//! Mirroring an Android phone (`src/lib/phoneMirror.ts` of the web app): the screen on this computer, clicks
//! and keys back to the phone. The idea and the server are scrcpy's (Genymobile, Apache-2.0); this is the
//! client side, spoken in the bytes the web app speaks — checked against the libraries it uses
//! (`npm run native:golden`).
//!
//! Nothing here touches the screen or the cable: the messages, the reports of the virtual keyboard and the
//! reading of the streams are plain functions, so they can be tested without a phone.

pub mod adb;
pub mod control;
pub mod decode;
pub mod fake;
pub mod h264;
pub mod hid;
pub mod key;
pub mod ogg;
pub mod options;
pub mod session;
pub mod stream;

/// What can go wrong between this computer and the phone, in words for the person.
#[derive(Debug, thiserror::Error)]
pub enum MirrorError {
    #[error("{0}")]
    Key(String),
    #[error("{0}")]
    Protocol(String),
    #[error("Die Verbindung zum Handy ist abgerissen.")]
    Disconnected,
    #[error("Das Handy hat diesen Computer nicht zugelassen. Tippen Sie auf dem Handy „Zulassen“ (am besten mit „Immer von diesem Computer zulassen“) und versuchen Sie es noch einmal.")]
    NotAllowed,
    #[error("Das Handy hat „{0}“ nicht geöffnet.")]
    Refused(String),
}

impl MirrorError {
    fn link(error: std::io::Error) -> MirrorError {
        let _ = error;
        MirrorError::Disconnected
    }
}
