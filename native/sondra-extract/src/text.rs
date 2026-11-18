//! Small text helpers shared by the extractors.

/// The two entities the sites use in titles. (The JavaScript does exactly these; more
/// would change titles people already have in their lists.)
pub fn unescape_title(raw: &str) -> String {
    raw.replace("&#039;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_owned()
}

/// As [`unescape_title`], and `&quot;`, for descriptions.
pub fn unescape_description(raw: &str) -> String {
    raw.replace("&#039;", "'")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
        .trim()
        .to_owned()
}

/// `S01E07`.
pub fn season_tag(season: u32, episode: u32) -> String {
    format!("S{season:02}E{episode:02}")
}
