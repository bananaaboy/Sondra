//! A stand-in for the part of Drive's REST API the devices use, in this process: folders,
//! files with Sondra's notes on them, queries on those notes, multipart upload, replace,
//! download, delete. For tests of the programs that sit on top (`sondra-devices`, the app);
//! it checks only that a bearer token is there.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use crate::client::{DriveClient, TokenSource};
use crate::DriveError;

pub const TOKEN: &str = "fake-token";

#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub parent: String,
    pub folder: bool,
    pub data: Vec<u8>,
    pub notes: BTreeMap<String, String>,
    pub created: u64,
    pub modified: u64,
}

#[derive(Default)]
pub struct State {
    pub entries: HashMap<String, Entry>,
    pub clock: u64,
    next: u32,
    pub requests: u32,
}

#[derive(Clone)]
pub struct FakeDrive {
    pub base: String,
    pub state: Arc<Mutex<State>>,
}

/// Tokens that are always good.
#[derive(Clone, Copy)]
pub struct Always;

impl TokenSource for Always {
    fn token(&self, _refused: bool) -> Result<String, DriveError> {
        Ok(TOKEN.into())
    }
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let from = text.find(open)? + open.len();
    let to = text[from..].find(close)? + from;
    Some(&text[from..to])
}

fn unquote(text: &str) -> String {
    text.replace("\\'", "'").replace("\\\\", "\\")
}

impl FakeDrive {
    pub fn start() -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", http.server_addr().to_ip().unwrap().port());
        let shared = state.clone();
        thread::spawn(move || {
            for request in http.incoming_requests() {
                let shared = shared.clone();
                thread::spawn(move || handle(request, &shared));
            }
        });
        Self { base, state }
    }

    pub fn api(&self) -> String {
        format!("{}/drive/v3", self.base)
    }

    pub fn client(&self) -> DriveClient<Always> {
        DriveClient::new(Always, self.api())
    }

    /// Every file (not folder) with this name, wherever it is.
    pub fn files_named(&self, name: &str) -> Vec<Entry> {
        let state = self.state.lock().unwrap();
        state
            .entries
            .values()
            .filter(|e| !e.folder && e.name == name)
            .cloned()
            .collect()
    }

    pub fn file_count(&self) -> usize {
        self.state.lock().unwrap().entries.values().filter(|e| !e.folder).count()
    }

    /// Ages a file by this many milliseconds, as if it had been written that long ago.
    pub fn age(&self, id: &str, millis: u64) {
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.entries.get_mut(id) {
            entry.modified = entry.modified.saturating_sub(millis);
            entry.created = entry.created.saturating_sub(millis);
        }
    }
}

/// 2026-01-01T00:00:00Z plus `ms` (RFC 3339), without a date library: enough for what is compared.
fn time(ms: u64) -> String {
    let total = ms / 1000;
    let (days, rest) = (total / 86_400, total % 86_400);
    // Day numbers within 2026 only: tests never run for months.
    let months = [31u64, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let (mut month, mut day) = (0usize, days);
    while month < 11 && day >= months[month] {
        day -= months[month];
        month += 1;
    }
    format!(
        "2026-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        month + 1,
        day + 1,
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        ms % 1000
    )
}

fn view(id: &str, e: &Entry) -> Value {
    json!({
        "id": id,
        "name": e.name,
        "size": e.data.len().to_string(),
        "mimeType": if e.folder { "application/vnd.google-apps.folder" } else { "application/octet-stream" },
        "modifiedTime": time(e.modified),
        "createdTime": time(e.created),
        "appProperties": e.notes,
    })
}

fn reply(request: tiny_http::Request, status: u16, body: Vec<u8>, kind: &str) {
    let header = tiny_http::Header::from_bytes("Content-Type", kind).unwrap();
    let _ = request.respond(
        tiny_http::Response::from_data(body)
            .with_status_code(status)
            .with_header(header),
    );
}

fn handle(mut request: tiny_http::Request, shared: &Arc<Mutex<State>>) {
    let url = request.url().to_owned();
    let method = request.method().as_str().to_owned();
    let authorized = request
        .headers()
        .iter()
        .any(|h| h.field.equiv("Authorization") && h.value.as_str() == format!("Bearer {TOKEN}"));
    let content_type = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Content-Type"))
        .map(|h| h.value.as_str().to_owned())
        .unwrap_or_default();
    let mut body = Vec::new();
    let _ = request.as_reader().read_to_end(&mut body);
    if !authorized {
        return reply(request, 401, b"{}".to_vec(), "application/json");
    }
    let parsed = url::Url::parse(&format!("http://x{url}")).unwrap();
    let path = parsed.path().to_owned();
    let params: HashMap<String, String> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let mut state = shared.lock().unwrap();
    state.requests += 1;
    state.clock += 1;
    let now = state.clock;
    let json_reply = |request: tiny_http::Request, value: Value| {
        reply(request, 200, value.to_string().into_bytes(), "application/json")
    };
    let id_of = |tail: &str| tail.trim_start_matches('/').to_owned();

    match (method.as_str(), path.as_str()) {
        ("GET", "/drive/v3/files") => {
            let q = params.get("q").cloned().unwrap_or_default();
            let only_folders = q.contains("mimeType = 'application/vnd.google-apps.folder'");
            let only_files = q.contains("mimeType != 'application/vnd.google-apps.folder'");
            let name = between(&q, "name = '", "' and").map(unquote);
            let parent = between(&q, "and '", "' in parents").map(unquote);
            let note = between(&q, "key='", "'").zip(between(&q, "value='", "' }")).map(|(k, v)| (unquote(k), unquote(v)));
            let mut found: Vec<(&String, &Entry)> = state
                .entries
                .iter()
                .filter(|(_, e)| !only_folders || e.folder)
                .filter(|(_, e)| !only_files || !e.folder)
                .filter(|(_, e)| name.as_ref().is_none_or(|n| &e.name == n))
                .filter(|(_, e)| parent.as_ref().is_none_or(|p| &e.parent == p))
                .filter(|(_, e)| note.as_ref().is_none_or(|(k, v)| e.notes.get(k) == Some(v)))
                .collect();
            found.sort_by_key(|(_, e)| e.created);
            let files: Vec<Value> = found.into_iter().map(|(id, e)| view(id, e)).collect();
            json_reply(request, json!({ "files": files }))
        }
        ("POST", "/drive/v3/files") => {
            let meta: Value = serde_json::from_slice(&body).unwrap_or_default();
            state.next += 1;
            let id = format!("f{}", state.next);
            let entry = Entry {
                name: meta["name"].as_str().unwrap_or_default().into(),
                parent: meta["parents"][0].as_str().unwrap_or("root").into(),
                folder: true,
                data: vec![],
                notes: BTreeMap::new(),
                created: now,
                modified: now,
            };
            state.entries.insert(id.clone(), entry);
            json_reply(request, json!({ "id": id }))
        }
        ("POST", "/upload/drive/v3/files") => {
            let boundary = content_type.split("boundary=").nth(1).unwrap_or_default().to_owned();
            let text = body.clone();
            let marker = format!("--{boundary}");
            // Two parts: the notes as JSON, then the content.
            let parts: Vec<&[u8]> = split(&text, marker.as_bytes());
            let (head, data) = (parts.get(1), parts.get(2));
            let (Some(head), Some(data)) = (head, data) else {
                return reply(request, 400, b"{}".to_vec(), "application/json");
            };
            let meta: Value = payload(head).and_then(|b| serde_json::from_slice(b).ok()).unwrap_or_default();
            let data = payload(data).unwrap_or_default().to_vec();
            state.next += 1;
            let id = format!("f{}", state.next);
            let notes = meta["appProperties"]
                .as_object()
                .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned()))).collect())
                .unwrap_or_default();
            let entry = Entry {
                name: meta["name"].as_str().unwrap_or_default().into(),
                parent: meta["parents"][0].as_str().unwrap_or("root").into(),
                folder: false,
                data,
                notes,
                created: now,
                modified: now,
            };
            let shown = view(&id, &entry);
            state.entries.insert(id, entry);
            json_reply(request, shown)
        }
        ("PATCH", p) if p.starts_with("/upload/drive/v3/files/") => {
            let id = id_of(&p["/upload/drive/v3/files".len()..]);
            match state.entries.get_mut(&id) {
                Some(entry) => {
                    entry.data = body;
                    entry.modified = now;
                    let shown = view(&id, entry);
                    json_reply(request, shown)
                }
                None => reply(request, 404, b"{}".to_vec(), "application/json"),
            }
        }
        ("GET", p) if p.starts_with("/drive/v3/files/") => {
            let id = id_of(&p["/drive/v3/files".len()..]);
            match state.entries.get(&id) {
                Some(entry) => reply(request, 200, entry.data.clone(), "application/octet-stream"),
                None => reply(request, 404, b"{}".to_vec(), "application/json"),
            }
        }
        ("DELETE", p) if p.starts_with("/drive/v3/files/") => {
            let id = id_of(&p["/drive/v3/files".len()..]);
            match state.entries.remove(&id) {
                Some(_) => reply(request, 204, vec![], "application/json"),
                None => reply(request, 404, b"{}".to_vec(), "application/json"),
            }
        }
        _ => reply(request, 404, b"{}".to_vec(), "application/json"),
    }
}

fn split<'a>(data: &'a [u8], marker: &[u8]) -> Vec<&'a [u8]> {
    let mut parts = Vec::new();
    let mut from = 0;
    let mut i = 0;
    while i + marker.len() <= data.len() {
        if &data[i..i + marker.len()] == marker {
            parts.push(&data[from..i]);
            i += marker.len();
            from = i;
        } else {
            i += 1;
        }
    }
    parts.push(&data[from..]);
    parts
}

/// A part's content: after the blank line, before the closing line break.
fn payload(part: &[u8]) -> Option<&[u8]> {
    let at = part.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let end = part.len().checked_sub(2).filter(|e| *e >= at)?;
    Some(&part[at..end])
}
