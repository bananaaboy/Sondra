//! A single-line text field: typing, selecting, clipboard, input methods (so accented letters and
//! East-Asian text work), a cursor that scrolls into view. GPUI draws every pixel itself and has no
//! text field of its own; this one follows the platform's text-input protocol (`EntityInputHandler`)
//! and tells a screen reader its name, its value and when it has the focus.
//!
//! Look (`DESIGN.md`): field white, a rule-coloured ring that turns ink on focus, the value in the face
//! of entered things (Courier Prime), small text, 8 × 12 px of padding, rounded like a control.

use std::ops::Range;

use gpui::{
    actions, div, fill, point, prelude::*, px, relative, size, App, Bounds, ClipboardItem, Context,
    CursorStyle, ElementId, ElementInputHandler, Entity, EntityInputHandler, EventEmitter,
    FocusHandle, Focusable, GlobalElementId, InspectorElementId, KeyBinding, LayoutId, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, ShapedLine,
    SharedString, Style, TextRun, UTF16Selection, UnderlineStyle, Window,
};
use sondra_a11y::{accessible, Role};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::{family, radius, size as text_size, Colors};

actions!(
    sondra_text_field,
    [
        Backspace,
        Delete,
        Left,
        Right,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectWordLeft,
        SelectWordRight,
        SelectHome,
        SelectEnd,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        DeleteWordBack,
        Submit,
        Cancel,
    ]
);

/// The key bindings of every field. Call once at start.
pub fn bind_keys(cx: &mut App) {
    const CONTEXT: Option<&str> = Some("SondraTextField");
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, CONTEXT),
        KeyBinding::new("delete", Delete, CONTEXT),
        KeyBinding::new("left", Left, CONTEXT),
        KeyBinding::new("right", Right, CONTEXT),
        KeyBinding::new("ctrl-left", WordLeft, CONTEXT),
        KeyBinding::new("ctrl-right", WordRight, CONTEXT),
        KeyBinding::new("shift-left", SelectLeft, CONTEXT),
        KeyBinding::new("shift-right", SelectRight, CONTEXT),
        KeyBinding::new("ctrl-shift-left", SelectWordLeft, CONTEXT),
        KeyBinding::new("ctrl-shift-right", SelectWordRight, CONTEXT),
        KeyBinding::new("shift-home", SelectHome, CONTEXT),
        KeyBinding::new("shift-end", SelectEnd, CONTEXT),
        KeyBinding::new("ctrl-a", SelectAll, CONTEXT),
        KeyBinding::new("home", Home, CONTEXT),
        KeyBinding::new("end", End, CONTEXT),
        KeyBinding::new("ctrl-v", Paste, CONTEXT),
        KeyBinding::new("shift-insert", Paste, CONTEXT),
        KeyBinding::new("ctrl-c", Copy, CONTEXT),
        KeyBinding::new("ctrl-insert", Copy, CONTEXT),
        KeyBinding::new("ctrl-x", Cut, CONTEXT),
        KeyBinding::new("shift-delete", Cut, CONTEXT),
        KeyBinding::new("ctrl-backspace", DeleteWordBack, CONTEXT),
        KeyBinding::new("enter", Submit, CONTEXT),
        KeyBinding::new("escape", Cancel, CONTEXT),
        // The Mac's own spelling of the same, for development there.
        KeyBinding::new("cmd-a", SelectAll, CONTEXT),
        KeyBinding::new("cmd-v", Paste, CONTEXT),
        KeyBinding::new("cmd-c", Copy, CONTEXT),
        KeyBinding::new("cmd-x", Cut, CONTEXT),
    ]);
}

/// What a field tells the view around it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FieldEvent {
    /// The text changed.
    Changed,
    /// Enter was pressed.
    Submitted,
    /// Escape was pressed.
    Cancelled,
}

pub struct TextField {
    focus_handle: FocusHandle,
    colors: Colors,
    /// The name a screen reader says; the placeholder is only a hint on the sheet.
    label: SharedString,
    placeholder: SharedString,
    content: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    /// What an input method is composing: shown underlined until it is committed.
    marked_range: Option<Range<usize>>,
    last_layout: Option<ShapedLine>,
    last_bounds: Option<Bounds<Pixels>>,
    /// How far the text is scrolled left, so that the cursor stays in view.
    scroll_x: Pixels,
    is_selecting: bool,
    max_chars: Option<usize>,
}

impl EventEmitter<FieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl TextField {
    pub fn new(cx: &mut Context<Self>, colors: Colors, label: impl Into<SharedString>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            colors,
            label: label.into(),
            placeholder: SharedString::default(),
            content: SharedString::default(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_bounds: None,
            scroll_x: px(0.),
            is_selecting: false,
            max_chars: None,
        }
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    pub fn max_chars(mut self, max: usize) -> Self {
        self.max_chars = Some(max);
        self
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    /// Replaces the text (the cursor goes to its end).
    pub fn set_text(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.content = text.into();
        let end = self.content.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    pub fn set_colors(&mut self, colors: Colors, cx: &mut Context<Self>) {
        self.colors = colors;
        cx.notify();
    }

    /* Moving and selecting ---------------------------------------------------------------- */

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify();
    }

    /// The start of the letter before `offset`, counted in what a person sees as one character.
    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < offset).then_some(i))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(i, _)| (i > offset).then_some(i))
            .unwrap_or(self.content.len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .rev()
            .find_map(|(i, w)| (i < offset && w.chars().any(char::is_alphanumeric)).then_some(i))
            .unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .find_map(|(i, w)| {
                (i + w.len() > offset && w.chars().any(char::is_alphanumeric))
                    .then_some(i + w.len())
            })
            .unwrap_or(self.content.len())
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx);
        }
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.previous_word(self.cursor_offset()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.next_word(self.cursor_offset()), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_word(self.cursor_offset()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_word(self.cursor_offset()), cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.content.len(), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.selected_range = 0..self.content.len();
        self.selection_reversed = false;
        cx.notify();
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.content.len(), cx);
    }

    /* Editing ------------------------------------------------------------------------------ */

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor_offset()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor_offset()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete_word_back(
        &mut self,
        _: &DeleteWordBack,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected_range.is_empty() {
            self.select_to(self.previous_word(self.cursor_offset()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            // One line: a pasted line break is a space.
            self.replace_text_in_range(None, &text.replace(['\r', '\n'], " "), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Submitted);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Cancelled);
    }

    /* The mouse ---------------------------------------------------------------------------- */

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }
        let (Some(bounds), Some(line)) = (self.last_bounds.as_ref(), self.last_layout.as_ref())
        else {
            return 0;
        };
        line.closest_index_for_x(position.x - bounds.left() + self.scroll_x)
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle);
        self.is_selecting = true;
        let index = self.index_for_mouse_position(event.position);
        if event.click_count >= 2 {
            // A double click takes the word under the pointer; a triple click the line.
            if event.click_count >= 3 {
                self.selected_range = 0..self.content.len();
            } else {
                let start = self.previous_word(index + 1).min(index);
                let end = self.next_word(index.saturating_sub(1)).max(index);
                self.selected_range = start..end;
            }
            self.selection_reversed = false;
            cx.notify();
        } else if event.modifiers.shift {
            self.select_to(index, cx);
        } else {
            self.move_to(index, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    /* UTF-16 offsets, which is what input methods speak --------------------------------------- */

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let (mut utf8, mut utf16) = (0, 0);
        for ch in self.content.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let (mut utf16, mut utf8) = (0, 0);
        for ch in self.content.chars() {
            if utf8 >= offset {
                break;
            }
            utf8 += ch.len_utf8();
            utf16 += ch.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }

    /// Text that fits `max_chars`: what comes in beyond it is cut off.
    fn clipped<'a>(&self, replacing: &Range<usize>, incoming: &'a str) -> &'a str {
        let Some(max) = self.max_chars else {
            return incoming;
        };
        let kept = self.content[..replacing.start].chars().count()
            + self.content[replacing.end..].chars().count();
        let room = max.saturating_sub(kept);
        match incoming.char_indices().nth(room) {
            Some((end, _)) => &incoming[..end],
            None => incoming,
        }
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let new_text = self.clipped(&range, new_text).to_owned();
        self.content =
            (self.content[..range.start].to_owned() + &new_text + &self.content[range.end..])
                .into();
        let end = range.start + new_text.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        let new_text = self.clipped(&range, new_text).to_owned();
        self.content =
            (self.content[..range.start].to_owned() + &new_text + &self.content[range.end..])
                .into();
        self.marked_range =
            (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .map(|r| r.start + range.start..r.end + range.start)
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let line = self.last_layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(range.start) - self.scroll_x,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(range.end) - self.scroll_x,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let local = self.last_bounds?.localize(&point)?;
        let line = self.last_layout.as_ref()?;
        let utf8 = line.index_for_x(point.x - local.x + self.scroll_x)?;
        Some(self.offset_to_utf16(utf8))
    }
}

/* Drawing ---------------------------------------------------------------------------------- */

struct TextElement {
    field: Entity<TextField>,
}

struct Prepaint {
    line: ShapedLine,
    cursor: Option<PaintQuad>,
    selection: Option<PaintQuad>,
    scroll_x: Pixels,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let field = self.field.read(cx);
        let colors = field.colors;
        let style = window.text_style();
        let (display, color) = if field.content.is_empty() {
            (field.placeholder.clone(), colors.faint)
        } else {
            (field.content.clone(), colors.prose)
        };

        let run = TextRun {
            len: display.len(),
            font: style.font(),
            color: color.into(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = match field.marked_range.as_ref() {
            Some(marked) if !field.content.is_empty() => [
                TextRun {
                    len: marked.start,
                    ..run.clone()
                },
                TextRun {
                    len: marked.end - marked.start,
                    underline: Some(UnderlineStyle {
                        color: Some(run.color),
                        thickness: px(1.),
                        wavy: false,
                    }),
                    ..run.clone()
                },
                TextRun {
                    len: display.len() - marked.end,
                    ..run
                },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect(),
            _ => vec![run],
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line = window
            .text_system()
            .shape_line(display, font_size, &runs, None);

        // Keep the cursor in view: scroll just far enough, never past the end of the text.
        let cursor_x = line.x_for_index(field.cursor_offset());
        let mut scroll_x = field.scroll_x;
        if cursor_x - scroll_x > bounds.size.width - px(2.) {
            scroll_x = cursor_x - bounds.size.width + px(2.);
        }
        if cursor_x < scroll_x {
            scroll_x = cursor_x;
        }
        if line.width <= bounds.size.width {
            scroll_x = px(0.);
        }

        let selection = (!field.selected_range.is_empty()).then(|| {
            fill(
                Bounds::from_corners(
                    point(
                        bounds.left() + line.x_for_index(field.selected_range.start) - scroll_x,
                        bounds.top(),
                    ),
                    point(
                        bounds.left() + line.x_for_index(field.selected_range.end) - scroll_x,
                        bounds.bottom(),
                    ),
                ),
                colors.panel_strong,
            )
        });
        let cursor = field.selected_range.is_empty().then(|| {
            fill(
                Bounds::new(
                    point(bounds.left() + cursor_x - scroll_x, bounds.top()),
                    size(px(2.), bounds.size.height),
                ),
                colors.ink,
            )
        });
        Prepaint {
            line,
            cursor,
            selection,
            scroll_x,
        }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.field.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.field.clone()),
            cx,
        );
        if let Some(selection) = prepaint.selection.take() {
            window.paint_quad(selection);
        }
        // Clipped to the field, so scrolled text does not run out under the ring.
        let line = prepaint.line.clone();
        let origin = point(bounds.origin.x - prepaint.scroll_x, bounds.origin.y);
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            line.paint(origin, window.line_height(), window, cx).ok();
        });
        if focus_handle.is_focused(window) {
            if let Some(cursor) = prepaint.cursor.take() {
                window.paint_quad(cursor);
            }
        }
        let scroll_x = prepaint.scroll_x;
        self.field.update(cx, |field, _| {
            field.last_layout = Some(prepaint.line.clone());
            field.last_bounds = Some(bounds);
            field.scroll_x = scroll_x;
        });
    }
}

impl Render for TextField {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors;
        let focused = self.focus_handle.is_focused(window);
        let entity = cx.entity();
        let name = self.label.clone();
        let value = self.content.clone();
        let focus = self.focus_handle.clone();

        let field = div()
            .id(ElementId::Name(format!("feld-{}", self.label).into()))
            .key_context("SondraTextField")
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_back))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::cancel))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .px(px(12.))
            .py(px(8.))
            .rounded(px(radius::NAV))
            .bg(c.raised)
            .border_1()
            // The ring turns ink on focus; the field does not move.
            .border_color(if focused { c.ink } else { c.rule })
            .font_family(family::VALUE)
            .text_size(px(text_size::SMALL))
            .line_height(px(text_size::SMALL * 1.5))
            .child(TextElement { field: entity });

        accessible(
            ElementId::Name(format!("textfeld-{}", self.label).into()),
            Role::TextInput,
            field,
        )
        .label(name)
        .value(value)
        .focus(&focus)
    }
}
