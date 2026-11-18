//! The one way an extractor touches the network.

use std::time::Duration;

use ureq::ResponseExt;

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// `false`: a redirect is returned as it is, with its `Location`.
    pub follow_redirects: bool,
    pub body: Option<Vec<u8>>,
    pub post: bool,
}

#[derive(Debug, Clone)]
pub struct Page {
    pub status: u16,
    /// The address the answer came from, after redirects.
    pub url: String,
    pub location: Option<String>,
    pub content_type: Option<String>,
    pub body: String,
}

impl Page {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("{0}")]
    Failed(String),
}

pub trait Fetch {
    fn fetch(&self, request: &Request) -> Result<Page, FetchError>;
}

/// A GET for a page, with the headers a browser sends.
pub fn html_request(url: &str, referer: Option<&str>) -> Request {
    let mut headers = vec![
        ("User-Agent".to_owned(), DEFAULT_USER_AGENT.to_owned()),
        (
            "Accept".to_owned(),
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8".to_owned(),
        ),
        (
            "Accept-Language".to_owned(),
            "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7".to_owned(),
        ),
    ];
    if let Some(referer) = referer {
        headers.push(("Referer".to_owned(), referer.to_owned()));
    }
    Request {
        url: url.to_owned(),
        headers,
        follow_redirects: true,
        ..Request::default()
    }
}

/// The real network: certificates always checked, redirects followed up to ten.
pub struct UreqFetch {
    following: ureq::Agent,
    manual: ureq::Agent,
}

impl Default for UreqFetch {
    fn default() -> Self {
        let base = |redirects: u32| {
            ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(25)))
                .http_status_as_error(false)
                .max_redirects(redirects)
                .max_redirects_will_error(false)
                .build()
                .into()
        };
        Self {
            following: base(10),
            manual: base(0),
        }
    }
}

impl Fetch for UreqFetch {
    fn fetch(&self, request: &Request) -> Result<Page, FetchError> {
        let agent = if request.follow_redirects {
            &self.following
        } else {
            &self.manual
        };
        let result = if request.post {
            let mut builder = agent.post(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            match &request.body {
                Some(body) => builder.send(body.as_slice()),
                None => builder.send_empty(),
            }
        } else {
            let mut builder = agent.get(&request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder.call()
        };
        let mut response = result.map_err(|e| FetchError::Failed(e.to_string()))?;
        let status = response.status().as_u16();
        let header = |name: &str| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let location = header("location");
        let content_type = header("content-type");
        let url = response.get_uri().to_string();
        let body = response.body_mut().read_to_string().unwrap_or_default();
        Ok(Page {
            status,
            url,
            location,
            content_type,
            body,
        })
    }
}
