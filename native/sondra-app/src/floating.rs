//! What waits for an answer or goes on behind another tool, kept in one small stack at the lower left on every
//! page but its own: a device that offers files (a person is waiting for „Annehmen“ or „Ablehnen“), and a
//! download that is still loading (its bar, the rate, „Abbrechen“). A film that plays has its own bar at the
//! lower right (`player_mini`).

use gpui::{div, prelude::*, px, AnyElement, Context};
use sondra_devices::engine::State;
use sondra_ui::{family, size, Ui};

use crate::devices_page::{files_phrase, say};
use crate::download_page::format_size;
use crate::nav::Panel;
use crate::shell::Shell;

impl Shell {
    pub(crate) fn floating_cards(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let me = cx.entity();
        let c = ui.c;
        let card = || {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .max_w(px(420.))
                .rounded(px(sondra_ui::radius::CARD))
                .bg(c.raised)
                .border_1()
                .border_color(c.line)
                .shadow(vec![gpui::BoxShadow { color: gpui::hsla(0., 0., 0., 0.2), offset: gpui::point(px(0.), px(8.)), blur_radius: px(24.), spread_radius: px(0.) }])
        };
        let mut stack: Vec<AnyElement> = Vec::new();

        // A device offers files: the answer is wanted wherever the person is.
        if self.panel() != Panel::Devices {
            if let Some(engine) = &self.devices.engine {
                for t in engine.snapshot().transfers.iter().filter(|t| t.state == State::Asking) {
                    let (yes, no, go) = (me.clone(), me.clone(), me.clone());
                    let (id_yes, id_no) = (t.id.clone(), t.id.clone());
                    stack.push(
                        card()
                            .child(ui.title(say(t)))
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap(px(8.))
                                    .child(ui.button(format!("karte-annehmen-{}", t.id), "Annehmen").small().primary().accessible_name(format!("{} annehmen", files_phrase(&t.files))).on_click(move |_, app| yes.update(app, |shell, cx| shell.devices_accept(&id_yes, cx))))
                                    .child(ui.button(format!("karte-ablehnen-{}", t.id), "Ablehnen").small().accessible_name(format!("{} ablehnen", files_phrase(&t.files))).on_click(move |_, app| {
                                        let id = id_no.clone();
                                        no.update(app, |shell, cx| {
                                            if let Some(e) = &shell.devices.engine {
                                                e.decline(&id);
                                            }
                                            cx.notify();
                                        })
                                    }))
                                    .child(ui.button(format!("karte-geraete-{}", t.id), "Zu den Geräten").small().on_click(move |_, app| go.update(app, |shell, cx| shell.go(Panel::Devices, cx)))),
                            )
                            .into_any_element(),
                    );
                }
            }
        }

        // A download that goes on behind another tool.
        if self.panel() != Panel::Downloader {
            if let Some(job) = &self.download.job {
                let p = *job.progress.lock().expect("lock");
                let fraction = p.total.filter(|t| *t > 0).map(|t| (p.loaded as f32 / t as f32).clamp(0.0, 1.0));
                let rate = p.loaded as f64 / job.started.elapsed().as_secs_f64().max(0.001);
                let said = match p.total {
                    Some(total) => format!("{} von {} · {}/s", format_size(p.loaded), format_size(total), format_size(rate as u64)),
                    None => format!("{} · {}/s", format_size(p.loaded), format_size(rate as u64)),
                };
                let (cancel, go) = (job.cancel.clone(), me.clone());
                stack.push(
                    card()
                        .child(div().truncate().child(ui.title(format!("Lädt: {}", job.title))))
                        .child(ui.bar("karte-laden", fraction, format!("{}: geladen", job.title)))
                        .child(div().font_family(family::VALUE).text_size(px(size::SMALL)).text_color(c.prose).child(said))
                        .child(
                            div()
                                .flex()
                                .gap(px(8.))
                                .child(ui.button("karte-zum-laden", "Zum Herunterladen").small().on_click(move |_, app| go.update(app, |shell, cx| shell.go(Panel::Downloader, cx))))
                                .child(ui.button("karte-laden-abbrechen", "Abbrechen").small().on_click(move |_, _| cancel.cancel())),
                        )
                        .into_any_element(),
                );
            }
        }

        // A new episode of a series on the list.
        for note in &self.news_rounds.notes {
            let (see, close) = (me.clone(), me.clone());
            let (id_see, id_close) = (note.id.clone(), note.id.clone());
            stack.push(
                card()
                    .child(div().truncate().child(ui.title(format!("Neue Folge: {}", note.title))))
                    .child(ui.hint(format!("Staffel {}, Folge {} ist auf AniWorld erschienen.", note.season, note.episode)))
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(ui.button(format!("neu-ansehen-{}", note.id), "Ansehen").small().primary().accessible_name(format!("{} ansehen", note.title)).on_click(move |_, app| {
                                let id = id_see.clone();
                                see.update(app, |shell, cx| shell.open_announced(&id, cx))
                            }))
                            .child(ui.button(format!("neu-schliessen-{}", note.id), "Schließen").small().accessible_name(format!("Meldung zu {} schließen", note.title)).on_click(move |_, app| {
                                let id = id_close.clone();
                                close.update(app, |shell, cx| {
                                    shell.news_rounds.notes.retain(|n| n.id != id);
                                    cx.notify();
                                })
                            })),
                    )
                    .into_any_element(),
            );
        }

        // A newer version of Sondra is ready.
        if let Some(card) = self.update_card(&ui, cx) {
            stack.push(card);
        }

        if stack.is_empty() {
            return None;
        }
        Some(div().absolute().bottom(px(16.)).left(px(16.)).flex().flex_col().gap(px(8.)).children(stack).into_any_element())
    }
}
