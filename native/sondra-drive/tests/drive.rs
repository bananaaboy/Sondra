//! The sign-in and the client against a stand-in for Google, in this process.
//!
//! The stand-in checks what Google checks: the PKCE verifier against the challenge, the
//! state coming back, the bearer token on every Drive request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use sondra_daemon::ports::Library;
use sondra_drive::keystore::{FileKeyStore, KeyStore, MemoryKeyStore};
use sondra_drive::{
    Account, ClientCredentials, DriveClient, DriveError, DriveLibrary, Endpoints, DRIVE_SCOPE,
};
use url::Url;

const SQLITE: &[u8] = include_bytes!("../../sondra-core/tests/fixtures/merkliste.sqlite");
const JSON: &[u8] = include_bytes!("../../sondra-core/tests/fixtures/merkliste.json");

struct Entry {
    name: String,
    parent: String,
    folder: bool,
    data: Vec<u8>,
    modified: String,
    trashed: bool,
}

#[derive(Default)]
struct Google {
    entries: HashMap<String, Entry>,
    /// What the sign-in was started with: the challenge and the state.
    challenge: Option<String>,
    /// Refresh tokens that are good, and the access tokens made from them.
    refresh_tokens: Vec<String>,
    access_tokens: Vec<String>,
    issued: u32,
    /// Answers to give before the real ones: Drive being busy, say.
    failures: Vec<u16>,
    scope: String,
    expires_in: u64,
    withhold_refresh_token: bool,
    token_requests: Vec<Vec<(String, String)>>,
    drive_requests: u32,
    revoked: Vec<String>,
}

struct Server {
    base: String,
    google: Arc<Mutex<Google>>,
}

impl Server {
    fn endpoints(&self) -> Endpoints {
        Endpoints {
            auth: format!("{}/auth", self.base),
            token: format!("{}/token", self.base),
            revoke: format!("{}/revoke", self.base),
            api: format!("{}/drive/v3", self.base),
        }
    }
}

fn form(body: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn start() -> Server {
    let google = Arc::new(Mutex::new(Google {
        scope: DRIVE_SCOPE.into(),
        expires_in: 3600,
        ..Default::default()
    }));
    let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!(
        "http://127.0.0.1:{}",
        http.server_addr().to_ip().unwrap().port()
    );
    let state = google.clone();
    thread::spawn(move || {
        for mut request in http.incoming_requests() {
            let url = Url::parse("http://x").unwrap().join(request.url()).unwrap();
            let mut body = String::new();
            let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
            let auth = request
                .headers()
                .iter()
                .find(|h| h.field.equiv("Authorization"))
                .map(|h| h.value.to_string());
            let mut g = state.lock().unwrap();
            let json = |value: serde_json::Value, status: u16| {
                tiny_http::Response::from_string(value.to_string())
                    .with_status_code(status)
                    .with_header(
                        tiny_http::Header::from_bytes("content-type", "application/json").unwrap(),
                    )
            };
            let path = url.path().to_owned();
            let response = match path.as_str() {
                "/token" => {
                    let fields = form(&body);
                    g.token_requests.push(fields.clone());
                    let get = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
                    match get("grant_type").as_deref() {
                        Some("authorization_code") => {
                            let verifier = get("code_verifier").unwrap_or_default();
                            let challenge =
                                URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
                            if get("code").as_deref() != Some("good-code")
                                || g.challenge.as_deref() != Some(challenge.as_str())
                            {
                                json(
                                    serde_json::json!({"error": "invalid_grant", "error_description": "bad code or verifier"}),
                                    400,
                                )
                            } else {
                                g.issued += 1;
                                let access = format!("access-{}", g.issued);
                                g.access_tokens.push(access.clone());
                                let mut answer = serde_json::json!({"access_token": access, "expires_in": g.expires_in, "scope": g.scope});
                                if !g.withhold_refresh_token {
                                    g.refresh_tokens.push("refresh-1".into());
                                    answer["refresh_token"] = "refresh-1".into();
                                }
                                json(answer, 200)
                            }
                        }
                        Some("refresh_token") => {
                            let token = get("refresh_token").unwrap_or_default();
                            if !g.refresh_tokens.contains(&token) {
                                json(serde_json::json!({"error": "invalid_grant"}), 400)
                            } else {
                                g.issued += 1;
                                let access = format!("access-{}", g.issued);
                                g.access_tokens.push(access.clone());
                                json(
                                    serde_json::json!({"access_token": access, "expires_in": g.expires_in}),
                                    200,
                                )
                            }
                        }
                        _ => json(serde_json::json!({"error": "unsupported_grant_type"}), 400),
                    }
                }
                "/revoke" => {
                    let token = form(&body)
                        .into_iter()
                        .find(|(k, _)| k == "token")
                        .map(|(_, v)| v)
                        .unwrap_or_default();
                    g.refresh_tokens.retain(|t| *t != token);
                    g.revoked.push(token);
                    json(serde_json::json!({}), 200)
                }
                p if p.starts_with("/drive/v3/files") => {
                    g.drive_requests += 1;
                    let bearer_ok = auth
                        .as_deref()
                        .and_then(|a| a.strip_prefix("Bearer "))
                        .is_some_and(|t| g.access_tokens.contains(&t.to_owned()));
                    if !bearer_ok {
                        json(serde_json::json!({"error": {"code": 401}}), 401)
                    } else if let Some(status) =
                        (!g.failures.is_empty()).then(|| g.failures.remove(0))
                    {
                        let reason = if status == 403 {
                            "rateLimitExceeded"
                        } else {
                            "busy"
                        };
                        json(
                            serde_json::json!({"error": {"code": status, "errors": [{"reason": reason}]}}),
                            status,
                        )
                    } else if p == "/drive/v3/files" {
                        let q = url
                            .query_pairs()
                            .find(|(k, _)| k == "q")
                            .map(|(_, v)| v.into_owned())
                            .unwrap_or_default();
                        let name = q
                            .strip_prefix("name = '")
                            .and_then(|r| r.split("' and ").next())
                            .unwrap_or("")
                            .to_owned();
                        // Drive's query language: a backslash escapes the next character.
                        let name = {
                            let mut out = String::new();
                            let mut chars = name.chars();
                            while let Some(c) = chars.next() {
                                out.push(if c == '\\' {
                                    chars.next().unwrap_or('\\')
                                } else {
                                    c
                                });
                            }
                            out
                        };
                        let parent = q
                            .split(" and '")
                            .nth(1)
                            .and_then(|r| r.split("' in parents").next())
                            .unwrap_or("")
                            .to_owned();
                        let want_folder =
                            q.contains("mimeType = 'application/vnd.google-apps.folder'");
                        let mut hits: Vec<_> = g
                            .entries
                            .iter()
                            .filter(|(_, e)| {
                                e.name == name
                                    && e.parent == parent
                                    && e.folder == want_folder
                                    && !e.trashed
                            })
                            .collect();
                        hits.sort_by(|a, b| b.1.modified.cmp(&a.1.modified));
                        let files: Vec<_> = hits
                            .iter()
                            .map(|(id, e)| serde_json::json!({"id": id, "name": e.name, "size": e.data.len().to_string(), "modifiedTime": e.modified, "mimeType": if e.folder {"application/vnd.google-apps.folder"} else {"application/octet-stream"}}))
                            .collect();
                        json(serde_json::json!({"files": files}), 200)
                    } else {
                        let id = p.trim_start_matches("/drive/v3/files/").to_owned();
                        match g.entries.get(&id) {
                            Some(e)
                                if url.query_pairs().any(|(k, v)| k == "alt" && v == "media") =>
                            {
                                tiny_http::Response::from_data(e.data.clone()).with_status_code(200)
                            }
                            _ => json(serde_json::json!({"error": {"code": 404}}), 404),
                        }
                    }
                }
                _ => json(serde_json::json!({}), 404),
            };
            drop(g);
            let _ = request.respond(response);
        }
    });
    Server { base, google }
}

fn put(
    server: &Server,
    id: &str,
    parent: &str,
    name: &str,
    folder: bool,
    data: &[u8],
    modified: &str,
) {
    server.google.lock().unwrap().entries.insert(
        id.into(),
        Entry {
            name: name.into(),
            parent: parent.into(),
            folder,
            data: data.to_vec(),
            modified: modified.into(),
            trashed: false,
        },
    );
}

/// The folders `Sondra/Merkliste` with a database in them.
fn with_merkliste(server: &Server) {
    put(
        server,
        "f-sondra",
        "root",
        "Sondra",
        true,
        b"",
        "2026-01-01",
    );
    put(
        server,
        "f-merk",
        "f-sondra",
        "Merkliste",
        true,
        b"",
        "2026-01-01",
    );
    put(
        server,
        "file-db",
        "f-merk",
        "Sondra-Merkliste.sqlite",
        false,
        SQLITE,
        "2026-11-01",
    );
}

fn creds() -> Option<ClientCredentials> {
    Some(ClientCredentials {
        id: "client-id".into(),
        secret: "client-secret".into(),
    })
}

fn account(server: &Server) -> Account {
    Account::new(
        creds(),
        server.endpoints(),
        Box::new(MemoryKeyStore::default()),
    )
}

/// What the browser does: opens the address, and the user agrees; Google sends the
/// browser back to the port the program opened.
fn agree(server: &Server) -> impl FnOnce(&str) -> Result<(), String> + '_ {
    move |address| {
        let url = Url::parse(address).map_err(|e| e.to_string())?;
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], DRIVE_SCOPE);
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(
            q["prompt"], "consent",
            "without it a second sign-in brings no refresh token"
        );
        assert_eq!(q["client_id"], "client-id");
        assert!(
            q["redirect_uri"].starts_with("http://127.0.0.1:"),
            "loopback, not a fixed port"
        );
        server.google.lock().unwrap().challenge = Some(q["code_challenge"].clone());
        let back = format!("{}?code=good-code&state={}", q["redirect_uri"], q["state"]);
        thread::spawn(move || {
            let _ = ureq::get(&back).call();
        });
        Ok(())
    }
}

#[test]
fn signs_in_with_pkce_and_keeps_the_refresh_token() {
    let server = start();
    let account = account(&server);
    assert!(account.configured());
    assert!(!account.connected());
    account
        .connect(agree(&server))
        .expect("the sign-in goes through");
    assert!(account.connected());
    let token = account.access_token(false).unwrap();
    assert_eq!(
        token, "access-1",
        "the one from the sign-in, not a second request"
    );
    assert_eq!(server.google.lock().unwrap().token_requests.len(), 1);
}

#[test]
fn a_second_look_at_the_token_does_not_ask_google_again_until_it_ends() {
    let server = start();
    let account = account(&server);
    account.connect(agree(&server)).unwrap();
    assert_eq!(
        account.access_token(false).unwrap(),
        account.access_token(false).unwrap()
    );
    assert_eq!(server.google.lock().unwrap().token_requests.len(), 1);
    // Forced (the last one was refused): a new one.
    assert_eq!(account.access_token(true).unwrap(), "access-2");
    // A token that ends within the minute counts as ended.
    server.google.lock().unwrap().expires_in = 30;
    assert_eq!(account.access_token(true).unwrap(), "access-3");
    assert_eq!(
        account.access_token(false).unwrap(),
        "access-4",
        "30 seconds left is too few"
    );
}

#[test]
fn a_wrong_state_is_refused_and_the_browser_is_told() {
    let server = start();
    let account = account(&server);
    let result = account.connect(|address| {
        let url = Url::parse(address).unwrap();
        let redirect = url
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .unwrap()
            .1
            .into_owned();
        thread::spawn(move || {
            let _ = ureq::get(&format!("{redirect}?code=good-code&state=somebody-elses")).call();
        });
        Ok(())
    });
    assert_eq!(result, Err(DriveError::Failed("state".into())));
    assert!(!account.connected());
}

#[test]
fn a_user_who_says_no_is_denied_not_failed() {
    let server = start();
    let account = account(&server);
    let result = account.connect(|address| {
        let url = Url::parse(address).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let back = format!(
            "{}?error=access_denied&state={}",
            q["redirect_uri"], q["state"]
        );
        thread::spawn(move || {
            let _ = ureq::get(&back).call();
        });
        Ok(())
    });
    assert_eq!(result, Err(DriveError::Denied));
}

#[test]
fn nobody_answering_ends_the_wait() {
    let server = start();
    let account = account(&server).with_sign_in_timeout(Duration::from_millis(300));
    assert_eq!(account.connect(|_| Ok(())), Err(DriveError::Timeout));
}

#[test]
fn a_favicon_request_is_not_the_answer() {
    let server = start();
    let account = account(&server);
    let result = account.connect(|address| {
        let url = Url::parse(address).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        server.google.lock().unwrap().challenge = Some(q["code_challenge"].clone());
        let redirect = q["redirect_uri"].clone();
        let back = format!("{redirect}?code=good-code&state={}", q["state"]);
        thread::spawn(move || {
            let _ = ureq::get(&format!("{redirect}favicon.ico")).call();
            let _ = ureq::get(&back).call();
        });
        Ok(())
    });
    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn a_sign_in_without_the_drive_scope_or_without_a_refresh_token_is_not_taken() {
    let server = start();
    server.google.lock().unwrap().scope = "email".into();
    assert_eq!(
        account(&server).connect(agree(&server)),
        Err(DriveError::Scope)
    );

    let server = start();
    server.google.lock().unwrap().withhold_refresh_token = true;
    assert_eq!(
        account(&server).connect(agree(&server)),
        Err(DriveError::Failed("kein refresh_token".into()))
    );
}

#[test]
fn without_a_client_it_says_so() {
    let server = start();
    let account = Account::new(
        None,
        server.endpoints(),
        Box::new(MemoryKeyStore::default()),
    );
    assert!(!account.configured());
    assert_eq!(account.connect(|_| Ok(())), Err(DriveError::NotConfigured));
    assert_eq!(account.access_token(false), Err(DriveError::Unauthorized));
}

#[test]
fn the_refresh_token_survives_a_restart_and_a_withdrawn_one_ends_the_sign_in() {
    let dir = tempfile_dir();
    let server = start();
    let first = Account::new(
        creds(),
        server.endpoints(),
        Box::new(FileKeyStore::new(dir.join("schluessel.bin"))),
    );
    first.connect(agree(&server)).unwrap();

    // The next run finds it and can get an access token without a browser.
    let second = Account::new(
        creds(),
        server.endpoints(),
        Box::new(FileKeyStore::new(dir.join("schluessel.bin"))),
    );
    assert!(second.connected());
    assert!(second.access_token(false).is_ok());

    // Google withdraws it (the person removed Sondra from their account).
    server.google.lock().unwrap().refresh_tokens.clear();
    assert_eq!(second.access_token(true), Err(DriveError::Unauthorized));
    assert!(!second.connected());
    let third = Account::new(
        creds(),
        server.endpoints(),
        Box::new(FileKeyStore::new(dir.join("schluessel.bin"))),
    );
    assert!(!third.connected(), "the dead key is gone from the disk too");
}

#[test]
fn disconnecting_withdraws_the_grant_at_google_and_forgets_it_here() {
    let dir = tempfile_dir();
    let server = start();
    let store = FileKeyStore::new(dir.join("k.bin"));
    let account = Account::new(creds(), server.endpoints(), Box::new(store));
    account.connect(agree(&server)).unwrap();
    account.disconnect();
    assert!(!account.connected());
    assert_eq!(server.google.lock().unwrap().revoked, ["refresh-1"]);
    assert!(FileKeyStore::new(dir.join("k.bin")).load().is_none());
}

fn tempfile_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sondra-drive-test-{}-{:?}",
        std::process::id(),
        thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn client(server: &Server) -> (Arc<Account>, DriveClient<Arc<Account>>) {
    let account = account(server);
    account.connect(agree(server)).unwrap();
    let account = Arc::new(account);
    let drive = DriveClient::new(account.clone(), server.endpoints().api)
        .with_backoff(Duration::from_millis(5));
    (account, drive)
}

#[test]
fn finds_folders_by_name_from_the_top_and_files_newest_first() {
    let server = start();
    with_merkliste(&server);
    put(
        &server,
        "file-old",
        "f-merk",
        "Sondra-Merkliste.sqlite",
        false,
        b"older",
        "2026-02-01",
    );
    let (_account, drive) = client(&server);
    assert_eq!(
        drive
            .folder_path(&["Sondra", "Merkliste"])
            .unwrap()
            .as_deref(),
        Some("f-merk")
    );
    assert_eq!(
        drive.folder_path(&["Sondra", "Gibt es nicht"]).unwrap(),
        None
    );
    let file = drive
        .find_file("f-merk", "Sondra-Merkliste.sqlite")
        .unwrap()
        .unwrap();
    assert_eq!(file.id, "file-db", "the newer of two files of one name");
    assert_eq!(file.size, Some(SQLITE.len() as u64));
    assert_eq!(drive.download("file-db").unwrap(), SQLITE);
}

#[test]
fn a_name_with_a_quote_in_it_is_found() {
    let server = start();
    put(
        &server,
        "f1",
        "root",
        "Ocean's \\ Eleven",
        true,
        b"",
        "2026-01-01",
    );
    let (_a, drive) = client(&server);
    assert_eq!(
        drive
            .find_folder("root", "Ocean's \\ Eleven")
            .unwrap()
            .as_deref(),
        Some("f1")
    );
    assert_eq!(sondra_drive::client::quote("a'b\\c"), "'a\\'b\\\\c'");
}

#[test]
fn a_refused_token_is_renewed_once_and_the_request_goes_through() {
    let server = start();
    with_merkliste(&server);
    let (_a, drive) = client(&server);
    // Drive stops knowing the token (it ended early).
    server.google.lock().unwrap().access_tokens.clear();
    // The renewed token is a new one; make the stand-in know whatever it issues next.
    assert_eq!(
        drive.folder_path(&["Sondra"]).unwrap().as_deref(),
        Some("f-sondra")
    );
}

#[test]
fn a_busy_drive_is_asked_again_and_a_dead_one_is_given_up_on() {
    let server = start();
    with_merkliste(&server);
    let (_a, drive) = client(&server);
    server.google.lock().unwrap().failures = vec![429, 503, 403];
    assert_eq!(
        drive.folder_path(&["Sondra"]).unwrap().as_deref(),
        Some("f-sondra"),
        "three refusals, then it works"
    );
    server.google.lock().unwrap().failures = vec![500; 10];
    assert!(
        matches!(drive.folder_path(&["Sondra"]), Err(DriveError::Failed(_))),
        "not forever"
    );
}

#[test]
fn a_missing_file_is_missing_not_failed() {
    let server = start();
    with_merkliste(&server);
    let (_a, drive) = client(&server);
    assert!(matches!(
        drive.download("nope"),
        Err(DriveError::Missing(_))
    ));
}

#[test]
fn the_library_reads_the_database_and_falls_back_to_the_older_json() {
    let server = start();
    with_merkliste(&server);
    let (_a, drive) = client(&server);
    let library = DriveLibrary::new(drive);
    let shared = library.read().expect("the database in Drive reads");
    assert_eq!(
        shared
            .items
            .iter()
            .map(|i| i.id.as_str())
            .collect::<Vec<_>>(),
        ["frieren", "naruto", "rezero", "film"]
    );

    // Only the old JSON is there.
    let server = start();
    put(
        &server,
        "f-sondra",
        "root",
        "Sondra",
        true,
        b"",
        "2026-01-01",
    );
    put(
        &server,
        "f-merk",
        "f-sondra",
        "Merkliste",
        true,
        b"",
        "2026-01-01",
    );
    put(
        &server,
        "file-json",
        "f-merk",
        "Sondra-Merkliste.json",
        false,
        JSON,
        "2026-01-01",
    );
    let (_a, drive) = client(&server);
    assert_eq!(DriveLibrary::new(drive).read().unwrap().items.len(), 4);
}

#[test]
fn the_library_says_what_is_wrong_in_words() {
    let server = start();
    let (_a, drive) = client(&server);
    let message = DriveLibrary::new(drive).read().unwrap_err();
    assert!(message.contains("noch keine Merkliste"), "{message}");

    let server = start();
    with_merkliste(&server);
    put(
        &server,
        "file-db",
        "f-merk",
        "Sondra-Merkliste.sqlite",
        false,
        b"this is not a database",
        "2026-12-01",
    );
    let (_a, drive) = client(&server);
    let message = DriveLibrary::new(drive).read().unwrap_err();
    assert!(message.contains("keine Merkliste"), "{message}");

    let message = DriveLibrary::new(DriveClient::new(
        Arc::new(account(&server)),
        server.endpoints().api,
    ))
    .read()
    .unwrap_err();
    assert!(message.contains("niemand angemeldet"), "{message}");
}
