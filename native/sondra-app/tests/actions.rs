//! The start page's tiles and the search over them are the web app's (`scripts/make-nav-golden.mts`).

use serde::Deserialize;
use sondra_app::actions::*;
use sondra_app::nav::Panel;

#[derive(Deserialize)]
struct Search {
    query: String,
    ids: Vec<String>,
}

#[test]
fn the_search_finds_what_the_web_search_finds_in_its_order() {
    let golden: Vec<Search> = serde_json::from_str(include_str!("golden/search.json")).unwrap();
    assert!(golden.len() >= 10);
    for case in golden {
        let mine: Vec<&str> = search(&case.query).iter().map(|a| a.id.as_str()).collect();
        assert_eq!(mine, case.ids, "search for {:?}", case.query);
    }
}

#[test]
fn every_action_leads_to_a_tool_and_the_start_page_shows_each_group_once() {
    assert_eq!(all().len(), 50);
    let groups = start_groups();
    assert_eq!(
        groups.iter().map(|(g, _)| *g).collect::<Vec<_>>(),
        filters().to_vec()
    );
    // „Hereinholen“ is the way in, not a group of tiles — but every other action stands in one.
    let shown: usize = groups.iter().map(|(_, a)| a.len()).sum();
    let in_filters = all()
        .iter()
        .filter(|a| filters().contains(&a.group))
        .count();
    assert_eq!(shown, in_filters);
    assert_eq!(find("download").unwrap().panel, Panel::Downloader);
    assert!(find("gibt-es-nicht").is_none());
    assert_eq!(Group::Holen.label(), "Hereinholen");
}

#[test]
fn a_search_for_nothing_finds_everything_and_for_nonsense_nothing() {
    assert_eq!(search("").len(), all().len());
    assert_eq!(search("   ").len(), all().len());
    assert!(search("zzzz").is_empty());
    // Capital letters do not matter.
    assert_eq!(
        search("TONART").iter().map(|a| &a.id).collect::<Vec<_>>(),
        search("tonart").iter().map(|a| &a.id).collect::<Vec<_>>()
    );
}
