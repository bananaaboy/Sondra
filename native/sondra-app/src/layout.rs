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

/// The side padding of the column on the plate.
pub const GUTTER: f32 = 32.0;

/// The rack on the left, and the rack of a narrow window (the marks alone).
pub const RACK: f32 = 248.0;
pub const RACK_COMPACT: f32 = 68.0;

/// Below this window width the rack shows only the marks.
pub const RACK_NARROW_BELOW: f32 = 980.0;

/// How many tiles stand in a row on a plate whose column is `inner` wide: whole cells, never stretched
/// past about 260 px a tile — more room shows more tiles, not wider ones.
pub fn columns_for(inner: f32) -> usize {
    match inner {
        w if w >= 1200.0 => 5,
        w if w >= 920.0 => 4,
        w if w >= 640.0 => 3,
        _ => 2,
    }
}
