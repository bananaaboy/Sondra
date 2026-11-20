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
    search_at(&endpoint(), title, season)
}

/* The account: progress sent while watching, and the list read back (`verifyAniListToken`, `syncProgressToTrackers`,
   `fetchAniListCollection`). Only with a token the person gave, and only when they asked for it. The token is never
   part of an error text. */

/// An entry of the person's AniList, with the status as the Merkliste names it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub title: String,
    pub progress: i64,
    pub total: Option<i64>,
    /// `watching`, `later`, `paused`, `dropped` or `done`.
    pub status: &'static str,
    pub cover_url: Option<String>,
    pub site_url: String,
}

fn endpoint() -> String {
    std::env::var("SONDRA_ANILIST").unwrap_or_else(|_| ENDPOINT.to_string())
}

fn ask(endpoint: &str, token: &str, body: Value) -> Result<Value, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(20))).http_status_as_error(false).build().into();
    let mut response = agent
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", token.trim()))
        .send(body.to_string().as_bytes())
        .map_err(|_| "AniList antwortet nicht. Prüfen Sie die Verbindung.".to_string())?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 400 {
        return Err("AniList nimmt das Token nicht an.".into());
    }
    if !status.is_success() {
        return Err(format!("AniList antwortet mit Fehler {}.", status.as_u16()));
    }
    let text = response.body_mut().read_to_string().map_err(|_| "AniList antwortet nicht.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "AniList hat etwas Unlesbares geantwortet.".to_string())
}

/// Whose token it is: `Some((id, name))`, or `None` when AniList does not know it.
pub fn verify_at(endpoint: &str, token: &str) -> Result<Option<(i64, String)>, String> {
    if token.trim().is_empty() {
        return Ok(None);
    }
    let body = ask(endpoint, token, json!({ "query": "query { Viewer { id name } }" }))?;
    let viewer = &body["data"]["Viewer"];
    Ok(viewer["id"].as_i64().zip(viewer["name"].as_str()).map(|(id, name)| (id, name.to_string())))
}

/// How AniList names the Merkliste's status; a series seen to its end is `COMPLETED` whatever the status says.
pub fn list_status(status: &str, done: bool) -> &'static str {
    if done || status == "done" {
        return "COMPLETED";
    }
    match status {
        "later" => "PLANNING",
        "paused" => "PAUSED",
        "dropped" => "DROPPED",
        _ => "CURRENT",
    }
}

/// Sets how far someone is in a series: the series is looked up by title (and season), then its entry saved.
pub fn save_progress_at(endpoint: &str, token: &str, title: &str, season: i64, watched: i64, total: Option<i64>, status: &str) -> Result<(), String> {
    let media = search_at(endpoint, title, season.max(1)).ok_or_else(|| "Die Serie gibt es auf AniList nicht (unter diesem Namen).".to_string())?;
    let done = total.is_some_and(|t| t > 0 && watched >= t);
    let mutation = "mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) { id progress status } }";
    let body = ask(endpoint, token, json!({ "query": mutation, "variables": { "mediaId": media.id, "progress": watched.max(0), "status": list_status(status, done) } }))?;
    if body["errors"].as_array().is_some_and(|e| !e.is_empty()) {
        return Err("AniList hat den Fortschritt nicht angenommen.".into());
    }
    Ok(())
}

/// The anime list of the account behind the token.
pub fn collection_at(endpoint: &str, token: &str) -> Result<Vec<Entry>, String> {
    let (id, _) = verify_at(endpoint, token)?.ok_or_else(|| "AniList nimmt das Token nicht an.".to_string())?;
    let query = "query ($userId: Int) { MediaListCollection(userId: $userId, type: ANIME) { lists { entries { progress status media { id siteUrl episodes title { romaji english } coverImage { large } } } } } }";
    let body = ask(endpoint, token, json!({ "query": query, "variables": { "userId": id } }))?;
    let mut out = Vec::new();
    for list in body["data"]["MediaListCollection"]["lists"].as_array().map(Vec::as_slice).unwrap_or_default() {
        for entry in list["entries"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let media = &entry["media"];
            let Some(media_id) = media["id"].as_i64() else { continue };
            let title = media["title"]["english"].as_str().filter(|t| !t.is_empty()).or(media["title"]["romaji"].as_str().filter(|t| !t.is_empty())).map_or_else(|| format!("Anime #{media_id}"), str::to_string);
            out.push(Entry {
                title,
                progress: entry["progress"].as_i64().unwrap_or(0),
                total: media["episodes"].as_i64().filter(|e| *e > 0),
                status: match entry["status"].as_str().unwrap_or("CURRENT") {
                    "PLANNING" => "later",
                    "PAUSED" => "paused",
                    "DROPPED" => "dropped",
                    "COMPLETED" => "done",
                    _ => "watching",
                },
                cover_url: media["coverImage"]["large"].as_str().map(str::to_string),
                site_url: media["siteUrl"].as_str().filter(|u| !u.is_empty()).map_or_else(|| format!("https://anilist.co/anime/{media_id}"), str::to_string),
            });
        }
    }
    Ok(out)
}

pub fn verify(token: &str) -> Result<Option<(i64, String)>, String> {
    verify_at(&endpoint(), token)
}

pub fn save_progress(token: &str, title: &str, season: i64, watched: i64, total: Option<i64>, status: &str) -> Result<(), String> {
    save_progress_at(&endpoint(), token, title, season, watched, total, status)
}

pub fn collection(token: &str) -> Result<Vec<Entry>, String> {
    collection_at(&endpoint(), token)
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
