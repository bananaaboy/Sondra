//! „Liste empfangen“ of the Merkliste (`MerklisteShare.tsx`, the receiving half): a link, its parts, or a
//! `.sondra-liste` file read, and set beside one's own list — „Beide haben 5 · nur bei Ihnen 12 · nur bei
//! Mia 8“. What only the other has can be taken, one by one or all, as it stands there or as „Später“ (then
//! without stand, rating and episode). Nothing is read as more than it is: the packing and its limits are
//! `sondra_merk::share`, the same as the website's.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use base64::Engine;
use gpui::{div, prelude::*, px, AnyElement, Context, Entity, PathPromptOptions};
use sondra_merk::cover::{unpack_raw, valid_thumb, KIND_JPEG, KIND_RAW, KIND_WEBP, RAW_H, RAW_W};
use sondra_merk::normalize::{normalize, Context as Ids};
use sondra_merk::share::{compare_shared, entry_from_shared, read_share_file, read_shared, shared_from_hash, Gathered, NewEntry, PartStore, Reading, SharedList, Take};
use sondra_ui::{FieldEvent, NoticeKind, TextField, Ui};

use crate::shell::Shell;

/// Where the parts of a list wait for the rest: a small file of the app's own.
pub struct FileParts(pub std::path::PathBuf);

impl PartStore for FileParts {
    fn read(&self) -> BTreeMap<String, Gathered> {
        std::fs::read(&self.0).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn write(&mut self, all: &BTreeMap<String, Gathered>) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(all) {
            let _ = std::fs::write(&self.0, bytes);
        }
    }
}

/// Parts kept in memory only (tests, and where there is no folder to keep them in).
#[derive(Default)]
pub struct MemoryParts(pub BTreeMap<String, Gathered>);

impl PartStore for MemoryParts {
    fn read(&self) -> BTreeMap<String, Gathered> {
        self.0.clone()
    }
    fn write(&mut self, all: &BTreeMap<String, Gathered>) {
        self.0 = all.clone();
    }
}

pub struct ReceiveState {
    pub open: bool,
    pub field: Entity<TextField>,
    pub list: Option<SharedList>,
    /// Which of the new ones (by position among them) are ticked.
    pub picked: BTreeSet<usize>,
    pub later: bool,
    pub said: Option<String>,
    pub problem: Option<String>,
    pub parts: Box<dyn PartStore>,
}

impl ReceiveState {
    pub fn new(cx: &mut Context<Shell>, colors: sondra_ui::Colors) -> ReceiveState {
        let field = cx.new(|cx| TextField::new(cx, colors, "Link der Liste").placeholder("Link oder Teil einer Liste einfügen").max_chars(40_000));
        cx.subscribe(&field, |shell: &mut Shell, _, event: &FieldEvent, cx| {
            if *event == FieldEvent::Submitted {
                shell.receive_read_field(cx);
            }
        })
        .detach();
        let parts: Box<dyn PartStore> = match crate::store::data_dir() {
            Some(dir) => Box::new(FileParts(dir.join("Teile.json"))),
            None => Box::new(MemoryParts::default()),
        };
        ReceiveState { open: false, field, list: None, picked: BTreeSet::new(), later: false, said: None, problem: None, parts }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The picture a shared entry brings, as a data address the covers draw: a WebP or JPEG as it came, and the
/// 34 bytes of „winzig“ blown up smoothly into a blur of the poster's colours.
pub fn thumb_data_uri(blob: &[u8]) -> Option<String> {
    if !valid_thumb(blob) {
        return None;
    }
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    match blob[0] {
        KIND_WEBP => Some(format!("data:image/webp;base64,{}", b64(&blob[1..]))),
        KIND_JPEG => Some(format!("data:image/jpeg;base64,{}", b64(&blob[1..]))),
        KIND_RAW => {
            let rgba = unpack_raw(&blob[1..])?;
            let small = image::RgbaImage::from_raw(RAW_W as u32, RAW_H as u32, rgba)?;
            let big = image::imageops::resize(&small, (RAW_W * 10) as u32, (RAW_H * 10) as u32, image::imageops::FilterType::Triangle);
            let mut png = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(big).write_to(&mut png, image::ImageFormat::Png).ok()?;
            Some(format!("data:image/png;base64,{}", b64(png.get_ref())))
        }
        _ => None,
    }
}

/// A new entry of this list from what a shared one carries.
pub fn item_from_entry(entry: &NewEntry, ids: &mut Ids) -> sondra_merk::Item {
    let mut raw = serde_json::json!({ "title": entry.title, "status": entry.status.unwrap_or_default(), "updatedAt": ids.now });
    if let Some(r) = entry.rating {
        raw["rating"] = r.into();
    }
    if let Some(s) = entry.season {
        raw["season"] = s.into();
    }
    if let Some(e) = entry.episode {
        raw["episode"] = e.into();
    }
    if let Some(uri) = entry.thumb.as_deref().and_then(thumb_data_uri) {
        raw["cover"] = uri.into();
        if entry.manga {
            raw["tileFormat"] = "manga".into();
        }
    }
    normalize(&raw, ids)
}

impl Shell {
    pub fn receive_open(&mut self, cx: &mut Context<Self>) {
        let r = &mut self.merk.receive;
        r.open = true;
        r.list = None;
        r.picked.clear();
        r.said = None;
        r.problem = None;
        r.field.update(cx, |f, cx| f.set_text("", cx));
        cx.notify();
    }

    /// For tests: where the parts of a list in pieces wait.
    pub fn receive_with_parts(&mut self, parts: Box<dyn PartStore>) {
        self.merk.receive.parts = parts;
    }

    fn receive_got(&mut self, list: SharedList) {
        let r = &mut self.merk.receive;
        let fresh = compare_shared(&list, &self.merk.items).fresh.len();
        r.picked = (0..fresh).collect();
        r.list = Some(list);
        r.problem = None;
        r.said = None;
    }

    /// Reads what is in the field: a whole link, a part of one, or the text after `#g=`.
    pub fn receive_read_field(&mut self, cx: &mut Context<Self>) {
        let text = self.merk.receive.field.read(cx).text().trim().to_string();
        self.receive_read(&text);
        cx.notify();
    }

    pub fn receive_read(&mut self, text: &str) {
        let hash = text.split_once('#').map(|(_, hash)| format!("#{hash}"));
        let payload = match &hash {
            Some(hash) => shared_from_hash(hash).unwrap_or(&hash[1..]),
            None => text,
        };
        let r = &mut self.merk.receive;
        match read_shared(payload, r.parts.as_mut(), now_ms()) {
            Reading::List(list) => self.receive_got(list),
            Reading::Parts { got, of } => {
                r.list = None;
                r.problem = None;
                r.said = Some(format!("Teil {} von {} ist da. Öffnen Sie die übrigen Links — die Teile setzen sich in jeder Reihenfolge zusammen.", got.last().copied().unwrap_or(0), of));
            }
            Reading::Broken => {
                r.list = None;
                r.said = None;
                r.problem = Some("Das ist keine Liste, die Sondra lesen kann.".into());
            }
        }
    }

    /// Reads a `.sondra-liste` file.
    pub fn receive_read_file(&mut self, path: &std::path::Path) {
        match std::fs::read(path).ok().and_then(|b| read_share_file(&b)) {
            Some(list) => self.receive_got(list),
            None => {
                let r = &mut self.merk.receive;
                r.list = None;
                r.problem = Some("Diese Datei ist keine Liste, die Sondra lesen kann.".into());
            }
        }
    }

    fn receive_choose_file(&mut self, cx: &mut Context<Self>) {
        let answer = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = answer.await {
                if let Some(path) = paths.into_iter().next() {
                    this.update(cx, |shell, cx| {
                        shell.receive_read_file(&path);
                        cx.notify();
                    })
                    .ok();
                }
            }
        })
        .detach();
    }

    /// Takes the ticked new ones onto the list, as they stand there or as „Später“.
    pub fn receive_take(&mut self) -> usize {
        let r = &self.merk.receive;
        let Some(list) = r.list.clone() else { return 0 };
        let fresh = compare_shared(&list, &self.merk.items).fresh;
        let how = if r.later { Take::Later } else { Take::AsThere };
        let mut ids = Ids::system();
        let mut taken = 0;
        for (n, shared) in fresh.iter().enumerate().rev() {
            if !r.picked.contains(&n) {
                continue;
            }
            let item = item_from_entry(&entry_from_shared(shared, how), &mut ids);
            self.merk.items.insert(0, item);
            taken += 1;
        }
        if taken > 0 {
            self.merk.save();
        }
        let r = &mut self.merk.receive;
        r.said = Some(if taken == 1 { "1 Serie aufgenommen.".into() } else { format!("{taken} Serien aufgenommen.") });
        r.picked.clear();
        taken
    }

    pub(crate) fn receive_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let r = &self.merk.receive;
        if !r.open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let mut body = div().flex().flex_col().gap(px(14.));
        body = body.child(ui.prose("Fügen Sie einen Link ein, den jemand mit Ihnen geteilt hat — oder öffnen Sie eine Datei. Es wird nichts geholt: die Liste steht im Link selbst. Gelesen wird nur Klartext, und Sie wählen, was auf Ihre Liste kommt."));
        let (read, file) = (me.clone(), me.clone());
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .child(div().w(px(420.)).child(r.field.clone()))
                .child(ui.button("empfangen-lesen", "Lesen").primary().on_click(move |_, app| read.update(app, |sh, cx| sh.receive_read_field(cx))))
                .child(ui.button("empfangen-datei", "Datei öffnen …").on_click(move |_, app| file.update(app, |sh, cx| sh.receive_choose_file(cx)))),
        );
        if let Some(problem) = &r.problem {
            body = body.child(ui.notice(NoticeKind::Warning, problem.clone()));
        }
        if let Some(said) = &r.said {
            body = body.child(ui.notice(NoticeKind::Info, said.clone()));
        }
        let mut actions: Vec<AnyElement> = Vec::new();
        if let Some(list) = &r.list {
            let cmp = compare_shared(list, &self.merk.items);
            let who = if list.name.is_empty() { "dort".to_string() } else { list.name.clone() };
            body = body.child(ui.subheading(format!("Beide haben {} · nur bei Ihnen {} · nur bei {} {}", cmp.both.len(), cmp.only_mine, who, cmp.fresh.len())));
            if cmp.fresh.is_empty() {
                body = body.child(ui.hint("Alles, was auf dieser Liste steht, haben Sie schon."));
            } else {
                let mut chips = div().flex().flex_wrap().gap(px(6.));
                for (n, item) in cmp.fresh.iter().enumerate() {
                    let me = me.clone();
                    let on = r.picked.contains(&n);
                    chips = chips.child(ui.chip(format!("neu-{n}"), item.title.clone(), on).accessible_name(format!("{} aufnehmen", item.title)).on_click(move |_, app| me.update(app, |sh, cx| {
                        let picked = &mut sh.merk.receive.picked;
                        if !picked.remove(&n) {
                            picked.insert(n);
                        }
                        cx.notify();
                    })));
                }
                let (all, none, there, later) = (me.clone(), me.clone(), me.clone(), me.clone());
                let count = cmp.fresh.len();
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .child(div().flex().flex_wrap().items_center().gap(px(8.)).child(ui.button("empfangen-alle", "Alle").small().on_click(move |_, app| all.update(app, |sh, cx| {
                            sh.merk.receive.picked = (0..count).collect();
                            cx.notify();
                        }))).child(ui.button("empfangen-keine", "Keine").small().on_click(move |_, app| none.update(app, |sh, cx| {
                            sh.merk.receive.picked.clear();
                            cx.notify();
                        }))).child(ui.chip("wie-dort", "Wie dort", !r.later).on_click(move |_, app| there.update(app, |sh, cx| {
                            sh.merk.receive.later = false;
                            cx.notify();
                        }))).child(ui.chip("als-spaeter", "Als Später", r.later).on_click(move |_, app| later.update(app, |sh, cx| {
                            sh.merk.receive.later = true;
                            cx.notify();
                        }))))
                        .child(chips),
                );
                if !cmp.both.is_empty() {
                    let names: Vec<String> = cmp.both.iter().map(|i| i.title.clone()).collect();
                    body = body.child(div().flex().flex_col().gap(px(4.)).pt(px(8.)).border_t_1().border_color(c.line).child(ui.hint("Schon auf Ihrer Liste")).child(ui.prose(names.join(" · "))));
                }
                let n = r.picked.len();
                let take = me.clone();
                actions.push(ui.button("empfangen-aufnehmen", if n == 1 { "1 Serie aufnehmen".to_string() } else { format!("{n} Serien aufnehmen") }).primary().disabled(n == 0).on_click(move |_, app| take.update(app, |sh, cx| {
                    sh.receive_take();
                    cx.notify();
                })).into_any_element());
            }
        }
        let (close, away) = (me.clone(), me.clone());
        let mut dialog = ui.dialog("empfangen-fenster", "Liste empfangen").width(680.).child(body);
        for a in actions {
            dialog = dialog.action(a);
        }
        Some(
            dialog
                .action(ui.button("empfangen-schliessen", "Schliessen").on_click(move |_, app| close.update(app, |sh, cx| {
                    sh.merk.receive.open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |sh, cx| {
                    sh.merk.receive.open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}
