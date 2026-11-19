//! A read-only Drive client. See `src/lib/driveClient.ts`.

use std::time::Duration;

use serde_json::Value;
use url::Url;

use crate::auth::{agent, Account};
use crate::DriveError;

pub(crate) const FOLDER_TYPE: &str = "application/vnd.google-apps.folder";
pub(crate) const FILE_FIELDS: &str = "id,name,size,modifiedTime,mimeType";
/// Nothing the service reads is bigger; a bigger answer is something else.
const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;

/// Where access tokens come from. `refused`: Drive turned the last one away.
pub trait TokenSource {
    fn token(&self, refused: bool) -> Result<String, DriveError>;
}

impl TokenSource for Account {
    fn token(&self, refused: bool) -> Result<String, DriveError> {
        self.access_token(refused)
    }
}

impl<T: TokenSource + ?Sized> TokenSource for std::sync::Arc<T> {
    fn token(&self, refused: bool) -> Result<String, DriveError> {
        (**self).token(refused)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub size: Option<u64>,
    pub modified_time: Option<String>,
    pub mime_type: Option<String>,
}

pub(crate) fn as_file(raw: &Value) -> DriveFile {
    DriveFile {
        id: raw["id"].as_str().unwrap_or_default().to_owned(),
        name: raw["name"].as_str().unwrap_or_default().to_owned(),
        size: raw["size"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| raw["size"].as_u64()),
        modified_time: raw["modifiedTime"].as_str().map(str::to_owned),
        mime_type: raw["mimeType"].as_str().map(str::to_owned),
    }
}

/// A string in a Drive query, quoted.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// What a request that must not be judged says: the status as it is (308 is a good answer to a piece of an upload), the
/// two headers an upload reads, and the text.
#[derive(Debug, Clone)]
pub(crate) struct Raw {
    pub status: u16,
    pub location: Option<String>,
    pub range: Option<String>,
    pub text: String,
}

/// An agent for the pieces of an upload: a piece may take minutes on a slow line, and a 308 is no redirect.
fn upload_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10 * 60)))
        .http_status_as_error(false)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .build()
        .into()
}

pub struct DriveClient<T: TokenSource> {
    tokens: T,
    http: ureq::Agent,
    pieces: ureq::Agent,
    api: String,
    backoff: Duration,
}

impl<T: TokenSource> DriveClient<T> {
    pub fn new(tokens: T, api: impl Into<String>) -> Self {
        Self {
            tokens,
            http: agent(),
            pieces: upload_agent(),
            api: api.into(),
            backoff: Duration::from_millis(500),
        }
    }

    #[doc(hidden)]
    pub fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    /// One GET with the token. A refused token is renewed once; a busy Drive is asked
    /// again, a little later each time, up to four times.
    fn get(&self, url: &str) -> Result<ureq::http::Response<ureq::Body>, DriveError> {
        self.send("GET", url, None, None)
    }

    /// One request with the token, the same patience as `get`. `body` carries its content type.
    pub(crate) fn send(
        &self,
        method: &str,
        url: &str,
        content_type: Option<&str>,
        body: Option<&[u8]>,
    ) -> Result<ureq::http::Response<ureq::Body>, DriveError> {
        let mut refused = false;
        let mut attempt: u32 = 0;
        loop {
            let token = self.tokens.token(refused)?;
            let mut request = ureq::http::Request::builder()
                .method(method)
                .uri(url)
                .header("Authorization", format!("Bearer {token}"));
            if let Some(kind) = content_type {
                request = request.header("Content-Type", kind);
            }
            let request = request
                .body(body.unwrap_or_default().to_vec())
                .map_err(|e| DriveError::Failed(e.to_string()))?;
            let mut response = self
                .http
                .run(request)
                .map_err(|e| DriveError::Offline(e.to_string()))?;
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                return Ok(response);
            }
            let text = response.body_mut().read_to_string().unwrap_or_default();
            match status {
                401 if !refused => refused = true,
                401 => return Err(DriveError::Unauthorized),
                404 => return Err(DriveError::Missing(url.to_owned())),
                429 | 500..=599 if attempt < 4 => {
                    std::thread::sleep(self.backoff * 2u32.pow(attempt));
                    attempt += 1;
                }
                403 if attempt < 4
                    && (text.contains("rateLimitExceeded")
                        || text.contains("userRateLimitExceeded")) =>
                {
                    std::thread::sleep(self.backoff * 2u32.pow(attempt));
                    attempt += 1;
                }
                _ => {
                    return Err(DriveError::Failed(format!(
                        "{status} {}",
                        text.chars().take(160).collect::<String>()
                    )))
                }
            }
        }
    }

    /// One request with the token whose answer is not judged: a refused token is renewed once, everything else is
    /// handed back with its status. `Err` only when the line itself fails.
    pub(crate) fn raw(&self, method: &str, url: &str, headers: &[(&str, String)], body: &[u8]) -> Result<Raw, DriveError> {
        let mut refused = false;
        loop {
            let token = self.tokens.token(refused)?;
            let mut request = ureq::http::Request::builder().method(method).uri(url).header("Authorization", format!("Bearer {token}"));
            for (name, value) in headers {
                request = request.header(*name, value);
            }
            let request = request.body(body.to_vec()).map_err(|e| DriveError::Failed(e.to_string()))?;
            let mut response = self.pieces.run(request).map_err(|e| DriveError::Offline(e.to_string()))?;
            let status = response.status().as_u16();
            if status == 401 && !refused {
                refused = true;
                continue;
            }
            let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
            let (location, range) = (header("location"), header("range"));
            let text = response.body_mut().read_to_string().unwrap_or_default();
            return Ok(Raw { status, location, range, text });
        }
    }

    /// How long to wait before asking again after a hiccup.
    pub(crate) fn pause(&self) -> Duration {
        self.backoff
    }

    pub(crate) fn api(&self) -> &str {
        &self.api
    }

    fn files(
        &self,
        query: &str,
        fields: &str,
        order: Option<&str>,
    ) -> Result<Vec<Value>, DriveError> {
        let mut params = vec![
            ("q", query),
            ("fields", fields),
            ("spaces", "drive"),
            ("pageSize", "10"),
        ];
        if let Some(order) = order {
            params.push(("orderBy", order));
        }
        let url = Url::parse_with_params(&format!("{}/files", self.api), params)
            .map_err(|e| DriveError::Failed(e.to_string()))?;
        let mut response = self.get(url.as_str())?;
        let body: Value = response
            .body_mut()
            .read_json()
            .map_err(|e| DriveError::Failed(e.to_string()))?;
        Ok(body["files"].as_array().cloned().unwrap_or_default())
    }

    /// A folder of this name directly in `parent` (`root` for the top), if there is one.
    pub fn find_folder(&self, parent: &str, name: &str) -> Result<Option<String>, DriveError> {
        let query = format!(
            "name = {} and mimeType = '{FOLDER_TYPE}' and {} in parents and trashed = false",
            quote(name),
            quote(parent)
        );
        let found = self.files(&query, "files(id,name)", None)?;
        Ok(found
            .first()
            .and_then(|f| f["id"].as_str())
            .map(str::to_owned))
    }

    /// The newest file of this name in `parent`, if there is one.
    pub fn find_file(&self, parent: &str, name: &str) -> Result<Option<DriveFile>, DriveError> {
        let query = format!(
            "name = {} and {} in parents and mimeType != '{FOLDER_TYPE}' and trashed = false",
            quote(name),
            quote(parent)
        );
        let found = self.files(
            &query,
            &format!("files({FILE_FIELDS})"),
            Some("modifiedTime desc"),
        )?;
        Ok(found.first().map(as_file))
    }

    /// Follows a path of folder names from the top of Drive, without making any.
    pub fn folder_path(&self, names: &[&str]) -> Result<Option<String>, DriveError> {
        let mut parent = "root".to_owned();
        for name in names {
            match self.find_folder(&parent, name)? {
                Some(id) => parent = id,
                None => return Ok(None),
            }
        }
        Ok(Some(parent))
    }

    pub fn download(&self, id: &str) -> Result<Vec<u8>, DriveError> {
        let url = Url::parse_with_params(&format!("{}/files/{}", self.api, id), [("alt", "media")])
            .map_err(|e| DriveError::Failed(e.to_string()))?;
        let mut response = self.get(url.as_str())?;
        response
            .body_mut()
            .with_config()
            .limit(MAX_DOWNLOAD)
            .read_to_vec()
            .map_err(|e| DriveError::Failed(e.to_string()))
    }
}
