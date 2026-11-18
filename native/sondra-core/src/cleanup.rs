//! What to delete when the storage limit is passed.
//!
//! One rule, held without exception: only episodes marked as *seen* are ever
//! candidates, and only files this service fetched itself. An unseen episode
//! is never deleted, even when that leaves the limit exceeded — the limit is
//! a wish, the unseen episode is what someone came for.

use std::path::PathBuf;

use crate::merkliste::Shared;
use crate::state::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deletion {
    pub path: PathBuf,
    pub size: u64,
    pub series_id: String,
    pub season: u32,
    pub episode: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CleanupPlan {
    pub delete: Vec<Deletion>,
    /// Over the limit even after deleting every seen file.
    pub still_over: bool,
}

/// The seen files to remove, oldest first, until the total fits the limit.
pub fn plan_cleanup(state: &State, shared: &Shared, limit_bytes: Option<u64>) -> CleanupPlan {
    let Some(limit) = limit_bytes else {
        return CleanupPlan::default();
    };
    let mut total = state.total_size();
    if total <= limit {
        return CleanupPlan::default();
    }
    let mut candidates: Vec<_> = state
        .fetched
        .iter()
        .filter(|file| {
            shared
                .alive()
                .find(|item| item.id == file.series_id)
                .is_some_and(|item| item.has_seen(file.season, file.episode))
        })
        .collect();
    candidates.sort_by_key(|file| file.fetched_at);

    let mut plan = CleanupPlan::default();
    for file in candidates {
        if total <= limit {
            break;
        }
        total -= file.size;
        plan.delete.push(Deletion {
            path: file.path.clone(),
            size: file.size,
            series_id: file.series_id.clone(),
            season: file.season,
            episode: file.episode,
        });
    }
    plan.still_over = total > limit;
    plan
}
