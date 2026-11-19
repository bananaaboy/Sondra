//! „Teilen“ of the Merkliste (`MerklisteShare.tsx`): the list as a link that carries it — nothing is uploaded and
//! nobody is asked; whoever has the link sees the list. The person chooses what goes (Am Schauen to begin
//! with, nothing else), with or without how far each is; never the addresses of the episodes or the notes.
//! Out come the link (or its parts when the list is long), the list as plain text, a QR code for a phone's
//! camera, and a file for what is too long even for parts. Packing is `sondra_merk::share`, byte for byte the
//! web app's, so a link made here opens on the website and the other way round.

use std::collections::{BTreeSet, HashMap};

use gpui::{div, prelude::*, px, AnyElement, ClipboardItem, Context};
use qrcode::{Color, EcLevel, QrCode};
use sondra_merk::share::{share_file, share_links, share_text, shareable_list, QR_LINK_MAX, LINK_MAX, SHARE_FILE_EXT};
use sondra_merk::view::STATUS_OPTIONS;
use sondra_merk::{Item, Status};
use sondra_ui::Ui;

use crate::shell::Shell;

/// Where a link made here points.
pub const ORIGIN: &str = "https://sondra.lizge.ch";

pub struct ShareState {
    pub open: bool,
    pub stands: BTreeSet<u8>,
    pub progress: bool,
    pub qr: bool,
    /// Which link (part) the QR code shows.
    pub part: usize,
    /// What the last copy or save said.
    pub said: Option<String>,
}

impl Default for ShareState {
    fn default() -> Self {
        ShareState { open: false, stands: BTreeSet::from([0]), progress: true, qr: false, part: 0, said: None }
    }
}

fn stand_index(status: Status) -> u8 {
    STATUS_OPTIONS.iter().position(|(s, _)| *s == status).unwrap_or(0) as u8
}

/// The entries the choices take in.
fn chosen<'a>(items: &'a [Item], state: &ShareState) -> Vec<Item> {
    items.iter().filter(|i| state.stands.contains(&stand_index(i.status))).cloned().collect()
}

/// The matrix of a QR code for `text`, row by row, `true` where it is dark.
pub fn qr_modules(text: &str) -> Option<Vec<Vec<bool>>> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::L).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    Some((0..width).map(|y| (0..width).map(|x| colors[y * width + x] == Color::Dark).collect()).collect())
}

impl Shell {
    /// Everything a person can take out for the choices made.
    pub fn share_outputs(&self) -> (Vec<String>, String) {
        let s = &self.merk.share;
        let list = shareable_list(&chosen(&self.merk.items, s), "", s.progress, &HashMap::new());
        let links = share_links(&list, ORIGIN, LINK_MAX);
        let text = share_text(&list, &links);
        (links, text)
    }

    pub(crate) fn share_overlay(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = &self.merk.share;
        if !s.open {
            return None;
        }
        let me = cx.entity();
        let c = ui.c;
        let counts: Vec<usize> = STATUS_OPTIONS.iter().map(|(st, _)| self.merk.items.iter().filter(|i| i.status == *st).count()).collect();
        let mut pills = div().flex().flex_wrap().gap(px(6.));
        for (n, (_, label)) in STATUS_OPTIONS.iter().enumerate() {
            if counts[n] == 0 {
                continue;
            }
            let me = me.clone();
            let on = s.stands.contains(&(n as u8));
            pills = pills.child(ui.chip(format!("teilen-{label}"), format!("{label} {}", counts[n]), on).accessible_name(format!("{label} mitnehmen, {} Serien", counts[n])).on_click(move |_, app| me.update(app, |shell, cx| {
                let st = &mut shell.merk.share;
                if !st.stands.remove(&(n as u8)) {
                    st.stands.insert(n as u8);
                }
                st.part = 0;
                st.said = None;
                cx.notify();
            })));
        }
        let progress = {
            let me = me.clone();
            ui.chip("teilen-fortschritt", "Mit Stand und Bewertung", s.progress).on_click(move |_, app| me.update(app, |shell, cx| {
                shell.merk.share.progress = !shell.merk.share.progress;
                shell.merk.share.part = 0;
                cx.notify();
            }))
        };
        let (links, text) = self.share_outputs();
        let n = chosen(&self.merk.items, s).len();
        let mut body = div().flex().flex_col().gap(px(14.));
        body = body.child(ui.prose("Die Liste steht im Link selbst: es wird nichts hochgeladen, und wer den Link hat, sieht sie. Adressen der Folgen und Notizen gehen nie mit."));
        body = body.child(div().flex().flex_col().gap(px(8.)).child(ui.subheading("Was soll mit?")).child(pills).child(div().flex().child(progress)));
        if n == 0 {
            body = body.child(ui.hint("Wählen Sie mindestens einen Stand."));
        } else if links.is_empty() {
            body = body.child(ui.hint(format!("{n} Serien sind mehr, als sich in Links tragen lässt — speichern Sie sie als Datei."))); 
        } else {
            let len: usize = links.iter().map(String::len).sum();
            body = body.child(ui.hint(if links.len() == 1 { format!("{n} Serien: ein Link, {len} Zeichen.") } else { format!("{n} Serien: {} Links, zusammen {len} Zeichen — jeder trägt einen Teil, und wer alle öffnet, hat die Liste.", links.len()) }));
        }
        // The QR code, for links short enough to be read off a screen.
        let qr_ok = links.get(s.part).is_some_and(|l| l.len() <= QR_LINK_MAX);
        if s.qr && qr_ok {
            if let Some(rows) = qr_modules(&links[s.part]) {
                let cell = 5.0;
                let quiet = 4;
                let size = (rows.len() + 2 * quiet) as f32 * cell;
                let mut grid = div().flex().flex_col().bg(gpui::white()).p(px(quiet as f32 * cell)).w(px(size)).h(px(size));
                for row in rows {
                    let mut line = div().flex();
                    for dark in row {
                        line = line.child(div().w(px(cell)).h(px(cell)).bg(if dark { gpui::black() } else { gpui::white() }));
                    }
                    grid = grid.child(line);
                }
                let mut qr = div().flex().flex_col().gap(px(8.)).child(grid);
                if links.len() > 1 {
                    let (prev, next) = (me.clone(), me.clone());
                    let part = s.part;
                    qr = qr.child(div().flex().items_center().gap(px(8.)).child(ui.button("qr-zurueck", "Zurück").small().disabled(part == 0).on_click(move |_, app| prev.update(app, |sh, cx| {
                        sh.merk.share.part = sh.merk.share.part.saturating_sub(1);
                        cx.notify();
                    }))).child(ui.value(format!("Code {} von {}", part + 1, links.len()))).child(ui.button("qr-weiter", "Weiter").small().disabled(part + 1 >= links.len()).on_click(move |_, app| next.update(app, |sh, cx| {
                        sh.merk.share.part += 1;
                        cx.notify();
                    }))));
                }
                body = body.child(qr);
            }
        } else if s.qr {
            body = body.child(ui.hint(format!("Für einen QR-Code ist der Link zu lang (mehr als {QR_LINK_MAX} Zeichen).")));
        }
        if let Some(said) = &s.said {
            body = body.child(ui.notice(sondra_ui::NoticeKind::Info, said.clone()));
        }
        let _ = c;
        let mut actions: Vec<AnyElement> = Vec::new();
        let enabled = n > 0;
        if !links.is_empty() && enabled {
            let (all, as_text, qr) = (links.clone(), text.clone(), me.clone());
            let (copy1, copy2) = (me.clone(), me.clone());
            actions.push(ui.button("link-kopieren", if links.len() == 1 { "Link kopieren" } else { "Links kopieren" }).on_click(move |_, app| {
                app.write_to_clipboard(ClipboardItem::new_string(all.join("\n")));
                copy1.update(app, |sh, cx| {
                    sh.merk.share.said = Some("Kopiert.".into());
                    cx.notify();
                })
            }).into_any_element());
            actions.push(ui.button("text-kopieren", "Als Text kopieren").on_click(move |_, app| {
                app.write_to_clipboard(ClipboardItem::new_string(as_text.clone()));
                copy2.update(app, |sh, cx| {
                    sh.merk.share.said = Some("Als Text kopiert.".into());
                    cx.notify();
                })
            }).into_any_element());
            actions.push(ui.button("qr-zeigen", if s.qr { "QR-Code verbergen" } else { "QR-Code zeigen" }).on_click(move |_, app| qr.update(app, |sh, cx| {
                sh.merk.share.qr = !sh.merk.share.qr;
                cx.notify();
            })).into_any_element());
        }
        if enabled {
            let file = me.clone();
            actions.push(ui.button("liste-als-datei", "Als Datei speichern").on_click(move |_, app| file.update(app, |sh, cx| {
                sh.share_save_file();
                cx.notify();
            })).into_any_element());
        }
        let (close, away) = (me.clone(), me.clone());
        let mut dialog = ui.dialog("teilen-fenster", "Merkliste teilen").width(620.).child(body);
        for a in actions {
            dialog = dialog.action(a);
        }
        Some(
            dialog
                .action(ui.button("teilen-schliessen", "Schliessen").primary().on_click(move |_, app| close.update(app, |sh, cx| {
                    sh.merk.share.open = false;
                    cx.notify();
                })))
                .on_close(move |_, app| away.update(app, |sh, cx| {
                    sh.merk.share.open = false;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    /// Writes the list as a file that opens in Sondra (`.sondra-liste`) into the downloads folder.
    pub fn share_save_file(&mut self) {
        let s = &self.merk.share;
        let list = shareable_list(&chosen(&self.merk.items, s), "", s.progress, &HashMap::new());
        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        let folder = crate::store::downloads_dir();
        let name = format!("Sondra-Merkliste-{day}");
        let result = std::fs::create_dir_all(&folder).and_then(|_| {
            let ext = SHARE_FILE_EXT.trim_start_matches('.');
            let target = sondra_media::run::unique_path(&folder, &name, ext);
            std::fs::write(&target, share_file(&list)).map(|_| target)
        });
        self.merk.share.said = Some(match result {
            Ok(p) => format!("Die Datei liegt in {}.", p.display()),
            Err(e) => format!("Die Datei liess sich nicht schreiben: {e}"),
        });
    }
}
