//! Which subtitle files lie beside a film, and what a made one is called — the web app's
//! `src/lib/subtitleFiles.ts`. Pure names: nothing here listens, looks anything up or reads a file.

use regex::Regex;
use std::sync::LazyLock;

static EXTENSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[^.]+$").unwrap());
static SUBTITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(srt|vtt)$").unwrap());
static LANGUAGE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[a-z]{2,3}$").unwrap());

/// The name without its extension, lower case — how a film finds its subtitles.
pub fn stem_of(name: &str) -> String {
    EXTENSION.replace(name, "").to_lowercase()
}

/// `Film.srt`, `Film.de.srt`, `Film.vtt`: the stem of a subtitle file, with a language tag cut off.
fn subtitle_stem(name: &str) -> String {
    LANGUAGE_TAG.replace(&stem_of(name), "").into_owned()
}

/// Anything that has a name and a folder.
pub trait Named {
    fn name(&self) -> &str;
    fn dir(&self) -> &str;
}

/// The subtitle files in the same folder that belong to a film, by name.
pub fn subtitles_beside<'a, T: Named>(film_name: &str, film_dir: &str, all: &'a [T]) -> Vec<&'a T> {
    let stem = stem_of(film_name);
    all.iter()
        .filter(|entry| {
            entry.dir() == film_dir && SUBTITLE.is_match(entry.name()) && (stem_of(entry.name()) == stem || subtitle_stem(entry.name()) == stem)
        })
        .collect()
}

/// The name a made subtitle gets: the film's, with `.srt` — no language tag, so every player takes it.
pub fn subtitle_name_for(name: &str) -> String {
    format!("{}.srt", EXTENSION.replace(name, ""))
}
