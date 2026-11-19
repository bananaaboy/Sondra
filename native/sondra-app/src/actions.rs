//! What Sondra can do, in one list — `src/lib/actions.ts`. The tiles of the start page and the search over
//! them. The list itself is data written by the web app's own code (`npm run native:golden` →
//! `data/actions.json`), so a capability added there cannot be forgotten here; the search is the same
//! function, checked against what the web app finds for typical questions.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::nav::Panel;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Holen,
    Ton,
    Video,
    Bild,
    Musik,
}

impl Group {
    pub fn label(self) -> &'static str {
        match self {
            Group::Holen => "Hereinholen",
            Group::Ton => "Ton",
            Group::Video => "Video",
            Group::Bild => "Bilder",
            Group::Musik => "Für Musik",
        }
    }
}

#[derive(Deserialize)]
struct Raw {
    id: String,
    panel: String,
    group: Group,
    label: String,
    hint: String,
    kinds: Vec<String>,
    keywords: Vec<String>,
}

#[derive(Deserialize)]
struct Data {
    filters: Vec<Group>,
    start: Vec<StartGroup>,
    actions: Vec<Raw>,
}

#[derive(Deserialize)]
struct StartGroup {
    group: Group,
    ids: Vec<String>,
}

pub struct Action {
    pub id: String,
    pub panel: Panel,
    pub group: Group,
    /// What it produces, in the user's words.
    pub label: String,
    pub hint: String,
    /// The file kinds it applies to; empty means it needs no file.
    pub kinds: Vec<String>,
    /// Extra words people actually type, including the English ones.
    pub keywords: Vec<String>,
    keywords_joined: String,
}

struct Loaded {
    actions: Vec<Action>,
    filters: Vec<Group>,
    start: Vec<(Group, Vec<usize>)>,
}

fn loaded() -> &'static Loaded {
    static LOADED: OnceLock<Loaded> = OnceLock::new();
    LOADED.get_or_init(|| {
        let data: Data = serde_json::from_str(include_str!("../data/actions.json"))
            .expect("data/actions.json is written by the web app's own code");
        let actions: Vec<Action> = data
            .actions
            .into_iter()
            .map(|a| Action {
                panel: Panel::from_id(&a.panel).expect("an action names a tool that exists"),
                keywords_joined: a.keywords.join(" "),
                id: a.id,
                group: a.group,
                label: a.label,
                hint: a.hint,
                kinds: a.kinds,
                keywords: a.keywords,
            })
            .collect();
        let at = |id: &str| {
            actions
                .iter()
                .position(|a| a.id == id)
                .expect("the start page names an action that exists")
        };
        let start = data
            .start
            .iter()
            .map(|g| (g.group, g.ids.iter().map(|id| at(id)).collect()))
            .collect();
        Loaded {
            actions,
            filters: data.filters,
            start,
        }
    })
}

pub fn all() -> &'static [Action] {
    &loaded().actions
}

pub fn find(id: &str) -> Option<&'static Action> {
    all().iter().find(|a| a.id == id)
}

/// The groups a visitor filters by on the start page; „Hereinholen“ is the way in above.
pub fn filters() -> &'static [Group] {
    &loaded().filters
}

/// The tiles of the start page: each group in its order, the common jobs first.
pub fn start_groups() -> Vec<(Group, Vec<&'static Action>)> {
    let l = loaded();
    l.start
        .iter()
        .map(|(g, ix)| (*g, ix.iter().map(|i| &l.actions[*i]).collect()))
        .collect()
}

/// Free-text search over everything, as forgiving as the web's: it matches the label, the hint and the
/// keywords, so „mp3 aus video“, „extract audio“ and „tonspur“ find the same thing, and a hit in the
/// label beats one in a keyword.
pub fn search(query: &str) -> Vec<&'static Action> {
    let lowered = query.to_lowercase();
    let terms: Vec<&str> = lowered.split_whitespace().collect();
    if terms.is_empty() {
        return all().iter().collect();
    }
    let mut scored: Vec<(i32, &Action)> = Vec::new();
    'actions: for action in all() {
        let label = action.label.to_lowercase();
        let hint = action.hint.to_lowercase();
        let mut score = 0;
        for term in &terms {
            if label.contains(term) {
                score += 6;
            } else if action.keywords_joined.contains(term) {
                score += 3;
            } else if hint.contains(term) {
                score += 2;
            } else {
                continue 'actions;
            }
        }
        scored.push((score, action));
    }
    // Stable, like the web's sort: equal scores keep the list's order.
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.into_iter().map(|(_, a)| a).collect()
}
