//! Keeping the two in step (`syncMerkliste`, `loadFromAnytype` in `src/lib/anytype.ts`).
//!
//! One round: read the page, merge it into this device's list, write the merged list back — unless the page
//! already holds exactly that. Compared with what is in Anytype, not with what this device wrote last:
//! another computer may have written an older list since, and compared as values, never as text.

use sondra_merk::merge::{merge_shared, shared_key, take_shared, Removed};
use sondra_merk::model::Item;

use crate::client::Anytype;
use crate::page::{has_data_heading, merkliste_from_markdown, merkliste_to_markdown};
use crate::{Error, Kind, Result};

/// What a round came to.
#[derive(Debug, Clone, PartialEq)]
pub struct Sync {
    /// The list after the round — this device's, to be kept.
    pub items: Vec<Item>,
    pub removed: Removed,
    /// Series that came from Anytype or changed through it.
    pub received: usize,
    /// The page was written.
    pub wrote: bool,
}

/// One round with the page in Anytype. A page that carries a data block Sondra cannot read holds another
/// device's list, maybe; writing this one over it would lose that.
pub fn sync_merkliste(link: &Anytype, items: &[Item], removed: &Removed) -> Result<Sync> {
    let markdown = link.read()?;
    let remote = markdown.as_deref().and_then(merkliste_from_markdown);
    if remote.is_none() && markdown.as_deref().is_some_and(has_data_heading) {
        return Err(Kind::Unreadable.into());
    }
    let (mut now_items, mut now_removed, mut received) = (items.to_vec(), removed.clone(), 0);
    if let Some(remote) = &remote {
        let (merged, merged_removed) = merge_shared(items, removed, &remote.items, &remote.removed);
        received = merged
            .iter()
            .filter(|m| items.iter().find(|i| i.id == m.id).map(|i| i.updated_at) != Some(m.updated_at))
            .count();
        now_items = merged;
        now_removed = merged_removed;
    }
    let same = remote.as_ref().is_some_and(|r| shared_key(&r.items, &r.removed) == shared_key(&now_items, &now_removed));
    let mut wrote = false;
    if !same {
        link.write(&merkliste_to_markdown(&now_items, &now_removed))?;
        wrote = true;
    }
    Ok(Sync { items: now_items, removed: now_removed, received, wrote })
}

/// What „Aus Anytype laden“ came to.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub items: Vec<Item>,
    pub removed: Removed,
    /// How many series the page held.
    pub loaded: usize,
    /// The page holds no list yet: nothing changes here, the next round writes this list there.
    pub empty: bool,
}

/// The default when connecting to a page that already holds a list: the page's list becomes this device's,
/// with pictures from files kept where the same series had one. The caller keeps the replaced list (to
/// offer „bisherige dazunehmen“).
pub fn load_from_anytype(link: &Anytype, items: &[Item], removed: &Removed) -> Result<Loaded> {
    let markdown = link.read()?;
    let remote = markdown.as_deref().and_then(merkliste_from_markdown);
    let Some(remote) = remote else {
        if markdown.as_deref().is_some_and(has_data_heading) {
            return Err(Error::from(Kind::Unreadable));
        }
        return Ok(Loaded { items: items.to_vec(), removed: removed.clone(), loaded: 0, empty: true });
    };
    let taken = take_shared(items, &remote.items);
    let mut next_removed = removed.clone();
    for (id, at) in &remote.removed {
        // The page's note wins, as in the web app (`{ ...mine, ...theirs }`).
        next_removed.insert(id.clone(), *at);
    }
    Ok(Loaded { loaded: remote.items.len(), items: taken, removed: next_removed, empty: false })
}
