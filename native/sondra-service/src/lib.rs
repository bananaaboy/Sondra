//! What the service's round needs from the web: looking for new episodes, and fetching one.
//!
//! [`WebChecker`] and [`WebFetcher`] plug the extractors (`sondra-extract`) and the downloader
//! (`sondra-download`) into the ports of `sondra-daemon`.

mod web;

pub use web::{episode_url, season_folder, WebChecker, WebFetcher};
