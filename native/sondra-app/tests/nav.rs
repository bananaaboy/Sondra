//! The navigation is the web app's (`scripts/make-nav-golden.mts`): the same tools, addresses, labels
//! and summaries, the same groups in the same order.

use serde::Deserialize;
use sondra_app::nav::*;

const GOLDEN: &str = include_str!("golden/nav.json");

#[derive(Deserialize)]
struct GPanel {
    id: String,
    slug: String,
    label: String,
    summary: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum GEntry {
    Panel {
        panel: String,
    },
    Group {
        id: String,
        label: String,
        panels: Vec<String>,
    },
}
#[derive(Deserialize)]
struct Golden {
    panels: Vec<GPanel>,
    entries: Vec<GEntry>,
}

fn golden() -> Golden {
    serde_json::from_str(GOLDEN).unwrap()
}

#[test]
fn the_tools_are_the_web_apps() {
    let g = golden();
    assert_eq!(PANELS.len(), g.panels.len());
    for (mine, theirs) in PANELS.iter().zip(&g.panels) {
        assert_eq!(mine.id, theirs.id);
        assert_eq!(mine.slug, theirs.slug, "{}", theirs.id);
        assert_eq!(mine.label, theirs.label, "{}", theirs.id);
        assert_eq!(mine.summary, theirs.summary, "{}", theirs.id);
    }
}

#[test]
fn the_groups_are_the_web_apps() {
    let g = golden();
    assert_eq!(ENTRIES.len(), g.entries.len());
    for (mine, theirs) in ENTRIES.iter().zip(&g.entries) {
        match (mine, theirs) {
            (Entry::Single(p), GEntry::Panel { panel }) => assert_eq!(p.meta().id, panel),
            (
                Entry::Group { id, label, panels },
                GEntry::Group {
                    id: i,
                    label: l,
                    panels: ps,
                },
            ) => {
                assert_eq!((id, label), (&i.as_str(), &l.as_str()));
                let mine: Vec<_> = panels.iter().map(|p| p.meta().id).collect();
                assert_eq!(mine, ps.iter().map(String::as_str).collect::<Vec<_>>());
            }
            _ => panic!("a single tool on one side, a group on the other"),
        }
    }
}

#[test]
fn the_row_and_the_list_are_in_the_same_order() {
    // Otherwise the arrow keys and the direction a tool slides in from would mean different things.
    let flat: Vec<_> = ENTRIES
        .iter()
        .flat_map(|e| e.panels().iter().copied())
        .collect();
    let all: Vec<_> = PANELS.iter().map(|m| m.panel).collect();
    assert_eq!(flat, all);
}

#[test]
fn an_address_names_a_tool_and_an_unknown_one_is_the_start() {
    assert_eq!(Panel::from_slug("spuren-trennen"), Panel::Stems);
    assert_eq!(Panel::from_slug("#ordner"), Panel::Folder);
    assert_eq!(Panel::from_slug(""), Panel::Start);
    assert_eq!(Panel::from_slug("gibt-es-nicht"), Panel::Start);
    for m in PANELS.iter() {
        assert_eq!(Panel::from_slug(m.slug), m.panel);
    }
}

#[test]
fn stepping_wraps_and_tools_slide_in_from_the_side_of_their_tab() {
    assert_eq!(Panel::Mic.step(1), Panel::Start);
    assert_eq!(Panel::Start.step(-1), Panel::Mic);
    assert_eq!(slide_from(Panel::Start, Panel::Audio), 1);
    assert_eq!(slide_from(Panel::Audio, Panel::Folder), -1);
    assert_eq!(slide_from(Panel::Audio, Panel::Audio), 0);
    assert_eq!(entry_of(Panel::Harmony), 7);
    assert_eq!(entry_of(Panel::Start), 0);
}

#[test]
fn the_sheet_grows_in_steps_and_stops() {
    use sondra_app::layout::*;
    assert_eq!(shell_width(1024.0), 1280.0);
    assert_eq!(shell_width(1600.0), 1440.0);
    assert_eq!(shell_width(2560.0), 1840.0);
    assert_eq!(shell_width(5000.0), 1840.0);
    assert_eq!(
        [400.0, 700.0, 1000.0, 1300.0].map(columns_for),
        [2, 3, 4, 5],
        "more room on the plate is more tiles, not wider ones"
    );
}
