//! The downloader against a server on this computer that behaves like the real ones do — and
//! like they do not: cut connections, a Range that is ignored, a playlist with sound kept apart.
//! Sound and picture for the HLS cases are made by the real FFmpeg; those tests are skipped, and
//! say so, where there is none.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sondra_download::{safe_stem, Cancel, DownloadError, Downloader, Progress};
use sondra_extract::stream::StreamInfo;

/* A server -------------------------------------------------------------------------------- */

#[derive(Clone)]
enum Route {
    /// The bytes, honouring `Range`.
    Bytes(Vec<u8>),
    /// The bytes, but the first `cut_first` requests end after `limit` bytes (a connection that dies).
    Cut {
        data: Vec<u8>,
        limit: usize,
        cut_first: usize,
        honour_range: bool,
    },
    Status(u16),
    Redirect(String),
}

struct Server {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    ranges: Arc<Mutex<Vec<Option<String>>>>,
}

struct Truncated {
    data: io::Cursor<Vec<u8>>,
    limit: usize,
    read: usize,
}

impl Read for Truncated {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.read >= self.limit {
            return Err(io::Error::new(io::ErrorKind::ConnectionReset, "cut"));
        }
        let room = (self.limit - self.read).min(buf.len());
        let n = self.data.read(&mut buf[..room])?;
        self.read += n;
        Ok(n)
    }
}

fn parse_range(header: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: usize = a.parse().ok()?;
    let end: usize = if b.is_empty() {
        len - 1
    } else {
        b.parse().ok()?
    };
    (start < len).then_some((start, end.min(len - 1)))
}

impl Server {
    fn start(routes: Vec<(&str, Route)>) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("a port");
        let base = format!("http://{}", server.server_addr().to_ip().expect("ip"));
        let routes: HashMap<String, Route> =
            routes.into_iter().map(|(p, r)| (p.to_owned(), r)).collect();
        let hits: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let ranges: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
        let (h, r) = (hits.clone(), ranges.clone());
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let path = request.url().to_owned();
                let range = request
                    .headers()
                    .iter()
                    .find(|x| x.field.equiv("Range"))
                    .map(|x| x.value.to_string());
                r.lock().unwrap().push(range.clone());
                let n = {
                    let mut hits = h.lock().unwrap();
                    let e = hits.entry(path.clone()).or_insert(0);
                    *e += 1;
                    *e
                };
                let header = |n: &str, v: &str| tiny_http::Header::from_bytes(n, v).unwrap();
                match routes.get(&path).cloned() {
                    None => {
                        let _ = request.respond(tiny_http::Response::empty(404));
                    }
                    Some(Route::Status(code)) => {
                        let _ = request.respond(tiny_http::Response::empty(code));
                    }
                    Some(Route::Redirect(to)) => {
                        let _ = request.respond(
                            tiny_http::Response::empty(302).with_header(header("Location", &to)),
                        );
                    }
                    Some(Route::Bytes(data)) => {
                        let _ = match range.as_deref().and_then(|r| parse_range(r, data.len())) {
                            Some((a, b)) => request.respond(
                                tiny_http::Response::from_data(data[a..=b].to_vec())
                                    .with_status_code(206)
                                    .with_header(header(
                                        "Content-Range",
                                        &format!("bytes {a}-{b}/{}", data.len()),
                                    )),
                            ),
                            None => request.respond(tiny_http::Response::from_data(data)),
                        };
                    }
                    Some(Route::Cut {
                        data,
                        limit,
                        cut_first,
                        honour_range,
                    }) => {
                        let wanted = if honour_range {
                            range.as_deref().and_then(|r| parse_range(r, data.len()))
                        } else {
                            None
                        };
                        let (body, status, content_range) = match wanted {
                            Some((a, b)) => (
                                data[a..=b].to_vec(),
                                206,
                                Some(format!("bytes {a}-{b}/{}", data.len())),
                            ),
                            None => (data.clone(), 200, None),
                        };
                        let len = body.len();
                        let cut = n <= cut_first;
                        let reader: Box<dyn Read + Send> = if cut {
                            Box::new(Truncated {
                                data: io::Cursor::new(body),
                                limit: limit.min(len),
                                read: 0,
                            })
                        } else {
                            Box::new(io::Cursor::new(body))
                        };
                        let mut response = tiny_http::Response::new(
                            tiny_http::StatusCode(status),
                            vec![],
                            reader,
                            Some(len),
                            None,
                        );
                        if let Some(cr) = content_range {
                            response = response.with_header(header("Content-Range", &cr));
                        }
                        let _ = request.respond(response);
                    }
                }
            }
        });
        Self { base, hits, ranges }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self, path: &str) -> usize {
        *self.hits.lock().unwrap().get(path).unwrap_or(&0)
    }
}

fn pseudo(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + usize::from(seed) * 7 + i / 251) % 256) as u8)
        .collect()
}

fn downloader(kib: Option<u32>) -> Downloader {
    let mut d = Downloader::new(kib, Cancel::new()).with_stall_timeout(Duration::from_secs(2));
    d.allow_private = true; // the server is on this computer
    d
}

fn stream(url: String, hls: bool) -> StreamInfo {
    StreamInfo {
        title: "T".into(),
        url,
        is_hls: hls,
        referer: "https://seite.example/".into(),
        hoster: "Test".into(),
    }
}

fn no_progress(_: Progress) {}

// Bodies under 32 KiB: that is where the test server (tiny_http) sends a Content-Length instead of
// chunks, and a connection that dies mid-body is only visible against a Content-Length.

/* Direct files ------------------------------------------------------------------------------ */

#[test]
fn a_direct_file_is_written_whole_and_named_from_the_title() {
    let data = pseudo(30_000, 1);
    let server = Server::start(vec![("/film.mp4", Route::Bytes(data.clone()))]);
    let dir = tempfile::tempdir().unwrap();
    let mut last = Progress::default();
    let got = downloader(None)
        .download(
            &stream(server.url("/film.mp4"), false),
            dir.path(),
            "Frieren - S01E01 - Der Anfang?",
            &mut |p| last = p,
        )
        .expect("a file");
    assert!(
        std::fs::read(&got.path).unwrap() == data,
        "the bytes differ"
    );
    assert_eq!(got.size, 30_000);
    assert_eq!(
        got.path.file_name().unwrap(),
        "Frieren - S01E01 - Der Anfang.mp4"
    );
    assert_eq!(last.loaded, 30_000);
    assert_eq!(last.total, Some(30_000));
    // No leftovers.
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names.len(), 1, "{names:?}");
}

#[test]
fn an_existing_file_is_never_replaced() {
    let data = pseudo(5_000, 2);
    let server = Server::start(vec![("/a.mp4", Route::Bytes(data.clone()))]);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Folge.mp4"), b"mine").unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/a.mp4"), false),
            dir.path(),
            "Folge",
            &mut no_progress,
        )
        .unwrap();
    assert_eq!(got.path.file_name().unwrap(), "Folge (2).mp4");
    assert_eq!(
        std::fs::read(dir.path().join("Folge.mp4")).unwrap(),
        b"mine"
    );
}

#[test]
fn a_cut_connection_is_resumed_with_range() {
    let data = pseudo(30_000, 3);
    let server = Server::start(vec![(
        "/f.mp4",
        Route::Cut {
            data: data.clone(),
            limit: 11_000,
            cut_first: 1,
            honour_range: true,
        },
    )]);
    let dir = tempfile::tempdir().unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/f.mp4"), false),
            dir.path(),
            "F",
            &mut no_progress,
        )
        .expect("resumed");
    assert!(
        std::fs::read(&got.path).unwrap() == data,
        "the bytes differ"
    );
    assert_eq!(server.hits("/f.mp4"), 2);
    let ranges = server.ranges.lock().unwrap().clone();
    assert_eq!(ranges[0], None);
    let second = ranges[1].clone().expect("the second asks for the rest");
    assert!(
        second.starts_with("bytes=") && second.ends_with('-') && second != "bytes=0-",
        "{second}"
    );
}

#[test]
fn a_server_that_ignores_range_starts_the_file_over_without_a_seam() {
    let data = pseudo(30_000, 4);
    let server = Server::start(vec![(
        "/f.mp4",
        Route::Cut {
            data: data.clone(),
            limit: 11_000,
            cut_first: 1,
            honour_range: false,
        },
    )]);
    let dir = tempfile::tempdir().unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/f.mp4"), false),
            dir.path(),
            "F",
            &mut no_progress,
        )
        .expect("again");
    assert_eq!(
        std::fs::read(&got.path).unwrap(),
        data,
        "the bytes before the cut must not stay in the file"
    );
}

#[test]
fn what_the_server_says_is_told_in_words() {
    let server = Server::start(vec![
        ("/gone", Route::Status(404)),
        ("/expired", Route::Status(403)),
        ("/tiny", Route::Bytes(vec![1, 2, 3])),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let get = |p: &str| {
        downloader(None)
            .download(
                &stream(server.url(p), false),
                dir.path(),
                "x",
                &mut no_progress,
            )
            .unwrap_err()
    };
    assert_eq!(get("/gone"), DownloadError::Status(404));
    assert_eq!(get("/expired"), DownloadError::Expired);
    assert_eq!(get("/tiny"), DownloadError::Empty(3));
    assert!(get("/tiny").to_string().contains("3 Bytes"));
    // Nothing is left behind by a failure.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_redirect_is_followed_by_hand() {
    let data = pseudo(4_000, 5);
    let server = Server::start(vec![
        ("/start", Route::Redirect("/real.mp4".into())),
        ("/real.mp4", Route::Bytes(data.clone())),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/start"), false),
            dir.path(),
            "R",
            &mut no_progress,
        )
        .unwrap();
    assert!(std::fs::read(got.path).unwrap() == data, "the bytes differ");
}

#[test]
fn this_computers_own_network_is_not_fetched() {
    let server = Server::start(vec![("/a.mp4", Route::Bytes(pseudo(5_000, 6)))]);
    let dir = tempfile::tempdir().unwrap();
    let strict = Downloader::new(None, Cancel::new()); // allow_private stays off
    let err = strict
        .download(
            &stream(server.url("/a.mp4"), false),
            dir.path(),
            "x",
            &mut no_progress,
        )
        .unwrap_err();
    assert_eq!(err, DownloadError::PrivateAddress);
    assert_eq!(server.hits("/a.mp4"), 0, "not even asked");
}

#[test]
fn the_bandwidth_limit_holds() {
    let data = pseudo(160 * 1024, 7);
    let server = Server::start(vec![("/f.mp4", Route::Bytes(data))]);
    let dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    downloader(Some(100))
        .download(
            &stream(server.url("/f.mp4"), false),
            dir.path(),
            "F",
            &mut no_progress,
        )
        .unwrap();
    let took = started.elapsed();
    // 160 KiB at 100 KiB/s is 1.6 s.
    assert!(took >= Duration::from_millis(1300), "too fast: {took:?}");
    assert!(took < Duration::from_secs(6), "far too slow: {took:?}");
}

#[test]
fn a_download_can_be_cancelled_and_leaves_nothing() {
    let server = Server::start(vec![("/f.mp4", Route::Bytes(pseudo(2 * 1024 * 1024, 8)))]);
    let dir = tempfile::tempdir().unwrap();
    let cancel = Cancel::new();
    let mut d = Downloader::new(Some(200), cancel.clone());
    d.allow_private = true;
    let seen = AtomicUsize::new(0);
    let err = d
        .download(
            &stream(server.url("/f.mp4"), false),
            dir.path(),
            "F",
            &mut |_| {
                if seen.fetch_add(1, Ordering::SeqCst) == 3 {
                    cancel.cancel();
                }
            },
        )
        .unwrap_err();
    assert_eq!(err, DownloadError::Cancelled);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn file_names_survive_every_file_system() {
    assert_eq!(
        safe_stem("One Piece - S01E01: \"Ich bin Ruffy!\""),
        "One Piece - S01E01 Ich bin Ruffy!"
    );
    assert_eq!(safe_stem("  a\\b/c*d?e  "), "a b c d e");
    assert_eq!(safe_stem(""), "download");
    assert_eq!(safe_stem("???"), "download");
    assert_eq!(safe_stem("CON"), "_CON");
    assert_eq!(safe_stem("nul.txt"), "_nul.txt");
    assert_eq!(safe_stem("Ende..."), "Ende");
    assert_eq!(safe_stem(&"x".repeat(200)).chars().count(), 80);
}

/* HLS --------------------------------------------------------------------------------------- */

fn ffmpeg_here() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A few seconds of test picture and tone, as the transport-stream segments HLS carries.
fn make_segments(work: &Path, video: bool, audio: bool, prefix: &str) -> Vec<Vec<u8>> {
    let mut command = std::process::Command::new("ffmpeg");
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    if video {
        command.args([
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=25:duration=6",
        ]);
    }
    if audio {
        command.args(["-f", "lavfi", "-i", "sine=frequency=440:duration=6"]);
    }
    if video {
        command.args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "25",
            "-pix_fmt",
            "yuv420p",
        ]);
    }
    if audio {
        command.args(["-c:a", "aac"]);
    }
    command
        .args([
            "-f",
            "segment",
            "-segment_time",
            "2",
            "-segment_format",
            "mpegts",
        ])
        .arg(work.join(format!("{prefix}%d.ts")));
    assert!(command.status().expect("ffmpeg runs").success());
    let mut out = Vec::new();
    for i in 0.. {
        match std::fs::read(work.join(format!("{prefix}{i}.ts"))) {
            Ok(bytes) => out.push(bytes),
            Err(_) => break,
        }
    }
    assert!(out.len() >= 3, "{} segments", out.len());
    out
}

fn probe(path: &Path) -> String {
    let out = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("ffprobe runs");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(",")
}

#[test]
fn an_hls_stream_becomes_one_mp4_with_picture_and_sound() {
    if !ffmpeg_here() {
        eprintln!("skipped: no ffmpeg here");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let segments = make_segments(work.path(), true, true, "s");
    let mut routes: Vec<(String, Route)> = Vec::new();
    let mut playlist = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-VERSION:3\n");
    for (i, s) in segments.iter().enumerate() {
        playlist.push_str(&format!("#EXTINF:2.0,\nseg{i}.ts\n"));
        routes.push((format!("/hls/seg{i}.ts"), Route::Bytes(s.clone())));
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    routes.push((
        "/hls/index.m3u8".into(),
        Route::Bytes(playlist.into_bytes()),
    ));
    let server = Server::start(
        routes
            .iter()
            .map(|(p, r)| (p.as_str(), r.clone()))
            .collect(),
    );
    let dir = tempfile::tempdir().unwrap();
    let mut last = 0;
    let got = downloader(None)
        .download(
            &stream(server.url("/hls/index.m3u8"), true),
            dir.path(),
            "Serie - S01E01",
            &mut |p| last = p.loaded,
        )
        .expect("an mp4");
    assert_eq!(got.path.file_name().unwrap(), "Serie - S01E01.mp4");
    assert!(got.size > 1024 && last > 0);
    let kinds = probe(&got.path);
    assert!(
        kinds.contains("video") && kinds.contains("audio"),
        "{kinds}"
    );
    // Only the finished file remains.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    // Every segment was asked for once.
    for i in 0..segments.len() {
        assert_eq!(server.hits(&format!("/hls/seg{i}.ts")), 1);
    }
}

#[test]
fn a_masters_best_quality_and_its_separate_sound_are_joined() {
    if !ffmpeg_here() {
        eprintln!("skipped: no ffmpeg here");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let pictures = make_segments(work.path(), true, false, "v");
    let sounds = make_segments(work.path(), false, true, "a");
    let mut routes: Vec<(String, Route)> = Vec::new();
    let list = |name: &str, n: usize| {
        let mut p = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n");
        for i in 0..n {
            p.push_str(&format!("#EXTINF:2.0,\n{name}{i}.ts\n"));
        }
        p.push_str("#EXT-X-ENDLIST\n");
        p
    };
    for (i, s) in pictures.iter().enumerate() {
        routes.push((format!("/m/hi/v{i}.ts"), Route::Bytes(s.clone())));
    }
    for (i, s) in sounds.iter().enumerate() {
        routes.push((format!("/m/ton/a{i}.ts"), Route::Bytes(s.clone())));
    }
    routes.push((
        "/m/hi/index.m3u8".into(),
        Route::Bytes(list("v", pictures.len()).into_bytes()),
    ));
    routes.push((
        "/m/ton/de.m3u8".into(),
        Route::Bytes(list("a", sounds.len()).into_bytes()),
    ));
    // The worse quality must not be fetched at all.
    routes.push(("/m/lo/index.m3u8".into(), Route::Status(500)));
    let master = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"ton\",NAME=\"Deutsch\",LANGUAGE=\"de\",DEFAULT=YES,URI=\"ton/de.m3u8\"\n\
                  #EXT-X-STREAM-INF:BANDWIDTH=300000,AUDIO=\"ton\"\nlo/index.m3u8\n\
                  #EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"ton\"\nhi/index.m3u8\n";
    routes.push((
        "/m/master.m3u8".into(),
        Route::Bytes(master.as_bytes().to_vec()),
    ));
    let server = Server::start(
        routes
            .iter()
            .map(|(p, r)| (p.as_str(), r.clone()))
            .collect(),
    );
    let dir = tempfile::tempdir().unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/m/master.m3u8"), true),
            dir.path(),
            "Master",
            &mut no_progress,
        )
        .expect("an mp4");
    let kinds = probe(&got.path);
    assert!(
        kinds.contains("video") && kinds.contains("audio"),
        "{kinds}"
    );
    assert_eq!(server.hits("/m/lo/index.m3u8"), 0);
}

#[test]
fn an_encrypted_stream_is_refused_with_the_websites_sentence() {
    let playlist =
        "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/k\"\n#EXTINF:2,\ns0.ts\n";
    let server = Server::start(vec![(
        "/e.m3u8",
        Route::Bytes(playlist.as_bytes().to_vec()),
    )]);
    let dir = tempfile::tempdir().unwrap();
    let err = downloader(None)
        .download(
            &stream(server.url("/e.m3u8"), true),
            dir.path(),
            "E",
            &mut no_progress,
        )
        .unwrap_err();
    assert_eq!(err, DownloadError::Encrypted);
    assert!(err.to_string().contains("umgeht keinen Kopierschutz"));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_missing_segment_fails_the_download_and_leaves_nothing() {
    if !ffmpeg_here() {
        eprintln!("skipped: no ffmpeg here");
        return;
    }
    let work = tempfile::tempdir().unwrap();
    let segments = make_segments(work.path(), true, true, "s");
    let mut routes: Vec<(String, Route)> = Vec::new();
    let mut playlist = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:2\n");
    for (i, s) in segments.iter().enumerate() {
        playlist.push_str(&format!("#EXTINF:2.0,\nseg{i}.ts\n"));
        if i != 1 {
            routes.push((format!("/h/seg{i}.ts"), Route::Bytes(s.clone())));
        }
    }
    routes.push(("/h/index.m3u8".into(), Route::Bytes(playlist.into_bytes())));
    let server = Server::start(
        routes
            .iter()
            .map(|(p, r)| (p.as_str(), r.clone()))
            .collect(),
    );
    let dir = tempfile::tempdir().unwrap();
    let err = downloader(None)
        .download(
            &stream(server.url("/h/index.m3u8"), true),
            dir.path(),
            "H",
            &mut no_progress,
        )
        .unwrap_err();
    assert_eq!(err, DownloadError::Status(404));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn an_hls_address_that_is_really_the_media_is_taken_as_a_file() {
    let data = pseudo(20_000, 9);
    let server = Server::start(vec![("/x.m3u8", Route::Bytes(data.clone()))]);
    let dir = tempfile::tempdir().unwrap();
    let got = downloader(None)
        .download(
            &stream(server.url("/x.m3u8"), true),
            dir.path(),
            "Y",
            &mut no_progress,
        )
        .unwrap();
    assert!(std::fs::read(got.path).unwrap() == data, "the bytes differ");
}
