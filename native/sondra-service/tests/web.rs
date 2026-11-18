//! The service's two web parts, against a stand-in site (pages, as `scripts/verify-extractors.mjs`
//! has them) and a media server on this computer.

use std::io::Cursor;
use std::path::Path;

use sondra_core::merkliste::Item;
use sondra_core::plan::Want;
use sondra_daemon::ports::{Checker, Fetcher};
use sondra_extract::testing::{voe_page, Pages};
use sondra_service::{episode_url, season_folder, WebChecker, WebFetcher};

#[test]
fn the_address_of_an_episode_is_built_from_the_series_link() {
    let e = |u: &str, s, n| episode_url(u, s, n);
    assert_eq!(
        e("https://aniworld.to/anime/stream/frieren", 2, 5).as_deref(),
        Some("https://aniworld.to/anime/stream/frieren/staffel-2/episode-5")
    );
    assert_eq!(
        e(
            "https://aniworld.to/anime/stream/frieren/staffel-1/episode-13?x=1#y",
            3,
            1
        )
        .as_deref(),
        Some("https://aniworld.to/anime/stream/frieren/staffel-3/episode-1")
    );
    assert_eq!(
        e("https://s.to/serie/stream/dark/staffel-1", 1, 2).as_deref(),
        Some("https://s.to/serie/stream/dark/staffel-1/episode-2")
    );
    assert_eq!(
        e("https://aniworld.to/anime/stream/frieren/filme", 0, 2).as_deref(),
        Some("https://aniworld.to/anime/stream/frieren/filme/film-2")
    );
    // Not the site's own, or not a series.
    assert_eq!(e("https://example.com/anime/stream/frieren", 1, 1), None);
    assert_eq!(e("https://aniworld.to/", 1, 1), None);
    assert_eq!(e("not a link", 1, 1), None);
    assert_eq!(season_folder(0), "Filme");
    assert_eq!(season_folder(3), "Staffel 3");
}

fn item(url: &str) -> Item {
    serde_json::from_value(serde_json::json!({ "id": "a1", "title": "Frieren", "url": url }))
        .expect("an item")
}

#[test]
fn the_checker_reports_how_far_a_series_is_online() {
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/frieren",
            r#"<div class="series-title"><h1 itemprop="name"><span>Frieren</span></h1></div>
               <a href="/anime/stream/frieren/staffel-1">1</a><a href="/anime/stream/frieren/staffel-2">2</a>"#,
        ),
        (
            "https://aniworld.to/anime/stream/frieren/staffel-2",
            r#"<tr data-episode-id="1"><td><meta itemprop="episodeNumber" content="7" /><a href="/anime/stream/frieren/staffel-2/episode-7">Folge 7</a></td></tr>"#,
        ),
    ]);
    let checker = WebChecker { fetch: pages };
    let found = checker
        .latest(&item(
            "https://aniworld.to/anime/stream/frieren/staffel-1/episode-13",
        ))
        .unwrap()
        .expect("online");
    assert_eq!((found.max_season, found.max_episode), (2, 7));
    assert!(found.checked_at > 0);
    // A link the service does not know is "the site does not say", not an error.
    assert!(checker
        .latest(&item("https://example.com/watch"))
        .unwrap()
        .is_none());
    // A site that cannot be read likewise.
    let down = WebChecker {
        fetch: Pages::new(&[]),
    };
    assert!(down
        .latest(&item("https://aniworld.to/anime/stream/frieren"))
        .unwrap()
        .is_none());
}

/* Fetching ------------------------------------------------------------------------------------ */

const EPISODE: &str = r#"<div class="series-title"><h1><span>One Piece</span></h1></div>
  <span class="episodeGermanTitle">Ich bin Ruffy!</span>
  <ul>
   <li data-lang-key="3" data-link-target="/redirect/1"><a href="/redirect/1"><h4>VOE</h4></a></li>
   <li data-lang-key="3" data-link-target="/redirect/2"><a href="/redirect/2"><h4>Vidoza</h4></a></li>
  </ul>"#;

fn media_server(body: Vec<u8>) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
    let base = format!("http://{}", server.server_addr().to_ip().unwrap());
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let response = if request.url() == "/film.mp4" {
                tiny_http::Response::new(
                    tiny_http::StatusCode(200),
                    vec![],
                    Cursor::new(body.clone()),
                    Some(body.len()),
                    None,
                )
            } else {
                tiny_http::Response::new(
                    tiny_http::StatusCode(404),
                    vec![],
                    Cursor::new(Vec::new()),
                    Some(0),
                    None,
                )
            };
            let _ = request.respond(response);
        }
    });
    base
}

fn want() -> Want {
    Want {
        series_id: "a1".into(),
        title: "One Piece".into(),
        url: "https://aniworld.to/anime/stream/one-piece".into(),
        season: 1,
        episode: 1,
    }
}

fn fetcher(pages: Pages, folder: &Path) -> WebFetcher<Pages> {
    let mut f = WebFetcher::new(pages, folder.to_owned());
    f.allow_private = true; // the media server is on this computer
    f
}

fn bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 13 + i / 7) % 256) as u8).collect()
}

#[test]
fn an_episode_lands_in_the_series_folder_with_the_episode_in_its_name() {
    let media = media_server(bytes(40_000));
    let voe = voe_page(&format!("{media}/film.mp4"), "One Piece - S01E01");
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1",
            EPISODE,
        ),
        ("https://voe.example/e/sample", &voe),
    ])
    .redirect(
        "https://aniworld.to/redirect/1",
        "https://voe.example/e/sample",
    );
    let folder = tempfile::tempdir().unwrap();
    let got = fetcher(pages, folder.path())
        .fetch(&want(), None)
        .expect("a file");
    assert_eq!(
        got.path,
        folder
            .path()
            .join("One Piece")
            .join("Staffel 1")
            .join("One Piece - S01E01 - Ich bin Ruffy!.mp4")
    );
    assert_eq!(got.size, 40_000);
    assert!(std::fs::read(&got.path).unwrap() == bytes(40_000));
}

#[test]
fn when_one_source_fails_the_next_mirror_is_tried() {
    let media = media_server(bytes(30_000));
    // VOE's stream is gone (404 at the media server); Vidoza's is there.
    let voe = voe_page(&format!("{media}/gone.mp4"), "x");
    let vidoza = format!(
        r#"<title>Bleach - Vidoza</title><source src="{media}/film.mp4" type="video/mp4">"#
    );
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1",
            EPISODE,
        ),
        ("https://voe.example/e/sample", &voe),
        ("https://vidoza.net/embed-vz1.html", &vidoza),
    ])
    .redirect(
        "https://aniworld.to/redirect/1",
        "https://voe.example/e/sample",
    )
    .redirect(
        "https://aniworld.to/redirect/2",
        "https://vidoza.net/embed-vz1.html",
    );
    let folder = tempfile::tempdir().unwrap();
    let got = fetcher(pages, folder.path())
        .fetch(&want(), None)
        .expect("the mirror worked");
    assert_eq!(got.size, 30_000);
}

#[test]
fn what_cannot_be_fetched_says_why_and_leaves_nothing() {
    let folder = tempfile::tempdir().unwrap();
    // A link the service cannot use.
    let mut w = want();
    w.url = "https://example.com/watch".into();
    let err = fetcher(Pages::new(&[]), folder.path())
        .fetch(&w, None)
        .unwrap_err();
    assert!(err.contains("selbst laden"), "{err}");
    // A page with no source that works.
    let err = fetcher(Pages::new(&[]), folder.path())
        .fetch(&want(), None)
        .unwrap_err();
    assert!(err.contains("keine abspielbare Quelle"), "{err}");
    // Every source gone: the last reason is told.
    let media = media_server(bytes(10));
    let voe = voe_page(&format!("{media}/gone.mp4"), "x");
    let pages = Pages::new(&[
        (
            "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1",
            EPISODE,
        ),
        ("https://voe.example/e/sample", &voe),
    ])
    .redirect(
        "https://aniworld.to/redirect/1",
        "https://voe.example/e/sample",
    );
    let err = fetcher(pages, folder.path())
        .fetch(&want(), None)
        .unwrap_err();
    assert!(err.contains("VOE") && err.contains("404"), "{err}");
    assert_eq!(
        walk(folder.path()),
        Vec::<String>::new(),
        "nothing is left behind"
    );
}

fn walk(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path.display().to_string());
        }
    }
    out
}

#[test]
fn the_configured_fetcher_reads_the_folder_when_it_fetches() {
    use sondra_service::runner::{save_config, state_path};
    let _ = state_path;
    let settings = tempfile::tempdir().unwrap();
    let folder = tempfile::tempdir().unwrap();
    let media = media_server(bytes(33_000));
    let voe = voe_page(&format!("{media}/film.mp4"), "x");
    let make = move || {
        Pages::new(&[
            (
                "https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1",
                EPISODE,
            ),
            ("https://voe.example/e/sample", &voe),
        ])
        .redirect(
            "https://aniworld.to/redirect/1",
            "https://voe.example/e/sample",
        )
    };
    let mut fetcher = sondra_service::ConfiguredFetcher::new(settings.path().to_owned(), make);
    fetcher.allow_private = true;

    // Nothing chosen: nothing is fetched, and it says why.
    let err = fetcher.fetch(&want(), None).unwrap_err();
    assert!(err.contains("kein Ordner gewählt"), "{err}");

    // Chosen after the service started: it applies to the next episode.
    let mut config = sondra_core::config::Config::default();
    config.folder = Some(folder.path().display().to_string());
    save_config(settings.path(), &config).unwrap();
    let got = fetcher.fetch(&want(), None).expect("a file");
    assert!(got.path.starts_with(folder.path()));
    assert_eq!(got.size, 33_000);
}
