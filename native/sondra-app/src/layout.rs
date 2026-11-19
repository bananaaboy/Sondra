//! The measures of the sheet, from the web app's CSS (`@utility shell`, `useColumns` in `Home.tsx`).
//! Pure functions, so they can be checked without a window.

/// The widest the column grows to at this window width: in steps from 1280 to 1840 px, because a flat
/// 1280 left half of a 2560 px monitor empty and a column that never stops is a head-turn.
pub fn shell_width(window: f32) -> f32 {
    match window {
        w if w >= 2400.0 => 1840.0,
        w if w >= 1920.0 => 1680.0,
        w if w >= 1600.0 => 1440.0,
        _ => 1280.0,
    }
}

/// The side padding of the column.
pub const GUTTER: f32 = 21.0;

/// How many tiles stand in a row — two rows of a group are shown. More room shows more tiles, not
/// wider ones.
pub fn columns(window: f32) -> usize {
    match window {
        w if w >= 1280.0 => 5,
        w if w >= 1024.0 => 4,
        w if w >= 640.0 => 3,
        _ => 2,
    }
}

/// The width of a tab, measured by the size of its text: 13 px Public Sans takes about 7.4 px a
/// character at semibold, plus 12 px of padding either side; a group has its small arrow too.
pub fn tab_width(label: &str, group: bool) -> f32 {
    let chars = label.chars().count() as f32;
    chars * 7.6 + 24.0 + if group { 16.0 } else { 0.0 }
}
