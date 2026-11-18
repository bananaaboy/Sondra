//! The sign-in, and the key that keeps it. See `desktop/googleDrive.mjs`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::keystore::KeyStore;
use crate::DriveError;

/// Only the files Sondra put in Drive itself.
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// How long the browser has for the sign-in before the port closes again.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
    pub api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            api: "https://www.googleapis.com/drive/v3".into(),
        }
    }
}

/// Google's "Desktop app" client: not a secret in an installed program, as Google says.
#[derive(Debug, Clone)]
pub struct ClientCredentials {
    pub id: String,
    pub secret: String,
}

#[derive(Default)]
struct State {
    refresh: Option<String>,
    /// The access token and when it ends.
    access: Option<(String, Instant)>,
}

pub struct Account {
    client: Option<ClientCredentials>,
    endpoints: Endpoints,
    store: Box<dyn KeyStore>,
    http: ureq::Agent,
    state: Mutex<State>,
    sign_in_timeout: Duration,
}

/// Why a token request did not give a token.
enum TokenFailure {
    /// A withdrawn or expired grant: the next step is a new sign-in.
    Revoked,
    Other(DriveError),
}

pub(crate) fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        // Statuses are read and judged here, not turned into errors by the library.
        .http_status_as_error(false)
        .build()
        .into()
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the system has random numbers");
    URL_SAFE_NO_PAD.encode(buf)
}

/// The page the browser shows after the sign-in; it has nothing more to do.
fn answer_page(ok: bool) -> String {
    let text = if ok {
        "Sondra ist mit Google Drive verbunden. Sie können dieses Fenster schliessen und zu Sondra zurückkehren."
    } else {
        "Die Anmeldung bei Google hat nicht geklappt. Schliessen Sie dieses Fenster und versuchen Sie es in Sondra noch einmal."
    };
    format!(
        "<!doctype html><html lang=\"de\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Sondra · Google Drive</title><style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8faf8;color:#0b4a22}}p{{max-width:34em;margin:24px}}@media(prefers-color-scheme:dark){{body{{background:#0a110d;color:#a6ecb9}}}}</style><p>{text}</p></html>"
    )
}

impl Account {
    pub fn new(
        client: Option<ClientCredentials>,
        endpoints: Endpoints,
        store: Box<dyn KeyStore>,
    ) -> Self {
        let refresh = store.load();
        Self {
            client,
            endpoints,
            store,
            http: agent(),
            state: Mutex::new(State {
                refresh,
                access: None,
            }),
            sign_in_timeout: SIGN_IN_TIMEOUT,
        }
    }

    #[doc(hidden)]
    pub fn with_sign_in_timeout(mut self, timeout: Duration) -> Self {
        self.sign_in_timeout = timeout;
        self
    }

    pub fn configured(&self) -> bool {
        self.client.is_some()
    }

    pub fn connected(&self) -> bool {
        self.state.lock().unwrap().refresh.is_some()
    }

    /// Whether the sign-in survives a restart.
    pub fn lasting(&self) -> bool {
        self.store.lasting()
    }

    pub fn api(&self) -> &str {
        &self.endpoints.api
    }

    fn token_request(&self, fields: &[(&str, &str)]) -> Result<Value, TokenFailure> {
        let client = self
            .client
            .as_ref()
            .ok_or(TokenFailure::Other(DriveError::NotConfigured))?;
        let mut form: Vec<(&str, &str)> =
            vec![("client_id", &client.id), ("client_secret", &client.secret)];
        form.extend_from_slice(fields);
        let mut response = self
            .http
            .post(&self.endpoints.token)
            .send_form(form)
            .map_err(|e| TokenFailure::Other(DriveError::Offline(e.to_string())))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let error = body["error"].as_str().unwrap_or("");
            if error == "invalid_grant" {
                return Err(TokenFailure::Revoked);
            }
            let detail = body["error_description"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| text.chars().take(160).collect());
            return Err(TokenFailure::Other(DriveError::Failed(
                format!("{status} {error} {detail}").trim().to_owned(),
            )));
        }
        Ok(body)
    }

    fn remember_access(&self, body: &Value) {
        let seconds = body["expires_in"]
            .as_u64()
            .filter(|s| *s > 0)
            .unwrap_or(3600);
        if let Some(token) = body["access_token"].as_str() {
            self.state.lock().unwrap().access = Some((
                token.to_owned(),
                Instant::now() + Duration::from_secs(seconds),
            ));
        }
    }

    /// An access token; new when the last one is about to end or was refused.
    pub fn access_token(&self, force: bool) -> Result<String, DriveError> {
        let refresh = {
            let state = self.state.lock().unwrap();
            let refresh = state.refresh.clone().ok_or(DriveError::Unauthorized)?;
            if !force {
                if let Some((token, ends)) = &state.access {
                    if *ends > Instant::now() + Duration::from_secs(60) {
                        return Ok(token.clone());
                    }
                }
            }
            refresh
        };
        match self.token_request(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]) {
            Ok(body) => {
                self.remember_access(&body);
                body["access_token"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| DriveError::Failed("no access_token".into()))
            }
            Err(TokenFailure::Revoked) => {
                self.drop_key();
                Err(DriveError::Unauthorized)
            }
            Err(TokenFailure::Other(error)) => Err(error),
        }
    }

    fn drop_key(&self) {
        *self.state.lock().unwrap() = State::default();
        self.store.clear();
    }

    /// Signs in through the system browser. `open` gets the address to open; the answer
    /// comes back on a port of this computer, for one request.
    pub fn connect(&self, open: impl FnOnce(&str) -> Result<(), String>) -> Result<(), DriveError> {
        let client = self.client.as_ref().ok_or(DriveError::NotConfigured)?;
        let verifier = random_url_safe(48);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_url_safe(16);

        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| DriveError::Failed(e.to_string()))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| DriveError::Failed("no port".into()))?
            .port();
        let redirect = format!("http://127.0.0.1:{port}/");

        let url = Url::parse_with_params(
            &self.endpoints.auth,
            &[
                ("client_id", client.id.as_str()),
                ("redirect_uri", &redirect),
                ("response_type", "code"),
                ("scope", DRIVE_SCOPE),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("state", &state),
                ("access_type", "offline"),
                // Without it a second sign-in brings no refresh token.
                ("prompt", "consent"),
            ],
        )
        .map_err(|e| DriveError::Failed(e.to_string()))?;
        open(url.as_str()).map_err(DriveError::Failed)?;

        let code = wait_for_answer(&server, &state, self.sign_in_timeout)?;
        drop(server);

        let body = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &redirect),
                ("code_verifier", &verifier),
            ])
            .map_err(|failure| match failure {
                TokenFailure::Revoked => DriveError::Failed("invalid_grant".into()),
                TokenFailure::Other(error) => error,
            })?;
        let granted = body["scope"]
            .as_str()
            .is_none_or(|scope| scope.split_whitespace().any(|s| s == DRIVE_SCOPE));
        if !granted {
            return Err(DriveError::Scope);
        }
        let refresh = body["refresh_token"]
            .as_str()
            .ok_or_else(|| DriveError::Failed("kein refresh_token".into()))?
            .to_owned();
        self.state.lock().unwrap().refresh = Some(refresh.clone());
        self.remember_access(&body);
        // Without a safe place the sign-in lives until the program ends; saying so is the caller's job.
        let _ = self.store.save(&refresh);
        Ok(())
    }

    /// Forgets the key here and withdraws it at Google, so the grant does not linger in the account.
    pub fn disconnect(&self) {
        let token = self.state.lock().unwrap().refresh.clone();
        self.drop_key();
        if let Some(token) = token {
            // A failure here leaves only a grant nobody holds.
            let _ = self
                .http
                .post(&self.endpoints.revoke)
                .send_form([("token", token.as_str())]);
        }
    }
}

/// Waits for the browser's one request and answers it. `state` must come back unchanged.
fn wait_for_answer(
    server: &tiny_http::Server,
    state: &str,
    timeout: Duration,
) -> Result<String, DriveError> {
    let deadline = Instant::now() + timeout;
    let base = Url::parse("http://127.0.0.1/").expect("a fixed address");
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(DriveError::Timeout);
        }
        let request = match server.recv_timeout(left) {
            Ok(Some(request)) => request,
            Ok(None) => return Err(DriveError::Timeout),
            Err(e) => return Err(DriveError::Failed(e.to_string())),
        };
        let Ok(url) = base.join(request.url()) else {
            let _ = request.respond(tiny_http::Response::empty(400));
            continue;
        };
        let param = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        // The browser also asks for /favicon.ico; only the answer counts.
        let Some(got_state) = param("state") else {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        };
        let same_state = got_state == state;
        let error = param("error");
        let code = param("code");
        let ok = same_state && error.is_none() && code.is_some();
        let page = tiny_http::Response::from_string(answer_page(ok)).with_header(
            tiny_http::Header::from_bytes("content-type", "text/html; charset=utf-8")
                .expect("a valid header"),
        );
        let _ = request.respond(page);
        if !same_state {
            return Err(DriveError::Failed("state".into()));
        }
        if let Some(error) = error {
            return Err(if error == "access_denied" {
                DriveError::Denied
            } else {
                DriveError::Failed(error)
            });
        }
        return code.ok_or_else(|| DriveError::Failed("kein code".into()));
    }
}
