//! Mirroring an Android phone (`src/lib/phoneMirror.ts` of the web app): the screen on this computer, clicks
//! and keys back to the phone. The idea and the server are scrcpy's (Genymobile, Apache-2.0); this is the
//! client side, spoken in the bytes the web app speaks — checked against the libraries it uses
//! (`npm run native:golden`).
//!
//! Nothing here touches the screen or the cable: the messages, the reports of the virtual keyboard and the
//! reading of the streams are plain functions, so they can be tested without a phone.

pub mod control;
pub mod hid;
pub mod options;
pub mod stream;
