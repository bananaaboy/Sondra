//! Keys, ids, records and messages.

use std::collections::HashMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const ID_LENGTH: usize = 20;
const NAME_MAX: usize = 40;
/// How old a message may be and still count, in milliseconds.
pub const MESSAGE_MAX_AGE: f64 = 15.0 * 60_000.0;
/// At most this many capabilities, each a short lower-case word; anything else is not a record.
const CAPS_MAX: usize = 16;

/// JSON with its keys in order, so the same value always signs the same: `canonical` of the web app,
/// character for character (keys by UTF-16 code unit, numbers and strings as `JSON.stringify` writes them).
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n),
        Value::String(s) => js_string(s),
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            format!("{{{}}}", entries.iter().map(|(k, v)| format!("{}:{}", js_string(k), canonical(v))).collect::<Vec<_>>().join(","))
        }
    }
}

/// A number as `JSON.stringify` writes it: `5` for 5.0, no trailing `.0`.
fn js_number(n: &serde_json::Number) -> String {
    if let Some(f) = n.as_f64() {
        if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e21 {
            return format!("{}", f as i128);
        }
    }
    n.to_string()
}

/// A string as `JSON.stringify` writes it.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn base32(bytes: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        // Keep only what has not been written, so the number never grows.
        value &= (1u32 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Only what makes the key the key; a JWK may carry `ext`, `key_ops` and the like.
fn public_part(jwk: &Value) -> Value {
    json!({ "kty": jwk.get("kty"), "crv": jwk.get("crv"), "x": jwk.get("x"), "y": jwk.get("y") })
}

/// This device's keys. The private half signs; where it is kept is the app's business.
pub struct DeviceKeys {
    signing: SigningKey,
    pub public_jwk: Value,
}

impl DeviceKeys {
    /// A new key pair.
    pub fn generate() -> DeviceKeys {
        Self::from_signing(SigningKey::random(&mut rand_core::OsRng))
    }

    /// The pair with this private scalar (32 bytes), as it was kept.
    pub fn from_bytes(bytes: &[u8]) -> Option<DeviceKeys> {
        SigningKey::from_slice(bytes).ok().map(Self::from_signing)
    }

    /// The private scalar, for the app to keep (protected) — never to send anywhere.
    pub fn secret_bytes(&self) -> Vec<u8> {
        self.signing.to_bytes().to_vec()
    }

    fn from_signing(signing: SigningKey) -> DeviceKeys {
        let point = signing.verifying_key().to_encoded_point(false);
        let jwk = json!({ "kty": "EC", "crv": "P-256", "x": URL_SAFE_NO_PAD.encode(point.x().expect("a point")), "y": URL_SAFE_NO_PAD.encode(point.y().expect("a point")) });
        DeviceKeys { signing, public_jwk: jwk }
    }

    pub fn id(&self) -> String {
        device_id_of(&self.public_jwk)
    }
}

/// The id a key earns: its SHA-256 (of the canonical public part), the first 100 bits, in base32.
pub fn device_id_of(jwk: &Value) -> String {
    let digest = Sha256::digest(canonical(&public_part(jwk)).as_bytes());
    base32(&digest)[..ID_LENGTH].to_string()
}

/// The four characters people see beside a name: „Laptop · 7KQ2“.
pub fn short_id(id: &str) -> &str {
    &id[..4.min(id.len())]
}

pub fn is_device_id(value: &str) -> bool {
    value.len() == ID_LENGTH && value.bytes().all(|b| ALPHABET.contains(&b))
}

fn sign_value(keys: &DeviceKeys, value: &Value) -> String {
    let mut rest = value.clone();
    if let Some(map) = rest.as_object_mut() {
        map.remove("sig");
    }
    let signature: Signature = keys.signing.sign(canonical(&rest).as_bytes());
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

fn verify_value(jwk: &Value, value: &Value) -> bool {
    let Some(sig) = value.get("sig").and_then(Value::as_str) else { return false };
    let (Some(x), Some(y)) = (jwk.get("x").and_then(Value::as_str), jwk.get("y").and_then(Value::as_str)) else { return false };
    let (Ok(x), Ok(y), Ok(sig)) = (URL_SAFE_NO_PAD.decode(x), URL_SAFE_NO_PAD.decode(y), URL_SAFE_NO_PAD.decode(sig)) else { return false };
    if x.len() != 32 || y.len() != 32 {
        return false;
    }
    let mut sec1 = vec![4u8];
    sec1.extend(&x);
    sec1.extend(&y);
    let Ok(key) = VerifyingKey::from_sec1_bytes(&sec1) else { return false };
    let Ok(signature) = Signature::from_slice(&sig) else { return false };
    let mut rest = value.clone();
    if let Some(map) = rest.as_object_mut() {
        map.remove("sig");
    }
    key.verify(canonical(&rest).as_bytes(), &signature).is_ok()
}

/// A name as it may stand: trimmed, no control characters, whitespace gathered, at most 40 characters.
pub fn clean_name(name: &str) -> String {
    let no_control: String = name.chars().filter(|c| !matches!(*c as u32, 0..=0x1f | 0x7f)).collect();
    let gathered = no_control.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    // `slice(0, 40)` counts UTF-16 units; the names are words, and a cut never splits a character here.
    let mut units = 0;
    let mut out = String::new();
    for c in gathered.chars() {
        units += c.len_utf16();
        if units > NAME_MAX {
            break;
        }
        out.push(c);
    }
    out.trim().to_string()
}

fn lower(text: &str) -> String {
    text.to_lowercase()
}

/// A name no other device carries: „Laptop“ when it is free, otherwise „Laptop 2“, „Laptop 3“ … Compared
/// without case and spaces at the ends.
pub fn unique_name(wanted: &str, others: &[String]) -> String {
    let cleaned = clean_name(wanted);
    let base = if cleaned.is_empty() { "Gerät".to_string() } else { cleaned };
    let taken: std::collections::HashSet<String> = others.iter().map(|n| lower(&clean_name(n))).collect();
    if !taken.contains(&lower(&base)) {
        return base;
    }
    // „Laptop 7“ is a name with a number: the stem is „Laptop“.
    let stem = match base.rsplit_once(' ') {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => head.to_string(),
        _ => base.clone(),
    };
    let mut n = 2;
    loop {
        let cut: String = stem.chars().take(NAME_MAX - 4).collect();
        let candidate = clean_name(&format!("{cut} {n}"));
        if !taken.contains(&lower(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// What a record says about its device, apart from the key and the signature.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordFields {
    pub name: String,
    /// `windows`, `android` or `browser`.
    pub kind: String,
    pub platform: String,
    /// Milliseconds since 1970.
    pub created: f64,
    pub seen: f64,
    pub caps: Vec<String>,
}

/// This device's record, signed.
pub fn sign_record(keys: &DeviceKeys, fields: &RecordFields) -> Value {
    let name = clean_name(&fields.name);
    let mut unsigned = Map::new();
    unsigned.insert("v".into(), json!(1));
    unsigned.insert("id".into(), json!(keys.id()));
    unsigned.insert("name".into(), json!(if name.is_empty() { "Gerät".to_string() } else { name }));
    unsigned.insert("kind".into(), json!(fields.kind));
    unsigned.insert("platform".into(), json!(clean_name(&fields.platform)));
    unsigned.insert("key".into(), keys.public_jwk.clone());
    unsigned.insert("created".into(), json!(fields.created as i64));
    unsigned.insert("seen".into(), json!(fields.seen as i64));
    // Left out when empty: an old record had no such field, and its signature must stay what it was.
    if !fields.caps.is_empty() {
        let mut caps = fields.caps.clone();
        caps.sort();
        unsigned.insert("caps".into(), json!(caps));
    }
    let unsigned = Value::Object(unsigned);
    let sig = sign_value(keys, &unsigned);
    let mut signed = unsigned;
    signed.as_object_mut().expect("an object").insert("sig".into(), json!(sig));
    signed
}

fn finite(v: Option<&Value>) -> bool {
    v.and_then(Value::as_f64).is_some_and(f64::is_finite)
}

fn cap_ok(cap: &str) -> bool {
    let b = cap.as_bytes();
    !b.is_empty() && b.len() <= 24 && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || *c == b'-')
}

/// A record read from Drive, believed only if it is whole, its id is its key's, and its owner signed
/// exactly this. Anything else is `None`.
pub fn check_record(raw: &Value) -> Option<Value> {
    let record = raw.as_object()?;
    if record.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let id = record.get("id").and_then(Value::as_str)?;
    if !is_device_id(id) {
        return None;
    }
    let key = record.get("key").filter(|k| k.is_object())?;
    let name = record.get("name").and_then(Value::as_str)?;
    if clean_name(name) != name || name.is_empty() {
        return None;
    }
    if !matches!(record.get("kind").and_then(Value::as_str), Some("windows" | "android" | "browser")) {
        return None;
    }
    if record.get("platform").and_then(Value::as_str).is_none() || !finite(record.get("created")) || !finite(record.get("seen")) {
        return None;
    }
    if let Some(caps) = record.get("caps") {
        let list = caps.as_array()?;
        if list.len() > CAPS_MAX || !list.iter().all(|c| c.as_str().is_some_and(cap_ok)) {
            return None;
        }
    }
    if device_id_of(key) != id {
        return None;
    }
    if !verify_value(key, raw) {
        return None;
    }
    Some(raw.clone())
}

/// The devices of the account from what Drive holds: per id the believable record seen last. Copies,
/// replays of older records and forgeries drop out. Newest seen first.
pub fn pick_devices(raws: &[Value]) -> Vec<Value> {
    let mut best: HashMap<String, Value> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for raw in raws {
        let Some(record) = check_record(raw) else { continue };
        let id = record["id"].as_str().unwrap_or_default().to_string();
        let seen = record["seen"].as_f64().unwrap_or(0.0);
        match best.get(&id) {
            Some(known) if known["seen"].as_f64().unwrap_or(0.0) >= seen => {}
            Some(_) => {
                best.insert(id, record);
            }
            None => {
                order.push(id.clone());
                best.insert(id, record);
            }
        }
    }
    let mut list: Vec<Value> = order.into_iter().filter_map(|id| best.remove(&id)).collect();
    // The sort is stable, as in the web app: equal `seen` keeps the order they were found in.
    list.sort_by(|a, b| b["seen"].as_f64().unwrap_or(0.0).total_cmp(&a["seen"].as_f64().unwrap_or(0.0)));
    list
}

/// A message to another device, signed by this one.
pub fn seal_message(keys: &DeviceKeys, id: &str, from: &str, to: &str, at: f64, kind: &str, transfer: &str, body: Value) -> Value {
    let unsigned = json!({ "v": 1, "id": id, "from": from, "to": to, "at": at as i64, "type": kind, "transfer": transfer, "body": body });
    let sig = sign_value(keys, &unsigned);
    let mut signed = unsigned;
    signed.as_object_mut().expect("an object").insert("sig".into(), json!(sig));
    signed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageProblem {
    Malformed,
    NotForMe,
    UnknownSender,
    Forged,
    Stale,
    Replayed,
}

/// A message is acted on only if it is for this device, from a device the account knows, signed by that
/// device's key, recent, and new.
pub fn open_message(raw: &Value, me: &str, devices: &[Value], now: f64, seen: &dyn Fn(&str) -> bool) -> Result<Value, MessageProblem> {
    let Some(m) = raw.as_object() else { return Err(MessageProblem::Malformed) };
    if m.get("v").and_then(Value::as_f64) != Some(1.0) || m.get("id").and_then(Value::as_str).is_none() || m.get("type").and_then(Value::as_str).is_none() || m.get("transfer").and_then(Value::as_str).is_none() {
        return Err(MessageProblem::Malformed);
    }
    let (from, to) = (m.get("from").and_then(Value::as_str), m.get("to").and_then(Value::as_str));
    let (Some(from), Some(to)) = (from.filter(|f| is_device_id(f)), to.filter(|t| is_device_id(t))) else { return Err(MessageProblem::Malformed) };
    if !finite(m.get("at")) {
        return Err(MessageProblem::Malformed);
    }
    if to != me {
        return Err(MessageProblem::NotForMe);
    }
    let Some(sender) = devices.iter().find(|d| d["id"].as_str() == Some(from)) else { return Err(MessageProblem::UnknownSender) };
    if !verify_value(&sender["key"], raw) {
        return Err(MessageProblem::Forged);
    }
    if (now - m["at"].as_f64().unwrap_or(0.0)).abs() > MESSAGE_MAX_AGE {
        return Err(MessageProblem::Stale);
    }
    if seen(m["id"].as_str().unwrap_or_default()) {
        return Err(MessageProblem::Replayed);
    }
    Ok(raw.clone())
}

/// A random id for a message or a transfer: 96 bits in base32.
pub fn random_id() -> String {
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).expect("the system's random numbers");
    base32(&bytes)
}

/// Can this device do `cap`? A record without the list can send and take files, nothing more.
pub fn can(device: Option<&Value>, cap: &str) -> bool {
    device.and_then(|d| d.get("caps")).and_then(Value::as_array).is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some(cap)))
}
