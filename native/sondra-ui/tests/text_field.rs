//! The text field in GPUI's test window: typing, editing keys, the clipboard, limits, events.

use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    point, prelude::*, px, size, AvailableSpace, ClipboardItem, Context, Entity, Render,
    TestAppContext, VisualTestContext, Window,
};
use sondra_a11y::{a11y_root, attach_sink, Role, Snapshot};
use sondra_ui::{bind_keys, fonts, FieldEvent, Mode, TextField};

struct Root {
    field: Entity<TextField>,
}

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        a11y_root(gpui::div().size_full().p(px(20.)).child(self.field.clone()))
    }
}

struct Opened<'a> {
    cx: &'a mut VisualTestContext,
    field: Entity<TextField>,
    events: Rc<RefCell<Vec<FieldEvent>>>,
    seen: Rc<RefCell<Vec<Rc<Snapshot>>>>,
}

fn open(cx: &mut TestAppContext, max: Option<usize>) -> Opened<'_> {
    cx.update(|cx| {
        fonts::load(cx);
        bind_keys(cx);
    });
    let field_cell: Rc<RefCell<Option<Entity<TextField>>>> = Rc::default();
    let cell = field_cell.clone();
    let (view, cx) = cx.add_window_view(move |_, cx| {
        let field = cx.new(|cx| {
            let f = TextField::new(cx, Mode::Light.colors(), "Serie suchen")
                .placeholder("Name oder Adresse");
            match max {
                Some(m) => f.max_chars(m),
                None => f,
            }
        });
        *cell.borrow_mut() = Some(field.clone());
        Root { field }
    });
    let field = field_cell.borrow().clone().unwrap();
    let events: Rc<RefCell<Vec<FieldEvent>>> = Rc::default();
    let sink = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&field, move |_, event: &FieldEvent, _| {
            sink.borrow_mut().push(event.clone())
        })
        .detach();
    });
    let seen: Rc<RefCell<Vec<Rc<Snapshot>>>> = Rc::default();
    let s2 = seen.clone();
    cx.update(|window, cx| {
        attach_sink(window, cx, move |snap| {
            s2.borrow_mut().push(Rc::new(snap.clone()))
        })
    });
    let focus = field.read_with(cx, |f, cx| gpui::Focusable::focus_handle(f, cx));
    cx.update(|window, _| window.focus(&focus));
    let draw = |cx: &mut VisualTestContext, view: Entity<Root>| {
        cx.draw(
            point(px(0.), px(0.)),
            size(
                AvailableSpace::Definite(px(500.)),
                AvailableSpace::Definite(px(200.)),
            ),
            move |_, _| view,
        );
    };
    draw(cx, view);
    Opened {
        cx,
        field,
        events,
        seen,
    }
}

fn text(o: &mut Opened) -> String {
    o.field.read_with(o.cx, |f, _| f.text().to_owned())
}

#[gpui::test]
fn typing_replaces_the_selection_and_keys_edit(cx: &mut TestAppContext) {
    let mut o = open(cx, None);
    o.cx.simulate_input("Frieren");
    assert_eq!(text(&mut o), "Frieren");
    o.cx.simulate_keystrokes("backspace backspace");
    assert_eq!(text(&mut o), "Frier");
    // Select all and type over it.
    o.cx.simulate_keystrokes("ctrl-a");
    o.cx.simulate_input("Re Zero");
    assert_eq!(text(&mut o), "Re Zero");
    // Home, then delete forwards; End, then a word back.
    o.cx.simulate_keystrokes("home delete");
    assert_eq!(text(&mut o), "e Zero");
    o.cx.simulate_keystrokes("end");
    o.cx.simulate_keystrokes("ctrl-backspace");
    assert_eq!(text(&mut o), "e ", "a word back, as Unicode counts words");
    assert!(o.events.borrow().iter().all(|e| *e == FieldEvent::Changed));
    assert!(!o.events.borrow().is_empty());
}

#[gpui::test]
fn what_a_person_sees_as_one_letter_is_one_step(cx: &mut TestAppContext) {
    let mut o = open(cx, None);
    // "e" with a combining accent, and a flag: two characters each to Unicode, one to the eye.
    o.cx.simulate_input("e\u{301}🇨🇭x");
    o.cx.simulate_keystrokes("left left");
    o.cx.simulate_keystrokes("backspace");
    assert_eq!(
        text(&mut o),
        "🇨🇭x",
        "one backspace takes the accented letter whole"
    );
    o.cx.simulate_keystrokes("delete");
    assert_eq!(text(&mut o), "x", "and one delete takes the flag whole");
}

#[gpui::test]
fn the_clipboard_cuts_copies_and_pastes_on_one_line(cx: &mut TestAppContext) {
    let mut o = open(cx, None);
    o.cx.simulate_input("Naruto Shippuden");
    o.cx.simulate_keystrokes("ctrl-a ctrl-x");
    assert_eq!(text(&mut o), "");
    assert_eq!(
        o.cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
        Some("Naruto Shippuden")
    );
    o.cx.write_to_clipboard(ClipboardItem::new_string("Eine\nZeile\r\nnur".into()));
    o.cx.simulate_keystrokes("ctrl-v");
    assert_eq!(text(&mut o), "Eine Zeile  nur");
    o.cx.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        o.cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
        Some("Eine Zeile  nur")
    );
}

#[gpui::test]
fn words_are_stepped_over_and_the_length_can_be_limited(cx: &mut TestAppContext) {
    let mut o = open(cx, Some(10));
    o.cx.simulate_input("Attack on Titan");
    assert_eq!(text(&mut o), "Attack on ", "cut at the limit, not refused");
    o.cx.simulate_keystrokes("home ctrl-right");
    o.cx.simulate_input("X");
    assert_eq!(text(&mut o), "Attack on ", "at the limit nothing more fits");
    o.cx.simulate_keystrokes("backspace");
    o.cx.simulate_input("X");
    assert_eq!(text(&mut o), "AttacX on ");
}

#[gpui::test]
fn enter_and_escape_are_told_to_the_view_around(cx: &mut TestAppContext) {
    let mut o = open(cx, None);
    o.cx.simulate_input("abc");
    o.cx.simulate_keystrokes("enter escape");
    let events = o.events.borrow();
    assert!(
        events.contains(&FieldEvent::Submitted) && events.contains(&FieldEvent::Cancelled),
        "{events:?}"
    );
}

#[gpui::test]
fn a_screen_reader_hears_the_name_and_the_value(cx: &mut TestAppContext) {
    let mut o = open(cx, None);
    o.cx.simulate_input("Frieren");
    // A new frame carries the new value.
    let focus = o
        .field
        .read_with(o.cx, |f, cx| gpui::Focusable::focus_handle(f, cx));
    o.cx.update(|window, _| window.focus(&focus));
    o.cx.update(|window, cx| window.refresh());
    let snaps = o.seen.borrow();
    let snap = snaps.last().expect("a frame");
    let node = snap
        .find(Role::TextInput, "Serie suchen")
        .expect("the field is named by its label, not its placeholder");
    assert_eq!(
        node.value.as_ref().map(|v| AsRef::<str>::as_ref(v)),
        Some("Frieren")
    );
}
