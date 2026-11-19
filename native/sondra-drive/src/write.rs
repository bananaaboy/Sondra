//! What the devices need beyond reading: look files up by Sondra's notes on them, make the
//! folders below „Sondra“, put small files there, replace them, delete them. See
//! `src/lib/driveClient.ts` (`search`, `create`, `rewrite`, `remove`, `folderAt`).
//!
//! Only small files (a device record, a message): one request each, no resumable upload.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use url::Url;

use crate::client::{as_file, quote, DriveClient, DriveFile, TokenSource, FILE_FIELDS, FOLDER_TYPE};
use crate::DriveError;

/// More than this is not a record or a message; it goes the resumable way, which is not here.
pub const SMALL_LIMIT: usize = 5 * 1024 * 1024;

/// A file found by its notes: the notes come along.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub file: DriveFile,
    pub notes: BTreeMap<String, String>,
}

fn upload_base(api: &str) -> String {
    match api.strip_suffix("/drive/v3") {
        Some(head) => format!("{head}/upload/drive/v3"),
        None => format!("{api}/upload"),
    }
}

fn notes_of(raw: &Value) -> BTreeMap<String, String> {
    raw["appProperties"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn json_of(mut response: ureq::http::Response<ureq::Body>) -> Result<Value, DriveError> {
    response
        .body_mut()
        .read_json()
        .map_err(|e| DriveError::Failed(e.to_string()))
}

impl<T: TokenSource> DriveClient<T> {
    /// Files anywhere Sondra can see that match a query on its notes, e.g.
    /// `appProperties has { key='sondraAn' and value='…' }`, oldest first.
    pub fn search(&self, query: &str) -> Result<Vec<Found>, DriveError> {
        let url = Url::parse_with_params(
            &format!("{}/files", self.api()),
            [
                (
                    "q",
                    format!("{query} and mimeType != '{FOLDER_TYPE}' and trashed = false"),
                ),
                (
                    "fields",
                    format!("files({FILE_FIELDS},appProperties,createdTime)"),
                ),
                ("orderBy", "createdTime".to_owned()),
                ("spaces", "drive".to_owned()),
                ("pageSize", "200".to_owned()),
            ],
        )
        .map_err(|e| DriveError::Failed(e.to_string()))?;
        let body = json_of(self.send("GET", url.as_str(), None, None)?)?;
        Ok(body["files"]
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .map(|f| Found {
                        file: as_file(f),
                        notes: notes_of(f),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The folder at the end of this path below the top of Drive, each one found or made.
    pub fn ensure_path(&self, names: &[&str]) -> Result<String, DriveError> {
        let mut parent = "root".to_owned();
        for name in names {
            parent = match self.find_folder(&parent, name)? {
                Some(id) => id,
                None => {
                    let url = format!("{}/files?fields=id", self.api());
                    let body = json!({"name": name, "mimeType": FOLDER_TYPE, "parents": [parent]});
                    let made = json_of(self.send(
                        "POST",
                        &url,
                        Some("application/json; charset=UTF-8"),
                        Some(body.to_string().as_bytes()),
                    )?)?;
                    made["id"]
                        .as_str()
                        .ok_or_else(|| DriveError::Failed("no id".into()))?
                        .to_owned()
                }
            };
        }
        Ok(parent)
    }

    /// A new file in a folder, with Sondra's notes on it. Never replaces one.
    pub fn create(
        &self,
        parent: &str,
        name: &str,
        data: &[u8],
        mime: &str,
        notes: &BTreeMap<String, String>,
    ) -> Result<DriveFile, DriveError> {
        if data.len() > SMALL_LIMIT {
            return Err(DriveError::Failed("too large for one request".into()));
        }
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|e| DriveError::Failed(e.to_string()))?;
        let boundary = format!("sondra{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let mut meta = json!({"name": name, "parents": [parent]});
        if !notes.is_empty() {
            meta["appProperties"] = json!(notes);
        }
        let mut body = Vec::new();
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let url = format!(
            "{}/files?uploadType=multipart&fields={FILE_FIELDS}",
            upload_base(self.api())
        );
        let made = json_of(self.send(
            "POST",
            &url,
            Some(&format!("multipart/related; boundary={boundary}")),
            Some(&body),
        )?)?;
        Ok(as_file(&made))
    }

    /// New content for a file Sondra made; its name, folder and notes stay.
    pub fn rewrite(&self, id: &str, data: &[u8], mime: &str) -> Result<DriveFile, DriveError> {
        let url = format!(
            "{}/files/{id}?uploadType=media&fields={FILE_FIELDS},appProperties",
            upload_base(self.api())
        );
        Ok(as_file(&json_of(self.send(
            "PATCH",
            &url,
            Some(mime),
            Some(data),
        )?)?))
    }

    /// Deletes a file for good; one that is gone already is fine.
    pub fn remove(&self, id: &str) -> Result<(), DriveError> {
        match self.send("DELETE", &format!("{}/files/{id}", self.api()), None, None) {
            Ok(_) | Err(DriveError::Missing(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// `appProperties has { key='…' and value='…' }`, the way the website asks.
pub fn notes_query(key: &str, value: &str) -> String {
    format!(
        "appProperties has {{ key={} and value={} }}",
        quote(key),
        quote(value)
    )
}
