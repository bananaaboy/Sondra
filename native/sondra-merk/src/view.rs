//! What the Merkliste shows of the list: filtered by what is typed and by where an entry stands, grouped
//! by that stand, each group in the chosen order — the web app's `MerklistePanel` (`filteredItems`,
//! `groups`), as data.

use crate::progress::{caught_up, seasons_of};
use crate::stats::{sort_items, Sort};
use crate::{Item, Status};

/// The five stands, in the order the page lists them, with their words.
pub const STATUS_OPTIONS: [(Status, &str); 5] = [
    (Status::Watching, "Am Schauen"),
    (Status::Later, "Später"),
    (Status::Paused, "Pausiert"),
    (Status::Done, "Fertig"),
    (Status::Dropped, "Abgebrochen"),
];

pub fn status_label(status: Status) -> &'static str {
    STATUS_OPTIONS.iter().find(|(s, _)| *s == status).map_or("", |(_, l)| l)
}

/// What narrows the list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Filter {
    /// Typed text: found in the title, the notes and the tags, without regard to case.
    pub query: String,
    pub status: Option<Status>,
    pub tag: Option<String>,
    /// Only series with something left to see.
    pub only_open: bool,
}

fn contains_lower(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

/// The entries that pass the filter, in the order of the list.
pub fn filter_items<'a>(items: &'a [Item], filter: &Filter) -> Vec<&'a Item> {
    let needle = filter.query.trim().to_lowercase();
    items
        .iter()
        .filter(|item| {
            needle.is_empty()
                || contains_lower(&item.title, &needle)
                || contains_lower(item.notes.as_deref().unwrap_or(""), &needle)
                || item.tags.iter().flatten().any(|t| contains_lower(t, &needle))
        })
        .filter(|item| filter.status.is_none_or(|s| item.status == s))
        .filter(|item| filter.tag.as_ref().is_none_or(|t| item.tags.iter().flatten().any(|x| x == t)))
        .filter(|item| !filter.only_open || !caught_up(&seasons_of(item)))
        .collect()
}

/// One section of the page: a stand and the entries in it.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub status: Status,
    pub label: &'static str,
    pub entries: Vec<Item>,
}

/// The sections that have entries, each sorted.
pub fn groups(items: &[Item], filter: &Filter, by: Sort) -> Vec<Group> {
    let kept: Vec<Item> = filter_items(items, filter).into_iter().cloned().collect();
    STATUS_OPTIONS
        .iter()
        .map(|(status, label)| Group {
            status: *status,
            label,
            entries: sort_items(&kept.iter().filter(|i| i.status == *status).cloned().collect::<Vec<_>>(), by),
        })
        .filter(|g| !g.entries.is_empty())
        .collect()
}

/// How many entries stand in each state, for the pills; a state nobody is in has no pill.
pub fn counts(items: &[Item]) -> Vec<(Status, &'static str, usize)> {
    STATUS_OPTIONS
        .iter()
        .map(|(status, label)| (*status, *label, items.iter().filter(|i| i.status == *status).count()))
        .filter(|(_, _, n)| *n > 0)
        .collect()
}

/// All tags on the list, once each, in the order they first appear.
pub fn all_tags(items: &[Item]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in items.iter().flat_map(|i| i.tags.iter().flatten()) {
        if !out.contains(tag) {
            out.push(tag.clone());
        }
    }
    out
}
