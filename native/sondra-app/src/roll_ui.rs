//! A pad's piano roll on the Zerschneiden page (`PianoRoll.tsx`): two octaves either side of the pad's own pitch, one
//! column a step. A press on empty ground sets a note, a drag lengthens it; a press on a note takes hold of it — its
//! right edge changes the length, the rest moves it — and a click without a drag takes it away. The rules are
//! `sondra_media::roll`; here is only the pointer, the drawing and what the buttons do.
//!
//! A pad with a roll plays its notes and not its steps (a channel is either stepped or rolled); „Zurück zu Schritten“
//! makes every note's start a step again. A time surface, so square-cornered, like the waveform.
//!
//! Not here yet: the big view and the arpeggio and bass generator of the web app.

use std::cell::Cell;
use std::rc::Rc;

use gpui::{canvas, div, point, prelude::*, px, AnyElement, Bounds, Context, MouseButton, Pixels, Point, ScrollHandle};
use sondra_a11y::{accessible, Role};
use sondra_media::pattern::{cells_to_notes, RollNote};
use sondra_media::roll::{self, cell_at, is_black, note_name, Gesture, Scale, Stamp, BOTTOM, ROWS, TOP};
use sondra_ui::Ui;

use crate::shell::Shell;

const ROW: f32 = 22.0;
const KEYS_WIDTH: f32 = 52.0;
const VIEW_HEIGHT: f32 = 440.0;
const LANE_HEIGHT: f32 = 40.0;

/// What is open of a pad's roll: which pad, the scale the keys snap to, the chord a press sets, the length the next note
/// starts with, and what the pointer holds.
pub struct RollView {
    pub id: String,
    pub scale: Scale,
    pub stamp: Stamp,
    pub last_length: usize,
    gesture: Option<Gesture>,
    pub bounds: Rc<Cell<Bounds<Pixels>>>,
    pub lane: Rc<Cell<Bounds<Pixels>>>,
    lane_down: bool,
    scroll: ScrollHandle,
}

impl RollView {
    fn new(id: String, scale: Scale, stamp: Stamp) -> RollView {
        let scroll = ScrollHandle::new();
        // Open at the pad's own pitch, not at the top of two octaves.
        scroll.set_offset(point(px(0.), px(-(TOP as f32 * ROW - VIEW_HEIGHT / 2.0 + ROW / 2.0).max(0.0))));
        RollView { id, scale, stamp, last_length: 2, gesture: None, bounds: Rc::new(Cell::new(Bounds::default())), lane: Rc::new(Cell::new(Bounds::default())), lane_down: false, scroll }
    }
}

impl Shell {
    fn roll_notes(&mut self) -> Option<&mut Vec<RollNote>> {
        let id = self.sampler.roll.as_ref()?.id.clone();
        self.sampler.pattern.notes.get_mut(&id)
    }

    fn roll_pad(&self) -> Option<usize> {
        let id = &self.sampler.roll.as_ref()?.id;
        self.sampler.pads.iter().position(|p| &p.id == id)
    }

    /// Opens a pad's roll; a pad that only had steps starts with a note at its own pitch for each step.
    pub fn sampler_roll_open(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(pad) = self.sampler.pads.get(index) else { return };
        let id = pad.id.clone();
        if !self.sampler.pattern.has_roll(&id) {
            let notes = cells_to_notes(self.sampler.pattern.cells.get(&id).map(Vec::as_slice));
            self.sampler.pattern.notes.insert(id.clone(), notes);
        }
        let (scale, stamp) = self.sampler.roll.as_ref().map_or((Scale::Chromatic, Stamp::Single), |r| (r.scale, r.stamp));
        self.sampler.roll = Some(RollView::new(id, scale, stamp));
        self.sampler.selected = index;
        cx.notify();
    }

    /// Back to steps: every note's start becomes a step at the pad's pitch.
    pub fn sampler_roll_close(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.sampler.roll.take() else { return };
        let steps = self.sampler.pattern.steps;
        if let Some(notes) = self.sampler.pattern.notes.remove(&view.id) {
            self.sampler.pattern.cells.insert(view.id, roll::notes_to_cells(&notes, steps));
        }
        cx.notify();
    }

    pub fn sampler_roll_clear(&mut self, cx: &mut Context<Self>) {
        if let Some(notes) = self.roll_notes() {
            notes.clear();
        }
        cx.notify();
    }

    pub fn sampler_roll_octave(&mut self, delta: i32, cx: &mut Context<Self>) {
        if let Some(notes) = self.roll_notes() {
            *notes = roll::shift_octave(notes, delta);
        }
        cx.notify();
    }

    /// The „Spice“ buttons: a chord progression or an arpeggio is drawn in place of what stands there (the
    /// Zurück-Knopf of the page takes the old steps back as long as the roll is open).
    pub fn sampler_roll_spice(&mut self, kind: roll::Spice, cx: &mut Context<Self>) {
        let steps = self.sampler.pattern.steps;
        let made = roll::generate(kind, steps);
        let first = made.first().map(|n| n.semitone).unwrap_or(0.0);
        if let Some(notes) = self.roll_notes() {
            *notes = made;
        }
        let index = self.sampler.selected;
        self.sampler_audition(index, first, cx);
        cx.notify();
    }

    pub fn sampler_roll_scale(&mut self, scale: Scale, cx: &mut Context<Self>) {
        if let Some(view) = self.sampler.roll.as_mut() {
            view.scale = scale;
        }
        cx.notify();
    }

    pub fn sampler_roll_stamp(&mut self, stamp: Stamp, cx: &mut Context<Self>) {
        if let Some(view) = self.sampler.roll.as_mut() {
            view.stamp = stamp;
        }
        cx.notify();
    }

    /// The pad heard at a key of the roll.
    pub fn sampler_roll_hear(&mut self, semitone: i32, cx: &mut Context<Self>) {
        if let Some(index) = self.roll_pad() {
            self.sampler_audition(index, f64::from(semitone), cx);
        }
    }

    fn roll_position(&self, at: Point<Pixels>) -> Option<(f32, f32, f32)> {
        let view = self.sampler.roll.as_ref()?;
        let b = view.bounds.get();
        let width: f32 = b.size.width.into();
        (width > 0.0).then(|| (f32::from(at.x - b.origin.x), f32::from(at.y - b.origin.y), width))
    }

    pub fn sampler_roll_down(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        // A press while one is held is the same press heard twice (the test window delivers some events twice), or one
        // whose release was lost: the first stands until the pointer is up.
        if self.sampler.roll.as_ref().is_none_or(|v| v.gesture.is_some()) {
            return;
        }
        let Some((x, y, width)) = self.roll_position(at) else { return };
        let steps = self.sampler.pattern.steps;
        let Some(view) = self.sampler.roll.as_ref() else { return };
        let (scale, stamp, last) = (view.scale, view.stamp, view.last_length);
        let cell = cell_at(x, y, width, ROW, steps, scale);
        let Some(notes) = self.roll_notes() else { return };
        let (gesture, outcome) = roll::press(notes, cell, width, steps, scale, stamp, last);
        if let Some(view) = self.sampler.roll.as_mut() {
            view.gesture = gesture;
        }
        if let Some(semitone) = outcome.audition {
            self.sampler_roll_hear(semitone, cx);
        }
        cx.notify();
    }

    pub fn sampler_roll_drag(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let Some((x, y, width)) = self.roll_position(at) else { return };
        let steps = self.sampler.pattern.steps;
        let Some(view) = self.sampler.roll.as_mut() else { return };
        let (Some(mut gesture), scale) = (view.gesture, view.scale) else { return };
        let cell = cell_at(x, y, width, ROW, steps, scale);
        let id = view.id.clone();
        let outcome = match self.sampler.pattern.notes.get_mut(&id) {
            Some(notes) => roll::drag(notes, &mut gesture, cell, steps, scale),
            None => return,
        };
        if let Some(view) = self.sampler.roll.as_mut() {
            view.gesture = Some(gesture);
        }
        if let Some(semitone) = outcome.audition {
            self.sampler_roll_hear(semitone, cx);
        }
        cx.notify();
    }

    pub fn sampler_roll_up(&mut self, cx: &mut Context<Self>) {
        let Some(view) = self.sampler.roll.as_mut() else { return };
        let (gesture, id) = (view.gesture.take(), view.id.clone());
        view.lane_down = false;
        let Some(gesture) = gesture else { return };
        let remember = self.sampler.pattern.notes.get_mut(&id).and_then(|notes| roll::release(notes, gesture));
        if let (Some(length), Some(view)) = (remember, self.sampler.roll.as_mut()) {
            view.last_length = length;
        }
        cx.notify();
    }

    /// The dynamics lane: the note that sounds in the step under the pointer gets the height as its velocity.
    fn roll_lane_set(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        let steps = self.sampler.pattern.steps;
        let Some(view) = self.sampler.roll.as_ref() else { return };
        let b = view.lane.get();
        let (width, height): (f32, f32) = (b.size.width.into(), b.size.height.into());
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        let step = (((f32::from(at.x - b.origin.x) / width) * steps as f32).floor().clamp(0.0, steps as f32 - 1.0)) as usize;
        let velocity = f64::from(1.0 - f32::from(at.y - b.origin.y) / height);
        if let Some(notes) = self.roll_notes() {
            if roll::set_velocity(notes, step, velocity) {
                cx.notify();
            }
        }
    }

    pub fn sampler_roll_lane_down(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        if let Some(view) = self.sampler.roll.as_mut() {
            view.lane_down = true;
        }
        self.roll_lane_set(at, cx);
    }

    pub fn sampler_roll_lane_drag(&mut self, at: Point<Pixels>, cx: &mut Context<Self>) {
        if self.sampler.roll.as_ref().is_some_and(|v| v.lane_down) {
            self.roll_lane_set(at, cx);
        }
    }

    /// For tests: the notes of the pad whose roll is open.
    pub fn sampler_roll_notes(&self) -> Vec<RollNote> {
        self.sampler.roll.as_ref().and_then(|v| self.sampler.pattern.notes.get(&v.id)).cloned().unwrap_or_default()
    }

    /// For tests: where the grid and the dynamics lane lie.
    pub fn sampler_roll_bounds(&self) -> Option<(Bounds<Pixels>, Bounds<Pixels>)> {
        self.sampler.roll.as_ref().map(|v| (v.bounds.get(), v.lane.get()))
    }

    /// The roll under the beat grid, when a pad's is open.
    pub(crate) fn roll_editor(&self, ui: Ui, cx: &mut Context<Self>) -> Option<AnyElement> {
        let view = self.sampler.roll.as_ref()?;
        let pad = self.sampler.pads.iter().position(|p| p.id == view.id)?;
        let notes = self.sampler.pattern.notes.get(&view.id)?;
        let steps = self.sampler.pattern.steps;
        let me = cx.entity();
        let c = ui.c;
        let allowed = view.scale;

        let mut head = div().flex().flex_col().gap(px(10.)).child(ui.subheading(format!("Klavierrolle · Pad {}", pad + 1)));
        head = head.child(ui.hint("Klicken setzt einen Ton, Ziehen macht ihn länger. Ein Ton lässt sich greifen und verschieben, am rechten Rand ziehen ändert die Länge, ein Klick darauf nimmt ihn weg. Das C in der Mitte ist die Tonhöhe des Pads."));
        let mut scales = div().flex().flex_wrap().gap(px(6.));
        for scale in Scale::ALL {
            let me = me.clone();
            scales = scales.child(ui.chip(format!("rolle-skala-{}", scale.label()), scale.label(), view.scale == scale).accessible_name(format!("Tonleiter {}", scale.label())).on_click(move |_, app| me.update(app, |sh, cx| sh.sampler_roll_scale(scale, cx))));
        }
        let mut stamps = div().flex().flex_wrap().gap(px(6.));
        for stamp in Stamp::ALL {
            let me = me.clone();
            stamps = stamps.child(ui.chip(format!("rolle-stempel-{}", stamp.label()), stamp.label(), view.stamp == stamp).accessible_name(format!("Beim Klicken setzen: {}", stamp.label())).on_click(move |_, app| me.update(app, |sh, cx| sh.sampler_roll_stamp(stamp, cx))));
        }
        head = head.child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Tonleiter")).child(scales)).child(div().flex().flex_col().gap(px(6.)).child(ui.hint("Setzt")).child(stamps));
        let (up, down, clear, back) = (me.clone(), me.clone(), me.clone(), me.clone());
        head = head.child(
            div()
                .flex()
                .flex_wrap()
                .gap(px(8.))
                .child(ui.button("rolle-oktave-hoch", "Eine Oktave höher").small().on_click(move |_, app| up.update(app, |sh, cx| sh.sampler_roll_octave(12, cx))))
                .child(ui.button("rolle-oktave-tief", "Eine Oktave tiefer").small().on_click(move |_, app| down.update(app, |sh, cx| sh.sampler_roll_octave(-12, cx))))
                .child(ui.button("rolle-akkorde", "Akkorde zeichnen").small().on_click({
                    let me = me.clone();
                    move |_, app| me.update(app, |sh, cx| sh.sampler_roll_spice(roll::Spice::Chords, cx))
                }))
                .child(ui.button("rolle-arpeggio", "Arpeggio zeichnen").small().on_click({
                    let me = me.clone();
                    move |_, app| me.update(app, |sh, cx| sh.sampler_roll_spice(roll::Spice::Arpeggio, cx))
                }))
                .child(ui.button("rolle-leeren", "Alle Noten löschen").small().on_click(move |_, app| clear.update(app, |sh, cx| sh.sampler_roll_clear(cx))))
                .child(ui.button("rolle-zurueck", "Zurück zu Schritten").small().accessible_name("Noten zurück in Schritte wandeln").on_click(move |_, app| back.update(app, |sh, cx| sh.sampler_roll_close(cx)))),
        );

        // The keys: a press on one lets the pad be heard at that pitch.
        let mut keys = div().flex().flex_col().w(px(KEYS_WIDTH)).flex_shrink_0().border_r_1().border_color(c.line);
        for row in 0..ROWS {
            let semitone = TOP - row as i32;
            let black = is_black(semitone);
            let me = me.clone();
            let name = note_name(semitone);
            keys = keys.child(
                accessible(
                    ("rolle-taste", (semitone + 100) as u32),
                    Role::Button,
                    div()
                        .id(("rolle-taste-flaeche", (semitone + 100) as u32))
                        .h(px(ROW))
                        .flex()
                        .items_center()
                        .justify_end()
                        .pr(px(6.))
                        .border_b_1()
                        .border_color(c.line)
                        .text_size(px(sondra_ui::size::MICRO))
                        .text_color(if semitone == 0 { c.ink } else { c.prose })
                        .bg(if black { c.panel_strong } else if allowed.allows(semitone) { c.raised } else { c.panel_soft })
                        .when(semitone == 0, |d| d.font_weight(gpui::FontWeight::BOLD))
                        .cursor_pointer()
                        .on_click(move |_, _, app| me.update(app, |sh, cx| sh.sampler_roll_hear(semitone, cx)))
                        .child(name.clone()),
                )
                .label(format!("{name} anspielen")),
            );
        }

        // The grid: rows, step lines, notes. The pointer is read against `bounds`, measured by the canvas inside it.
        let measure = view.bounds.clone();
        let mut grid = div().relative().flex_1().h(px(ROWS as f32 * ROW)).bg(c.raised).cursor_crosshair();
        grid = grid.child(canvas(move |b, _, _| measure.set(b), |_, _, _, _| {}).absolute().size_full());
        for row in 0..ROWS {
            let semitone = TOP - row as i32;
            let shade = if semitone == 0 {
                Some(c.panel_mid)
            } else if !allowed.allows(semitone) {
                Some(c.panel_soft)
            } else if is_black(semitone) {
                Some(c.panel_soft)
            } else {
                None
            };
            let mut band = div().absolute().left_0().right_0().top(px(row as f32 * ROW)).h(px(ROW)).border_b_1().border_color(c.line);
            if let Some(color) = shade {
                band = band.bg(color);
            }
            grid = grid.child(band);
        }
        for step in 0..=steps {
            grid = grid.child(div().absolute().top_0().bottom_0().left(gpui::relative(step as f32 / steps as f32)).w(px(1.)).bg(if step % 4 == 0 { c.rule } else { c.line }));
        }
        for (i, note) in notes.iter().enumerate() {
            let semitone = note.semitone.round() as i32;
            if !(BOTTOM..=TOP).contains(&semitone) {
                continue;
            }
            let vel = note.velocity.unwrap_or(0.9);
            let body = div()
                .absolute()
                .left(gpui::relative(note.step as f32 / steps as f32))
                .w(gpui::relative(note.length as f32 / steps as f32))
                .top(px((TOP - semitone) as f32 * ROW + 1.0))
                .h(px(ROW - 2.0))
                .bg(c.ink)
                .border_1()
                .border_color(c.canvas)
                .opacity((0.45 + vel * 0.55) as f32)
                .child(div().absolute().right(px(2.)).top(px(3.)).bottom(px(3.)).w(px(2.)).bg(c.on_ink));
            grid = grid.child(accessible(("rolle-note", i as u32), Role::ListItem, body).label(format!("{}, Schritt {}, {} lang", note_name(semitone), note.step + 1, note.length)));
        }
        let (press, drag, release, out) = (me.clone(), me.clone(), me.clone(), me.clone());
        let grid = div()
            .id("klavierrolle-flaeche")
            .flex_1()
            .on_mouse_down(MouseButton::Left, move |event, _, app| {
                let at = event.position;
                press.update(app, |sh, cx| sh.sampler_roll_down(at, cx))
            })
            .on_mouse_move(move |event, _, app| {
                if event.pressed_button == Some(MouseButton::Left) {
                    let at = event.position;
                    drag.update(app, |sh, cx| sh.sampler_roll_drag(at, cx))
                }
            })
            .on_mouse_up(MouseButton::Left, move |_, _, app| release.update(app, |sh, cx| sh.sampler_roll_up(cx)))
            .on_mouse_up_out(MouseButton::Left, move |_, _, app| out.update(app, |sh, cx| sh.sampler_roll_up(cx)))
            .child(grid);
        let grid = accessible("klavierrolle", Role::Group, grid).label("Klavierrolle").value(format!("{} Noten", notes.len()));

        let scroll = div().id("klavierrolle-box").h(px(VIEW_HEIGHT)).overflow_y_scroll().track_scroll(&view.scroll).border_1().border_color(c.line).child(div().flex().child(keys).child(grid));

        // Dynamics: how hard each note is struck, one bar a note.
        let lane_measure = view.lane.clone();
        let mut lane = div().relative().flex_1().h(px(LANE_HEIGHT)).cursor_ns_resize();
        lane = lane.child(canvas(move |b, _, _| lane_measure.set(b), |_, _, _, _| {}).absolute().size_full());
        for step in 0..=steps {
            lane = lane.child(div().absolute().top_0().bottom_0().left(gpui::relative(step as f32 / steps as f32)).w(px(1.)).bg(if step % 4 == 0 { c.rule } else { c.line }));
        }
        for note in notes.iter() {
            let vel = note.velocity.unwrap_or(0.9) as f32;
            lane = lane.child(div().absolute().bottom_0().left(gpui::relative((note.step as f32 + 0.18) / steps as f32)).w(gpui::relative(0.64 / steps as f32)).h(px(LANE_HEIGHT * vel * 0.86)).bg(c.ink).opacity(0.75));
        }
        let (down, moved, up, out) = (me.clone(), me.clone(), me.clone(), me.clone());
        let lane = div()
            .id("klavierrolle-dynamik")
            .flex_1()
            .on_mouse_down(MouseButton::Left, move |event, _, app| {
                let at = event.position;
                down.update(app, |sh, cx| sh.sampler_roll_lane_down(at, cx))
            })
            .on_mouse_move(move |event, _, app| {
                if event.pressed_button == Some(MouseButton::Left) {
                    let at = event.position;
                    moved.update(app, |sh, cx| sh.sampler_roll_lane_drag(at, cx))
                }
            })
            .on_mouse_up(MouseButton::Left, move |_, _, app| up.update(app, |sh, cx| sh.sampler_roll_up(cx)))
            .on_mouse_up_out(MouseButton::Left, move |_, _, app| out.update(app, |sh, cx| sh.sampler_roll_up(cx)))
            .child(lane);
        let lane = accessible("klavierrolle-dynamik", Role::Group, lane).label("Anschlagsstärke je Schritt");
        let lane_row = div().flex().border_1().border_color(c.line).bg(c.panel_soft).child(div().w(px(KEYS_WIDTH)).flex_shrink_0().flex().items_center().justify_end().pr(px(6.)).child(ui.hint("Dyn"))).child(lane);

        Some(div().flex().flex_col().gap(px(12.)).child(head).child(scroll).child(lane_row).into_any_element())
    }
}
