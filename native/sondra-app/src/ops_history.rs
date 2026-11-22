//! „Rückgängig“ and „Wiederholen“ for the settings of a page that edits by settings (Video, Bilder): every
//! settled change of the settings is a step. The page looks at its settings as it is drawn; a drag is one
//! step when it ends, not a step per frame; a new file starts a new history.

use std::cell::RefCell;

/// How many steps are kept.
const KEPT: usize = 60;

#[derive(Debug)]
pub struct OpsHistory<T> {
    inner: RefCell<Inner<T>>,
}

#[derive(Debug)]
struct Inner<T> {
    /// What the history belongs to (the file), so a new one starts afresh.
    key: String,
    last: Option<T>,
    undo: Vec<T>,
    redo: Vec<T>,
}

impl<T> Default for OpsHistory<T> {
    fn default() -> Self {
        OpsHistory { inner: RefCell::new(Inner { key: String::new(), last: None, undo: Vec::new(), redo: Vec::new() }) }
    }
}

impl<T: Clone + PartialEq> OpsHistory<T> {
    /// Notes the settings as they are now; `settled` is false while something is being dragged.
    pub fn observe(&self, key: &str, now: &T, settled: bool) {
        let mut h = self.inner.borrow_mut();
        if h.key != key {
            h.key = key.to_string();
            h.last = Some(now.clone());
            h.undo.clear();
            h.redo.clear();
            return;
        }
        if !settled {
            return;
        }
        match &h.last {
            Some(last) if last != now => {
                let before = last.clone();
                h.undo.push(before);
                if h.undo.len() > KEPT {
                    h.undo.remove(0);
                }
                h.redo.clear();
                h.last = Some(now.clone());
            }
            None => h.last = Some(now.clone()),
            _ => {}
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.inner.borrow().undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.inner.borrow().redo.is_empty()
    }

    /// The settings one step back, given the ones now.
    pub fn undo(&self, now: &T) -> Option<T> {
        let mut h = self.inner.borrow_mut();
        let back = h.undo.pop()?;
        h.redo.push(now.clone());
        h.last = Some(back.clone());
        Some(back)
    }

    pub fn redo(&self, now: &T) -> Option<T> {
        let mut h = self.inner.borrow_mut();
        let next = h.redo.pop()?;
        h.undo.push(now.clone());
        h.last = Some(next.clone());
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_changes_are_steps_and_a_drag_is_one() {
        let h = OpsHistory::<i32>::default();
        h.observe("a", &1, true);
        assert!(!h.can_undo());
        h.observe("a", &2, true);
        // A drag: many values, one step when it settles.
        h.observe("a", &3, false);
        h.observe("a", &4, false);
        h.observe("a", &5, true);
        assert_eq!(h.undo(&5), Some(2));
        assert_eq!(h.undo(&2), Some(1));
        assert_eq!(h.undo(&1), None);
        assert_eq!(h.redo(&1), Some(2));
        // A new change drops what could be done again.
        h.observe("a", &9, true);
        assert!(!h.can_redo());
        // Another file: a new history.
        h.observe("b", &0, true);
        assert!(!h.can_undo());
    }
}
