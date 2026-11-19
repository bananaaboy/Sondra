//! A film in Drive read through the program's own small server: ranges come out of Drive as ranges, the token
//! stays in the program, and the address cannot be guessed.

use sondra_drive::fake::FakeDrive;
use sondra_drive::DriveStream;

fn get(url: &str, range: Option<&str>) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
    let mut request = ureq::http::Request::builder().method("GET").uri(url);
    if let Some(range) = range {
        request = request.header("Range", range);
    }
    let mut response = agent.run(request.body(Vec::<u8>::new()).unwrap()).unwrap();
    let headers = response.headers().iter().map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned())).collect();
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_vec().unwrap_or_default();
    (status, headers, body)
}

fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
}

fn setup() -> (FakeDrive, DriveStream, String, Vec<u8>) {
    let fake = FakeDrive::start();
    let client = fake.client();
    let folder = client.ensure_path(&["Sondra", "Filme"]).unwrap();
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let file = client.create(&folder, "Film Eins.mkv", &data, "video/x-matroska", &Default::default()).unwrap();
    let stream = DriveStream::start(fake.client()).unwrap();
    (fake, stream, file.id, data)
}

#[test]
fn a_range_comes_out_of_drive_as_that_range() {
    let (fake, stream, id, data) = setup();
    let url = stream.url(&id, "Film Eins.mkv", data.len() as u64, "video/x-matroska");
    assert!(url.contains("Film%20Eins.mkv"), "{url}");

    let (status, headers, body) = get(&url, Some("bytes=1000-1999"));
    assert_eq!(status, 206);
    assert_eq!(body, &data[1000..2000]);
    assert_eq!(header(&headers, "Content-Range").unwrap(), format!("bytes 1000-1999/{}", data.len()));
    assert_eq!(header(&headers, "Accept-Ranges").unwrap(), "bytes");
    assert_eq!(header(&headers, "Content-Type").unwrap(), "video/x-matroska");
    // Only that range was asked of Drive, not the whole film.
    assert_eq!(fake.state.lock().unwrap().range_requests, [(1000, 1999)]);

    // From a point to the end, and the last bytes — the way a player jumps and reads the index at the end.
    let (status, _, body) = get(&url, Some("bytes=199000-"));
    assert_eq!((status, body.as_slice()), (206, &data[199_000..]));
    let (status, headers, body) = get(&url, Some("bytes=-500"));
    assert_eq!((status, body.as_slice()), (206, &data[199_500..]));
    assert_eq!(header(&headers, "Content-Range").unwrap(), "bytes 199500-199999/200000");
}

#[test]
fn without_a_range_the_whole_film_comes_and_a_range_past_the_end_is_refused() {
    let (_fake, stream, id, data) = setup();
    let url = stream.url(&id, "Film Eins.mkv", data.len() as u64, "video/x-matroska");
    let (status, headers, body) = get(&url, None);
    assert_eq!(status, 200);
    assert_eq!(body, data);
    assert_eq!(header(&headers, "Content-Length").unwrap_or_else(|| panic!("{headers:?}")), data.len().to_string());
    let (status, headers, _) = get(&url, Some("bytes=300000-"));
    assert_eq!(status, 416);
    assert_eq!(header(&headers, "Content-Range").unwrap(), "bytes */200000");
}

#[test]
fn the_address_cannot_be_guessed() {
    let (_fake, stream, id, data) = setup();
    let url = stream.url(&id, "Film Eins.mkv", data.len() as u64, "video/x-matroska");
    // The same address with another secret is not served.
    let mut parts: Vec<&str> = url.splitn(5, '/').collect();
    parts[3] = "geraten";
    let (status, _, body) = get(&parts.join("/"), Some("bytes=0-9"));
    assert_eq!(status, 404);
    assert!(body.is_empty());
    // Nor is anything without a size.
    let bare = url.split('?').next().unwrap();
    assert_eq!(get(bare, None).0, 400);
}
