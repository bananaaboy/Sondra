//! Stand-in pages shared by the tests.

use std::cell::RefCell;
use std::collections::HashMap;

use sondra_extract::fetch::{Fetch, FetchError, Page, Request};

/// Stand-in pages by address; anything else is a 404. Remembers what was asked.
pub struct Pages {
    pages: HashMap<String, String>,
    pub asked: RefCell<Vec<String>>,
}

impl Pages {
    pub fn new(pages: &[(&str, &str)]) -> Self {
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
