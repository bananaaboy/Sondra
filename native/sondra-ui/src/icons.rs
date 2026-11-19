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
