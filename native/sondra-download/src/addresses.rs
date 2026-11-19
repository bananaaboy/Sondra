//! Every address in a piece of text, the way people paste them. A port of `extractAddresses` in
//! `src/lib/download.ts`: one per line, but as often „a, b“, „a,b“, „a; b“, in quotes, in angle brackets,
//! at the end of a sentence with its full stop. Commas inside an address stay; only a comma, semicolon or
//! bar before the next `http` separates. Duplicates count once.

/// Closing brackets a pasted address keeps only when it also opened them.
fn trim_unbalanced(address: &str, open: char, close: char) -> &str {
    let mut value = address;
    while value.ends_with(close) && value.matches(close).count() > value.matches(open).count() {
        value = &value[..value.len() - close.len_utf8()];
    }
    value
}

fn starts_scheme(lower: &[u8]) -> bool {
    lower.starts_with(b"http://") || lower.starts_with(b"https://")
}

pub fn extract_addresses(text: &str) -> Vec<String> {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut found: Vec<String> = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if !starts_scheme(&bytes[at..]) {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        // The match runs to the next space or quote.
        let end = text[at..]
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`'))
            .map_or(text.len(), |(i, _)| at + i);
        let matched = &text[at..end];
        let lower_matched = &lower[at..end];
        // Split before a run of separators that is followed by another address.
        let mut pieces: Vec<&str> = Vec::new();
        let (mut from, mut i) = (0, 0);
        while i < matched.len() {
            let c = matched.as_bytes()[i];
            if matches!(c, b',' | b';' | b'|') {
                let mut j = i;
                while j < matched.len() && matches!(matched.as_bytes()[j], b',' | b';' | b'|') {
                    j += 1;
                }
                if starts_scheme(&lower_matched.as_bytes()[j..]) {
                    pieces.push(&matched[from..i]);
                    from = j;
                }
                i = j;
            } else {
                i += 1;
            }
        }
        pieces.push(&matched[from..]);
        for piece in pieces {
            let candidate = piece.trim_end_matches([',', ';', '.', ':', '!', '?', '»', '“', '”', '„', '‘', '’', '\'', '"']);
            let candidate = trim_unbalanced(trim_unbalanced(trim_unbalanced(candidate, '(', ')'), '[', ']'), '{', '}');
            let candidate = candidate.trim_end_matches([',', ';', '.', ':', '!', '?']);
            let ok = url::Url::parse(candidate).ok().is_some_and(|u| u.host_str().is_some_and(|h| !h.is_empty()));
            if ok && !found.iter().any(|f| f == candidate) {
                found.push(candidate.to_owned());
            }
        }
        at = end.max(at + 1);
    }
    found
}
