//! The AniWorld cases of `scripts/verify-extractors.mjs`, against the same pages.

use std::cell::RefCell;
use std::collections::HashMap;

use sondra_extract::aniworld::*;
use sondra_extract::fetch::{Fetch, FetchError, Page, Request};

/// Stand-in pages by address; anything else is a 404. Remembers what was asked.
struct Pages {
    pages: HashMap<String, String>,
    asked: RefCell<Vec<String>>,
}

impl Pages {
    fn new(pages: &[(&str, &str)]) -> Self {
        Self {
            pages: pages
                .iter()
                .map(|(u, b)| ((*u).to_owned(), (*b).to_owned()))
                .collect(),
            asked: RefCell::default(),
        }
    }
}

impl Fetch for Pages {
    fn fetch(&self, request: &Request) -> Result<Page, FetchError> {
        self.asked.borrow_mut().push(request.url.clone());
        let body = self.pages.get(&request.url);
        Ok(Page {
            status: if body.is_some() { 200 } else { 404 },
            url: request.url.clone(),
            location: None,
            content_type: Some("text/html".into()),
            body: body.cloned().unwrap_or_else(|| "nicht da".into()),
        })
    }
}

const SEASON: &str = r#"
  <!DOCTYPE html><html><head><title>One Piece Staffel 1</title></head><body>
    <div class="series-title"><h1><span>One Piece</span></h1></div>
    <table><tbody>
      <tr data-episode-id="1">
        <td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/one-piece/staffel-1/episode-1">Folge 1</a></td>
        <td><strong>Ich bin Ruffy!</strong> - <span>I'm Luffy!</span></td>
      </tr>
      <tr data-episode-id="2">
        <td><meta itemprop="episodeNumber" content="2" /><a href="/anime/stream/one-piece/staffel-1/episode-2">Folge 2</a></td>
        <td><strong>Der große Schwertkämpfer</strong> - <span>Great Swordsman</span></td>
      </tr>
    </tbody></table>
  </body></html>"#;

const FILME: &str = r#"
  <!DOCTYPE html><html><head><title>One Piece Filme</title></head><body>
    <div class="series-title"><h1><span>One Piece</span></h1></div>
    <table><tbody>
      <tr data-episode-id="101">
        <td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/one-piece/filme/film-1">Film 1</a></td>
        <td><strong>Das Abenteuer beginnt</strong></td>
      </tr>
      <tr data-episode-id="102">
        <td><meta itemprop="episodeNumber" content="2" /><a href="/anime/stream/one-piece/filme/film-2">Film 2</a></td>
        <td><strong>Abenteuer auf der Spiralinsel</strong></td>
      </tr>
    </tbody></table>
  </body></html>"#;

#[test]
fn recognises_the_sites_own_links() {
    assert!(is_aniworld_url(
        "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1"
    ));
    assert!(is_aniworld_url(
        "https://aniworld.to/anime/stream/one-piece/filme/film-1"
    ));
    assert!(is_aniworld_url("https://s.to/serie/stream/x"));
    assert!(!is_aniworld_url("https://youtube.com/watch?v=123"));
    assert!(!is_aniworld_url("kein link"));
    assert!(is_aniworld_season_url(
        "https://aniworld.to/anime/stream/one-piece/staffel-1"
    ));
    assert!(is_aniworld_season_url(
        "https://aniworld.to/anime/stream/one-piece"
    ));
    assert!(!is_aniworld_season_url(
        "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1"
    ));
}

#[test]
fn language_preferences() {
    assert_eq!(parse_language("auto"), None);
    assert_eq!(parse_language(""), None);
    assert_eq!(parse_language("ger_sub"), Some(3));
    assert_eq!(parse_language("Deutsch Sub"), Some(3));
    assert_eq!(parse_language("de"), Some(1));
    assert_eq!(parse_language("ger-dub"), Some(1));
    assert_eq!(parse_language("English"), Some(2));
    assert_eq!(parse_language("klingonisch"), None);
}

#[test]
fn reads_a_season_page_in_order_with_titles() {
    let pages = Pages::new(&[(
        "https://aniworld.to/anime/stream/one-piece/staffel-1",
        SEASON,
    )]);
    let season = extract_season(
        &pages,
        "https://aniworld.to/anime/stream/one-piece/staffel-1",
    )
    .expect("a season");
    assert_eq!(season.title, "One Piece - Staffel 1");
    assert_eq!(season.season_number, 1);
    assert_eq!(season.items.len(), 2);
    assert_eq!(season.items[0].title, "One Piece - S01E01 - Ich bin Ruffy!");
    assert_eq!(
        season.items[0].url,
        "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1"
    );
    assert_eq!(
        season.items[1].title,
        "One Piece - S01E02 - Der große Schwertkämpfer"
    );
}

#[test]
fn reads_the_films_page() {
    let pages = Pages::new(&[("https://aniworld.to/anime/stream/one-piece/filme", FILME)]);
    let films =
        extract_season(&pages, "https://aniworld.to/anime/stream/one-piece/filme").expect("films");
    assert_eq!(films.title, "One Piece - Filme");
    assert_eq!(films.season_number, 0);
    assert_eq!(
        films.items[0].title,
        "One Piece - Film 1 - Das Abenteuer beginnt"
    );
    assert_eq!(films.items[1].episode_number, 2);
}

#[test]
fn a_page_without_table_rows_falls_back_to_the_links() {
    let html = r#"<div class="series-title"><h1><span>X</span></h1></div>
        <a href="/anime/stream/x/staffel-2/episode-3">3</a>
        <a href="/anime/stream/x/staffel-2/episode-4">4</a>
        <a href="/anime/stream/x/staffel-2/episode-3">3 again</a>"#;
    let pages = Pages::new(&[("https://aniworld.to/anime/stream/x/staffel-2", html)]);
    let season = extract_season(&pages, "https://aniworld.to/anime/stream/x/staffel-2").unwrap();
    assert_eq!(
        season
            .items
            .iter()
            .map(|i| i.episode_number)
            .collect::<Vec<_>>(),
        [3, 4],
        "the same link twice is one episode"
    );
    assert_eq!(season.items[0].title, "X - S02E03");
}

#[test]
fn a_page_that_cannot_be_read_or_has_no_episodes_is_nothing() {
    assert_eq!(
        extract_season(
            &Pages::new(&[]),
            "https://aniworld.to/anime/stream/gone/staffel-1"
        ),
        None
    );
    let pages = Pages::new(&[(
        "https://aniworld.to/anime/stream/empty/staffel-1",
        "<html>nothing here</html>",
    )]);
    assert_eq!(
        extract_season(&pages, "https://aniworld.to/anime/stream/empty/staffel-1"),
        None
    );
}

fn frieren() -> Pages {
    Pages::new(&[
        (
            "https://aniworld.to/anime/stream/frieren",
            r#"
      <div class="series-title"><h1 itemprop="name"><span>Frieren &amp; Co</span></h1></div>
      <ul><li><a href="/anime/stream/frieren/filme">Filme</a></li>
      <li><a href="/anime/stream/frieren/staffel-1" title="Staffel 1">1</a></li>
      <li><a href="/anime/stream/frieren/staffel-2" title="Staffel 2">2</a></li></ul>
      <a href="/anime/stream/frieren/staffel-1/episode-28">28</a>
      <aside><a href="/anime/stream/one-piece">One Piece</a>
      <a href="/anime/stream/one-piece/staffel-21/episode-1100">Neu: One Piece 1100</a>
      <div data-season-id="48213"></div></aside>"#,
        ),
        (
            "https://aniworld.to/anime/stream/frieren/staffel-2",
            r#"
      <tr data-episode-id="1"><td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/frieren/staffel-2/episode-1">Folge 1</a></td></tr>
      <tr data-episode-id="2"><td><meta itemprop="episodeNumber" content="7" /><a href="/anime/stream/frieren/staffel-2/episode-7">Folge 7</a></td></tr>
      <aside><a href="/anime/stream/one-piece/staffel-21/episode-1100">Neu: One Piece 1100</a></aside>"#,
        ),
    ])
}

#[test]
fn how_far_a_series_is_online_counts_only_its_own_links() {
    let pages = frieren();
    let online = check_online_updates(
        &pages,
        "https://aniworld.to/anime/stream/frieren/staffel-1/episode-13",
        false,
        42,
    )
    .expect("online");
    assert_eq!(online.series_title, "Frieren & Co");
    assert_eq!(
        online.max_season, 2,
        "another series' Staffel 21 and a database id do not count"
    );
    assert_eq!(
        online.max_episode, 7,
        "the newest episode in the newest season, from the page of that season"
    );
    assert!(online.has_movies);
    assert_eq!(online.checked_at, 42);
    assert_eq!(
        pages.asked.borrow().join(" "),
        "https://aniworld.to/anime/stream/frieren https://aniworld.to/anime/stream/frieren/staffel-2",
        "the series page and the newest season, nothing else"
    );
}

#[test]
fn a_link_that_is_not_the_sites_own_is_not_asked_about() {
    let pages = frieren();
    assert_eq!(
        check_online_updates(&pages, "https://example.com/anime/stream/frieren", false, 0),
        None
    );
    assert!(
        pages.asked.borrow().is_empty(),
        "nothing leaves the computer for a foreign host"
    );
    assert_eq!(
        check_online_updates(
            &pages,
            "https://aniworld.to/anime/stream/gibt-es-nicht",
            false,
            0
        ),
        None
    );
}

#[test]
fn full_metadata_counts_every_season_and_the_films() {
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/frieren",
            r#"<div class="series-title"><h1><span>F</span></h1></div>
          <a href="/anime/stream/frieren/filme">Filme</a>
          <a href="/anime/stream/frieren/staffel-1/episode-28">28</a>
          <a href="/anime/stream/frieren/staffel-2">2</a>
          <a href="/anime/stream/frieren/staffel-3">3</a>"#,
        ),
        (
            "https://aniworld.to/anime/stream/frieren/staffel-2",
            r#"<a href="/anime/stream/frieren/staffel-2/episode-10">10</a>"#,
        ),
        (
            "https://aniworld.to/anime/stream/frieren/staffel-3",
            r#"<a href="/anime/stream/frieren/staffel-3/episode-4">4</a>"#,
        ),
        (
            "https://aniworld.to/anime/stream/frieren/filme",
            r#"<a href="/anime/stream/frieren/filme/film-1">1</a><a href="/anime/stream/frieren/filme/film-2">2</a>"#,
        ),
    ]);
    let online =
        check_online_updates(&pages, "https://aniworld.to/anime/stream/frieren", true, 0).unwrap();
    let seasons = online.seasons.expect("seasons were asked for");
    let counts: Vec<_> = seasons.iter().map(|s| (s.number, s.episodes)).collect();
    assert_eq!(
        counts,
        [(1, Some(28)), (2, Some(10)), (3, Some(4)), (0, Some(2))]
    );
}

#[test]
fn a_slug_with_a_dot_stays_itself() {
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/dr.stone",
            r#"<a href="/anime/stream/dr.stone/staffel-3">3</a><a href="/anime/stream/drXstone/staffel-9">other</a>"#,
        ),
        (
            "https://aniworld.to/anime/stream/dr.stone/staffel-3",
            r#"<a href="/anime/stream/dr.stone/staffel-3/episode-5">5</a>"#,
        ),
    ]);
    let online = check_online_updates(
        &pages,
        "https://aniworld.to/anime/stream/dr.stone",
        false,
        0,
    )
    .unwrap();
    assert_eq!(
        (online.max_season, online.max_episode),
        (3, 5),
        "'.' is not a wildcard"
    );
}
