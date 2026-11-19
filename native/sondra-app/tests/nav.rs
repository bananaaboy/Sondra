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
fn what_does_not_fit_goes_behind_more_from_the_end_and_the_chosen_one_stays() {
    let widths = [60.0, 90.0, 70.0, 90.0, 110.0, 70.0, 100.0, 60.0, 90.0];
    let all = fit_row(&widths, 2.0, 60.0, 2000.0, 0);
    assert_eq!(all.hidden, Vec::<usize>::new());
    assert_eq!(all.shown.len(), 9);

    let narrow = fit_row(&widths, 2.0, 60.0, 420.0, 0);
    assert!(!narrow.hidden.is_empty());
    assert_eq!(*narrow.hidden.last().unwrap(), 8, "the tools go first");
    assert!(narrow.shown.contains(&0));
    let used: f32 = narrow.shown.iter().map(|i| widths[*i]).sum::<f32>()
        + 2.0 * narrow.shown.len() as f32
        + 60.0;
    assert!(used <= 420.0 + 2.0, "it fits: {used}");
    let mut every: Vec<_> = narrow.shown.iter().chain(&narrow.hidden).copied().collect();
    every.sort();
    assert_eq!(every, (0..9).collect::<Vec<_>>(), "nothing is lost");

    // A tool from the end of the row stays visible when it is the chosen one.
    let chosen = fit_row(&widths, 2.0, 60.0, 420.0, 8);
    assert!(chosen.shown.contains(&8));
    assert!(!chosen.hidden.contains(&8));
}

#[test]
fn a_row_too_narrow_for_anything_keeps_the_chosen_entry() {
    let fit = fit_row(&[100.0, 100.0], 2.0, 60.0, 50.0, 1);
    assert_eq!(fit.shown, vec![1]);
    assert_eq!(fit.hidden, vec![0]);
}
