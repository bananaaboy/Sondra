//! The hoster cases of `scripts/verify-extractors.mjs`, against the same pages.

mod common;

use common::Pages;
use sondra_extract::hosters::*;
use sondra_extract::voe::extract_voe;

#[test]
fn recognises_voe_and_its_clones() {
    assert!(is_voe_url("https://voe.sx/e/2ldxarskbpp2"));
    assert!(is_voe_url("https://jamesbornmain.com/e/2ldxarskbpp2"));
    // As in the JavaScript: a host with "voe" in it, or any other host's /e/ path, is taken for VOE
    // — this decides which extractor to try first, it is not a security check.
    assert!(is_voe_url("https://example.com/e/2ldxarskbpp2"));
    assert!(!is_voe_url("https://example.com/watch/1"));
    // ... but not one of the other known hosters.
    assert!(!is_voe_url("https://filemoon.sx/e/abc123xyz"));
    assert!(!is_voe_url("https://dood.to/e/xyz123"));
    assert!(!is_voe_url("https://aniworld.to/e/x"));
}

#[test]
fn voe_decodes_the_scrambled_payload() {
    let encoded = common::voe_payload(
        "One Piece - Episode 1",
        "https://delivery.voe.example/hls/master.m3u8",
    );
    let html = format!(
        r#"<!DOCTYPE html><html><head><title>VOE Sample</title></head><body><script type="application/json">["{encoded}"]</script></body></html>"#
    );
    let pages = Pages::new(&[("https://voe.example/e/sample", &html)]);
    let stream = extract_voe(&pages, "https://voe.example/e/sample").expect("a stream");
    assert_eq!(stream.url, "https://delivery.voe.example/hls/master.m3u8");
    assert_eq!(stream.title, "One Piece - Episode 1");
    assert!(stream.is_hls);
    assert_eq!(stream.hoster, "VOE");
    assert_eq!(stream.referer, "https://voe.example/e/sample");
}

#[test]
fn voe_follows_a_redirect_stub_and_reads_the_payload_variable() {
    let encoded = common::voe_payload("Folge", "https://cdn.example/a.m3u8");
    let stub = r#"<script>window.location.href = '/real/page';</script>"#;
    let real = format!(r#"<title>Titel - VOE Sx</title><script>var wc0 = '{encoded}';</script>"#);
    let pages = Pages::new(&[
        ("https://voe.example/e/x", stub),
        ("https://voe.example/real/page", &real),
    ]);
    let stream = extract_voe(&pages, "https://voe.example/e/x").unwrap();
    assert_eq!(stream.url, "https://cdn.example/a.m3u8");
    assert_eq!(
        stream.referer, "https://voe.example/real/page",
        "the page the stream was found on"
    );
}

#[test]
fn voe_falls_back_to_inline_definitions_and_any_m3u8() {
    let hls = r#"<title>Ein Film - VOE Sx</title><script>var s = {"hls": "https://cdn.example/x.m3u8"}</script>"#;
    let p = Pages::new(&[("https://voe.example/e/1", hls)]);
    let s = extract_voe(&p, "https://voe.example/e/1").unwrap();
    assert_eq!(
        (s.url.as_str(), s.is_hls, s.title.as_str()),
        ("https://cdn.example/x.m3u8", true, "Ein Film")
    );

    // In base64, and as mp4.
    let b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode("https://cdn.example/v.mp4")
    };
    let mp4 = format!(r#"<script>var s = {{"mp4": "{b64}"}}</script>"#);
    let p = Pages::new(&[("https://voe.example/e/2", &mp4)]);
    let s = extract_voe(&p, "https://voe.example/e/2").unwrap();
    assert_eq!(
        (s.url.as_str(), s.is_hls, s.title.as_str()),
        ("https://cdn.example/v.mp4", false, "VOE Video")
    );

    let scan = r#"<script>player.load("https://cdn.example/master.m3u8?t=1")</script>"#;
    let p = Pages::new(&[("https://voe.example/e/3", scan)]);
    assert_eq!(
        extract_voe(&p, "https://voe.example/e/3").unwrap().url,
        "https://cdn.example/master.m3u8?t=1"
    );
}

#[test]
fn voe_gives_up_quietly() {
    let p = Pages::new(&[
        ("https://voe.example/e/empty", "<html>nothing</html>"),
        (
            "https://voe.example/e/junk",
            r#"<script type="application/json">["not a payload"]</script>"#,
        ),
    ]);
    assert_eq!(extract_voe(&p, "https://voe.example/e/empty"), None);
    assert_eq!(extract_voe(&p, "https://voe.example/e/junk"), None);
    assert_eq!(extract_voe(&p, "https://voe.example/e/missing"), None);
}

#[test]
fn recognises_the_other_hosters() {
    assert!(is_filemoon_url("https://filemoon.sx/e/abc123xyz"));
    assert!(is_vidmoly_url("https://vidmoly.to/embed-xyz.html"));
    assert!(is_doodstream_url("https://dood.to/e/xyz123"));
    assert!(is_streamtape_url(
        "https://streamtape.com/e/68rB24M1gXszB12"
    ));
    assert!(is_vidoza_url("https://vidoza.net/embed-8x7y6z5w4v.html"));
    assert!(is_hoster_url("https://vidoza.net/embed-8x7y6z5w4v.html"));
    assert!(!is_hoster_url("https://youtube.com/watch?v=1"));
}

#[test]
fn the_packer_unpacks_the_sample() {
    let sample = "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1=\"2\";',3,3,'var|source|https://storage.example/hls.m3u8'.split('|')))";
    assert_eq!(
        sondra_extract::packer::unpack(sample).as_deref(),
        Some("var source=\"https://storage.example/hls.m3u8\";")
    );
    assert_eq!(sondra_extract::packer::unpack("nothing packed"), None);
    assert_eq!(
        sondra_extract::packer::unpack("eval(function(p,a,c,k,e,d) but broken"),
        None
    );
}

fn filemoon_api_page(title: &str, file: &str) -> (String, String) {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let key = [7u8; 32];
    let iv = [9u8; 12];
    let plain =
        format!(r#"{{"sources":[{{"file":"{file}","mime_type":"application/x-mpegurl"}}]}}"#);
    let sealed = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(Nonce::from_slice(&iv), plain.as_bytes())
        .unwrap();
    let body = format!(
        r#"{{"title":"{title}","playback":{{"key_parts":["{}","{}"],"iv":"{}","payload":"{}"}}}}"#,
        URL_SAFE_NO_PAD.encode(&key[..16]),
        URL_SAFE_NO_PAD.encode(&key[16..]),
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(sealed)
    );
    (
        "<html><title>FileMoon Video</title><div id=\"player\"></div></html>".to_owned(),
        body,
    )
}

#[test]
fn filemoon_decrypts_the_api_answer() {
    let (page, api) = filemoon_api_page(
        "Attack on Titan S01E01",
        "https://cdn.filemoon.example/hls/stream.m3u8",
    );
    let pages = Pages::new(&[
        ("https://fm.example/filemoon/e/fm123", &page),
        ("https://fm.example/filemoon/api/videos/fm123", &api),
    ]);
    let s = extract_filemoon(&pages, "https://fm.example/filemoon/e/fm123").expect("a stream");
    assert_eq!(s.url, "https://cdn.filemoon.example/hls/stream.m3u8");
    assert_eq!(s.title, "Attack on Titan S01E01");
    assert!(s.is_hls);
    assert_eq!(s.hoster, "Filemoon");
}

#[test]
fn filemoon_falls_back_to_the_packed_script_and_a_tampered_answer_is_not_trusted() {
    let sample = "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1=\"2\";',3,3,'var|source|https://storage.example/hls.m3u8'.split('|')))";
    let packed = format!("<html><title>Packed FileMoon</title><script>{sample}</script></html>");
    let pages = Pages::new(&[("https://fm.example/filemoon/e/fm_packed", &packed)]);
    let s = extract_filemoon(&pages, "https://fm.example/filemoon/e/fm_packed")
        .expect("from the packer");
    assert_eq!(s.url, "https://storage.example/hls.m3u8");

    // An answer whose tag does not fit is not decrypted, and the page without a stream gives nothing.
    let (page, mut api) = filemoon_api_page("T", "https://cdn.example/a.m3u8");
    api = api.replace("\"payload\":\"", "\"payload\":\"AAAA");
    let pages = Pages::new(&[
        ("https://fm.example/filemoon/e/fm123", &page),
        ("https://fm.example/filemoon/api/videos/fm123", &api),
    ]);
    assert_eq!(
        extract_filemoon(&pages, "https://fm.example/filemoon/e/fm123"),
        None
    );
}

#[test]
fn vidmoly_finds_the_player_source() {
    let html = r#"<html><head><title>Demon Slayer - Vidmoly</title></head><body><script>var player = jwplayer("vplayer");
        player.setup({ sources: [{ file: "https://stream.vidmoly.example/hls/ep1.m3u8" }] });</script></body></html>"#;
    let pages = Pages::new(&[("https://vidmoly.example/vidmoly/embed-vm123.html", html)]);
    let s = extract_vidmoly(&pages, "https://vidmoly.example/vidmoly/embed-vm123.html").unwrap();
    assert_eq!(s.url, "https://stream.vidmoly.example/hls/ep1.m3u8");
    assert!(s.is_hls);
    assert_eq!(s.title, "Demon Slayer");
}

#[test]
fn doodstream_builds_the_address_from_the_pass() {
    let page = r#"<html><head><title>Jujutsu Kaisen - Dood</title></head><script>fetch('/pass_md5/mytoken12345');</script></html>"#;
    let pages = Pages::new(&[
        ("https://dood.example/dood/e/dood123", page),
        (
            "https://dood.example/pass_md5/mytoken12345",
            "https://video.dood.example/stream/",
        ),
    ]);
    let s =
        extract_doodstream(&pages, "https://dood.example/dood/e/dood123", 1234).expect("a stream");
    assert!(
        s.url.starts_with("https://video.dood.example/stream/"),
        "{}",
        s.url
    );
    assert!(s.url.contains("token=mytoken12345"));
    assert!(s.url.ends_with("&expiry=1234"));
    assert!(!s.is_hls);
    assert_eq!(s.title, "Jujutsu Kaisen");

    let reload = Pages::new(&[
        ("https://dood.example/dood/e/d1", page),
        ("https://dood.example/pass_md5/mytoken12345", "RELOAD"),
    ]);
    assert_eq!(
        extract_doodstream(&reload, "https://dood.example/dood/e/d1", 0),
        None
    );
}

#[test]
fn streamtape_joins_the_substrings() {
    let html = r#"<html><head><title>Naruto - Streamtape</title></head><body><div id="norobotlink"></div><script>
        document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_video?id=st123&token=' + ('xyzTOKEN456').substring(3);
        </script></body></html>"#;
    let pages = Pages::new(&[("https://st.example/streamtape/e/st123", html)]);
    let s = extract_streamtape(&pages, "https://st.example/streamtape/e/st123").unwrap();
    assert_eq!(
        s.url,
        "https://streamtape.com/get_video?id=st123&token=TOKEN456&stream=1"
    );
    assert_eq!(s.title, "Naruto");
}

#[test]
fn vidoza_reads_the_source_tag() {
    let html = r#"<html><head><title>Bleach - Vidoza</title></head><video id="player"><source src="https://media.vidoza.example/video.mp4" type="video/mp4"></video></html>"#;
    let pages = Pages::new(&[
        ("https://vz.example/vidoza/embed-vz123.html", html),
        ("https://vidoza.net/embed-abc123.html", html),
    ]);
    let s = extract_vidoza(&pages, "https://vz.example/vidoza/embed-vz123.html").unwrap();
    assert_eq!(s.url, "https://media.vidoza.example/video.mp4");
    assert!(!s.is_hls);
    // A bare id becomes the embed address.
    let s = extract_vidoza(&pages, "https://vidoza.net/abc123").unwrap();
    assert_eq!(s.referer, "https://vidoza.net/embed-abc123.html");
}
