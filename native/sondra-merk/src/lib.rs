//! The Merkliste: the entry, how it is read, how far it is seen, and how two copies of it are merged —
//! the web app's rules (`src/lib/merkliste.ts`), checked against its numbers. A list written here is read
//! there and the other way round; neither side ever makes the list worse than it was.

pub mod cover;
pub mod folder;
pub mod importer;
pub mod matching;
pub mod merge;
pub mod model;
pub mod normalize;
pub mod plan;
pub mod progress;
pub mod recap;
pub mod share;
pub mod sqlite;
pub mod stats;
pub mod urlinfo;

pub use model::*;
