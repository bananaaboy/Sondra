//! What an address says about the episode it names (`parseLinkEpisodeInfo`, `deriveLinkTitle` in
//! `src/lib/download.ts`) — the same patterns, so an entry saved from a link is read the same way.

use std::sync::OnceLock;

use regex::Regex;
use url::Url;

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("a fixed pattern"))
}

macro_rules! rx {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        re(&CELL, $pattern)
    }};
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkEpisodeInfo {
    pub season: i64,
    pub episode: Option<i64>,
    pub is_episodic_url: bool,
    pub series_slug: Option<String>,
}

fn plain() -> LinkEpisodeInfo {
    LinkEpisodeInfo {
        season: 1,
        episode: Some(1),
        is_episodic_url: false,
        series_slug: None,
    }
}

/// `https://` put before what has no scheme, as the web app does before it asks `new URL`.
fn parse(raw: &str) -> Option<Url> {
    let trimmed = raw.trim();
    let with_scheme = if rx!(r"(?i)^https?://").is_match(trimmed) {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    Url::parse(&with_scheme).ok()
}

fn is_aniworld_host(host: &str) -> bool {
    rx!(r"(?i)^(?:[a-z0-9-]+\.)*(?:aniworld\.(?:to|la)|s\.to|serienstream\.(?:to|sx))$")
        .is_match(host)
}

fn number(captures: &regex::Captures, group: usize) -> i64 {
    captures[group].parse::<i64>().unwrap_or(0)
}

/// A query parameter as `searchParams.get` gives it: the first one, decoded; empty counts as absent.
fn query(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// JS `Number(text)` for the plain cases that matter here: a decimal number, or nothing.
fn js_number(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

pub fn parse_link_episode_info(raw: &str) -> LinkEpisodeInfo {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return plain();
    }
    let Some(url) = parse(trimmed) else {
        return plain();
    };
    let path = url.path();
    let host = url.host_str().unwrap_or("");

    if is_aniworld_host(host) {
        let slug = rx!(r"(?i)/(?:anime|serie)/stream/([^/?#]+)")
            .captures(path)
            .map(|c| c[1].to_string());
        let is_filme = rx!(r"(?i)/filme(?:/|$)").is_match(path);
        let season = if is_filme {
            0
        } else if let Some(c) = rx!(r"(?i)/staffel-(\d+)").captures(path) {
            number(&c, 1).max(1)
        } else {
            1
        };
        let episode = rx!(r"(?i)/(?:episode|film)-(\d+)")
            .captures(path)
            .map(|c| number(&c, 1).max(1));
        return LinkEpisodeInfo {
            season,
            episode,
            is_episodic_url: true,
            series_slug: slug,
        };
    }

    if let Some(c) = rx!(r"(?i)/(?:watch|v|d)/[^/]+-episode-(\d+)").captures(path) {
        return LinkEpisodeInfo {
            season: 1,
            episode: Some(number(&c, 1).max(1)),
            is_episodic_url: true,
            series_slug: None,
        };
    }

    if let Some(c) = rx!(r"(?i)(?:/player)?/tv/\d+/(\d+)/(\d+)").captures(path) {
        return LinkEpisodeInfo {
            season: number(&c, 1).max(1),
            episode: Some(number(&c, 2).max(1)),
            is_episodic_url: true,
            series_slug: None,
        };
    }

    let q_season = query(&url, "season")
        .filter(|s| !s.is_empty())
        .or_else(|| query(&url, "staffel").filter(|s| !s.is_empty()));
    let q_episode = query(&url, "episode")
        .filter(|s| !s.is_empty())
        .or_else(|| query(&url, "folge").filter(|s| !s.is_empty()))
        .or_else(|| query(&url, "index").filter(|s| !s.is_empty()));
    let has_list = url.query_pairs().any(|(key, _)| key == "list");
    if q_season.is_some() || q_episode.is_some() || has_list {
        let season = q_season
            .as_deref()
            .and_then(js_number)
            .map_or(1, |n| (n.max(0.0)) as i64);
        let episode = q_episode
            .as_deref()
            .and_then(js_number)
            .map(|n| (n.max(1.0)) as i64);
        return LinkEpisodeInfo {
            season,
            episode,
            is_episodic_url: true,
            series_slug: None,
        };
    }

    if let Some(c) = rx!(r"(?i)/s(\d{1,2})e(\d{1,3})(?:/|$|-|\.)").captures(path) {
        return LinkEpisodeInfo {
            season: number(&c, 1).max(0),
            episode: Some(number(&c, 2).max(1)),
            is_episodic_url: true,
            series_slug: None,
        };
    }

    let season = rx!(r"(?i)/(?:staffel|season)[-_]?(\d+)").captures(path);
    let episode = rx!(r"(?i)/(?:episode|folge|ep|film)[-_]?(\d+)").captures(path);
    if season.is_some() || episode.is_some() {
        return LinkEpisodeInfo {
            season: season.map_or(1, |c| number(&c, 1).max(0)),
            episode: episode.map(|c| number(&c, 1).max(1)),
            is_episodic_url: true,
            series_slug: None,
        };
    }
    plain()
}

/// `decodeURIComponent`: percent escapes to text; `None` where JS would throw (a broken escape, bytes
/// that are no UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Each letter that starts a word in capitals — `\b\w` with ASCII words, as JS has them.
fn capitalise_words(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut previous_is_word = false;
    for ch in text.chars() {
        let is_word = ch.is_ascii_alphanumeric() || ch == '_';
        if is_word && !previous_is_word {
            out.extend(ch.to_uppercase());
        } else {
            out.push(ch);
        }
        previous_is_word = is_word;
    }
    out
}

pub fn derive_link_title(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "Gespeicherter Link".into();
    }
    let fallback = || {
        let units: Vec<u16> = trimmed.encode_utf16().take(48).collect();
        String::from_utf16_lossy(&units)
    };
    let Some(url) = parse(trimmed) else {
        return fallback();
    };
    let host = rx!(r"(?i)^www\.")
        .replace(url.host_str().unwrap_or(""), "")
        .into_owned();
    if is_aniworld_host(&host) {
        if let Some(c) = rx!(r"(?i)/(?:anime|serie)/stream/([^/?#]+)").captures(url.path()) {
            let Some(decoded) = decode_uri_component(&c[1]) else {
                return fallback();
            };
            let spaced = rx!(r"[-_]+").replace_all(&decoded, " ");
            return capitalise_words(&spaced);
        }
    }
    let segments: Vec<&str> = url
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .filter(|s| {
            !rx!(r"(?i)^(?:watch|stream|anime|serie|video|embed|v|staffel-\d+|episode-\d+|filme|film-\d+)$")
                .is_match(s)
        })
        .collect();
    if let Some(last) = segments.last() {
        if last.chars().count() > 2 {
            let Some(decoded) = decode_uri_component(last) else {
                return fallback();
            };
            let no_ext = rx!(r"(?i)\.[a-z0-9]{2,4}$").replace(&decoded, "");
            let spaced = rx!(r"[-_]+").replace_all(&no_ext, " ");
            let cleaned = spaced.trim();
            if !cleaned.is_empty() {
                return capitalise_words(cleaned);
            }
        }
    }
    if let Some(v) = query(&url, "v").filter(|v| !v.is_empty()) {
        return format!("{host} ({v})");
    }
    host
}
