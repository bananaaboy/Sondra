//! Every component of the kit, drawn in GPUI's test window: what a screen reader would find.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use accesskit::{Action, ActionRequest, TreeId};
use gpui::{
    point, prelude::*, px, size, AvailableSpace, Context, Render, TestAppContext,
    VisualTestContext, Window,
};
use sondra_a11y::{a11y_root, attach_sink, Role, Snapshot};
use sondra_ui::{fonts, Mode, NoticeKind, Ui};

type Seen = Rc<RefCell<Vec<Rc<Snapshot>>>>;

/// The content of the test window: components keep their focus in the window's state, so they have to
/// be drawn inside a view, as in the app.
struct Probe {
    ui: Ui,
    pressed: Rc<Cell<u32>>,
    ignored: Rc<Cell<u32>>,
}

impl Render for Probe {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let ui = self.ui;
        let (p, d) = (self.pressed.clone(), self.ignored.clone());
        a11y_root(
            ui.sheet()
                .size_full()
                .flex()
                .flex_col()
                .child(ui.wordmark())
                .child(ui.heading("Werkzeuge"))
                .child(ui.prose("Wählen Sie eine Datei aus."))
                .child(
                    ui.button("datei", "Datei auswählen")
                        .primary()
                        .on_click(move |_, _| p.set(p.get() + 1)),
                )
                .child(
                    ui.button("aus", "Nicht möglich")
                        .disabled(true)
                        .on_click(move |_, _| d.set(d.get() + 1)),
                )
                .child(ui.chip("kind-ton", "Ton", true))
                .child(ui.chip("kind-video", "Video", false))
                .child(ui.tab("reiter-start", "Start", true))
                .child(ui.tab("reiter-ordner", "Ordner", false))
                .child(
                    ui.tile(
                        "umwandeln",
                        "Umwandeln",
                        "Dateien in ein anderes Format bringen.",
                    )
                    .symbol("U"),
                )
                .child(ui.notice(NoticeKind::Info, "Die Merkliste ist abgeglichen."))
                .child(ui.notice(NoticeKind::Warning, "Der Ordner ist nicht erreichbar."))
                .child(ui.value("Folge 12 · S01E12.mkv")),
        )
    }
}

fn open(
    cx: &mut TestAppContext,
    mode: Mode,
) -> (&mut VisualTestContext, Seen, Rc<Cell<u32>>, Rc<Cell<u32>>) {
    let (pressed, ignored) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
    let (p, i) = (pressed.clone(), ignored.clone());
    let (view, cx) = cx.add_window_view(move |_, _| Probe {
        ui: Ui::new(mode.colors()),
        pressed: p,
        ignored: i,
    });
    cx.update(|_, cx| fonts::load(cx));
    let seen: Seen = Rc::default();
    let sink = seen.clone();
    cx.update(|window, cx| {
        attach_sink(window, cx, move |snap| {
            sink.borrow_mut().push(Rc::new(snap.clone()))
        })
    });
    cx.draw(
        point(px(0.), px(0.)),
        size(
            AvailableSpace::Definite(px(900.)),
            AvailableSpace::Definite(px(700.)),
        ),
        move |_, _| view,
    );
    (cx, seen, pressed, ignored)
}

#[gpui::test]
fn every_component_has_a_role_and_a_name(cx: &mut TestAppContext) {
    let (_cx, seen, _, _) = open(cx, Mode::Light);
    let snaps = seen.borrow();
    let snap = snaps.last().expect("a frame");

    assert!(
        snap.find(Role::Label, "Sondra").is_some(),
        "the wordmark is read as Sondra"
    );
    assert!(snap.find(Role::Heading, "Werkzeuge").is_some());
    assert!(snap
        .find(Role::Label, "Wählen Sie eine Datei aus.")
        .is_some());
    let primary = snap
        .find(Role::Button, "Datei auswählen")
        .expect("a button");
    assert!(primary.default_action.is_some(), "it can be activated");
    let disabled = snap
        .find(Role::Button, "Nicht möglich")
        .expect("a disabled button is still there");
    assert!(
        disabled.disabled && disabled.default_action.is_none(),
        "but it does nothing, and says so"
    );

    let on = snap.find(Role::Button, "Ton").expect("a chip");
    assert_eq!(on.toggled, Some(true));
    assert_eq!(
        snap.find(Role::Button, "Video").unwrap().toggled,
        Some(false)
    );
    assert_eq!(
        snap.find(Role::Button, "Start").unwrap().selected,
        Some(true),
        "the chosen tab says so"
    );
    assert_eq!(
        snap.find(Role::Button, "Ordner").unwrap().selected,
        Some(false)
    );

    let tile = snap
        .find(Role::Button, "Umwandeln")
        .expect("a tile is a button named by its title");
    assert_eq!(
        tile.description.as_ref().map(|d| AsRef::<str>::as_ref(d)),
        Some("Dateien in ein anderes Format bringen.")
    );

    let info = snap
        .find(Role::Status, "Die Merkliste ist abgeglichen.")
        .expect("a notice is a status");
    assert!(info.live);
    assert!(
        snap.find(Role::Alert, "Der Ordner ist nicht erreichbar.")
            .is_some(),
        "a warning is an alert"
    );
    assert!(snap.find(Role::Label, "Folge 12 · S01E12.mkv").is_some());
}

#[gpui::test]
fn activating_a_button_runs_it_and_a_disabled_one_cannot_be_run(cx: &mut TestAppContext) {
    let (cx, seen, pressed, ignored) = open(cx, Mode::Dark);
    let (primary, disabled) = {
        let snaps = seen.borrow();
        let snap = snaps.last().unwrap();
        (
            snap.find(Role::Button, "Datei auswählen").unwrap().id,
            snap.find(Role::Button, "Nicht möglich").unwrap().id,
        )
    };
    for target in [primary, disabled] {
        cx.update(|window, cx| {
            sondra_a11y::run_action(
                ActionRequest {
                    action: Action::Click,
                    target_tree: TreeId::ROOT,
                    target_node: target,
                    data: None,
                },
                window,
                cx,
            )
        });
    }
    assert_eq!(pressed.get(), 1);
    assert_eq!(ignored.get(), 0);
}

#[test]
fn the_palettes_are_the_web_apps_and_dark_is_not_an_inversion() {
    use sondra_ui::{DARK, LIGHT};
    let hex = |c: gpui::Rgba| {
        format!(
            "{:02x}{:02x}{:02x}",
            (c.r * 255.0).round() as u8,
            (c.g * 255.0).round() as u8,
            (c.b * 255.0).round() as u8
        )
    };
    assert_eq!(hex(LIGHT.canvas), "f8faf8");
    assert_eq!(hex(LIGHT.ink), "0b4a22");
    assert_eq!(hex(DARK.canvas), "0a110d");
    assert_eq!(hex(DARK.ink), "a6ecb9");
    // The stage is the same neutral dark in both: it takes no part in a change of theme.
    assert_eq!(hex(LIGHT.stage_ink), hex(DARK.stage_ink));
    assert_eq!(hex(LIGHT.stage_accent), hex(DARK.stage_accent));
    // Ink and its ground swap roles: dark ink is lighter than dark canvas, light ink darker than light canvas.
    let luma = |c: gpui::Rgba| 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    assert!(luma(DARK.ink) > luma(DARK.canvas) && luma(LIGHT.ink) < luma(LIGHT.canvas));
}
