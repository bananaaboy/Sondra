//! A stand-in for Anytype's local API (`scripts/verify-anytype.mts`): the routes and answers of the
//! 2025-11-08 reference, strict where Anytype is — the version header, the key — and rewriting a page's
//! Markdown on the way in the way Anytype's export hands it back (a code block loses its language, an
//! editor joins and re-cuts its lines, trailing spaces go), so the data block has to survive that.
//!
//! It speaks `/v2` as well (anytype-heart 0.51.6): a key paired for chosen spaces is refused on `/v1` the way
//! Anytype refuses it, and `/v2` holds a page as blocks with ids, takes no whole-page replace, and keeps to
//! its limits — 512 ops per PATCH, 256 blocks per op, strict bodies.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Map, Value};

pub const KEY: &str = "schluessel-123";
/// A key paired for space-a only: /v1 refuses it, /v2 takes it.
pub const SCOPED_KEY: &str = "schluessel-space-a";
pub const GRANTED: [&str; 1] = ["space-a"];
pub const CODE: &str = "4711";
/// A shared space with reading rights only: writing there is 403.
pub const READ_ONLY: &str = "space-c";

/// What the /v2 side was sent: PATCH rounds, the largest batch and run, /v1 calls with the scoped key.
#[derive(Debug, Default, Clone, Copy)]
pub struct Seen {
    pub patches: usize,
    pub max_ops: usize,
    pub max_blocks: usize,
    pub v1_scoped: usize,
}

/// A page's top blocks, as Anytype splits Markdown: the code block whole, every list item and heading its own.
fn blocks_of(markdown: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut fenced = false;
    let flush = |current: &mut Vec<&str>, blocks: &mut Vec<String>| {
        if current.iter().any(|l| !l.trim().is_empty()) {
            blocks.push(current.join("\n"));
        }
        current.clear();
    };
    for line in markdown.split('\n') {
        let fence = line.trim_start().starts_with("```");
        if fenced {
            current.push(line);
            if fence {
                fenced = false;
                flush(&mut current, &mut blocks);
            }
            continue;
        }
        if fence {
            flush(&mut current, &mut blocks);
            current.push(line);
            fenced = true;
            continue;
        }
        if line.trim().is_empty() {
            flush(&mut current, &mut blocks);
            continue;
        }
        let b = line.as_bytes();
        let heading = b.iter().take_while(|c| **c == b'#').count();
        if (b.len() >= 2 && matches!(b[0], b'-' | b'*' | b'+') && b[1] == b' ') || ((1..=6).contains(&heading) && b.get(heading) == Some(&b' ')) {
            flush(&mut current, &mut blocks);
        }
        current.push(line);
    }
    flush(&mut current, &mut blocks);
    blocks
}

/// What Anytype and an editor do to Markdown: no code language, code lines re-cut at 60, trailing spaces gone.
fn reflow(markdown: &str) -> String {
    let mut out = String::new();
    let mut rest = markdown;
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        // A fence only counts with its newline after the language.
        let Some(newline) = after.find('\n') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let language = &after[..newline];
        if !language.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
            out.push_str("```");
            rest = after;
            continue;
        }
        let body = &after[newline + 1..];
        let Some(end) = body.find("```") else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let joined: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
        out.push_str("```\n");
        for chunk in joined.as_bytes().chunks(60) {
            out.push_str(&String::from_utf8_lossy(chunk));
            out.push('\n');
        }
        out.push_str("```");
        rest = &body[end + 3..];
    }
    out.push_str(rest);
    out.split('\n').map(|l| l.trim_end_matches([' ', '\t'])).collect::<Vec<_>>().join("\n")
}

#[derive(Clone, Debug)]
pub struct Page {
    pub id: String,
    pub name: String,
    pub space: String,
    pub archived: bool,
    pub blocks: Vec<(String, String)>,
}

struct State {
    pages: Vec<Page>,
    gone: HashSet<String>,
    valid_key: String,
    issue_scoped: bool,
    seen: Seen,
    object_count: usize,
    block_count: usize,
}

impl State {
    fn blocks(&mut self, texts: Vec<String>) -> Vec<(String, String)> {
        texts
            .into_iter()
            .map(|t| {
                self.block_count += 1;
                (format!("blk-{}", self.block_count), t)
            })
            .collect()
    }
}

fn markdown_of(page: &Page) -> String {
    page.blocks.iter().map(|b| b.1.as_str()).collect::<Vec<_>>().join("\n\n")
}

fn row(page: &Page) -> Value {
    json!({ "id": page.id, "name": page.name, "archived": page.archived, "space": page.space })
}

pub struct FakeAnytype {
    base: String,
    state: Arc<Mutex<State>>,
}

impl FakeAnytype {
    pub fn start() -> FakeAnytype {
        let state = Arc::new(Mutex::new(State {
            pages: Vec::new(),
            gone: HashSet::new(),
            valid_key: KEY.into(),
            issue_scoped: false,
            seen: Seen::default(),
            object_count: 0,
            block_count: 0,
        }));
        let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", http.server_addr().to_ip().unwrap().port());
        let shared = state.clone();
        thread::spawn(move || {
            for request in http.incoming_requests() {
                handle(request, &shared);
            }
        });
        FakeAnytype { base, state }
    }

    pub fn api(&self) -> String {
        self.base.clone()
    }

    pub fn pages(&self) -> Vec<Page> {
        self.state.lock().unwrap().pages.clone()
    }

    /// The pages still there (not emptied from Anytype's bin).
    pub fn live_pages(&self) -> Vec<Page> {
        let s = self.state.lock().unwrap();
        s.pages.iter().filter(|p| !s.gone.contains(&p.id)).cloned().collect()
    }

    pub fn markdown(&self, id: &str) -> String {
        let s = self.state.lock().unwrap();
        s.pages.iter().find(|p| p.id == id).map(markdown_of).unwrap_or_default()
    }

    /// Someone edits the page in Anytype.
    pub fn set_markdown(&self, id: &str, markdown: &str) {
        let mut s = self.state.lock().unwrap();
        let blocks = s.blocks(blocks_of(&reflow(markdown)));
        if let Some(page) = s.pages.iter_mut().find(|p| p.id == id) {
            page.blocks = blocks;
        }
    }

    /// A page emptied from Anytype's bin: it answers 410 from now on.
    pub fn delete_for_good(&self, id: &str) {
        self.state.lock().unwrap().gone.insert(id.into());
    }

    pub fn clear_pages(&self) {
        self.state.lock().unwrap().pages.clear();
    }

    /// The key Anytype accepts from now on (a different one withdraws the first).
    pub fn set_valid_key(&self, key: &str) {
        self.state.lock().unwrap().valid_key = key.into();
    }

    /// The next pairing hands out the key for chosen spaces.
    pub fn issue_scoped(&self, on: bool) {
        self.state.lock().unwrap().issue_scoped = on;
    }

    pub fn seen(&self) -> Seen {
        self.state.lock().unwrap().seen
    }

    pub fn split(markdown: &str) -> Vec<String> {
        blocks_of(markdown)
    }
}

fn respond(request: tiny_http::Request, status: u16, json: Option<Value>) {
    let body = json.map(|j| j.to_string()).unwrap_or_default();
    let mut response = tiny_http::Response::from_data(body.into_bytes()).with_status_code(status);
    response = response.with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = request.respond(response);
}

fn handle(mut request: tiny_http::Request, shared: &Arc<Mutex<State>>) {
    let method = request.method().as_str().to_owned();
    let url = request.url().to_owned();
    let find = |request: &tiny_http::Request, name: &'static str| request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_owned());
    let (version, authorization) = (find(&request, "Anytype-Version"), find(&request, "Authorization"));
    let mut text = String::new();
    let _ = std::io::Read::read_to_string(request.as_reader(), &mut text);
    let parsed = url::Url::parse(&format!("http://x{url}")).unwrap();
    let path = parsed.path().to_owned();
    let query = |name: &str| parsed.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (format, outline) = (query("format"), query("outline"));
    let mut s = shared.lock().unwrap();

    if path == "/docs/openapi.json" {
        return respond(request, 200, Some(json!({ "openapi": "3.1.0" })));
    }
    if version.as_deref() != Some("2025-11-08") {
        return respond(request, 400, Some(json!({ "message": "version" })));
    }
    let body: Value = if text.is_empty() { json!({}) } else { serde_json::from_str(&text).unwrap_or(json!({})) };
    if method == "POST" && path == "/v1/auth/challenges" {
        return if body["app_name"] == "Sondra" { respond(request, 201, Some(json!({ "challenge_id": "challenge-1" }))) } else { respond(request, 400, Some(json!({}))) };
    }
    if method == "POST" && path == "/v1/auth/api_keys" {
        return if body["challenge_id"] == "challenge-1" && body["code"] == CODE {
            respond(request, 201, Some(json!({ "api_key": if s.issue_scoped { SCOPED_KEY } else { KEY } })))
        } else {
            respond(request, 400, Some(json!({ "message": "invalid code" })))
        };
    }
    if authorization.as_deref() != Some(&format!("Bearer {}", s.valid_key)) {
        return respond(request, 401, Some(json!({ "message": "unauthorized" })));
    }
    if s.valid_key == SCOPED_KEY && path.starts_with("/v1/") {
        s.seen.v1_scoped += 1;
        return respond(
            request,
            403,
            Some(json!({
                "status": 403,
                "code": "v1_not_available_for_scoped_keys",
                "message": format!("key \"Sondra\" carries a space grant (spaces [{}] with readwrite access), which /v1 cannot honor — call the same route on /v2, or issue an unscoped key for /v1", GRANTED.join(" "))
            })),
        );
    }
    if path.starts_with("/v2/") {
        let (status, answer) = v2(&mut s, &method, &path, format.as_deref(), outline.as_deref(), &body);
        return respond(request, status, answer);
    }
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    // /v1/spaces
    if method == "GET" && segments == ["v1", "spaces"] {
        return respond(request, 200, Some(json!({ "data": [{ "id": "space-a", "name": "Privat" }, { "id": "space-b", "name": "Familie" }], "pagination": {} })));
    }
    if segments.len() >= 4 && segments[0] == "v1" && segments[1] == "spaces" {
        let space = segments[2].to_owned();
        let live = |s: &State| s.pages.iter().filter(|p| p.space == space && !s.gone.contains(&p.id)).cloned().collect::<Vec<_>>();
        if method == "POST" && segments[3] == "search" && segments.len() == 4 {
            let query = body["query"].as_str().unwrap_or("").to_owned();
            let data: Vec<Value> = live(&s).iter().filter(|p| p.name.contains(&query)).map(row).collect();
            return respond(request, 200, Some(json!({ "data": data, "pagination": {} })));
        }
        if segments[3] == "objects" && segments.len() == 4 {
            if method == "GET" {
                let data: Vec<Value> = live(&s).iter().map(row).collect();
                return respond(request, 200, Some(json!({ "data": data, "pagination": {} })));
            }
            if method == "POST" {
                if space == READ_ONLY {
                    return respond(request, 403, Some(json!({ "message": "forbidden" })));
                }
                s.object_count += 1;
                let id = format!("object-{}", s.object_count);
                let blocks = s.blocks(blocks_of(&reflow(body["body"].as_str().unwrap_or(""))));
                let page = Page { id: id.clone(), name: body["name"].as_str().unwrap_or("").into(), space, archived: false, blocks };
                let object = with_markdown(&page);
                s.pages.push(page);
                return respond(request, 201, Some(json!({ "object": object })));
            }
        }
        if segments[3] == "objects" && segments.len() == 5 {
            let id = url::form_urlencoded::parse(segments[4].as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_default();
            let Some(at) = s.pages.iter().position(|p| p.id == id) else { return respond(request, 404, Some(json!({ "message": "not found" }))) };
            if s.gone.contains(&id) {
                return respond(request, 410, Some(json!({ "message": "object deleted" })));
            }
            if method == "GET" {
                return respond(request, 200, Some(json!({ "object": with_markdown(&s.pages[at]) })));
            }
            if method == "PATCH" {
                if space == READ_ONLY {
                    return respond(request, 403, Some(json!({ "message": "forbidden" })));
                }
                if let Some(md) = body["markdown"].as_str() {
                    let blocks = s.blocks(blocks_of(&reflow(md)));
                    s.pages[at].blocks = blocks;
                }
                return respond(request, 200, Some(json!({ "object": with_markdown(&s.pages[at]) })));
            }
        }
    }
    respond(request, 404, Some(json!({ "message": "no route" })))
}

fn with_markdown(page: &Page) -> Value {
    let mut v = row(page);
    v["markdown"] = Value::String(markdown_of(page));
    v
}

/// The /v2 routes Sondra uses, as strict as Anytype's.
fn v2(s: &mut State, method: &str, path: &str, format: Option<&str>, outline: Option<&str>, json: &Value) -> (u16, Option<Value>) {
    let refuse = |status: u16, code: &str, message: String| (status, Some(json!({ "status": status, "code": code, "message": message, "issues": [] })));
    let stray = |allowed: &[&str]| json.as_object().and_then(|o| o.keys().find(|k| !allowed.contains(&k.as_str())).cloned());
    if method == "GET" && path == "/v2/spaces" {
        let all = [("space-a", "Privat"), ("space-b", "Familie")];
        let data: Vec<Value> = all.iter().filter(|(id, _)| GRANTED.contains(id)).map(|(id, name)| json!({ "id": id, "name": name })).collect();
        return (200, Some(json!({ "data": data, "total": 1, "offset": 0, "limit": 100, "has_more": false, "has_not_granted_spaces": true })));
    }
    let tail = path.trim_start_matches("/v2/spaces/");
    let Some((space, rest)) = tail.split_once('/') else { return refuse(404, "not_found", "no route".into()) };
    if !GRANTED.contains(&space) {
        return refuse(403, "space_not_granted", format!("space \"{space}\" is not granted to this key"));
    }
    let live = |s: &State| s.pages.iter().filter(|p| p.space == space && !s.gone.contains(&p.id) && !p.archived).cloned().collect::<Vec<_>>();
    let listed = |pages: Vec<Page>| {
        let data: Vec<Value> = pages.iter().map(|p| json!({ "id": p.id, "name": p.name, "type": "page" })).collect();
        (200, Some(json!({ "data": data, "total": data.len(), "offset": 0, "limit": 50, "has_more": false })))
    };
    if method == "POST" && rest == "search" {
        if let Some(extra) = stray(&["query", "type", "filter", "filters", "sorts", "fields"]) {
            return refuse(400, "validation_failed", format!("unknown key \"{extra}\""));
        }
        let query = json["query"].as_str().unwrap_or("").to_owned();
        return listed(live(s).into_iter().filter(|p| p.name.contains(&query)).collect());
    }
    if method == "GET" && rest == "objects" {
        return listed(live(s));
    }
    if method == "POST" && rest == "objects" {
        if let Some(extra) = stray(&["type", "name", "properties", "markdown"]) {
            return refuse(400, "validation_failed", format!("unknown key \"{extra}\" — the shortcut accepts type, name, properties, markdown"));
        }
        if json["type"] != "page" {
            return refuse(400, "validation_failed", "unknown type".into());
        }
        s.object_count += 1;
        let id = format!("object-{}", s.object_count);
        let blocks = s.blocks(blocks_of(&reflow(json["markdown"].as_str().unwrap_or(""))));
        s.pages.push(Page { id: id.clone(), name: json["name"].as_str().unwrap_or("").into(), space: space.into(), archived: false, blocks });
        return (201, Some(json!({ "id": id, "type": "page", "etag": "e1" })));
    }
    let Some(encoded) = rest.strip_prefix("objects/") else { return refuse(404, "not_found", "no route".into()) };
    if encoded.contains('/') {
        return refuse(404, "not_found", "no route".into());
    }
    let id = url::form_urlencoded::parse(encoded.as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_default();
    let Some(at) = s.pages.iter().position(|p| p.id == id && p.space == space) else { return refuse(404, "not_found", "object not found".into()) };
    if s.gone.contains(&id) {
        return refuse(410, "gone", "object deleted".into());
    }
    if method == "GET" && format == Some("md") {
        if outline.is_some() {
            return refuse(400, "validation_failed", "format=md and outline are mutually exclusive".into());
        }
        return (200, Some(json!({ "id": id, "type": "page", "etag": "e1", "markdown": markdown_of(&s.pages[at]) })));
    }
    if method == "GET" && outline == Some("true") {
        let blocks: Vec<Value> = s.pages[at].blocks.iter().map(|(bid, text)| json!({ "indent": 0, "id": bid, "type": "text", "text": text.chars().take(80).collect::<String>() })).collect();
        return (200, Some(json!({ "id": id, "type": "page", "etag": "e1", "outline": blocks })));
    }
    if method == "PATCH" {
        if let Some(extra) = stray(&["ops"]) {
            return refuse(400, "validation_failed", format!("unknown key \"{extra}\" — the PATCH body carries only ops"));
        }
        let Some(ops) = json["ops"].as_array().filter(|o| !o.is_empty()) else { return refuse(400, "validation_failed", "ops missing".into()) };
        if ops.len() > 512 {
            return refuse(400, "validation_failed", format!("{} ops exceed the 512-op limit", ops.len()));
        }
        // One batch is atomic: worked on a copy, kept only when every op went through.
        let mut blocks = s.pages[at].blocks.clone();
        let mut biggest = 0;
        for (index, op) in ops.iter().enumerate() {
            let name = op["op"].as_str().unwrap_or("");
            if name == "delete_block" {
                let target = op["id"].as_str().unwrap_or("");
                if !blocks.iter().any(|b| b.0 == target) {
                    return refuse(400, "validation_failed", format!("ops[{index}]: unknown block \"{target}\""));
                }
                blocks.retain(|b| b.0 != target);
            } else if name == "insert_blocks" {
                let position = op.get("position").and_then(Value::as_str);
                if position.is_some_and(|p| p != "first" && p != "last") {
                    return refuse(400, "validation_failed", "invalid position".into());
                }
                let run = blocks_of(&reflow(op["markdown"].as_str().unwrap_or("")));
                if run.len() > 256 {
                    return refuse(400, "validation_failed", format!("ops[{index}]: {} blocks exceed the 256-block per-op limit", run.len()));
                }
                biggest = biggest.max(run.len());
                let made = s.blocks(run);
                blocks = if position == Some("first") { made.into_iter().chain(blocks).collect() } else { blocks.into_iter().chain(made).collect() };
            } else {
                return refuse(400, "validation_failed", format!("ops[{index}]: op \"{name}\" not used here"));
            }
        }
        s.pages[at].blocks = blocks;
        s.seen.patches += 1;
        s.seen.max_ops = s.seen.max_ops.max(ops.len());
        s.seen.max_blocks = s.seen.max_blocks.max(biggest);
        return (200, Some(json!({ "id": id, "etag": "e2", "diff_stats": Map::new() })));
    }
    refuse(405, "method_not_allowed", method.into())
}
