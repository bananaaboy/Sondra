//! The background service.
//!
//! [`round::run_round`] is the whole of what it does, once: look for new
//! episodes, tidy up, fetch. Everything that touches the outside — Drive, the
//! sites, the Recycle Bin, the clock — comes in through the traits in
//! [`ports`], so that a round can be played through here with fakes. The real
//! ones (Google Drive, the extractors, Windows) are built on the other side of
//! these traits.

pub mod ports;
pub mod round;
