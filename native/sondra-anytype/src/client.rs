//! The link to Anytype (`createAnytype` in `desktop/anytype.mjs`): what Sondra asks of Anytype, in both
//! dialects, with what it keeps between runs — the key, and the space and page it writes to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sondra_drive::keystore::{FileKeyStore, KeyStore};

use crate::page::{item_count, markdown_runs};
use crate::{Error, Kind, Result};

/// Where Anytype's desktop app listens (0.46.7 and later).
pub const ANYTYPE_API: &str = "http://127.0.0.1:31009";
/// The API version asked for; the reference of 8 November 2025.
pub const ANYTYPE_VERSION: &str = "2025-11-08";
/// The default page name the list lives on.
pub const PAGE_NAME: &str = "Sondra · Merkliste";
/// `/v2` takes at most 512 ops per PATCH.
const V2_MAX_OPS: usize = 500;

/// The space and page the list lives on, and which dialect this key needs (`anytype.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_name: Option<String>,
    /// `"v2"` once a key turned out to be bound to chosen spaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Space {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub name: String,
    /// How many series the note's data block holds (0 when it holds none).
    pub item_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// Anytype is open on this computer and answers.
    pub reachable: bool,
    /// Sondra holds a key from Anytype.
    pub paired: bool,
    /// The key outlives the app (the system can encrypt it).
    pub lasting: bool,
    pub space: Option<Space>,
    pub note: Option<Space>,
}

#[derive(Debug, Clone)]
struct Row {
    id: String,
    name: String,
    archived: bool,
}

struct Inner {
    key: Option<String>,
    config: Config,
}

pub struct Anytype {
    api: String,
    config_file: PathBuf,
    store: Box<dyn KeyStore>,
    log: Box<dyn Fn(&str) + Send + Sync>,
    inner: Mutex<Inner>,
}

/// `encodeURIComponent`.
fn component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn rows_of(answer: Option<Value>) -> Vec<Row> {
    answer
        .as_ref()
        .and_then(|a| a.get("data"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(Row {
                        id: row.get("id")?.as_str()?.to_owned(),
                        name: row.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        archived: row.get("archived").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Anytype {
    /// The link with its files in `dir`; the key rests where `store` puts it.
    pub fn new(dir: impl AsRef<Path>, api: impl Into<String>, store: Box<dyn KeyStore>) -> Anytype {
        Anytype::with_log(dir, api, store, |_| {})
    }

    /// The production link: the key beside the config, protected with the account's own key on Windows.
    pub fn in_dir(dir: impl AsRef<Path>) -> Anytype {
        let dir = dir.as_ref();
        Anytype::new(dir, ANYTYPE_API, Box::new(FileKeyStore::new(dir.join("anytype-schluessel.bin"))))
    }

    pub fn with_log(dir: impl AsRef<Path>, api: impl Into<String>, store: Box<dyn KeyStore>, log: impl Fn(&str) + Send + Sync + 'static) -> Anytype {
        let config_file = dir.as_ref().join("anytype.json");
        let config = std::fs::read(&config_file).ok().and_then(|b| serde_json::from_slice::<Config>(&b).ok()).unwrap_or_default();
        let key = store.load();
        Anytype { api: api.into(), config_file, store, log: Box::new(log), inner: Mutex::new(Inner { key, config }) }
    }

    fn say(&self, text: &str) {
        (self.log)(text);
    }

    fn config(&self) -> Config {
        self.inner.lock().unwrap().config.clone()
    }

    fn key(&self) -> Option<String> {
        self.inner.lock().unwrap().key.clone()
    }

    fn change(&self, edit: impl FnOnce(&mut Config)) {
        let mut inner = self.inner.lock().unwrap();
        edit(&mut inner.config);
        if let Some(dir) = self.config_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&self.config_file, serde_json::to_vec(&inner.config).unwrap_or_default());
    }

    fn drop_key(&self) {
        self.inner.lock().unwrap().key = None;
        self.store.clear();
    }

    fn v2(&self) -> bool {
        self.config().api.as_deref() == Some("v2")
    }

    /* One request ------------------------------------------------------------------------------ */

    fn call(&self, method: &str, route: &str, body: Option<Value>, auth: bool, timeout: Duration) -> Result<Option<Value>> {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).build().into();
        let short = route.split('?').next().unwrap_or(route);
        let mut request = ureq::http::Request::builder().method(method).uri(format!("{}{route}", self.api)).header("Anytype-Version", ANYTYPE_VERSION);
        if body.is_some() {
            request = request.header("Content-Type", "application/json");
        }
        if auth {
            if let Some(key) = self.key() {
                request = request.header("Authorization", format!("Bearer {key}"));
            }
        }
        let bytes = body.map(|b| serde_json::to_vec(&b).unwrap_or_default()).unwrap_or_default();
        let request = request.body(bytes).map_err(|e| Error::new(Kind::Failed, e.to_string()))?;
        let mut response = agent
            .run(request)
            .map_err(|e| Error::new(Kind::Unreachable, format!("{method} {short}: {e}")))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        if (200..300).contains(&status) {
            return Ok(if status == 204 || text.trim().is_empty() { None } else { serde_json::from_str(&text).ok() });
        }
        // Anytype answers errors as { message, … } (and /v2 adds a code); the sentence is what helps.
        let (message, reason) = match serde_json::from_str::<Value>(&text) {
            Ok(parsed) => (
                parsed.get("message").and_then(Value::as_str).unwrap_or(&text).to_owned(),
                parsed.get("code").and_then(Value::as_str).unwrap_or_default().to_owned(),
            ),
            Err(_) => (text.clone(), String::new()),
        };
        let detail = format!("{method} {short}: HTTP {status} {}", message.chars().take(160).collect::<String>()).trim().to_owned();
        // A key bound to chosen spaces: /v1 cannot take it, /v2 can.
        if status == 403 && reason == "v1_not_available_for_scoped_keys" {
            return Err(Error::new(Kind::ScopedKey, detail));
        }
        if auth && status == 401 {
            // The key was withdrawn in Anytype's settings; a new code is needed.
            self.drop_key();
            return Err(Error::new(Kind::Unauthorized, detail));
        }
        if status == 403 && reason == "space_not_granted" {
            return Err(Error::new(Kind::NotGranted, detail));
        }
        // Forbidden is about this space or object, not about the key: it stays.
        if status == 403 {
            return Err(Error::new(Kind::Forbidden, detail));
        }
        // 410: deleted in Anytype, emptied from its bin.
        if status == 404 || status == 410 {
            return Err(Error::new(Kind::Missing, detail));
        }
        if status == 429 {
            return Err(Error::new(Kind::Busy, detail));
        }
        Err(Error::new(if status == 400 { Kind::Rejected } else { Kind::Failed }, detail))
    }

    fn ask(&self, method: &str, route: &str, body: Option<Value>) -> Result<Option<Value>> {
        self.call(method, route, body, true, Duration::from_secs(10))
    }

    /* The few things Sondra asks, in both dialects -------------------------------------------- */

    fn d_spaces(&self) -> Result<Vec<Row>> {
        let answer = if self.v2() { self.ask("GET", "/v2/spaces?ids=full&limit=100", None)? } else { self.ask("GET", "/v1/spaces?limit=100", None)? };
        Ok(rows_of(answer))
    }

    fn d_search(&self, space: &str, query: &str) -> Result<Vec<Row>> {
        let answer = if self.v2() {
            self.ask("POST", &format!("/v2/spaces/{space}/search?ids=full&limit=50"), Some(json!({ "query": query, "type": "page" })))?
        } else {
            self.ask("POST", &format!("/v1/spaces/{space}/search"), Some(json!({ "query": query, "types": ["page"], "type": "page" })))?
        };
        Ok(rows_of(answer))
    }

    fn d_list(&self, space: &str) -> Result<Vec<Row>> {
        let version = if self.v2() { "v2" } else { "v1" };
        Ok(rows_of(self.ask("GET", &format!("/{version}/spaces/{space}/objects?limit=50"), None)?))
    }

    fn object(&self, version: &str, space: &str, id: &str) -> String {
        format!("/{version}/spaces/{space}/objects/{}", component(id))
    }

    /// The page as Markdown; a page in Anytype's bin counts as gone.
    fn d_read(&self, space: &str, id: &str) -> Result<String> {
        if self.v2() {
            let answer = self.ask("GET", &format!("{}?format=md", self.object("v2", space, id)), None)?;
            return Ok(answer.as_ref().and_then(|a| a.get("markdown")).and_then(Value::as_str).unwrap_or_default().to_owned());
        }
        let answer = self.ask("GET", &format!("{}?format=md", self.object("v1", space, id)), None)?;
        let object = answer.as_ref().and_then(|a| a.get("object"));
        if object.and_then(|o| o.get("archived")).and_then(Value::as_bool).unwrap_or(false) {
            return Err(Kind::Missing.into());
        }
        Ok(object.and_then(|o| o.get("markdown")).and_then(Value::as_str).unwrap_or_default().to_owned())
    }

    /// A new page; its id.
    fn d_create(&self, space: &str, name: &str, markdown: &str) -> Result<String> {
        let (answer, id) = if self.v2() {
            let a = self.ask("POST", &format!("/v2/spaces/{space}/objects"), Some(json!({ "type": "page", "name": name, "markdown": markdown })))?;
            let id = a.as_ref().and_then(|a| a.get("id")).and_then(Value::as_str).map(str::to_owned);
            (a, id)
        } else {
            let a = self.ask("POST", &format!("/v1/spaces/{space}/objects"), Some(json!({ "name": name, "type_key": "page", "body": markdown })))?;
            let id = a.as_ref().and_then(|a| a.get("object")).and_then(|o| o.get("id")).and_then(Value::as_str).map(str::to_owned);
            (a, id)
        };
        let _ = answer;
        id.ok_or_else(|| Error::new(Kind::Failed, "keine Objekt-ID"))
    }

    /// The page's text replaced. `/v1` takes it whole; `/v2` has no such call — its own way to start a page
    /// over is to delete every top block and insert the new ones, as one batch where the limits allow.
    fn d_replace(&self, space: &str, id: &str, markdown: &str) -> Result<()> {
        if !self.v2() {
            self.ask("PATCH", &self.object("v1", space, id), Some(json!({ "markdown": markdown })))?;
            return Ok(());
        }
        let outline = self.ask("GET", &format!("{}?outline=true", self.object("v2", space, id)), None)?;
        let mut ops: Vec<Value> = outline
            .as_ref()
            .and_then(|o| o.get("outline"))
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b.get("indent").and_then(Value::as_i64) == Some(0))
                    .filter_map(|b| b.get("id").and_then(Value::as_str))
                    .map(|block| json!({ "op": "delete_block", "id": block, "recursive": true }))
                    .collect()
            })
            .unwrap_or_default();
        ops.extend(markdown_runs(markdown, 200).into_iter().map(|run| json!({ "op": "insert_blocks", "markdown": run, "position": "last" })));
        for chunk in ops.chunks(V2_MAX_OPS) {
            self.ask("PATCH", &self.object("v2", space, id), Some(json!({ "ops": chunk })))?;
        }
        Ok(())
    }

    /// Runs one step; if Anytype refuses the key on `/v1` for its space grant, the same step once more on
    /// `/v2`, and `/v2` from now on.
    fn guarded<T>(&self, mut step: impl FnMut(&Self) -> Result<T>) -> Result<T> {
        match step(self) {
            Err(e) if e.kind == Kind::ScopedKey && !self.v2() => {
                self.change(|c| c.api = Some("v2".into()));
                self.say("Anytype: Schlüssel mit Space-Freigabe, weiter über /v2");
                step(self)
            }
            other => other,
        }
    }

    fn need_space(&self) -> Result<String> {
        if self.key().is_none() {
            return Err(Kind::Unauthorized.into());
        }
        self.config().space_id.map(|s| component(&s)).ok_or_else(|| Kind::NoSpace.into())
    }

    /// The page's id: the remembered one, or the one found by its name.
    fn find_page(&self) -> Result<Option<String>> {
        let space = self.need_space()?;
        let config = self.config();
        if let Some(id) = config.object_id {
            return Ok(Some(id));
        }
        let target = config.object_name.filter(|n| !n.is_empty()).unwrap_or_else(|| PAGE_NAME.to_owned());
        let named = |rows: Vec<Row>| rows.into_iter().find(|r| r.name == target && !r.archived);
        let mut page = None;
        match self.d_search(&space, &target) {
            Ok(rows) => page = named(rows),
            Err(e) if e.kind == Kind::ScopedKey => return Err(e),
            Err(_) => {}
        }
        if page.is_none() && target.contains('·') {
            match self.d_search(&space, "Sondra") {
                Ok(rows) => page = named(rows),
                Err(e) if e.kind == Kind::ScopedKey => return Err(e),
                Err(_) => {}
            }
        }
        if page.is_none() {
            match self.d_list(&space) {
                Ok(rows) => page = named(rows),
                Err(e) if e.kind == Kind::ScopedKey => return Err(e),
                Err(_) => {}
            }
        }
        let Some(page) = page else { return Ok(None) };
        let (id, name) = (page.id.clone(), if page.name.is_empty() { target } else { page.name });
        self.change(|c| {
            c.object_id = Some(id.clone());
            c.object_name = Some(name);
        });
        Ok(Some(page.id))
    }

    /* What the page asks ------------------------------------------------------------------------ */

    pub fn status(&self) -> Status {
        let reachable = match self.call("GET", "/docs/openapi.json", None, false, Duration::from_secs(2)) {
            Err(e) => e.kind != Kind::Unreachable,
            Ok(_) => true,
        };
        let paired = self.key().is_some();
        let config = self.config();
        Status {
            reachable,
            paired,
            lasting: self.store.lasting(),
            space: config.space_id.clone().filter(|_| paired).map(|id| Space { id, name: config.space_name.clone().unwrap_or_default() }),
            note: config
                .object_id
                .clone()
                .filter(|_| paired)
                .map(|id| Space { id, name: config.object_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| PAGE_NAME.to_owned()) }),
        }
    }

    /// Anytype shows a four-digit code for this; [`Anytype::pair`] takes it.
    pub fn challenge(&self) -> Result<String> {
        let answer = self.call("POST", "/v1/auth/challenges", Some(json!({ "app_name": "Sondra" })), false, Duration::from_secs(10))?;
        answer
            .as_ref()
            .and_then(|a| a.get("challenge_id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| Error::new(Kind::Failed, "keine challenge_id"))
    }

    pub fn pair(&self, challenge_id: &str, code: &str) -> Result<()> {
        if challenge_id.is_empty() || code.len() != 4 || !code.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Kind::Rejected.into());
        }
        let answer = self
            .call("POST", "/v1/auth/api_keys", Some(json!({ "challenge_id": challenge_id, "code": code })), false, Duration::from_secs(10))
            .map_err(|e| if matches!(e.kind, Kind::Rejected | Kind::Missing) { Error::from(Kind::WrongCode) } else { e })?;
        let key = answer
            .as_ref()
            .and_then(|a| a.get("api_key"))
            .and_then(Value::as_str)
            .ok_or_else(|| Error::new(Kind::Failed, "kein api_key"))?
            .to_owned();
        let _ = self.store.save(&key);
        self.inner.lock().unwrap().key = Some(key);
        // A new key may see more or less than the old one: which dialect it needs is found out again.
        if self.config().api.is_some() {
            self.change(|c| c.api = None);
        }
        self.say("Anytype: verbunden");
        Ok(())
    }

    pub fn spaces(&self) -> Result<Vec<Space>> {
        if self.key().is_none() {
            return Err(Kind::Unauthorized.into());
        }
        Ok(self.guarded(|me| me.d_spaces())?.into_iter().map(|r| Space { id: r.id, name: r.name }).collect())
    }

    pub fn list_notes(&self, space_id: Option<&str>) -> Result<Vec<Note>> {
        if self.key().is_none() {
            return Err(Kind::Unauthorized.into());
        }
        self.guarded(|me| {
            let target = space_id.map(str::to_owned).filter(|s| !s.is_empty()).or_else(|| me.config().space_id).ok_or(Error::from(Kind::NoSpace))?;
            let space = component(&target);
            let mut candidates: Vec<Row> = Vec::new();
            let mut take = |rows: Vec<Row>| {
                for row in rows {
                    if !row.archived && row.name.contains("Sondra") && !candidates.iter().any(|c| c.id == row.id) {
                        candidates.push(row);
                    }
                }
            };
            match me.d_search(&space, "Sondra") {
                Ok(rows) => take(rows),
                Err(e) if e.kind == Kind::ScopedKey => return Err(e),
                Err(_) => {}
            }
            match me.d_list(&space) {
                Ok(rows) => take(rows),
                Err(e) if e.kind == Kind::ScopedKey => return Err(e),
                Err(_) => {}
            }
            Ok(candidates
                .into_iter()
                .map(|row| {
                    let item_count = me.d_read(&space, &row.id).map(|md| item_count(&md)).unwrap_or(0);
                    Note { id: row.id, name: row.name, item_count }
                })
                .collect())
        })
    }

    /// Chooses the space — and the page, when one is given.
    pub fn use_space(&self, id: &str, name: &str, object_id: Option<&str>, object_name: Option<&str>) -> Result<()> {
        if id.is_empty() {
            return Err(Kind::Rejected.into());
        }
        self.change(|c| {
            c.space_id = Some(id.to_owned());
            c.space_name = Some(name.to_owned());
            c.object_id = object_id.filter(|s| !s.is_empty()).map(str::to_owned);
            c.object_name = object_name.filter(|s| !s.is_empty()).map(str::to_owned);
        });
        Ok(())
    }

    /// A new page, which becomes the one the list lives on.
    pub fn create_note(&self, space_id: Option<&str>, name: &str, space_name: &str, initial_markdown: &str) -> Result<Space> {
        if self.key().is_none() {
            return Err(Kind::Unauthorized.into());
        }
        let target = space_id.map(str::to_owned).filter(|s| !s.is_empty()).or_else(|| self.config().space_id).ok_or(Error::from(Kind::NoSpace))?;
        let space = component(&target);
        let page_name = if name.trim().is_empty() { PAGE_NAME.to_owned() } else { name.trim().to_owned() };
        let id = self.guarded(|me| me.d_create(&space, &page_name, initial_markdown))?;
        self.change(|c| {
            c.space_id = Some(target.clone());
            if !space_name.is_empty() {
                c.space_name = Some(space_name.to_owned());
            }
            c.object_id = Some(id.clone());
            c.object_name = Some(page_name.clone());
        });
        self.say(&format!("Anytype: Seite „{page_name}“ angelegt"));
        Ok(Space { id, name: page_name })
    }

    /// The page's text, or `None` while there is no page yet.
    pub fn read(&self) -> Result<Option<String>> {
        self.guarded(|me| {
            let space = me.need_space()?;
            let Some(id) = me.find_page()? else { return Ok(None) };
            match me.d_read(&space, &id) {
                Ok(text) => Ok(Some(text)),
                Err(e) if e.kind == Kind::Missing => {
                    // Deleted in Anytype: look again by name, else there is none — and one found by name
                    // that is gone as well counts as none.
                    me.change(|c| c.object_id = None);
                    let Some(id) = me.find_page()? else { return Ok(None) };
                    match me.d_read(&space, &id) {
                        Ok(text) => Ok(Some(text)),
                        Err(again) if again.kind == Kind::Missing => {
                            me.change(|c| {
                                c.object_id = None;
                                c.object_name = None;
                            });
                            Ok(None)
                        }
                        Err(again) => Err(again),
                    }
                }
                Err(e) => Err(e),
            }
        })
    }

    pub fn write(&self, markdown: &str) -> Result<()> {
        self.guarded(|me| {
            let space = me.need_space()?;
            let target = me.config().object_name.filter(|n| !n.is_empty()).unwrap_or_else(|| PAGE_NAME.to_owned());
            if let Some(id) = me.find_page()? {
                match me.d_replace(&space, &id, markdown) {
                    Ok(()) => return Ok(()),
                    Err(e) if e.kind == Kind::Missing => me.change(|c| c.object_id = None),
                    Err(e) => return Err(e),
                }
            }
            let id = me.d_create(&space, &target, markdown)?;
            me.change(|c| {
                c.object_id = Some(id);
                c.object_name = Some(target.clone());
            });
            me.say(&format!("Anytype: Seite „{target}“ angelegt"));
            Ok(())
        })
    }

    /// Forgets the space and the page, keeps the key — to choose them again.
    pub fn forget_space(&self) {
        self.change(|c| {
            c.space_id = None;
            c.space_name = None;
            c.object_id = None;
            c.object_name = None;
        });
    }

    /// Disconnects: the key and the link's file are gone.
    pub fn forget(&self) {
        self.drop_key();
        self.inner.lock().unwrap().config = Config::default();
        let _ = std::fs::remove_file(&self.config_file);
        self.say("Anytype: getrennt");
    }

    /// Paired and a space chosen — nothing is asked of Anytype to know it. Rounds only run while this holds.
    pub fn connected(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.key.is_some() && inner.config.space_id.is_some()
    }

    /// The link's settings, for the page.
    pub fn settings(&self) -> Config {
        self.config()
    }
}
