//! An AniWorld / SerienStream episode page: its hoster links, resolved to streams you can play.
//! Ports of `extractAniworld`, `resolveAniworldRedirect` and `extractDirectHoster`.

use regex::Regex;
use serde::Serialize;
use url::Url;

use crate::aniworld::{is_aniworld_season_url, parse_language};
use crate::fetch::{html_request, Fetch};
use crate::hosters::{
    extract_doodstream, extract_filemoon, extract_streamtape, extract_vidmoly, extract_vidoza,
    is_doodstream_url, is_filemoon_url, is_streamtape_url, is_vidmoly_url, is_vidoza_url,
    is_voe_url,
};
use crate::stream::StreamInfo;
use crate::voe::extract_voe;

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

fn language_label(key: u32) -> Option<&'static str> {
    match key {
        1 => Some("Deutsch"),
        2 => Some("Englisch Sub"),
        3 => Some("Deutsch Sub"),
        _ => None,
    }
}

/// Where a redirect link of the site leads: the hoster's embed page.
pub fn resolve_redirect(fetch: &dyn Fetch, redirect_url: &str, referer: &str) -> Option<String> {
    let mut request = html_request(redirect_url, Some(referer));
    request.follow_redirects = false;
    let page = fetch.fetch(&request).ok()?;
    let base = Url::parse(redirect_url).ok()?;
    if let Some(location) = page.location.as_deref().filter(|l| !l.is_empty()) {
        return base.join(location).ok().map(|u| u.to_string());
    }
    if !page.url.is_empty() && page.url != redirect_url {
        return Some(page.url);
    }
    if page.ok() {
        let found = rx(
            r#"(?i)<meta[^>]+http-equiv=['"]refresh['"][^>]+content=['"]\d+;\s*url=['"]?([^'">]+)"#,
        )
        .captures(&page.body)
        .or_else(|| {
            rx(r#"(?i)(?:window\.)?location(?:\.href|\.replace)?\s*(?:=\s*|\()\s*['"]([^'"]+)['"]"#)
                .captures(&page.body)
        })
        .or_else(|| {
            rx(r#"(?i)<a\b[^>]+href=['"]([^'"]+)['"][^>]*>\s*(?:hier|click|weiter|redirect)"#)
                .captures(&page.body)
        });
        if let Some(found) = found {
            return base.join(&found[1]).ok().map(|u| u.to_string());
        }
    }
    None
}

/// The hoster the address belongs to, asked first; then, for a link no check knows, the three
/// extractors that cope with unbranded clones.
pub fn extract_direct_hoster(fetch: &dyn Fetch, raw_url: &str, now_ms: i64) -> Option<StreamInfo> {
    if is_filemoon_url(raw_url) {
        if let Some(found) = extract_filemoon(fetch, raw_url) {
            return Some(found);
        }
    }
    if is_streamtape_url(raw_url) {
        if let Some(found) = extract_streamtape(fetch, raw_url) {
            return Some(found);
        }
    }
    if is_vidmoly_url(raw_url) {
        if let Some(found) = extract_vidmoly(fetch, raw_url) {
            return Some(found);
        }
    }
    if is_vidoza_url(raw_url) {
        if let Some(found) = extract_vidoza(fetch, raw_url) {
            return Some(found);
        }
    }
    if is_doodstream_url(raw_url) {
        if let Some(found) = extract_doodstream(fetch, raw_url, now_ms) {
            return Some(found);
        }
    }
    if is_voe_url(raw_url) {
        if let Some(found) = extract_voe(fetch, raw_url) {
            return Some(found);
        }
    }
    extract_voe(fetch, raw_url)
        .or_else(|| extract_filemoon(fetch, raw_url))
        .or_else(|| extract_streamtape(fetch, raw_url))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HosterEntry {
    pub lang_key: u32,
    pub lang_label: String,
    pub hoster_name: String,
    pub redirect_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedStream {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub language: String,
    pub lang_key: u32,
    pub url: String,
    pub is_hls: bool,
    pub referer: String,
    pub ext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableLanguage {
    pub key: u32,
    pub code: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub title: String,
    pub series_title: String,
    pub season: u32,
    pub episode: u32,
    pub url: String,
    pub is_hls: bool,
    pub referer: String,
    pub hoster: String,
    pub language: String,
    pub lang_key: u32,
    pub available_languages: Vec<AvailableLanguage>,
    pub streams: Vec<ResolvedStream>,
    pub all_entries: Vec<HosterEntry>,
}

fn pad2(n: u32) -> String {
    format!("{n:02}")
}

fn hoster_entries(html: &str, origin: &str) -> Vec<HosterEntry> {
    let mut entries = Vec::new();
    let item = rx(r#"(?i)<li\b[^>]*class=['"][^'"]*episodeLink[^'"]*['"][^>]*>([\s\S]*?)</li>"#);
    for found in item.captures_iter(html) {
        let whole = &found[0];
        let inner = &found[1];
        let lang = rx(r#"data-lang-key=['"](\d+)['"]"#).captures(whole);
        let target = rx(r#"data-link-target=['"]([^'"]+)['"]"#)
            .captures(whole)
            .or_else(|| rx(r#"href=['"]([^'"]*/redirect/\d+)['"]"#).captures(whole));
        let name = rx(r"(?i)<h4[^>]*>([^<]+)</h4>")
            .captures(inner)
            .or_else(|| rx(r#"(?i)title=['"](?:Hoster\s+)?([A-Za-z0-9_-]+)['"]"#).captures(whole));
        if let (Some(target), Some(name)) = (target, name) {
            let lang_key = lang.and_then(|l| l[1].parse().ok()).unwrap_or(1);
            let raw = &target[1];
            entries.push(HosterEntry {
                lang_key,
                lang_label: language_label(lang_key).unwrap_or("Sprache").to_owned(),
                hoster_name: name[1].trim().to_owned(),
                redirect_url: if raw.starts_with("http") {
                    raw.to_owned()
                } else {
                    format!("{origin}{raw}")
                },
            });
        }
    }
    if entries.is_empty() {
        let fallback = rx(r#"(?i)href=['"](/redirect/\d+)['"][^>]*>[\s\S]*?<h4[^>]*>([^<]+)</h4>"#);
        for found in fallback.captures_iter(html) {
            entries.push(HosterEntry {
                lang_key: 1,
                lang_label: "Standard".into(),
                hoster_name: found[2].trim().to_owned(),
                redirect_url: format!("{origin}{}", &found[1]),
            });
        }
    }
    entries
}

/// How much a link is worth: the hoster by a fixed order, the language by the preference.
fn score(entry: &HosterEntry, preferred: Option<u8>) -> i32 {
    const ORDER: [&str; 7] = [
        "voe",
        "filemoon",
        "vidmoly",
        "streamtape",
        "vidoza",
        "doodstream",
        "dood",
    ];
    let name = entry.hoster_name.to_lowercase();
    let host = ORDER
        .iter()
        .position(|h| name.contains(h))
        .map_or(0, |i| 100 - 10 * i as i32);
    let lang = match preferred {
        Some(p) => {
            if u32::from(p) == entry.lang_key {
                500
            } else {
                0
            }
        }
        None => match entry.lang_key {
            3 => 30,
            1 => 25,
            _ => 15,
        },
    };
    host + lang
}

/// An episode or film page, resolved. `language` is the person's preference (`"ger_sub"`, `"de"`, …) or
/// empty. A series or season page has no streams: use `extract_season` for it; this returns
/// `None`, as does a page without a stream that works.
pub fn extract_episode(
    fetch: &dyn Fetch,
    url: &str,
    language: &str,
    now_ms: i64,
) -> Option<Episode> {
    extract_episode_inner(fetch, url, language, now_ms, 0)
}

fn extract_episode_inner(
    fetch: &dyn Fetch,
    url: &str,
    language: &str,
    now_ms: i64,
    depth: u8,
) -> Option<Episode> {
    if is_aniworld_season_url(url) {
        return None;
    }
    let page = fetch.fetch(&html_request(url, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;
    let parsed = Url::parse(url).ok()?;
    let origin = parsed.origin().ascii_serialization();

    let series_title =
        rx(r#"(?i)<div class="series-title"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<span>([^<]+)</span>"#)
            .captures(&html)
            .or_else(|| {
                rx(r#"(?i)<h1\b[^>]*\bitemprop=['"]name['"][^>]*>[\s\S]*?<span>([^<]+)</span>"#)
                    .captures(&html)
            })
            .or_else(|| rx(r#"(?i)<meta property="og:title" content="([^"]+)""#).captures(&html))
            .map_or_else(|| "Anime".to_owned(), |c| c[1].trim().to_owned());
    let german = rx(r#"(?i)<span class="episodeGermanTitle"[^>]*>([^<]+)</span>"#)
        .captures(&html)
        .map(|c| c[1].trim().to_owned())
        .unwrap_or_default();
    let english = rx(r#"(?i)<small class="episodeEnglishTitle"[^>]*>([^<]+)</small>"#)
        .captures(&html)
        .map(|c| c[1].trim().to_owned())
        .unwrap_or_default();

    let path = parsed.path();
    let season_in_path = rx(r"(?i)staffel-(\d+)")
        .captures(path)
        .and_then(|c| c[1].parse::<u32>().ok());
    let episode_in_path = rx(r"(?i)episode-(\d+)")
        .captures(path)
        .and_then(|c| c[1].parse::<u32>().ok());
    let film = rx(r"(?i)filme(?:/film-(\d+))?").captures(path);
    let season = season_in_path.unwrap_or(if film.is_some() { 0 } else { 1 });
    let episode = episode_in_path.unwrap_or_else(|| {
        film.as_ref().map_or(1, |f| {
            f.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(1)
        })
    });
    let tag = if film.is_some() && season_in_path.is_none() {
        format!("Film {episode}")
    } else {
        format!("S{}E{}", pad2(season), pad2(episode))
    };
    let tail = if !german.is_empty() {
        format!(" - {german}")
    } else if !english.is_empty() {
        format!(" - {english}")
    } else {
        String::new()
    };
    let compound = format!("{series_title} - {tag}{tail}");

    let entries = hoster_entries(&html, &origin);
    if entries.is_empty() {
        // A page that only lists episodes: take its first.
        if depth == 0 {
            let first = rx(
                r#"(?i)href=['"](/(?:anime|serie)/stream/[^/]+/(?:staffel-\d+/episode-\d+|filme/film-\d+))['"]"#,
            )
            .captures(&html)?;
            return extract_episode_inner(
                fetch,
                &format!("{origin}{}", &first[1]),
                language,
                now_ms,
                1,
            );
        }
        return None;
    }

    let preferred = parse_language(language);
    let mut sorted: Vec<&HosterEntry> = entries.iter().collect();
    // Stable, like the JavaScript sort: equal scores keep the page's order.
    sorted.sort_by_key(|e| std::cmp::Reverse(score(e, preferred)));

    let mut streams: Vec<ResolvedStream> = Vec::new();
    for entry in sorted {
        let combo = format!("{}-{}", entry.hoster_name.to_lowercase(), entry.lang_key);
        if streams.iter().any(|s| s.id == combo) {
            continue;
        }
        let Some(embed) = resolve_redirect(fetch, &entry.redirect_url, url) else {
            continue;
        };
        let Some(direct) = extract_direct_hoster(fetch, &embed, now_ms) else {
            continue;
        };
        if direct.url.is_empty() {
            continue;
        }
        let ext = if direct.is_hls || direct.url.contains(".mp4") {
            "mp4"
        } else {
            "m4a"
        };
        streams.push(ResolvedStream {
            id: combo,
            label: format!("{} · {}", entry.hoster_name, entry.lang_label),
            provider: entry.hoster_name.clone(),
            language: entry.lang_label.clone(),
            lang_key: entry.lang_key,
            url: direct.url,
            is_hls: direct.is_hls,
            referer: direct.referer,
            ext: ext.to_owned(),
        });
        if streams.len() >= 3 {
            break;
        }
    }
    let primary = streams.first()?.clone();

    let lang_tag = match primary.lang_key {
        3 => "Ger-Sub".to_owned(),
        1 => "Ger-Dub".to_owned(),
        2 => "Eng-Sub".to_owned(),
        _ => primary.language.clone(),
    };
    let title = if language.trim().is_empty() {
        compound
    } else {
        format!("{compound} [{lang_tag}]")
    };

    let mut keys: Vec<u32> = Vec::new();
    for e in &entries {
        if !keys.contains(&e.lang_key) {
            keys.push(e.lang_key);
        }
    }
    let available_languages = keys
        .into_iter()
        .map(|key| AvailableLanguage {
            key,
            code: match key {
                1 => "ger_dub".into(),
                3 => "ger_sub".into(),
                2 => "eng_sub".into(),
                _ => format!("lang_{key}"),
            },
            label: language_label(key).map_or_else(|| format!("Sprache {key}"), str::to_owned),
        })
        .collect();

    Some(Episode {
        title,
        series_title,
        season,
        episode,
        url: primary.url.clone(),
        is_hls: primary.is_hls,
        referer: primary.referer.clone(),
        hoster: primary.provider.clone(),
        language: primary.language.clone(),
        lang_key: primary.lang_key,
        available_languages,
        streams,
        all_entries: entries,
    })
}
