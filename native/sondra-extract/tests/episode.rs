//! The episode flow, against the same stand-in site the website's own check uses
//! (`scripts/verify-extractors.mjs`).

mod common;

use common::Pages;
use sondra_extract::episode::*;

const EPISODE: &str = r#"
      <!DOCTYPE html><html><head><title>One Piece Staffel 1 Folge 1</title></head><body>
        <div class="series-title"><h1><span>One Piece</span></h1></div>
        <div class="hosterSiteTitle">
          <h2><span class="episodeGermanTitle">Ich bin Ruffy!</span> <small class="episodeEnglishTitle">I'm Luffy!</small></h2>
        </div>
        <div class="hosterSiteVideo">
          <ul class="row">
            <li class="col-md-3 episodeLink101" data-lang-key="3" data-link-id="101" data-link-target="/redirect/101">
              <div><a class="watchEpisode" href="/redirect/101"><h4>VOE</h4></a></div>
            </li>
            <li class="col-md-3 episodeLink102" data-lang-key="1" data-link-id="102" data-link-target="/redirect/102">
              <div><a class="watchEpisode" href="/redirect/102"><h4>Filemoon</h4></a></div>
            </li>
          </ul>
        </div>
      </body></html>"#;

const SITE: &str = "https://ani.example";
const PAGE: &str = "https://ani.example/anime/stream/one-piece/staffel-1/episode-1";

/// VOE's embed page with the payload the JavaScript check uses, and a Filemoon page that has a packed script.
fn site() -> Pages {
    let voe = common::voe_page("https://delivery.voe.example/hls/master.m3u8", "Sample");
    let packed = "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1=\"2\";',3,3,'var|source|https://storage.example/hls.m3u8'.split('|')))";
    Pages::new(&[
        (PAGE, EPISODE),
        ("https://voe.example/e/sample", &voe),
        (
            "https://filemoon.example/e/fm123",
            &format!("<html><title>Packed - FileMoon</title><script>{packed}</script></html>"),
        ),
    ])
    .redirect(
        &format!("{SITE}/redirect/101"),
        "https://voe.example/e/sample",
    )
    .redirect(
        &format!("{SITE}/redirect/102"),
        "https://filemoon.example/e/fm123",
    )
}

#[test]
fn resolves_the_hosters_in_order_of_preference() {
    let found = extract_episode(&site(), PAGE, "", 0).expect("an episode");
    assert_eq!(found.title, "One Piece - S01E01 - Ich bin Ruffy!");
    assert_eq!((found.season, found.episode), (1, 1));
    assert_eq!(found.hoster, "VOE");
    assert_eq!(found.url, "https://delivery.voe.example/hls/master.m3u8");
    assert!(found.is_hls);
    assert_eq!(found.all_entries.len(), 2);
    assert_eq!(found.streams.len(), 2);
    assert_eq!(found.streams[1].provider, "Filemoon");
    assert_eq!(found.streams[1].label, "Filemoon · Deutsch");
    assert_eq!(found.streams[0].ext, "mp4");
    assert_eq!(
        found
            .available_languages
            .iter()
            .map(|l| l.code.as_str())
            .collect::<Vec<_>>(),
        ["ger_sub", "ger_dub"]
    );
}

#[test]
fn a_language_preference_decides_and_shows_in_the_title() {
    let found = extract_episode(&site(), PAGE, "ger_dub", 0).expect("an episode");
    assert_eq!(found.hoster, "Filemoon");
    assert_eq!(found.lang_key, 1);
    assert_eq!(found.title, "One Piece - S01E01 - Ich bin Ruffy! [Ger-Dub]");
}

#[test]
fn a_hoster_that_gives_nothing_is_skipped_and_none_at_all_is_nothing() {
    let broken = Pages::new(&[(PAGE, EPISODE)])
        .redirect(
            &format!("{SITE}/redirect/101"),
            "https://voe.example/e/gone",
        )
        .redirect(
            &format!("{SITE}/redirect/102"),
            "https://filemoon.example/e/gone",
        );
    assert_eq!(extract_episode(&broken, PAGE, "", 0), None);
    assert_eq!(extract_episode(&Pages::new(&[]), PAGE, "", 0), None);
}

#[test]
fn a_season_page_has_no_streams_here() {
    assert_eq!(
        extract_episode(
            &site(),
            "https://ani.example/anime/stream/one-piece/staffel-1",
            "",
            0
        ),
        None
    );
}

#[test]
fn a_film_is_numbered_as_one() {
    let film = EPISODE.to_owned();
    let url = "https://ani.example/anime/stream/one-piece/filme/film-2";
    let voe = common::voe_page("https://delivery.voe.example/hls/master.m3u8", "Sample");
    let pages = Pages::new(&[(url, &film), ("https://voe.example/e/sample", &voe)]).redirect(
        &format!("{SITE}/redirect/101"),
        "https://voe.example/e/sample",
    );
    let found = extract_episode(&pages, url, "", 0).expect("a film");
    assert_eq!(found.title, "One Piece - Film 2 - Ich bin Ruffy!");
    assert_eq!((found.season, found.episode), (0, 2));
}

#[test]
fn the_redirect_can_also_be_a_page_that_forwards() {
    let meta = r#"<meta http-equiv="refresh" content="0; url=https://voe.example/e/sample">"#;
    let pages = Pages::new(&[("https://ani.example/redirect/9", meta)]);
    assert_eq!(
        resolve_redirect(&pages, "https://ani.example/redirect/9", PAGE).as_deref(),
        Some("https://voe.example/e/sample")
    );
    let js = r#"<script>window.location.href = "/e/zz";</script>"#;
    let pages = Pages::new(&[("https://ani.example/redirect/8", js)]);
    assert_eq!(
        resolve_redirect(&pages, "https://ani.example/redirect/8", PAGE).as_deref(),
        Some("https://ani.example/e/zz")
    );
}
