use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use sondra_core::merkliste::{Item, Online};
use sondra_core::plan::Want;
use sondra_daemon::ports::{Checker, FetchedFile, Fetcher};
use sondra_download::{safe_stem, Cancel, Downloader};
use sondra_extract::aniworld::{check_online_updates, is_aniworld_url};
use sondra_extract::episode::extract_episode;
use sondra_extract::fetch::Fetch;
use sondra_extract::stream::StreamInfo;
use url::Url;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The address of one episode (or film) of a series: `…/anime/stream/<slug>/staffel-2/episode-5`.
/// `season` 0 is the films. `None` for a link that is not one of the series sites' own.
/// A port of the AniWorld branch of `buildUrlWithEpisode`.
pub fn episode_url(series_url: &str, season: u32, episode: u32) -> Option<String> {
    if !is_aniworld_url(series_url) {
        return None;
    }
    let mut url = Url::parse(series_url).ok()?;
    let path = url.path().to_owned();
    let start = path
        .find("/anime/stream/")
        .or_else(|| path.find("/serie/stream/"))?
        + 1;
    let rest = &path[start..];
    let mut parts = rest.split('/');
    let (kind, stream, slug) = (parts.next()?, parts.next()?, parts.next()?);
    if stream != "stream" || slug.is_empty() {
        return None;
    }
    let base = format!("/{kind}/stream/{slug}");
    url.set_path(&if season == 0 {
        format!("{base}/filme/film-{}", episode.max(1))
    } else {
        format!("{base}/staffel-{season}/episode-{}", episode.max(1))
    });
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

/// `Staffel 2`, or `Filme` for season 0 (as the web app and Drive name them).
pub fn season_folder(season: u32) -> String {
    if season == 0 {
        "Filme".into()
    } else {
        format!("Staffel {season}")
    }
}

/// Looks on the series' own site for the newest episode.
pub struct WebChecker<F: Fetch> {
    pub fetch: F,
}

impl<F: Fetch> Checker for WebChecker<F> {
    fn latest(&self, item: &Item) -> Result<Option<Online>, String> {
        let now = now_ms();
        Ok(
            check_online_updates(&self.fetch, &item.url, false, now).map(|info| Online {
                max_season: info.max_season,
                max_episode: info.max_episode,
                checked_at: now,
            }),
        )
    }
}

/// Fetches one episode into `<folder>/<series>/Staffel n/`.
pub struct WebFetcher<F: Fetch> {
    pub fetch: F,
    pub folder: PathBuf,
    /// The language to prefer, as on the website (`"ger_sub"` …); empty takes the site's order.
    pub language: String,
    /// Where FFmpeg is; `None` looks on the path.
    pub ffmpeg: Option<PathBuf>,
    pub cancel: Cancel,
    /// For tests against a server on this computer; a real fetch never sets it.
    pub allow_private: bool,
}

impl<F: Fetch> WebFetcher<F> {
    pub fn new(fetch: F, folder: PathBuf) -> Self {
        Self {
            fetch,
            folder,
            language: String::new(),
            ffmpeg: None,
            cancel: Cancel::new(),
            allow_private: false,
        }
    }
}

impl<F: Fetch> Fetcher for WebFetcher<F> {
    fn fetch(&self, want: &Want, bandwidth_kib: Option<u32>) -> Result<FetchedFile, String> {
        let url = episode_url(&want.url, want.season, want.episode).ok_or_else(|| {
            "Die Adresse der Serie ist keine, die Sondra selbst laden kann.".to_owned()
        })?;
        let found = extract_episode(&self.fetch, &url, &self.language, now_ms())
            .ok_or_else(|| "Für diese Folge wurde keine abspielbare Quelle gefunden.".to_owned())?;
        let dir = self
            .folder
            .join(safe_stem(&want.title))
            .join(season_folder(want.season));

        // The first source that works; the others are mirrors of it.
        let mut last = String::new();
        for stream in &found.streams {
            let mut downloader = Downloader::new(bandwidth_kib, self.cancel.clone());
            downloader.ffmpeg = self.ffmpeg.clone();
            downloader.allow_private = self.allow_private;
            let info = StreamInfo {
                title: found.title.clone(),
                url: stream.url.clone(),
                is_hls: stream.is_hls,
                referer: stream.referer.clone(),
                hoster: stream.provider.clone(),
            };
            match downloader.download(&info, &dir, &found.title, &mut |_| {}) {
                Ok(file) => return Ok(file),
                Err(sondra_download::DownloadError::Cancelled) => return Err("Abgebrochen.".into()),
                Err(error) => last = format!("{}: {error}", stream.provider),
            }
        }
        Err(last)
    }
}
