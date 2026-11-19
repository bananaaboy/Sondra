//! The page in Anytype (`merklisteToMarkdown`, `merklisteFromMarkdown` in `src/lib/anytype.ts`). Two parts:
//! on top the list as people read it — what is being watched, where, how far — which Anytype brings to the
//! person's other devices, the phone included; below, the same list as data (base64 in a code block, so no
//! Markdown conversion on Anytype's side can bend it), from which Sondra on another computer takes it back.

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use sondra_merk::merge::{travelling, Removed};
use sondra_merk::model::{Item, Status};
use sondra_merk::normalize::{normalize, Context};
use sondra_merk::progress::{caught_up, item_progress, season_name, season_progress, seasons_of};

pub const DATA_HEADING: &str = "## Sondra-Daten";
pub const DATA_FENCE: &str = "sondra-merkliste";

/// A list read back from a page.
#[derive(Debug, Clone, PartialEq)]
pub struct Remote {
    pub items: Vec<Item>,
    pub removed: Removed,
}

/// The page's Markdown in runs `/v2` takes as one `insert_blocks` each. Every line outside the code fence is
/// counted as a block — more than Anytype makes of them, never fewer — and a run is cut only where a new
/// block starts at the top, never inside the fence or under a list item.
pub fn markdown_runs(markdown: &str, max: usize) -> Vec<String> {
    let mut runs: Vec<String> = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    let mut lines = 0usize;
    let mut fenced = false;
    let mut blank = true;
    for line in markdown.split('\n') {
        let fence = line.trim_start().starts_with("```");
        let counted = !fenced && !line.trim().is_empty();
        let opens = counted && (blank || fence || starts_block(line));
        if opens && lines >= max {
            runs.push(run.join("\n"));
            run.clear();
            lines = 0;
        }
        if counted {
            lines += 1;
        }
        if fence {
            fenced = !fenced;
        }
        blank = line.trim().is_empty();
        run.push(line);
    }
    let last = run.join("\n");
    if !last.trim().is_empty() {
        runs.push(last);
    }
    runs
}

/// `^(?:[-*+] |\d+[.)] |#{1,6} |> )`
fn starts_block(line: &str) -> bool {
    let bytes = line.as_bytes();
    if bytes.len() >= 2 && matches!(bytes[0], b'-' | b'*' | b'+') && bytes[1] == b' ' {
        return true;
    }
    if line.starts_with("> ") {
        return true;
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 && bytes.len() > digits + 1 && matches!(bytes[digits], b'.' | b')') && bytes[digits + 1] == b' ' {
        return true;
    }
    let hashes = bytes.iter().take_while(|b| **b == b'#').count();
    (1..=6).contains(&hashes) && bytes.get(hashes) == Some(&b' ')
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '#' | '<' | '>' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn stand(item: &Item) -> String {
    let progress = item_progress(item);
    let seen = match progress.total {
        Some(total) if total != 0 => format!("{} von {} gesehen", progress.watched, total),
        _ => format!("{} gesehen", progress.watched),
    };
    if caught_up(&seasons_of(item)) {
        return format!("Alles gesehen · {seen}");
    }
    if item.status == Status::Later && progress.watched == 0 {
        return "Nicht angefangen".into();
    }
    let place = match (item.episode, item.season) {
        (None, 0) => "Filme".to_owned(),
        (None, s) => format!("Staffel {s}"),
        (Some(e), 0) => format!("Film {e}"),
        (Some(e), s) => format!("Staffel {s}, Folge {e}"),
    };
    format!("{place} · {seen}")
}

/// The list as the data block carries it: the entries as they travel and what was removed.
pub fn data_of(items: &[Item], removed: &Removed) -> String {
    let value = json!({
        "kind": DATA_FENCE,
        "version": 1,
        "items": items.iter().map(travelling).collect::<Vec<_>>(),
        "removed": removed,
    });
    STANDARD.encode(serde_json::to_vec(&value).unwrap_or_default())
}

/// The list as a page: readable on top, the data underneath.
pub fn merkliste_to_markdown(items: &[Item], removed: &Removed) -> String {
    let mut lines: Vec<String> = vec![
        "Diese Seite schreibt Sondra. Abgehakt wird in Sondra; was hier von Hand geändert wird, überschreibt der nächste Abgleich.".into(),
        String::new(),
    ];
    let groups = [
        (Status::Watching, "Am Schauen"),
        (Status::Later, "Später"),
        (Status::Paused, "Pausiert"),
        (Status::Done, "Fertig"),
        (Status::Dropped, "Abgebrochen"),
    ];
    for (status, heading) in groups {
        let entries: Vec<&Item> = items.iter().filter(|i| i.status == status).collect();
        if entries.is_empty() {
            continue;
        }
        lines.push(format!("## {heading}"));
        lines.push(String::new());
        for item in entries {
            let stars = match item.rating {
                Some(n) if n > 0 => format!(" · {}", "★".repeat(n as usize)),
                _ => String::new(),
            };
            lines.push(format!("- **{}** — {}{}", escape(&item.title), stand(item), stars));
            let seasons: Vec<String> = seasons_of(item)
                .iter()
                .map(|season| {
                    let p = season_progress(season);
                    let amount = match p.total {
                        Some(total) if total != 0 => format!("{} von {}", p.watched, total),
                        _ => format!("{} gesehen", p.watched),
                    };
                    format!("{}: {}", season_name(season), amount)
                })
                .collect();
            if !seasons.is_empty() {
                lines.push(format!("  {}", escape(&seasons.join(" · "))));
            }
            if let Some(notes) = item.notes.as_deref().filter(|n| !n.is_empty()) {
                lines.push(format!("  {}", escape(&notes.split_whitespace().collect::<Vec<_>>().join(" "))));
            }
            if !item.url.trim().is_empty() {
                lines.push(format!("  {}", item.url.trim()));
            }
        }
        lines.push(String::new());
    }
    let data = data_of(items, removed);
    lines.push(DATA_HEADING.into());
    lines.push(String::new());
    lines.push("Aus diesem Block nimmt Sondra auf einem anderen Rechner die Liste zurück. Bitte nicht ändern.".into());
    lines.push(String::new());
    lines.push(format!("```{DATA_FENCE}"));
    for chunk in data.as_bytes().chunks(76) {
        lines.push(String::from_utf8_lossy(chunk).into_owned());
    }
    lines.push("```".into());
    lines.push(String::new());
    lines.join("\n")
}

/// The data block's text: with its language, or — Anytype drops code fence languages when it converts —
/// the first block after the heading.
fn data_block(markdown: &str) -> Option<&str> {
    let tag = format!("```{DATA_FENCE}");
    if let Some(start) = markdown.find(&tag) {
        let from = start + tag.len();
        let rest = &markdown[from..];
        return Some(rest.find("```").map_or(rest, |end| &rest[..end]));
    }
    let from = markdown.find(DATA_HEADING).unwrap_or(0);
    let rest = &markdown[from..];
    let fence = rest.find("```")?;
    let inner = &rest[fence + 3..];
    Some(inner.find("```").map_or(inner, |end| &inner[..end]))
}

/// What Anytype did to the lines does not matter: only base64 characters count.
fn decode(block: &str) -> Option<Value> {
    let data: String = block.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=')).collect();
    let bytes = STANDARD.decode(&data).or_else(|_| STANDARD_NO_PAD.decode(data.trim_end_matches('='))).ok()?;
    let parsed: Value = serde_json::from_slice(&bytes).ok()?;
    (parsed.get("kind").and_then(Value::as_str) == Some(DATA_FENCE) && parsed.get("items").is_some_and(Value::is_array)).then_some(parsed)
}

/// How many series the page's data block holds.
pub fn item_count(markdown: &str) -> usize {
    data_block(markdown)
        .and_then(decode)
        .and_then(|v| v.get("items").and_then(Value::as_array).map(Vec::len))
        .unwrap_or(0)
}

/// The list back out of the page — `None` when the data block is missing or bent.
pub fn merkliste_from_markdown(markdown: &str) -> Option<Remote> {
    let parsed = decode(data_block(markdown)?)?;
    let mut ctx = Context::system();
    let items = parsed["items"].as_array()?.iter().filter(|v| v.is_object()).map(|v| normalize(v, &mut ctx)).collect();
    let mut removed = Removed::new();
    if let Some(map) = parsed.get("removed").and_then(Value::as_object) {
        for (id, at) in map {
            if let Some(n) = at.as_f64() {
                removed.insert(id.clone(), n as i64);
            }
        }
    }
    Some(Remote { items, removed })
}

/// Whether the page carries a data block at all (readable or not).
pub fn has_data_heading(markdown: &str) -> bool {
    markdown.contains(DATA_HEADING)
}
