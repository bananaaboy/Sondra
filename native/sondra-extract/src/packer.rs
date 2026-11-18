//! Dean Edwards' P.A.C.K.E.R. unpacker. A port of `unpackPackedJs`.

use regex::Regex;

const ALPHABET: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

fn base_decode(token: &str, radix: usize) -> Option<usize> {
    let mut value = 0usize;
    for c in token.chars() {
        let digit = ALPHABET.find(c)?;
        if digit >= radix {
            return None;
        }
        value = value.checked_mul(radix)?.checked_add(digit)?;
    }
    Some(value)
}

/// A quoted JavaScript string, without its quotes.
fn unquote(text: &str) -> String {
    if text.len() >= 2 && text.starts_with('\'') && text.ends_with('\'') {
        text[1..text.len() - 1]
            .replace("\\'", "'")
            .replace("\\\\", "\\")
    } else if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text[1..text.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        text.to_owned()
    }
}

/// The code a page's packed script hides, or `None` when there is none or it does not parse.
pub fn unpack(source: &str) -> Option<String> {
    if !source.contains("eval(function(p,a,c,k,e,d)") {
        return None;
    }
    let pattern = Regex::new(
        r#"eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\((['"][\s\S]*?['"]),\s*(\d+),\s*(\d+),\s*(['"][\s\S]*?['"])\.split\(['"]\|['"]\)"#,
    )
    .expect("a fixed pattern");
    let found = pattern.captures(source)?;
    let payload = unquote(&found[1]);
    let radix: usize = found[2].parse().ok()?;
    let count: usize = found[3].parse().ok()?;
    let mut keywords: Vec<String> = unquote(&found[4]).split('|').map(str::to_owned).collect();
    while keywords.len() < count {
        keywords.push(String::new());
    }
    // `\b\w+\b` in JavaScript: runs of ASCII word characters.
    let words = Regex::new(r"[A-Za-z0-9_]+").expect("a fixed pattern");
    Some(
        words
            .replace_all(&payload, |c: &regex::Captures| {
                let token = &c[0];
                match base_decode(token, radix) {
                    Some(index) if index < keywords.len() && !keywords[index].is_empty() => {
                        keywords[index].clone()
                    }
                    _ => token.to_owned(),
                }
            })
            .into_owned(),
    )
}
