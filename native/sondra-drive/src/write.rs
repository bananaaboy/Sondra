//! What the devices need beyond reading: look files up by Sondra's notes on them, make the
//! folders below „Sondra“, put small files there, replace them, delete them. See
//! `src/lib/driveClient.ts` (`search`, `create`, `rewrite`, `remove`, `folderAt`).
//!
//! Only small files (a device record, a message): one request each, no resumable upload.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use url::Url;

use crate::client::{as_file, quote, DriveClient, DriveFile, TokenSource, FILE_FIELDS, FOLDER_TYPE};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// A piece of a resumable upload; Drive wants a multiple of 256 KiB.
pub const CHUNK: u64 = 8 * 1024 * 1024;

/// How a file got into Drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Put {
    /// A new file.
    Made(DriveFile),
    /// A file of that name stood there and was written new (the folder and the notes stay).
    Replaced(DriveFile),
    /// A file of that name and size stood there already: nothing was sent.
    Same(DriveFile),
}

/// What to do when the name is taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Nothing is sent when a file of that name and size is there; otherwise it is written new.
    SkipSame,
    /// Always written new.
    Replace,
}

fn next_byte(range: Option<&str>) -> Option<u64> {
    // `bytes=0-12345`: Drive has the first 12346.
    let end = range?.rsplit('-').next()?.trim().parse::<u64>().ok()?;
    Some(end + 1)
}

impl<T: TokenSource> DriveClient<T> {
    /// A file into a folder of Drive: one request up to five megabytes, above that a resumable upload in pieces of eight,
    /// picked up again where Drive says it stands after a hiccup (`driveClient.ts`, `put`). `progress` gets (sent, total)
    /// and `cancel` stops it. A file of that name and size is not sent again (`Mode::SkipSame`).
    #[allow(clippy::too_many_arguments)]
    pub fn put_file(&self, parent: &str, name: &str, path: &Path, mime: &str, notes: &BTreeMap<String, String>, mode: Mode, cancel: &AtomicBool, mut progress: impl FnMut(u64, u64)) -> Result<Put, DriveError> {
        let size = std::fs::metadata(path).map_err(|e| DriveError::Failed(format!("{}: {e}", path.display())))?.len();
        let existing = self.find_file(parent, name)?;
        if let (Some(found), Mode::SkipSame) = (&existing, mode) {
            if found.size == Some(size) {
                progress(size, size);
                return Ok(Put::Same(found.clone()));
            }
        }
        progress(0, size);
        let file = if size <= SMALL_LIMIT as u64 {
            let data = std::fs::read(path).map_err(|e| DriveError::Failed(format!("{}: {e}", path.display())))?;
            match &existing {
                Some(found) => self.rewrite(&found.id, &data, mime)?,
                None => self.create(parent, name, &data, mime, notes)?,
            }
        } else {
            self.resumable(parent, name, path, size, mime, notes, existing.as_ref(), cancel, &mut progress)?
        };
        progress(size, size);
        Ok(if existing.is_some() { Put::Replaced(file) } else { Put::Made(file) })
    }

    #[allow(clippy::too_many_arguments)]
    fn resumable(&self, parent: &str, name: &str, path: &Path, size: u64, mime: &str, notes: &BTreeMap<String, String>, existing: Option<&DriveFile>, cancel: &AtomicBool, progress: &mut impl FnMut(u64, u64)) -> Result<DriveFile, DriveError> {
        let base = upload_base(self.api());
        let (method, url, meta) = match existing {
            Some(found) => ("PATCH", format!("{base}/files/{}?uploadType=resumable&fields={FILE_FIELDS}", found.id), json!({})),
            None => {
                let mut meta = json!({"name": name, "parents": [parent], "mimeType": mime});
                if !notes.is_empty() {
                    meta["appProperties"] = json!(notes);
                }
                ("POST", format!("{base}/files?uploadType=resumable&fields={FILE_FIELDS}"), meta)
            }
        };
        let opened = self.raw(method, &url, &[("Content-Type", "application/json; charset=UTF-8".into()), ("X-Upload-Content-Type", mime.to_owned()), ("X-Upload-Content-Length", size.to_string())], meta.to_string().as_bytes())?;
        if !(200..300).contains(&opened.status) {
            return Err(DriveError::Failed(format!("{} {}", opened.status, opened.text.chars().take(160).collect::<String>())));
        }
        let session = opened.location.ok_or_else(|| DriveError::Failed("Drive nannte keine Upload-Adresse".into()))?;
        let mut file = std::fs::File::open(path).map_err(|e| DriveError::Failed(format!("{}: {e}", path.display())))?;
        let (mut offset, mut tries) = (0u64, 0u32);
        let mut piece = Vec::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(DriveError::Cancelled);
            }
            let end = (offset + CHUNK).min(size);
            piece.clear();
            file.seek(SeekFrom::Start(offset)).map_err(|e| DriveError::Failed(e.to_string()))?;
            (&mut file).take(end - offset).read_to_end(&mut piece).map_err(|e| DriveError::Failed(e.to_string()))?;
            let sent = self.raw("PUT", &session, &[("Content-Range", format!("bytes {offset}-{}/{size}", end - 1))], &piece);
            let answer = match sent {
                Ok(r) if r.status == 200 || r.status == 201 => return Ok(as_file(&serde_json::from_str(&r.text).map_err(|e| DriveError::Failed(e.to_string()))?)),
                Ok(r) if r.status == 308 => {
                    // Drive says how far it got; no Range at all means nothing of this piece.
                    offset = next_byte(r.range.as_deref()).unwrap_or(0);
                    tries = 0;
                    progress(offset, size);
                    continue;
                }
                Ok(r) if r.status == 404 || r.status == 410 => return Err(DriveError::Failed("Die Upload-Sitzung ist abgelaufen".into())),
                Ok(r) if matches!(r.status, 429 | 500..=599) => Some(r),
                Ok(r) => return Err(DriveError::Failed(format!("{} {}", r.status, r.text.chars().take(160).collect::<String>()))),
                Err(DriveError::Offline(_)) => None,
                Err(e) => return Err(e),
            };
            let _ = answer;
            // Dropped, or a hiccup of the server: ask where it stands, then go on from there.
            tries += 1;
            if tries > 4 {
                return Err(DriveError::Offline("Upload abgebrochen".into()));
            }
            std::thread::sleep(self.pause() * 2u32.pow(tries - 1));
            if let Ok(status) = self.raw("PUT", &session, &[("Content-Range", format!("bytes */{size}"))], &[]) {
                if status.status == 200 || status.status == 201 {
                    return Ok(as_file(&serde_json::from_str(&status.text).map_err(|e| DriveError::Failed(e.to_string()))?));
                }
                if status.status == 308 {
                    offset = next_byte(status.range.as_deref()).unwrap_or(0);
                    progress(offset, size);
                }
            }
        }
    }
}
