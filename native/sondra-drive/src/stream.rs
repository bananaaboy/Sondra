//! A film in Drive played where it lies (`drive-media/<id>` of the website's service worker, as a program on this
//! computer): a small server on 127.0.0.1 that answers FFmpeg's range requests with ranges of the file in Drive, so a
//! film starts at once instead of after the whole file has come, and a jump in the film asks for the bytes it needs.
//!
//! * the address carries a secret picked at start (`/<secret>/<id>/<name>`): a web page in the browser cannot guess
//!   it, so it cannot read Drive through this computer;
//! * the token never leaves the program: FFmpeg sends none, this server adds it (`DriveClient` renews it after a 401);
//! * the size comes with the address (the folder listing has it), so no request is spent on asking;
//! * Drive answering a range with the whole file (200) is handled: the bytes before the start are skipped.

use std::io::Read;
use std::sync::Arc;

use url::Url;

use crate::client::{DriveClient, TokenSource};

pub struct DriveStream {
    port: u16,
    secret: String,
}

fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    // Only the first range of a list: a player asks for one.
    let first = spec.split(',').next()?.trim();
    let (from, to) = first.split_once('-')?;
    match (from.trim(), to.trim()) {
        ("", n) => {
            // The last n bytes.
            let n: u64 = n.parse().ok()?;
            (n > 0).then(|| (size.saturating_sub(n), size - 1))
        }
        (a, "") => Some((a.parse().ok()?, size - 1)),
        (a, b) => Some((a.parse().ok()?, b.parse::<u64>().ok()?.min(size - 1))),
    }
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap_or_else(|_| tiny_http::Header::from_bytes("X-Sondra", "x").unwrap())
}

fn plain(request: tiny_http::Request, status: u16, headers: Vec<tiny_http::Header>) {
    let mut response = tiny_http::Response::from_data(Vec::new()).with_status_code(status);
    for h in headers {
        response = response.with_header(h);
    }
    let _ = request.respond(response);
}

fn serve<T: TokenSource + Send + Sync + 'static>(client: &DriveClient<T>, secret: &str, request: tiny_http::Request) {
    let Ok(url) = Url::parse(&format!("http://x{}", request.url())) else { return plain(request, 400, vec![]) };
    let segments: Vec<String> = url.path_segments().map(|s| s.map(|p| Url::parse(&format!("http://x/{p}")).map(|u| u.path().trim_start_matches('/').to_owned()).unwrap_or_default()).collect()).unwrap_or_default();
    // The secret is compared whole.
    let right = segments.first().is_some_and(|s| s.len() == secret.len() && s.bytes().zip(secret.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0);
    if !right || segments.len() < 2 {
        return plain(request, 404, vec![]);
    }
    let method = request.method().as_str().to_owned();
    if method != "GET" && method != "HEAD" {
        return plain(request, 405, vec![header("Allow", "GET, HEAD")]);
    }
    let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let (Some(id), Some(size)) = (segments.get(1).cloned(), query("size").and_then(|s| s.parse::<u64>().ok())) else { return plain(request, 400, vec![]) };
    let kind = query("type").filter(|t| !t.is_empty()).unwrap_or_else(|| "application/octet-stream".into());
    let asked = request.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_owned());
    if size == 0 {
        return plain(request, 200, vec![header("Content-Type", &kind), header("Accept-Ranges", "bytes"), header("Content-Length", "0")]);
    }
    let (partial, (start, end)) = match &asked {
        Some(range) => match parse_range(range, size) {
            Some(r) if r.0 < size && r.0 <= r.1 => (true, r),
            _ => return plain(request, 416, vec![header("Content-Range", &format!("bytes */{size}"))]),
        },
        None => (false, (0, size - 1)),
    };
    let length = end - start + 1;
    let mut headers = vec![header("Content-Type", &kind), header("Accept-Ranges", "bytes")];
    if partial {
        headers.push(header("Content-Range", &format!("bytes {start}-{end}/{size}")));
    }
    if method == "HEAD" {
        headers.push(header("Content-Length", &length.to_string()));
        return plain(request, if partial { 206 } else { 200 }, headers);
    }
    let media = format!("{}/files/{id}?alt=media", client.api());
    let Ok(response) = client.send_with("GET", &media, None, None, &[("Range", format!("bytes={start}-{end}"))]) else {
        return plain(request, 502, vec![]);
    };
    let from_drive = response.status().as_u16();
    let mut reader = response.into_body().into_reader();
    if from_drive == 200 && start > 0 {
        // Drive ignored the range: what comes before the start is read and dropped.
        if std::io::copy(&mut (&mut reader).take(start), &mut std::io::sink()).is_err() {
            return plain(request, 502, vec![]);
        }
    }
    let body = reader.take(length);
    // Left to itself the server sends bodies over 32 KB in chunks, and a player wants the size.
    let response = tiny_http::Response::new(tiny_http::StatusCode(if partial { 206 } else { 200 }), headers, body, Some(length as usize), None).with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

impl DriveStream {
    /// Starts listening on a port of this computer's own address; the thread lives as long as the program.
    pub fn start<T: TokenSource + Send + Sync + 'static>(client: DriveClient<T>) -> std::io::Result<DriveStream> {
        let http = tiny_http::Server::http("127.0.0.1:0").map_err(|e| std::io::Error::other(e.to_string()))?;
        let port = http.server_addr().to_ip().map(|a| a.port()).ok_or_else(|| std::io::Error::other("no port"))?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|e| std::io::Error::other(e.to_string()))?;
        let secret: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let (client, kept) = (Arc::new(client), secret.clone());
        std::thread::spawn(move || {
            for request in http.incoming_requests() {
                let (client, secret) = (client.clone(), kept.clone());
                // One thread for each request: a player asks for several ranges at once.
                std::thread::spawn(move || serve(&client, &secret, request));
            }
        });
        Ok(DriveStream { port, secret })
    }

    /// Where a file of Drive can be read: the name only makes the address read well in a player's own words.
    pub fn url(&self, id: &str, name: &str, size: u64, mime: &str) -> String {
        let mut url = Url::parse(&format!("http://127.0.0.1:{}/", self.port)).expect("a fixed address");
        if let Ok(mut parts) = url.path_segments_mut() {
            parts.clear().push(&self.secret).push(id).push(if name.is_empty() { "datei" } else { name });
        }
        url.query_pairs_mut().append_pair("size", &size.to_string()).append_pair("type", mime);
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn ranges_are_read_the_way_players_ask() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=900-5000", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-9, 20-29", 1000), Some((0, 9)));
        assert_eq!(parse_range("items=0-9", 1000), None);
        assert_eq!(parse_range("bytes=x-9", 1000), None);
    }
}
