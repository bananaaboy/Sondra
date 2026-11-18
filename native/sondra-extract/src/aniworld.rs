//! AniWorld and SerienStream: series pages, season pages, and how far a series is online.
//! A port of the matching parts of `api/extractors.js`.

use std::collections::BTreeSet;

use regex::Regex;
use serde::Serialize;
use url::Url;

use crate::fetch::{html_request, Fetch};
use crate::text::{season_tag, unescape_description, unescape_title};

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a fixed pattern")
}

fn hosts() -> Regex {
    rx(r"(?i)^(?:[a-z0-9-]+\.)*(?:aniworld\.(?:to|la)|s\.to|serienstream\.(?:to|sx))$")
}

pub fn is_aniworld_url(raw: &str) -> bool {
    Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(|h| hosts().is_match(h)))
        .unwrap_or(false)
}

/// A series or a season page, as opposed to an episode or a film.
pub fn is_aniworld_season_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if !url.host_str().is_some_and(|h| hosts().is_match(h)) {
        return false;
    }
    let path = url.path();
    let is_episode = rx(r"(?i)/episode-\d+").is_match(path) || rx(r"(?i)/film-\d+").is_match(path);
    let is_season_or_series =
        rx(r"(?i)/(?:anime|serie)/stream/[^/]+(?:/(?:staffel-\d+|filme))?/?$").is_match(path);
    !is_episode && is_season_or_series
}

/// 1 = German, 2 = English, 3 = German subtitles; `None` takes what the site offers first.
pub fn parse_language(pref: &str) -> Option<u8> {
    let s = pref.trim().to_lowercase();
    if s.is_empty() || s == "auto" {
        return None;
    }
    if s == "3"
        || s == "ger_sub"
        || s.contains("ger-sub")
        || s.contains("desub")
        || s.contains("german_sub")
        || s.contains("deutsch sub")
    {
        return Some(3);
    }
    if s == "1"
        || s == "ger_dub"
        || s.contains("ger-dub")
        || s.contains("dedub")
        || s.contains("german_dub")
        || s.contains("deutsch dub")
        || s == "de"
    {
        return Some(1);
    }
    if s == "2"
        || s == "eng_sub"
        || s.contains("eng-sub")
        || s.contains("ensub")
        || s.contains("english")
        || s == "en"
    {
        return Some(2);
    }
    None
}

fn series_title(html: &str) -> String {
    let found =
        rx(r#"(?i)<div class="series-title"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<span>([^<]+)</span>"#)
            .captures(html)
            .or_else(|| {
                rx(r#"(?i)<h1\b[^>]*\bitemprop=['"]name['"][^>]*>[\s\S]*?<span>([^<]+)</span>"#)
                    .captures(html)
            })
            .or_else(|| rx(r#"(?i)<meta property="og:title" content="([^"]+)""#).captures(html));
    unescape_title(
        found
            .as_ref()
            .map_or("Anime", |c| c.get(1).map_or("Anime", |m| m.as_str())),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeItem {
    pub episode_number: u32,
    pub season_number: u32,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonPage {
    pub title: String,
    pub series_title: String,
    pub season_number: u32,
    pub items: Vec<EpisodeItem>,
}

/// All episodes of a season (or the films) page, in order.
pub fn extract_season(fetch: &dyn Fetch, url: &str) -> Option<SeasonPage> {
    let page = fetch.fetch(&html_request(url, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = &page.body;
    let parsed = Url::parse(url).ok()?;
    let origin = parsed.origin().ascii_serialization();
    let is_film_page = rx(r"(?i)/filme(?:/|$)").is_match(parsed.path());
    let series = series_title(html);
    let season_number = rx(r"(?i)staffel-(\d+)")
        .captures(parsed.path())
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(if is_film_page { 0 } else { 1 });

    let number_tag = |episode: u32| {
        if is_film_page {
            format!("Film {episode}")
        } else {
            season_tag(season_number, episode)
        }
    };

    let mut episodes: Vec<EpisodeItem> = Vec::new();
    let link_strict = rx(
        r#"(?i)href=['"](/(?:anime|serie)/stream/[^/]+/(?:staffel-\d+/episode-\d+|filme/film-\d+))['"]"#,
    );
    let link_loose = rx(r#"(?i)href=['"](/(?:anime|serie)/stream/[^/]+/[^'"]+)['"]"#);
    let itemprop = rx(r#"(?i)itemprop=['"]episodeNumber['"]\s+content=['"](\d+)['"]"#);
    let from_link = rx(r"(?i)(?:episode|film)-(\d+)");
    let german = rx(r"(?i)<strong>([^<]+)</strong>");
    let second = rx(r"(?i)<span>([^<]+)</span>");

    for row in rx(r"(?i)<tr[^>]*data-episode-id=[\s\S]*?</tr>").find_iter(html) {
        let tr = row.as_str();
        let Some(link) = link_strict.captures(tr).or_else(|| link_loose.captures(tr)) else {
            continue;
        };
        let path = link[1].to_owned();
        let number = itemprop
            .captures(tr)
            .or_else(|| from_link.captures(&path))
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(episodes.len() as u32 + 1);
        let name = {
            let de = german
                .captures(tr)
                .map(|c| unescape_title(&c[1]))
                .unwrap_or_default();
            let other = second
                .captures(tr)
                .map(|c| unescape_title(&c[1]))
                .unwrap_or_default();
            if de.is_empty() {
                other
            } else {
                de
            }
        };
        let tail = if name.is_empty() {
            String::new()
        } else {
            format!(" - {name}")
        };
        episodes.push(EpisodeItem {
            episode_number: number,
            season_number,
            title: format!("{series} - {}{tail}", number_tag(number)),
            url: format!("{origin}{path}"),
        });
    }

    if episodes.is_empty() {
        let mut seen = BTreeSet::new();
        let mut paths = Vec::new();
        for c in link_strict.captures_iter(html) {
            if seen.insert(c[1].to_owned()) {
                paths.push(c[1].to_owned());
            }
        }
        for (i, path) in paths.iter().enumerate() {
            let number = from_link
                .captures(path)
                .and_then(|c| c[1].parse().ok())
                .unwrap_or(i as u32 + 1);
            episodes.push(EpisodeItem {
                episode_number: number,
                season_number,
                title: format!("{series} - {}", number_tag(number)),
                url: format!("{origin}{path}"),
            });
        }
    }
    if episodes.is_empty() {
        return None;
    }
    Some(SeasonPage {
        title: if is_film_page {
            format!("{series} - Filme")
        } else {
            format!("{series} - Staffel {season_number}")
        },
        series_title: series,
        season_number,
        items: episodes,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonCount {
    pub number: u32,
    pub episodes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineInfo {
    pub series_title: String,
    pub max_season: u32,
    pub max_episode: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub has_movies: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seasons: Option<Vec<SeasonCount>>,
    pub checked_at: i64,
}

/// How far a series is online: its newest season and the newest episode in it. `None` for a
/// link that is not AniWorld's own, or a page that cannot be read.
pub fn check_online_updates(
    fetch: &dyn Fetch,
    raw_url: &str,
    full_metadata: bool,
    now_ms: i64,
) -> Option<OnlineInfo> {
    let parsed = Url::parse(raw_url).ok()?;
    if !parsed.host_str().is_some_and(|h| hosts().is_match(h)) {
        return None;
    }
    let slug = rx(r"(?i)/(?:anime|serie)/stream/([^/?#]+)").captures(parsed.path())?[1].to_owned();
    // Into a pattern below; a dot or bracket in a slug must stay itself.
    let slug_pattern = regex::escape(&slug);
    let base_type = if parsed.path().contains("/serie/") {
        "serie"
    } else {
        "anime"
    };
    let base = format!(
        "{}/{base_type}/stream/{slug}",
        parsed.origin().ascii_serialization()
    );

    let page = fetch.fetch(&html_request(&base, None)).ok()?;
    if !page.ok() {
        return None;
    }
    let html = page.body;
    let series = series_title(&html);

    // Seasons are the links to this series' own season pages. Any staffel link or data-season-id
    // counted too, and a sidebar with another series' "Staffel 21" — or a database id — became this
    // one's newest season.
    let season_re = rx(&format!(
        r"(?i)/(?:anime|serie)/stream/{slug_pattern}/staffel-(\d+)"
    ));
    let season_nums: Vec<u32> = season_re
        .captures_iter(&html)
        .filter_map(|c| c[1].parse().ok())
        .filter(|n| *n > 0)
        .collect();
    let max_season = season_nums.iter().copied().max().unwrap_or(1);

    let mut season_html = html.clone();
    if max_season > 1 {
        if let Ok(p) = fetch.fetch(&html_request(&format!("{base}/staffel-{max_season}"), None)) {
            if p.ok() {
                season_html = p.body;
            }
        }
    }

    let itemprop = rx(r#"(?i)itemprop=['"]episodeNumber['"]\s+content=['"](\d+)['"]"#);
    let count_in = |page: &str, season: u32, film: bool| -> Option<u32> {
        let own = if film {
            rx(&format!(
                r"(?i)/(?:anime|serie)/stream/{slug_pattern}/filme/film-(\d+)"
            ))
        } else {
            rx(&format!(
                r"(?i)/(?:anime|serie)/stream/{slug_pattern}/staffel-{season}/episode-(\d+)"
            ))
        };
        own.captures_iter(page)
            .chain(itemprop.captures_iter(page))
            .filter_map(|c| c[1].parse::<u32>().ok())
            .filter(|n| *n > 0)
            .max()
    };
    let max_episode = count_in(&season_html, max_season, false).unwrap_or(1);

    let cover_url = rx(r#"(?i)<div class=['"][^'"]*seriesCoverBox[^'"]*['"][^>]*>[\s\S]*?<img[^>]+(?:data-src|src)=['"]([^'"]+)['"]"#)
        .captures(&html)
        .or_else(|| rx(r#"(?i)<img[^>]+itemprop=['"]image['"][^>]+(?:data-src|src)=['"]([^'"]+)['"]"#).captures(&html))
        .or_else(|| rx(r#"(?i)<meta property=['"]og:image['"] content=['"]([^'"]+)['"]"#).captures(&html))
        .and_then(|c| Url::parse(&base).ok()?.join(&c[1]).ok())
        .map(|u| u.to_string());

    let description = rx(r#"(?i)data-full-description=['"]([^'"]+)['"]"#)
        .captures(&html)
        .or_else(|| {
            rx(r#"(?i)<p class=['"][^'"]*seri_des[^'"]*['"][^>]*>([^<]+)</p>"#).captures(&html)
        })
        .map(|c| unescape_description(&c[1]));

    let has_movies = rx(&format!(
        r"(?i)/(?:anime|serie)/stream/{slug_pattern}/filme\b"
    ))
    .is_match(&html);

    let seasons = full_metadata.then(|| {
        let unique: BTreeSet<u32> = if season_nums.is_empty() {
            BTreeSet::from([1])
        } else {
            season_nums.iter().copied().collect()
        };
        let mut entries: Vec<SeasonCount> = unique
            .into_iter()
            .map(|number| {
                if number == 1 {
                    return SeasonCount {
                        number: 1,
                        episodes: count_in(&html, 1, false),
                    };
                }
                if number == max_season && season_html != html {
                    return SeasonCount {
                        number: max_season,
                        episodes: Some(max_episode),
                    };
                }
                let episodes = fetch
                    .fetch(&html_request(&format!("{base}/staffel-{number}"), None))
                    .ok()
                    .filter(|p| p.ok())
                    .and_then(|p| count_in(&p.body, number, false));
                SeasonCount { number, episodes }
            })
            .collect();
        if has_movies {
            if let Ok(p) = fetch.fetch(&html_request(&format!("{base}/filme"), None)) {
                if p.ok() {
                    entries.push(SeasonCount {
                        number: 0,
                        episodes: count_in(&p.body, 0, true),
                    });
                }
            }
        }
        entries
    });

    Some(OnlineInfo {
        series_title: series,
        max_season,
        max_episode,
        cover_url,
        description,
        has_movies,
        seasons,
        checked_at: now_ms,
    })
}
