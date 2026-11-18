//! VOE and its clones. A port of `extractVoe`.

use regex::Regex;
use serde_json::Value;
use url::Url;

use crate::fetch::{html_request, Fetch};
use crate::stream::{b64_lenient, latin1, rot13, utf8_lossy, StreamInfo};

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

/// The scrambled payload VOE ships: rot13, noise removed, base64, every character shifted by
/// three, reversed, base64 again, then JSON.
fn decode_payload(encoded: &str) -> Option<Value> {
    let mut step1 = rot13(encoded);
    for noise in ["@$", "^^", "~@", "%?", "*~", "!!", "#&"] {
        step1 = step1.replace(noise, "");
    }
    let step2 = latin1(&b64_lenient(&step1));
    // `String.fromCharCode(code - 3)`: a code below three wraps around, as 16-bit numbers do.
    let step3: String = step2
        .chars()
        .map(|c| char::from_u32(u32::from((c as u32 as i32 - 3) as u16)).unwrap_or('\u{fffd}'))
        .collect();
    let step4: String = step3.chars().rev().collect();
    let step5 = utf8_lossy(&b64_lenient(&step4));
    serde_json::from_str(&step5).ok()
}

fn stream_of(data: &Value, fallback_title: &str, referer: &str) -> Option<StreamInfo> {
    let source = data["source"].as_str().filter(|s| !s.is_empty());
    let url = source.or_else(|| data["direct_access_url"].as_str().filter(|s| !s.is_empty()))?;
    Some(StreamInfo {
        title: data["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or(fallback_title)
            .to_owned(),
        url: url.to_owned(),
        is_hls: url.contains(".m3u8") || source.is_some(),
        referer: referer.to_owned(),
        hoster: "VOE".into(),
    })
}

pub fn extract_voe(fetch: &dyn Fetch, url: &str) -> Option<StreamInfo> {
    let mut current = url.to_owned();
    let page = fetch.fetch(&html_request(&current, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let mut html = page.body;

    // 1. A client-side redirect stub.
    let redirect =
        rx(r#"(?i)(?:window\.)?location(?:\.href|\.replace)?\s*(?:=\s*|\()\s*['"]([^'"]+)['"]"#);
    if let Some(next) = redirect
        .captures(&html)
        .and_then(|c| Url::parse(&current).ok()?.join(&c[1]).ok())
    {
        current = next.to_string();
        if let Ok(p) = fetch.fetch(&html_request(&current, None)) {
            if p.ok() {
                html = p.body;
            }
        }
    }

    let title = rx(r"(?i)<title>([^<]+)</title>")
        .captures(&html)
        .or_else(|| rx(r#"(?i)property="og:title"\s+content="([^"]+)""#).captures(&html))
        .map(|c| rx(r"(?i) - VOE.*$").replace(&c[1], "").trim().to_owned())
        .unwrap_or_else(|| "VOE Video".to_owned());

    // 2. The JSON script tags of the modern player.
    let scripts = rx(
        r#"(?i)<script\b[^>]*\btype\s*=\s*(?:"application/json"|'application/json')[^>]*>([\s\S]*?)</script>"#,
    );
    for tag in scripts.captures_iter(&html) {
        let Ok(Value::Array(list)) = serde_json::from_str::<Value>(tag[1].trim()) else {
            continue;
        };
        let Some(encoded) = list.first().and_then(Value::as_str) else {
            continue;
        };
        if let Some(stream) = decode_payload(encoded).and_then(|d| stream_of(&d, &title, &current))
        {
            return Some(stream);
        }
    }

    // 2b. The same payload in a script variable.
    if let Some(c) = rx(r#"(?:var|const|let)\s+(?:wc0|sourcesContent|payload)\s*=\s*['"]([A-Za-z0-9+/=@$^~%*!#&]+)['"]"#).captures(&html) {
        if let Some(stream) = decode_payload(&c[1]).and_then(|d| stream_of(&d, &title, &current)) {
            return Some(stream);
        }
    }

    // 3. Inline definitions, plain or in base64.
    let plain_or_b64 = |candidate: &str| -> Option<String> {
        let found = if candidate.starts_with("http") {
            candidate.to_owned()
        } else {
            utf8_lossy(&b64_lenient(candidate))
        };
        found.starts_with("http").then_some(found)
    };
    for (key, is_hls) in [("hls", true), ("mp4", false)] {
        let pattern = format!(r#"(?i)['"]{key}['"]\s*:\s*['"]([^'"]+)['"]"#);
        if let Some(url) = rx(&pattern)
            .captures(&html)
            .and_then(|c| plain_or_b64(&c[1]))
        {
            return Some(StreamInfo {
                title,
                url,
                is_hls,
                referer: current,
                hoster: "VOE".into(),
            });
        }
    }

    // 4. Any m3u8 in the page.
    if let Some(c) = rx(r#"(https?://[^'"\s]+\.m3u8[^'"\s]*)"#).captures(&html) {
        return Some(StreamInfo {
            title,
            url: c[1].to_owned(),
            is_hls: true,
            referer: current,
            hoster: "VOE".into(),
        });
    }
    None
}
