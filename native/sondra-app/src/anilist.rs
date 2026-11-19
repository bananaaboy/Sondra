//! AniList's public search (`src/lib/anilist.ts`, `searchAniListMedia`): the one place where adding a series
//! asks somebody else — and only when the person presses „Suchen“, never by itself (no provider is wired in
//! to hear what is typed). It answers with the cover and how many episodes the series has.

use serde_json::{json, Value};

/// What a search finds.
#[derive(Debug, Clone, PartialEq)]
pub struct Media {
    pub id: i64,
    pub title: String,
    pub episodes: Option<i64>,
    pub status: Option<String>,
    pub cover_url: Option<String>,
    pub season_year: Option<i64>,
}

const ENDPOINT: &str = "https://graphql.anilist.co";

const QUERY: &str = "query ($search: String) { Media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id idMal title { romaji english native } episodes status seasonYear description(asHtml: false) coverImage { extraLarge large } } }";

/// The title as the search wants it: without „– Staffel 2“ and „S01E03“ tails.
pub fn clean_title(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut cut = title.len();
    // „ - Staffel 3 …“, „: Staffel 3“
    for (i, _) in lower.char_indices() {
        let rest = &lower[i..];
        let trimmed = rest.trim_start();
        let lead = rest.len() - trimmed.len();
        if let Some(after) = trimmed.strip_prefix(['-', '–', '—', ':']) {
            if after.trim_start().starts_with("staffel") && after.trim_start()["staffel".len()..].trim_start().starts_with(|c: char| c.is_ascii_digit()) {
                cut = cut.min(i);
                break;
            }
        }
        let _ = lead;
    }
    let head = &title[..cut];
    // „ S01E03 …“
    let bytes = head.as_bytes();
    let mut end = head.len();
    for i in 0..bytes.len() {
        if (bytes[i] == b'S' || bytes[i] == b's') && bytes.get(i + 1).is_some_and(|b| b.is_ascii_digit()) {
            let mut j = i + 1;
            while bytes.get(j).is_some_and(|b| b.is_ascii_digit()) {
                j += 1;
            }
            if matches!(bytes.get(j), Some(b'E' | b'e')) && bytes.get(j + 1).is_some_and(|b| b.is_ascii_digit()) && (i == 0 || bytes[i - 1].is_ascii_whitespace()) {
                end = i;
                break;
            }
        }
    }
    head[..end].trim().to_string()
}

/// Reads AniList's answer.
pub fn parse(body: &Value, fallback_title: &str) -> Option<Media> {
    let media = body.get("data")?.get("Media")?;
    if media.is_null() {
        return None;
    }
    let title = media["title"]["romaji"].as_str().map(str::to_string).unwrap_or_else(|| fallback_title.to_string());
    Some(Media {
        id: media["id"].as_i64()?,
        title,
        episodes: media["episodes"].as_i64().filter(|e| *e > 0),
        status: media["status"].as_str().map(str::to_string),
        cover_url: media["coverImage"]["extraLarge"].as_str().or(media["coverImage"]["large"].as_str()).map(str::to_string),
        season_year: media["seasonYear"].as_i64(),
    })
}

/// Searches by title (and season number, from 2 on as „… Season n“). `endpoint` is AniList's, or a test's.
pub fn search_at(endpoint: &str, title: &str, season: i64) -> Option<Media> {
    let clean = clean_title(title);
    if clean.is_empty() {
        return None;
    }
    let query = if season > 1 { format!("{clean} Season {season}") } else { clean.clone() };
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(15))).http_status_as_error(false).build().into();
    let mut response = agent.post(endpoint).header("Content-Type", "application/json").header("Accept", "application/json").send(json!({ "query": QUERY, "variables": { "search": query } }).to_string().as_bytes()).ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = serde_json::from_str(&response.body_mut().read_to_string().ok()?).ok()?;
    parse(&body, &clean)
}

pub fn search(title: &str, season: i64) -> Option<Media> {
    search_at(&std::env::var("SONDRA_ANILIST").unwrap_or_else(|_| ENDPOINT.to_string()), title, season)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_loses_the_tails_the_search_does_not_want() {
        assert_eq!(clean_title("Frieren – Staffel 2"), "Frieren");
        assert_eq!(clean_title("Dark: Staffel 3 Teil 2"), "Dark");
        assert_eq!(clean_title("Frieren S01E12 Abschied"), "Frieren");
        assert_eq!(clean_title("  Mob Psycho 100  "), "Mob Psycho 100");
        assert_eq!(clean_title("Staffel Eins"), "Staffel Eins", "a title that merely has the word stays");
        assert_eq!(clean_title("Kaguya-sama - Staffel 1"), "Kaguya-sama");
    }

    #[test]
    fn the_answer_is_read_with_what_it_has() {
        let body = json!({ "data": { "Media": { "id": 154587, "title": { "romaji": "Sousou no Frieren", "english": "Frieren" }, "episodes": 28, "status": "FINISHED", "seasonYear": 2023, "coverImage": { "large": "https://x/l.jpg", "extraLarge": "https://x/xl.jpg" } } } });
        let media = parse(&body, "x").unwrap();
        assert_eq!((media.id, media.title.as_str(), media.episodes), (154587, "Sousou no Frieren", Some(28)));
        assert_eq!(media.cover_url.as_deref(), Some("https://x/xl.jpg"));
        assert!(parse(&json!({ "data": { "Media": null } }), "x").is_none());
        let zero = json!({ "data": { "Media": { "id": 1, "episodes": 0 } } });
        assert_eq!(parse(&zero, "Titel").unwrap().episodes, None);
        assert_eq!(parse(&zero, "Titel").unwrap().title, "Titel");
    }
}
