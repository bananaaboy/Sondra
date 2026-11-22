//! Sound out of the computer. A player needs three things of it: somewhere to put decoded samples, a
//! volume and a pause, and — the one that matters — the clock of what has actually been heard, because a
//! film is held to its sound, not the other way round (the picture waits for the sound, never the sound
//! for the picture; the ear forgives a dropped frame and nothing else).
//!
//! The part that decides what goes to the speakers is [`Mixer`], pure and tested without a sound card.
//! [`AudioOut`] puts it on the default output device; where there is none (a machine without a sound
//! card, a build server) opening fails with [`AudioError::NoDevice`] and the player keeps time with a
//! clock of its own instead.

mod input;
mod mixer;
mod output;

pub mod chime;
pub use input::{input_devices, open_input, open_loopback, Capture, Mic};
pub use mixer::{Mixer, Shared};
pub use output::{chosen_output_device, output_devices, set_output_device, AudioError, AudioOut, Output, SilentOut};
