//! The embed hosters behind the series sites: Filemoon, Vidmoly, Doodstream, Streamtape, Vidoza.
//! Ports of the matching functions of `api/extractors.js`.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use regex::Regex;
use serde_json::Value;
use url::Url;

use crate::aniworld::is_aniworld_url;
use crate::fetch::{html_request, Fetch, Request, DEFAULT_USER_AGENT};
use crate::packer;
use crate::stream::{b64_lenient, utf8_lossy, StreamInfo};

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

const VOE_HOSTS: &str = r"(?i)(?:^|\.)(?:voe\.sx|tube\.sx|jamesbornmain\.com|chaliceguzzlerlandlord\.com|jeremyparticipantanything\.com|voe-network\.net|repackcloud\.com|playercdn\.net|launchingforgive\.com|youdadad\.com|generousscoundrel\.com|bigtitssexy\.com|greenteabear\.com|jilliandietrich\.com|leonaheavens\.com|tuktukstream\.com|stephaniecorneliussen\.net)$";
const FILEMOON_HOSTS: &str = r"(?i)(?:^|\.)(?:filemoon\.(?:sx|to|in|nl|wf|top|me)|kerapoxy\.cc|moonmov\.pro|moonplayer\.net|embedmoon\.xyz)$";
const VIDMOLY_HOSTS: &str = r"(?i)(?:^|\.)(?:vidmoly\.(?:to|me|net|in|org))$";
const DOOD_HOSTS: &str = r"(?i)(?:^|\.)(?:dood\.(?:to|so|ws|wf|re|pm|la|li|watch|cx|yt|stream)|doodstream\.(?:com|co)|dsvplay\.com|myvidplay\.com|playmogo\.com|d0o0d\.com|dooood\.com|ds2play\.com)$";
const STREAMTAPE_HOSTS: &str =
    r"(?i)(?:^|\.)(?:streamtape\.(?:com|net|to|xyz)|streamta\.pe|streamadblocker\.com)$";
const VIDOZA_HOSTS: &str = r"(?i)(?:^|\.)(?:vidoza\.(?:net|org|co))$";

/// Host and path of a link, the two things the checks below look at.
fn parts(raw: &str) -> Option<(String, String)> {
    let url = Url::parse(raw).ok()?;
    Some((url.host_str()?.to_owned(), url.path().to_owned()))
}

pub fn is_filemoon_url(raw: &str) -> bool {
    parts(raw).is_some_and(|(h, p)| {
        rx(FILEMOON_HOSTS).is_match(&h) || h.contains("filemoon") || p.contains("/filemoon/")
    })
}

pub fn is_vidmoly_url(raw: &str) -> bool {
    parts(raw).is_some_and(|(h, p)| {
        rx(VIDMOLY_HOSTS).is_match(&h) || h.contains("vidmoly") || p.contains("/vidmoly/")
    })
}

pub fn is_doodstream_url(raw: &str) -> bool {
    parts(raw).is_some_and(|(h, p)| {
        rx(DOOD_HOSTS).is_match(&h)
            || h.contains("dood")
            || h.contains("dsvplay")
            || h.contains("playmogo")
            || p.contains("/dood/")
    })
}

pub fn is_streamtape_url(raw: &str) -> bool {
    parts(raw).is_some_and(|(h, p)| {
        rx(STREAMTAPE_HOSTS).is_match(&h) || h.contains("streamtape") || p.contains("/streamtape/")
    })
}

pub fn is_vidoza_url(raw: &str) -> bool {
    parts(raw).is_some_and(|(h, p)| {
        rx(VIDOZA_HOSTS).is_match(&h) || h.contains("vidoza") || p.contains("/vidoza/")
    })
}

pub fn is_voe_url(raw: &str) -> bool {
    let Some((host, path)) = parts(raw) else {
        return false;
    };
    if rx(VOE_HOSTS).is_match(&host) || host.contains("voe") || path.contains("/voe/") {
        return true;
    }
    // Do not falsely claim other known hosters when the path starts with /e/.
    if is_filemoon_url(raw)
        || is_vidmoly_url(raw)
        || is_doodstream_url(raw)
        || is_streamtape_url(raw)
        || is_vidoza_url(raw)
        || is_aniworld_url(raw)
    {
        return false;
    }
    path.starts_with("/e/")
}

pub fn is_hoster_url(raw: &str) -> bool {
    is_voe_url(raw)
        || is_filemoon_url(raw)
        || is_vidmoly_url(raw)
        || is_doodstream_url(raw)
        || is_streamtape_url(raw)
        || is_vidoza_url(raw)
}

fn title_of(html: &str, strip: &str, default: &str) -> String {
    rx(r"(?i)<title>([^<]+)</title>")
        .captures(html)
        .map(|c| {
            rx(&format!("(?i) - {strip}.*$"))
                .replace(&c[1], "")
                .trim()
                .to_owned()
        })
        .unwrap_or_else(|| default.to_owned())
}

fn join(base: &str, relative: &str) -> Option<String> {
    Url::parse(base)
        .ok()?
        .join(relative)
        .ok()
        .map(|u| u.to_string())
}

/* Filemoon */

fn filemoon_api(data: &Value, current: &str) -> Option<StreamInfo> {
    let pb = &data["playback"];
    let parts = pb["key_parts"].as_array()?;
    let key: Vec<u8> = parts
        .iter()
        .filter_map(Value::as_str)
        .flat_map(b64_lenient)
        .collect();
    let iv = b64_lenient(pb["iv"].as_str()?);
    let payload = b64_lenient(pb["payload"].as_str()?);
    if payload.len() < 16 || key.len() != 32 || iv.len() != 12 {
        return None;
    }
    // AES-256-GCM; the tag is the last sixteen bytes, which is how the `aes-gcm` crate reads them too.
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &payload,
                aad: b"",
            },
        )
        .ok()?;
    let inner: Value = serde_json::from_slice(&plain).ok()?;
    let sources = inner["sources"].as_array()?;
    let chosen = sources
        .iter()
        .find(|s| {
            s["mime_type"]
                .as_str()
                .is_some_and(|m| m.contains("mpegurl"))
                || s["url"].as_str().is_some_and(|u| u.contains(".m3u8"))
        })
        .or_else(|| sources.first())?;
    let raw = chosen["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| chosen["file"].as_str().filter(|s| !s.is_empty()))?;
    Some(StreamInfo {
        title: data["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or("FileMoon Video")
            .to_owned(),
        url: join(current, raw)?,
        is_hls: true,
        referer: current.to_owned(),
        hoster: "Filemoon".into(),
    })
}

pub fn extract_filemoon(fetch: &dyn Fetch, url: &str) -> Option<StreamInfo> {
    let mut current = url.to_owned();
    let page = fetch.fetch(&html_request(&current, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let mut html = page.body;

    // 1. A nested player.
    if let Some(src) = rx(r#"(?i)<iframe\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]"#)
        .captures(&html)
        .map(|c| c[1].to_owned())
    {
        if !src.contains("about:blank") {
            if let Some(frame) = join(&current, &src) {
                if let Ok(p) = fetch.fetch(&html_request(&frame, Some(&current))) {
                    if p.ok() {
                        html = p.body;
                        current = frame;
                    }
                }
            }
        }
    }

    let parsed = Url::parse(&current).ok()?;
    let code = parsed
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned();

    // 2. The modern API.
    if !code.is_empty() && code != "e" && code != "d" {
        let prefix = if parsed.path().contains("/filemoon/") {
            "/filemoon"
        } else {
            ""
        };
        let host = match parsed.port() {
            Some(port) => format!("{}:{port}", parsed.host_str()?),
            None => parsed.host_str()?.to_owned(),
        };
        let api = format!("{}://{host}{prefix}/api/videos/{code}", parsed.scheme());
        let mut request = html_request(&api, Some(&current));
        request.headers.retain(|(n, _)| n != "Accept");
        request.headers.push((
            "Accept".into(),
            "application/json, text/javascript, */*".into(),
        ));
        request
            .headers
            .push(("X-Requested-With".into(), "XMLHttpRequest".into()));
        if let Ok(p) = fetch.fetch(&request) {
            if p.ok() {
                if let Some(stream) = serde_json::from_str::<Value>(&p.body)
                    .ok()
                    .and_then(|d| filemoon_api(&d, &current))
                {
                    return Some(stream);
                }
            }
        }
    }

    // 3. The packed script.
    let unpacked = packer::unpack(&html);
    let target = unpacked.as_deref().unwrap_or(&html);
    let found = rx(r#"file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]"#)
        .captures(target)
        .or_else(|| rx(r#"sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]"#).captures(target))
        .or_else(|| rx(r#"(https?://[^'"\s]+\.m3u8[^'"\s]*)"#).captures(target))?;
    Some(StreamInfo {
        title: title_of(&html, "FileMoon", "FileMoon Video"),
        url: join(&current, &found[1])?,
        is_hls: true,
        referer: current,
        hoster: "Filemoon".into(),
    })
}

/* Vidmoly */

pub fn extract_vidmoly(fetch: &dyn Fetch, url: &str) -> Option<StreamInfo> {
    let parsed = Url::parse(url).ok()?;
    let embed_id = rx(r"/embed-([a-zA-Z0-9]+)\.html")
        .captures(parsed.path())
        .or_else(|| rx(r"/([a-zA-Z0-9]+)$").captures(parsed.path()))
        .map(|c| c[1].to_owned())
        .unwrap_or_default();
    let target = if !embed_id.is_empty() && !parsed.path().contains("/embed-") {
        format!(
            "{}/embed-{embed_id}.html",
            parsed.origin().ascii_serialization()
        )
    } else {
        url.to_owned()
    };
    let mut request = html_request(&target, Some("https://vidmoly.to/"));
    if !embed_id.is_empty() {
        request.headers.push((
            "Cookie".into(),
            format!("cf_turnstile_demo_pass_{embed_id}=1"),
        ));
    }
    let page = fetch.fetch(&request).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;
    let searched = match packer::unpack(&html) {
        Some(unpacked) => format!("{html}\n{unpacked}"),
        None => html.clone(),
    };
    let found = rx(r#"sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]"#)
        .captures(&searched)
        .or_else(|| rx(r#"file\s*:\s*['"](https?://[^'"]+\.m3u8[^'"]*)['"]"#).captures(&searched))
        .or_else(|| rx(r#"['"](https?://[^'"]+\.m3u8[^'"]*)['"]"#).captures(&searched))?;
    Some(StreamInfo {
        title: title_of(&html, "Vidmoly", "Vidmoly Video"),
        url: join(&target, &found[1])?,
        is_hls: true,
        referer: "https://vidmoly.to/".into(),
        hoster: "Vidmoly".into(),
    })
}

/* Doodstream */

/// `now_ms` and the ten-letter token make the address unique, as the site expects.
pub fn extract_doodstream(fetch: &dyn Fetch, url: &str, now_ms: i64) -> Option<StreamInfo> {
    let mut normalized = rx(r"/(?:d|f)/").replace(url, "/e/").into_owned();
    if !normalized.contains("/e/") {
        normalized = rx(r"/([a-zA-Z0-9]+)$")
            .replace(&normalized, "/e/$1")
            .into_owned();
    }
    let page = fetch.fetch(&html_request(&normalized, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;
    let pass = rx(r#"/pass_md5/[^'"<>\s]+"#)
        .find(&html)?
        .as_str()
        .to_owned();
    let origin = Url::parse(&normalized).ok()?.origin().ascii_serialization();
    let mut request = Request {
        url: format!("{origin}{pass}"),
        follow_redirects: true,
        ..Request::default()
    };
    request.headers = vec![
        ("Referer".into(), normalized.clone()),
        ("User-Agent".into(), DEFAULT_USER_AGENT.into()),
    ];
    let answer = fetch.fetch(&request).ok()?;
    if !answer.ok() {
        return None;
    }
    let base = answer.body.trim().to_owned();
    if base.is_empty() || base.contains("RELOAD") {
        return None;
    }
    const LETTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut random = [0u8; 10];
    getrandom::fill(&mut random).ok()?;
    let token: String = random
        .iter()
        .map(|b| LETTERS[usize::from(*b) % LETTERS.len()] as char)
        .collect();
    let raw = format!(
        "{base}{token}?token={}&expiry={now_ms}",
        pass.rsplit('/').next().unwrap_or("")
    );
    let final_url = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw
    };
    Some(StreamInfo {
        title: title_of(&html, "Dood", "DoodStream Video"),
        url: final_url,
        is_hls: false,
        referer: normalized,
        hoster: "Doodstream".into(),
    })
}

/* Streamtape */

fn with_stream_flag(link: String) -> String {
    if link.contains("stream=1") {
        link
    } else {
        format!(
            "{link}{}stream=1",
            if link.contains('?') { '&' } else { '?' }
        )
    }
}

/// The address Streamtape builds in JavaScript by joining substrings: `'//host/get?x=' + ('abcTOKEN').substring(3)`.
fn assemble(expression: &str) -> String {
    let string = rx(r#"['"]([^'"]*)['"]"#);
    let offset = rx(r"\.substring\((\d+)\)");
    let mut assembled = String::new();
    for part in expression.split('+') {
        let Some(found) = string.captures(part) else {
            continue;
        };
        let mut value: Vec<char> = found[1].chars().collect();
        for skip in offset.captures_iter(part) {
            let n: usize = skip[1].parse().unwrap_or(0);
            value = value.into_iter().skip(n).collect();
        }
        assembled.extend(value);
    }
    assembled
}

pub fn extract_streamtape(fetch: &dyn Fetch, url: &str) -> Option<StreamInfo> {
    let normalized = rx(r"/v/").replace(url, "/e/").into_owned();
    let page = fetch.fetch(&html_request(&normalized, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;

    let expression =
        rx(r#"(?i)ById\(['"]([a-zA-Z0-9_]*link[a-zA-Z0-9_]*)['"]\)\.innerHTML\s*=\s*([^;]+);"#)
            .captures(&html)
            .map(|c| c[2].to_owned())
            .or_else(|| {
                rx(r"(?i)innerHTML\s*=\s*([^\n;]+norobotlink[^\n;]+)")
                    .captures(&html)
                    .map(|c| c[1].to_owned())
            })
            .or_else(|| {
                rx(r#"(?i)(['"]//streamtape\.com/get_video\?[^;]+)"#)
                    .captures(&html)
                    .map(|c| c[1].to_owned())
            });

    let mut link = expression
        .map(|e| assemble(&e))
        .filter(|a| !a.is_empty())
        .map(|assembled| {
            let link = if assembled.starts_with("//") {
                format!("https:{assembled}")
            } else {
                assembled
            };
            let link = if link.starts_with("http") {
                link
            } else {
                format!("https://{link}")
            };
            with_stream_flag(link)
        });
    if link.is_none() {
        link = rx(r#"(https?://[^'"]+streamtape\.com/get_video\?[^'"]+)"#)
            .captures(&html)
            .map(|c| with_stream_flag(c[1].to_owned()));
    }
    let link = link?;

    let title = rx(r"(?i)<title>([^<]+)</title>")
        .captures(&html)
        .or_else(|| rx(r#"(?i)name="og:title"\s+content="([^"]+)""#).captures(&html))
        .map(|c| {
            rx(r"(?i) - Streamtape.*$")
                .replace(&c[1], "")
                .trim()
                .to_owned()
        })
        .unwrap_or_else(|| "Streamtape Video".into());
    Some(StreamInfo {
        title,
        url: link,
        is_hls: false,
        referer: normalized,
        hoster: "Streamtape".into(),
    })
}

/* Vidoza */

pub fn extract_vidoza(fetch: &dyn Fetch, url: &str) -> Option<StreamInfo> {
    let target = rx(r"/([a-zA-Z0-9]+)(\.html)?$")
        .replace(url, |c: &regex::Captures| {
            if c[1].starts_with("embed-") {
                c[0].to_owned()
            } else {
                format!("/embed-{}.html", &c[1])
            }
        })
        .into_owned();
    let page = fetch.fetch(&html_request(&target, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;
    let found = rx(r#"(?i)<source\s+src=['"]([^'"]+)['"]\s+type=['"]video/mp4['"]"#)
        .captures(&html)
        .or_else(|| {
            rx(r#"(?i)sourcesCode\s*:\s*\[\{\s*src\s*:\s*['"]([^'"]+)['"]"#).captures(&html)
        })
        .or_else(|| {
            rx(r#"(?i)file\s*:\s*['"](https?://[^'"]+\.(?:mp4|m3u8)[^'"]*)['"]"#).captures(&html)
        })
        .or_else(|| rx(r#"(?i)file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]"#).captures(&html))?;
    let stream = join(&target, &found[1])?;
    Some(StreamInfo {
        title: title_of(&html, "Vidoza", "Vidoza Video"),
        is_hls: stream.contains(".m3u8"),
        url: stream,
        referer: target,
        hoster: "Vidoza".into(),
    })
}

/// A decoded page body, for the callers that only have bytes.
pub fn body_text(bytes: &[u8]) -> String {
    utf8_lossy(bytes)
}
