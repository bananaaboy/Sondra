//! The notifications drawer („Mitteilungen“): what waits for the person — announced episodes, devices that
//! offer files — and a short log of what happened while they looked elsewhere: a download done, files
//! converted, an update ready. It opens from the bell at the foot of the rack and slides in beside it; a
//! click on an entry goes where it happened. Nothing here is sent anywhere.

use std::time::{Duration, Instant};

use gpui::{deferred, div, prelude::*, px, AnyElement, Context};
use sondra_a11y::{accessible, Role};
use sondra_ui::{motion, radius, size, Ui};

use crate::nav::Panel;
use crate::shell::Shell;

/// How many past entries are kept.
const KEEP: usize = 40;

#[derive(Clone)]
pub struct Entry {
    pub id: u64,
    pub title: String,
    pub text: String,
    pub target: Option<Panel>,
    pub at: Instant,
}

#[derive(Default)]
pub struct Inbox {
    pub open: bool,
    pub log: Vec<Entry>,
    next: u64,
    /// Entries up to this id have been seen (the drawer was open after them).
    seen: u64,
}

impl Inbox {
    pub fn unread(&self) -> usize {
        self.log.iter().filter(|e| e.id > self.seen).count()
    }
}

/// „gerade eben“, „vor 3 Min.“, „vor 2 Std.“.
fn ago(at: Instant) -> String {
    let s = at.elapsed().as_secs();
    match s {
        0..=59 => "gerade eben".into(),
        60..=3599 => format!("vor {} Min.", s / 60),
        _ => format!("vor {} Std.", s / 3600),
    }
}

impl Shell {
    /// Writes a line into the drawer: something finished while the person may have been elsewhere.
    pub(crate) fn note(&mut self, title: impl Into<String>, text: impl Into<String>, target: Option<Panel>) {
        let inbox = &mut self.inbox;
        inbox.next += 1;
        inbox.log.insert(0, Entry { id: inbox.next, title: title.into(), text: text.into(), target, at: Instant::now() });
        inbox.log.truncate(KEEP);
    }

    pub(crate) fn toggle_inbox(&mut self, cx: &mut Context<Self>) {
        self.inbox.open = !self.inbox.open;
        if self.inbox.open {
            self.inbox.seen = self.inbox.next;
        }
        cx.notify();
    }

    /// What the bell counts: what waits, and what happened since the drawer was last open.
    pub(crate) fn inbox_count(&self) -> usize {
        self.attention_count() + self.inbox.unread()
    }

    /// The drawer, beside the rack, over the plate.
    pub(crate) fn inbox_drawer(&self, ui: Ui, left: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.inbox.open {
            return None;
        }
        let c = ui.c;
        let me = cx.entity();
        let mut list = div().id("mitteilungen-liste").flex_1().min_h_0().overflow_y_scroll().flex().flex_col().gap(px(8.)).px(px(16.)).pb(px(16.));

        // What waits: the person's answer is wanted.
        let waiting = self.attention_lines();
        if !waiting.is_empty() {
            list = list.child(div().pt(px(4.)).child(ui.rack_heading("Wartet auf Sie")));
            for (n, (title, text)) in waiting.into_iter().enumerate() {
                let open = me.clone();
                let target = if title.starts_with("Neue Folge") { Panel::Merkliste } else { Panel::Devices };
                list = list.child(row(ui, format!("wartet-{n}"), &title, &text, None, true, n, move |app| {
                    open.update(app, |shell, cx| {
                        shell.inbox.open = false;
                        shell.go(target, cx);
                    })
                }));
            }
        }
        if !self.inbox.log.is_empty() {
            list = list.child(div().pt(px(10.)).child(ui.rack_heading("Zuletzt")));
            for (n, entry) in self.inbox.log.iter().enumerate() {
                let open = me.clone();
                let target = entry.target;
                list = list.child(row(ui, format!("mitteilung-{}", entry.id), &entry.title, &entry.text, Some(ago(entry.at)), false, n + 1, move |app| {
                    open.update(app, |shell, cx| {
                        shell.inbox.open = false;
                        if let Some(panel) = target {
                            shell.go(panel, cx);
                        }
                        cx.notify();
                    })
                }));
            }
        }
        if self.attention_count() == 0 && self.inbox.log.is_empty() {
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(14.))
                    .py(px(28.))
                    .child(ui.bars_art("mitteilungen-leer", 56.))
                    .child(ui.title("Alles ruhig"))
                    .child(div().w(px(240.)).text_center().child(ui.hint("Hier steht, wenn eine neue Folge erscheint, ein Gerät etwas schickt oder etwas fertig ist."))),
            );
        }

        let (close, clear) = (me.clone(), me.clone());
        let mut head = div()
            .flex_none()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(10.))
            .px(px(20.))
            .pt(px(18.))
            .pb(px(12.))
            .child(ui.title("Mitteilungen"));
        let mut tools = div().flex().items_center().gap(px(4.));
        if !self.inbox.log.is_empty() {
            tools = tools.child(ui.button("mitteilungen-leeren", "Leeren").small().ghost().on_click(move |_, app| {
                clear.update(app, |shell, cx| {
                    shell.inbox.log.clear();
                    cx.notify();
                })
            }));
        }
        tools = tools.child(ui.button("mitteilungen-zu", "Schliessen").small().ghost().on_click(move |_, app| close.update(app, |shell, cx| shell.toggle_inbox(cx))));
        head = head.child(tools);

        let outside = me.clone();
        let drawer = div()
            .id("mitteilungen")
            .w(px(360.))
            .max_h(px(560.))
            .flex()
            .flex_col()
            .rounded(px(radius::DIALOG))
            .bg(c.raised)
            .border_1()
            .border_color(c.plate_edge)
            .shadow(sondra_ui::float_shadow())
            .text_size(px(size::BODY))
            .occlude()
            .on_mouse_down_out(move |_, _, app| {
                outside.update(app, |shell, cx| {
                    if shell.inbox.open {
                        shell.inbox.open = false;
                        cx.notify();
                    }
                })
            })
            .child(head)
            .child(list);
        let drawer = accessible("mitteilungsfach", Role::Dialog, drawer).label("Mitteilungen");
        Some(
            deferred(motion::enter_floating(div().absolute().left(px(left)).bottom(px(12.)).child(drawer), "mitteilungen-auf", (-16.0, 0.0), Duration::ZERO, motion::BASE))
                .with_priority(20)
                .into_any_element(),
        )
    }
}

/// One entry: a dot (lit for what waits), title, line, and when.
fn row(ui: Ui, id: String, title: &str, text: &str, when: Option<String>, waiting: bool, index: usize, on_open: impl Fn(&mut gpui::App) + 'static) -> AnyElement {
    let on_open = std::rc::Rc::new(on_open);
    let on_key = on_open.clone();
    let c = ui.c;
    let mut words = div().flex_1().min_w_0().flex().flex_col().gap(px(2.)).child(div().font_weight(gpui::FontWeight::SEMIBOLD).text_color(c.prose).child(title.to_string()));
    words = words.child(div().text_size(px(size::SMALL)).text_color(c.muted).child(text.to_string()));
    if let Some(when) = &when {
        words = words.child(div().text_size(px(size::MICRO)).text_color(c.muted).child(when.clone()));
    }
    let visual = div()
        .id(gpui::ElementId::Name(id.clone().into()))
        .flex()
        .items_start()
        .gap(px(12.))
        .p(px(12.))
        .rounded(px(radius::CARD))
        .bg(if waiting { c.ink_wash } else { c.panel_soft })
        .cursor_pointer()
        .hover(move |s| s.bg(c.panel_mid))
        .child(div().mt(px(6.)).flex_none().size(px(8.)).rounded(px(radius::PILL)).bg(if waiting { c.ink } else { c.faint }))
        .child(words)
        .on_click(move |_, _, app| on_open(app));
    let node = accessible(gpui::ElementId::Name(format!("{id}-zeile").into()), Role::Button, visual)
        .label(title.to_string())
        .description(match when { Some(w) => format!("{text}. {w}"), None => text.to_string() })
        .on_activate(move |_, app| on_key(app));
    motion::enter(div().child(node), gpui::ElementId::Name(format!("{id}-ein").into()), (0.0, 6.0), motion::stagger(index), motion::FAST)
}
