//! Finding the stream behind a link. A port of `api/extractors.js`, held to the same
//! pages: the tests here are the cases of `scripts/verify-extractors.mjs`.
//!
//! Everything that touches the network goes through [`fetch::Fetch`], so that the
//! extractors are played through against stand-in pages, the way the JavaScript ones are.

pub mod aniworld;
pub mod episode;
pub mod fetch;
pub mod hosters;
pub mod packer;
pub mod stream;
pub mod text;
pub mod voe;
