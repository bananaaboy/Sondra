//! Stand-in pages shared by the tests.
#![allow(dead_code)] // each test file uses its own part of these helpers

use std::cell::RefCell;
use std::collections::HashMap;

use sondra_extract::fetch::{Fetch, FetchError, Page, Request};

/// Stand-in pages by address; anything else is a 404. Remembers what was asked.
pub struct Pages {
    pages: HashMap<String, String>,
    redirects: HashMap<String, String>,
    pub asked: RefCell<Vec<String>>,
}

impl Pages {
    pub fn new(pages: &[(&str, &str)]) -> Self {
        Self {
            pages: pages
                .iter()
                .map(|(u, b)| ((*u).to_owned(), (*b).to_owned()))
                .collect(),
            redirects: HashMap::new(),
            asked: RefCell::default(),
        }
    }

    /// An address that answers with a redirect to another (as `/redirect/101` does).
    pub fn redirect(mut self, from: &str, to: &str) -> Self {
        self.redirects.insert(from.to_owned(), to.to_owned());
        self
    }
}

impl Fetch for Pages {
    fn fetch(&self, request: &Request) -> Result<Page, FetchError> {
        self.asked.borrow_mut().push(request.url.clone());
        if let Some(to) = self.redirects.get(&request.url) {
            return Ok(Page {
                status: 302,
                url: request.url.clone(),
                location: Some(to.clone()),
                content_type: None,
                body: String::new(),
            });
        }
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

/// The same encoder as the JavaScript test's `createVoePayload`, written independently of the
/// decoder it tests.
pub fn voe_payload(title: &str, source: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let rot13 = |s: &str| sondra_extract::stream::rot13(s);
    let json = format!(r#"{{"title":"{title}","source":"{source}"}}"#);
    let s5: String = STANDARD.encode(json.as_bytes()).chars().rev().collect();
    let s4: Vec<u8> = s5.chars().map(|c| (c as u8) + 3).collect();
    let s3 = STANDARD.encode(&s4);
    let s2 = format!(
        "{}@${}^^{}*~{}",
        &s3[..8],
        &s3[8..16],
        &s3[16..24],
        &s3[24..]
    );
    rot13(&s2)
}

/// VOE's embed page carrying that payload.
pub fn voe_page(source: &str, title: &str) -> String {
    format!(
        r#"<!DOCTYPE html><html><head><title>VOE Sample</title></head><body><script type="application/json">["{}"]</script></body></html>"#,
        voe_payload(title, source)
    )
}
