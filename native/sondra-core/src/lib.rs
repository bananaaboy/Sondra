//! Sondra's native core.
//!
//! No window and no network in here: only what has to be decided, so that it
//! can be tested on any machine. The background service and, later, the app
//! itself are built on top of it.
//!
//! The Merkliste is shared with the website and the apps through one file in
//! Google Drive. This core only ever *reads* it. What it has fetched and
//! deleted lives in its own state ([`state::State`]); writing the list back
//! is left to the apps until the two sides agree on a merge.

pub mod cleanup;
pub mod config;
pub mod merkliste;
pub mod plan;
pub mod schedule;
pub mod state;
