//! Cues a person can read: at most two lines of about 42 characters. A port of the shaping half of
//! `src/lib/transcribe.ts`.

use crate::Segment;

const MAX_LINE: usize = 42;
const MAX_CUE: usize = 2 * MAX_LINE;

fn len(text: &str) -> usize {
    // JavaScript counts UTF-16 units.
    text.encode_utf16().count()
}

/// A long segment is split at word boundaries, its time shared out by length.
pub fn to_cues(segments: &[Segment]) -> Vec<Segment> {
    let mut cues = Vec::new();
    for segment in segments {
        let words: Vec<&str> = segment.text.split_whitespace().collect();
        let mut pieces: Vec<String> = Vec::new();
        let mut piece = String::new();
        for word in words {
            if !piece.is_empty() && len(&format!("{piece} {word}")) > MAX_CUE {
                pieces.push(std::mem::take(&mut piece));
                piece = word.to_owned();
            } else if piece.is_empty() {
                piece = word.to_owned();
            } else {
                piece = format!("{piece} {word}");
            }
        }
        if !piece.is_empty() {
            pieces.push(piece);
        }
        let total = pieces.iter().map(|t| len(t)).sum::<usize>().max(1) as f64;
        let mut at = segment.start;
        for text in pieces {
            let length = ((segment.end - segment.start) * len(&text) as f64) / total;
            cues.push(Segment { start: at, end: at + length, text: wrap(&text) });
            at += length;
        }
    }
    cues
}

/// Two lines about equal in length: the space nearest the middle.
fn wrap(text: &str) -> String {
    if len(text) <= MAX_LINE {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let middle = units.len() as f64 / 2.0;
    let mut best: Option<usize> = None;
    for (i, u) in units.iter().enumerate() {
        if *u == u16::from(b' ') && best.is_none_or(|b| (i as f64 - middle).abs() < (b as f64 - middle).abs()) {
            best = Some(i);
        }
    }
    match best {
        None => text.to_owned(),
        Some(b) => format!("{}\n{}", String::from_utf16_lossy(&units[..b]), String::from_utf16_lossy(&units[b + 1..])),
    }
}

fn stamp(seconds: f64, separator: char) -> String {
    let total = ((seconds * 1000.0).round().max(0.0)) as u64;
    let (ms, s, m, h) = (total % 1000, (total / 1000) % 60, (total / 60000) % 60, total / 3_600_000);
    format!("{h:02}:{m:02}:{s:02}{separator}{ms:03}")
}

pub fn to_srt(segments: &[Segment]) -> String {
    to_cues(segments).iter().enumerate().map(|(i, c)| format!("{}\n{} --> {}\n{}\n", i + 1, stamp(c.start, ','), stamp(c.end, ','), c.text)).collect::<Vec<_>>().join("\n")
}

pub fn to_vtt(segments: &[Segment]) -> String {
    format!("WEBVTT\n\n{}", to_cues(segments).iter().map(|c| format!("{} --> {}\n{}\n", stamp(c.start, '.'), stamp(c.end, '.'), c.text)).collect::<Vec<_>>().join("\n"))
}

/// Plain text, one paragraph per pause of more than two seconds.
pub fn to_text(segments: &[Segment]) -> String {
    let mut text = String::new();
    for (i, segment) in segments.iter().enumerate() {
        let gap = if i > 0 { segment.start - segments[i - 1].end } else { 0.0 };
        if i == 0 {
            text.push_str(&segment.text);
        } else if gap > 2.0 {
            text.push_str(&format!("\n\n{}", segment.text));
        } else {
            text.push_str(&format!(" {}", segment.text));
        }
    }
    text.trim().to_owned() + "\n"
}
