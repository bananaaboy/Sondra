//! File names: from a title, free of what Windows refuses, and never over an existing file.

use std::path::{Path, PathBuf};

/// A name that survives every file system (`filenameFor` in `src/lib/studio.ts`): the characters
/// Windows refuses become spaces, runs of white space one, at most 80 characters, and a reserved
/// device name or a trailing dot is made harmless.
pub fn safe_stem(title: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in title.chars() {
        let bad =
            matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control();
        if bad || c.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(c);
    }
    let mut stem: String = out.chars().take(80).collect();
    stem = stem.trim().trim_end_matches('.').to_owned();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let head = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if stem.is_empty() {
        "download".into()
    } else if RESERVED.contains(&head.as_str()) {
        format!("_{stem}")
    } else {
        stem
    }
}

/// The file extension an address names, when it is one a media file has.
pub(crate) fn extension_of(url: &str) -> Option<&'static str> {
    let path = url::Url::parse(url).ok()?.path().to_ascii_lowercase();
    [
        "mp4", "m4v", "mkv", "webm", "mov", "avi", "mp3", "m4a", "aac", "ogg", "opus", "flac",
        "wav",
    ]
    .into_iter()
    .find(|e| path.ends_with(&format!(".{e}")))
}

/// `dir/stem.ext`, or `dir/stem (2).ext` when that is taken.
pub(crate) fn free_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let stem = safe_stem(stem);
    let mut candidate = dir.join(format!("{stem}.{extension}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{extension}"));
        n += 1;
    }
    candidate
}
