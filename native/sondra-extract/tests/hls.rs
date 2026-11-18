//! The playlist cases of `scripts/verify-download.mts`.

use sondra_extract::hls::*;

#[test]
fn a_master_lists_the_best_quality_first_and_keeps_the_sound_apart() {
    let text = [
        "#EXTM3U",
        r#"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ton",NAME="Deutsch",LANGUAGE="de",DEFAULT=YES,URI="ton/de.m3u8""#,
        r#"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ton",NAME="English",LANGUAGE="en",URI="ton/en.m3u8""#,
        r#"#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=100,BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="ton""#,
        "v360.m3u8",
        r#"#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="ton""#,
        "v720.m3u8",
    ]
    .join("\n");
    let master = parse(&text, "https://cdn.example/stream/master.m3u8");
    assert!(master.is_master);
    // `BANDWIDTH`, not `AVERAGE-BANDWIDTH`.
    assert_eq!(
        master
            .variants
            .iter()
            .map(|v| v.bandwidth)
            .collect::<Vec<_>>(),
        [3_000_000, 900_000]
    );
    assert_eq!(
        master.variants[0].url,
        "https://cdn.example/stream/v720.m3u8"
    );
    assert_eq!(master.variants[0].resolution.as_deref(), Some("1280x720"));
    let sound = audio_for(&master, &master.variants[0]).expect("the default track");
    assert_eq!(sound.url, "https://cdn.example/stream/ton/de.m3u8");
    assert_eq!(sound.language.as_deref(), Some("de"));
}

#[test]
fn byte_ranges_start_with_the_init_segment_and_continue() {
    let text = [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        r#"#EXT-X-MAP:URI="film.mp4",BYTERANGE="800@0""#,
        "#EXTINF:4,",
        "#EXT-X-BYTERANGE:1000@800",
        "film.mp4",
        "#EXTINF:4,",
        "#EXT-X-BYTERANGE:500",
        "film.mp4",
    ]
    .join("\n");
    let p = parse(&text, "https://cdn.example/film.m3u8");
    assert!(!p.is_master);
    assert_eq!(
        p.ranges,
        [
            Some(ByteRange { start: 0, end: 799 }),
            Some(ByteRange {
                start: 800,
                end: 1799
            }),
            Some(ByteRange {
                start: 1800,
                end: 2299
            }),
        ]
    );
    assert_eq!(p.segments.len(), 3);
    assert!(p
        .segments
        .iter()
        .all(|s| s == "https://cdn.example/film.mp4"));
}

#[test]
fn encryption_is_noticed_and_a_variants_own_address_is_not_its_sound() {
    let p = parse(
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/k\"\nseg.ts\n",
        "https://c.example/a.m3u8",
    );
    assert!(p.encrypted);
    let p = parse(
        "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nseg.ts\n",
        "https://c.example/a.m3u8",
    );
    assert!(!p.encrypted);

    let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"v.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=5,AUDIO=\"a\"\nv.m3u8\n";
    let master = parse(text, "https://c.example/m.m3u8");
    assert!(audio_for(&master, &master.variants[0]).is_none());
}

#[test]
fn addresses_inside_this_network_are_dropped_and_windows_line_ends_are_fine() {
    let text = "#EXTM3U\r\nseg1.ts\r\nhttp://127.0.0.1:8080/a.ts\r\nhttp://192.168.1.1/b.ts\r\nhttps://localhost/c.ts\r\nhttp://[::1]/d.ts\r\nftp://x.example/e.ts\r\nhttps://ok.example/f.ts\r\n";
    let p = parse(text, "https://media.example.com/hls/master.m3u8");
    assert_eq!(
        p.segments,
        [
            "https://media.example.com/hls/seg1.ts",
            "https://ok.example/f.ts"
        ]
    );
    assert_eq!(p.ranges.len(), 2);
}

#[test]
fn a_playlist_is_told_from_media_by_its_first_line() {
    assert!(looks_like_playlist(b"\xEF\xBB\xBF\n#EXTM3U\n"));
    assert!(!looks_like_playlist(b"\x00\x00\x00\x18ftypmp42"));
}
