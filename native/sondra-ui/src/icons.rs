//! The marks of the tools: the web app's own lines (`data/icons.json`, written from `panelMeta.tsx`), drawn
//! as strokes on a 16 × 16 grid. The marks are served to GPUI as SVG assets; `svg().path(...)` colours them
//! with the text colour, so a mark takes the ink on hover like the field under it.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

use gpui::{AssetSource, SharedString};
use serde::Deserialize;

#[derive(Deserialize)]
struct Data {
    panels: HashMap<String, String>,
    actions: HashMap<String, String>,
}

fn all() -> &'static HashMap<String, Vec<u8>> {
    static ALL: OnceLock<HashMap<String, Vec<u8>>> = OnceLock::new();
    ALL.get_or_init(|| {
        let data: Data = serde_json::from_str(include_str!("../data/icons.json"))
            .expect("data/icons.json is written by the web app's own code");
        let wrap = |inner: &str| {
            format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" fill=\"none\" \
                 stroke=\"currentColor\" stroke-width=\"1.35\" stroke-linecap=\"round\" \
                 stroke-linejoin=\"round\">{inner}</svg>"
            )
            .into_bytes()
        };
        let mut out = HashMap::new();
        for (id, inner) in data.panels {
            out.insert(format!("icons/panel/{id}.svg"), wrap(&inner));
        }
        for (id, inner) in data.actions {
            out.insert(format!("icons/action/{id}.svg"), wrap(&inner));
        }
        for (id, inner) in UI_MARKS {
            out.insert(format!("icons/ui/{id}.svg"), wrap(inner));
        }
        out
    })
}

/// Serves the marks to GPUI: `Application::new().with_assets(Assets)`.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(all().get(path).map(|bytes| Cow::Borrowed(bytes.as_slice())))
    }
    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        Ok(all()
            .keys()
            .filter(|key| key.starts_with(path))
            .map(|key| SharedString::from(key.clone()))
            .collect())
    }
}

/// The marks of the window's own chrome, drawn here on the same 16 × 16 grid and stroke as the tools'.
const UI_MARKS: [(&str, &str); 5] = [
    // A crescent: the lights go down.
    ("dunkel", "<path d=\"M13 9.6A5.5 5.5 0 1 1 6.4 3a4.3 4.3 0 0 0 6.6 6.6z\"/>"),
    // A disc with rays: the lights go up.
    ("hell", "<circle cx=\"8\" cy=\"8\" r=\"2.8\"/><path d=\"M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1\"/>"),
    // Two sheets: the files of the session.
    ("dateien", "<path d=\"M5.5 2.5h4l3 3v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z\"/><path d=\"M9.5 2.5v3h3\"/><path d=\"M3 5v8.5a1 1 0 0 0 1 1h6\"/>"),
    // A cloud: Google Drive.
    ("drive", "<path d=\"M4.6 12.5h7a2.7 2.7 0 0 0 .3-5.4 3.9 3.9 0 0 0-7.5-.9A3.2 3.2 0 0 0 4.6 12.5z\"/>"),
    // A small spark: what is new in this version.
    ("neu", "<path d=\"M8 2v3.2M8 10.8V14M2 8h3.2M10.8 8H14M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2\"/>"),
];

/// A mark of the window's chrome: `dunkel`, `hell`, `dateien`, `drive`, `neu`.
pub fn ui_icon(id: &str) -> SharedString {
    format!("icons/ui/{id}.svg").into()
}

/// The mark of a tool.
pub fn panel_icon(panel_id: &str) -> Option<SharedString> {
    let path = format!("icons/panel/{panel_id}.svg");
    all().contains_key(&path).then(|| path.into())
}

/// The mark of a job of the sound editor, if it has its own.
pub fn action_icon(action_id: &str) -> Option<SharedString> {
    let path = format!("icons/action/{action_id}.svg");
    all().contains_key(&path).then(|| path.into())
}
