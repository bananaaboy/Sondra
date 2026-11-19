//! Two copies of the list become one (`mergeMerkliste`, `mergeShared`, `travelling`, … in `merkliste.ts`).
//! The rule is the one the web app and the Drive file already live by: per series the side changed last
//! wins, what was removed on either side after its last change stays removed, and pictures from files
//! stay on the device that chose them. Neither side's list ever gets worse by being merged.

use std::collections::BTreeMap;

use crate::model::{CoverFrame, Item};

/// Stands in for a picture from a file, which stays on its device.
pub const LOCAL_PICTURE: &str = "sondra:lokal";

/// The ids of removed entries and when they were removed.
pub type Removed = BTreeMap<String, i64>;

#[derive(Debug, Clone, PartialEq)]
pub struct Import {
    pub items: Vec<Item>,
    pub added: usize,
    pub updated: usize,
    /// Entries already the same here.
    pub same: usize,
    /// Entries this device had changed more recently than the file; kept as they are.
    pub kept: usize,
}

fn name_of(item: &Item) -> String {
    item.title.trim().to_lowercase()
}

/// Brings a file's entries into the list. The same series — same entry, or the same name — is not
/// doubled: whichever side was changed last wins, so reading in an older export never undoes what was
/// ticked off since.
pub fn merge_merkliste(current: &[Item], incoming: &[Item]) -> Import {
    let mut next: Vec<Item> = current.to_vec();
    let (mut added, mut updated, mut same, mut kept) = (0, 0, 0, 0);
    for entry in incoming {
        let found = next
            .iter()
            .position(|item| item.id == entry.id || name_of(item) == name_of(entry));
        match found {
            None => {
                next.push(entry.clone());
                added += 1;
            }
            Some(i) if entry.updated_at > next[i].updated_at => {
                let mut replaced = entry.clone();
                replaced.id = next[i].id.clone();
                next[i] = replaced;
                updated += 1;
            }
            Some(i) if entry.updated_at == next[i].updated_at => same += 1,
            Some(_) => kept += 1,
        }
    }
    Import {
        items: next,
        added,
        updated,
        same,
        kept,
    }
}

fn is_file_picture(cover: &Option<String>) -> bool {
    cover.as_deref().is_some_and(|c| c.starts_with("data:"))
}

/// An entry as it travels to another device: pictures from files left behind.
pub fn travelling(item: &Item) -> Item {
    let mut out = item.clone();
    if is_file_picture(&out.cover) {
        out.cover = Some(LOCAL_PICTURE.into());
        out.cover_frame = None;
    }
    if let Some(seasons) = out.seasons.as_mut() {
        for season in seasons {
            if is_file_picture(&season.cover) {
                season.cover = Some(LOCAL_PICTURE.into());
                season.cover_frame = None;
            }
            if let Some(parts) = season.parts.as_mut() {
                for part in parts {
                    if is_file_picture(&part.cover) {
                        part.cover = Some(LOCAL_PICTURE.into());
                        part.cover_frame = None;
                    }
                }
            }
        }
    }
    out
}

fn back(
    cover: &mut Option<String>,
    frame: &mut Option<CoverFrame>,
    mine: Option<(&Option<String>, &Option<CoverFrame>)>,
) {
    if cover.as_deref() != Some(LOCAL_PICTURE) {
        return;
    }
    match mine {
        Some((c, f)) if is_file_picture(c) => {
            *cover = c.clone();
            *frame = *f;
        }
        _ => {
            *cover = None;
            *frame = None;
        }
    }
}

/// An arrived entry with this device's own pictures put back where they were.
fn with_local_pictures(item: &Item, local: Option<&Item>) -> Item {
    let mut out = item.clone();
    back(
        &mut out.cover,
        &mut out.cover_frame,
        local.map(|l| (&l.cover, &l.cover_frame)),
    );
    if let Some(seasons) = out.seasons.as_mut() {
        let local_seasons = local.and_then(|l| l.seasons.as_ref());
        for season in seasons {
            let mine =
                local_seasons.and_then(|list| list.iter().find(|s| s.number == season.number));
            back(
                &mut season.cover,
                &mut season.cover_frame,
                mine.map(|m| (&m.cover, &m.cover_frame)),
            );
            if let Some(parts) = season.parts.as_mut() {
                for (i, part) in parts.iter_mut().enumerate() {
                    let mine_part = mine.and_then(|m| m.parts.as_ref()).and_then(|p| p.get(i));
                    back(
                        &mut part.cover,
                        &mut part.cover_frame,
                        mine_part.map(|p| (&p.cover, &p.cover_frame)),
                    );
                }
            }
        }
    }
    out
}

/// This device's list merged with a copy kept elsewhere: per series the side changed last wins
/// (`merge_merkliste`), what was removed on either side after its last change stays removed, and pictures
/// from files stay where they were chosen.
pub fn merge_shared(
    current: &[Item],
    local_removed: &Removed,
    remote_items: &[Item],
    remote_removed: &Removed,
) -> (Vec<Item>, Removed) {
    let mut removed = local_removed.clone();
    for (id, at) in remote_removed {
        if !removed.get(id).is_some_and(|mine| mine >= at) {
            removed.insert(id.clone(), *at);
        }
    }
    let gone = |item: &Item| {
        removed
            .get(&item.id)
            .is_some_and(|at| *at >= item.updated_at)
    };
    let incoming: Vec<Item> = remote_items.iter().filter(|i| !gone(i)).cloned().collect();
    let merged = merge_merkliste(current, &incoming);
    let items: Vec<Item> = merged
        .items
        .iter()
        .filter(|i| !gone(i))
        .map(|i| with_local_pictures(i, current.iter().find(|c| c.id == i.id)))
        .collect();
    // An entry changed after its removal is back on the list; its removal is spent and need not travel
    // any further.
    for item in &items {
        removed.remove(&item.id);
    }
    (items, removed)
}

/// The copy kept elsewhere taken as this device's list — what „Aus Anytype laden“ does: its entries
/// replace these, with this device's pictures from files put back where the same entry had one.
pub fn take_shared(current: &[Item], remote_items: &[Item]) -> Vec<Item> {
    remote_items
        .iter()
        .map(|i| with_local_pictures(i, current.iter().find(|c| c.id == i.id)))
        .collect()
}

/// What decides whether the file has to be written again: list and removals, never the date. Compared as
/// values, not as text — two engines order the keys of an object differently and mean the same.
pub fn shared_key(list: &[Item], removed: &Removed) -> serde_json::Value {
    serde_json::json!({
        "items": list.iter().map(travelling).collect::<Vec<_>>(),
        "removed": removed,
    })
}

/// An entry put back on purpose — the removal undone, a file read in — counts as changed now. Its removal
/// is still noted elsewhere, and only a change after it keeps the next round from taking the entry off
/// again.
pub fn revived(item: &Item, removed: &Removed, now: i64) -> Item {
    let mut out = item.clone();
    if removed
        .get(&item.id)
        .is_some_and(|at| *at >= item.updated_at)
    {
        out.updated_at = now;
    }
    out
}
