//! The network under a download: certificates always checked, redirects followed by hand.

use std::io::Read;
use std::time::Duration;

use sondra_extract::fetch::DEFAULT_USER_AGENT;
use sondra_extract::hls::is_private_host;
use url::Url;

use crate::DownloadError;

pub(crate) fn agent(stall: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        // Followed by hand, so that every hop is looked at.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        // A stalled connection ends; time spent waiting for the bandwidth limit does not count.
        .timeout_per_read(Some(stall))
        .build()
        .into()
}

pub(crate) struct Opened {
    pub status: u16,
    /// Where the answer came from, after redirects.
    pub url: String,
    pub body: Box<dyn Read + Send>,
    content_range_total: Option<u64>,
    content_length: Option<u64>,
}

impl Opened {
    /// The size of the whole file, when the answer says.
    pub(crate) fn total_for(&self, written: u64) -> Option<u64> {
        self.content_range_total.or(self
            .content_length
            .map(|l| l + if self.status == 206 { written } else { 0 }))
    }
}

pub(crate) fn open(
    agent: &ureq::Agent,
    url: &str,
    referer: Option<&str>,
    range: Option<&str>,
    allow_private: bool,
) -> Result<Opened, DownloadError> {
    let mut current = Url::parse(url).map_err(|e| DownloadError::Network(e.to_string()))?;
    for _ in 0..8 {
        if !matches!(current.scheme(), "http" | "https")
            || (!allow_private && is_private_host(&current))
        {
            return Err(DownloadError::PrivateAddress);
        }
        let mut request = agent
            .get(current.as_str())
            .header("User-Agent", DEFAULT_USER_AGENT)
            .header("Accept", "*/*");
        if let Some(referer) = referer {
            request = request.header("Referer", referer);
        }
        if let Some(range) = range {
            request = request.header("Range", range);
        }
        let response = request
            .call()
            .map_err(|e| DownloadError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let Some(location) = location else {
                return Err(DownloadError::Status(status));
            };
            current = current
                .join(&location)
                .map_err(|e| DownloadError::Network(e.to_string()))?;
            continue;
        }
        match status {
            200 | 206 => {}
            403 => return Err(DownloadError::Expired),
            _ => return Err(DownloadError::Status(status)),
        }
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let content_range_total = header("content-range")
            .and_then(|v| v.rsplit('/').next().map(str::to_owned))
            .and_then(|t| t.parse().ok());
        let content_length = header("content-length").and_then(|v| v.parse().ok());
        let body = response.into_body().into_reader();
        return Ok(Opened {
            status,
            url: current.to_string(),
            body: Box::new(body),
            content_range_total,
            content_length,
        });
    }
    Err(DownloadError::Network("zu viele Weiterleitungen".into()))
}
