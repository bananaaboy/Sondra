//! Subtitles as the player shows them: a file (SubRip or WebVTT) turned into cues, each with its start, its
//! end and its words, and the cue that belongs to a moment. The browser does this for the website's
//! `<track>`; a native player has to do it itself, and does it the way a browser does — through the same
//! WebVTT form (`srt_to_vtt`), tags and settings left out of the words.

use std::sync::LazyLock;

use regex::Regex;

use crate::srt_to_vtt;

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    /// Seconds.
    pub start: f64,
    pub end: f64,
    /// Lines of text, tags and formatting codes left out; an empty cue is not kept.
    pub text: String,
}

static TIMING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*((?:\d{1,}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,}:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s.*)?$").unwrap()
});
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?[a-zA-Z][^>]*>|<\d{1,2}:\d{2}[:.]\d{2,3}[.\d]*>").unwrap());
/// ASS-style override codes some SubRip files carry: `{\an8}`, `{\i1}`.
static CODES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\\[^}]*\}").unwrap());

fn seconds(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [m, s] => (0.0, m.parse::<f64>().ok()?, s),
        [h, m, s] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, s),
        _ => return None,
    };
    let s: f64 = s.replace(',', ".").parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn plain(text: &str) -> String {
    let text = CODES.replace_all(text, "");
    let text = TAGS.replace_all(&text, "");
    text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", "\u{a0}").replace("&lrm;", "").replace("&rlm;", "")
}

/// The cues of a SubRip or WebVTT file, in the order of their start.
pub fn parse_cues(text: &str) -> Vec<Cue> {
    let vtt = srt_to_vtt(text);
    let mut cues = Vec::new();
    for block in vtt.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        // The timing line is the first or the second of a block (an identifier may come before it).
        let Some(at) = lines.iter().take(2).position(|l| TIMING.is_match(l)) else { continue };
        let Some(c) = TIMING.captures(lines[at]) else { continue };
        let (Some(start), Some(end)) = (seconds(&c[1]), seconds(&c[2])) else { continue };
        let words: Vec<String> = lines[at + 1..].iter().map(|l| plain(l)).collect();
        let words = words.join("\n").trim().to_string();
        if end > start && !words.is_empty() {
            cues.push(Cue { start, end, text: words });
        }
    }
    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    cues
}

/// The cues on screen at `time` (two may overlap), in the order they started.
pub fn cues_at(cues: &[Cue], time: f64) -> Vec<&Cue> {
    cues.iter().filter(|c| c.start <= time && time < c.end).collect()
}
