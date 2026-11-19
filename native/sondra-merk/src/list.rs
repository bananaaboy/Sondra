//! The list itself: taking an entry off and putting it back, the way the web app does
//! (`removeMerkItem`/`restoreMerkItem` with `noteRemoved`/`noteRestored`). A removal is noted by name and
//! time, because the next round with Drive must not bring the entry back; putting it back, on purpose,
//! counts as a change made now, and only a change after the removal keeps it from going again.

use crate::merge::{revived, Removed};
use crate::Item;

/// An entry taken off the list, and where it stood, for „Rückgängig“.
#[derive(Debug, Clone, PartialEq)]
pub struct Taken {
    pub item: Item,
    pub index: usize,
}

/// Takes the entry with this id off and notes the removal at `now`.
pub fn remove_item(items: &mut Vec<Item>, removed: &mut Removed, id: &str, now: i64) -> Option<Taken> {
    let index = items.iter().position(|i| i.id == id)?;
    let item = items.remove(index);
    removed.insert(item.id.clone(), now);
    Some(Taken { item, index })
}

/// Puts an entry back where it stood (or at the end, when the list has become shorter); its removal is no
/// longer noted. An entry with that id already on the list stays as it is.
pub fn restore_item(items: &mut Vec<Item>, removed: &mut Removed, taken: &Taken, now: i64) {
    let back = revived(&taken.item, removed, now);
    removed.remove(&taken.item.id);
    if items.iter().any(|i| i.id == taken.item.id) {
        return;
    }
    items.insert(taken.index.min(items.len()), back);
}
