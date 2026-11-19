//! The palette, the type and the radii of `DESIGN.md` and `src/styles/theme.css` — the web app's own
//! numbers, in light and dark. Dark is its own mapping with its own contrast pass, not an inversion: ink
//! and its ground swap roles, and the one saturated value has to be the light one.

use gpui::Rgba;

/// `#rrggbb` as a colour.
pub const fn hex(value: u32) -> Rgba {
    Rgba {
        r: ((value >> 16) & 0xff) as f32 / 255.0,
        g: ((value >> 8) & 0xff) as f32 / 255.0,
        b: (value & 0xff) as f32 / 255.0,
        a: 1.0,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Colors {
    /// The ground of the whole app.
    pub canvas: Rgba,
    /// Fields and the one plate that has its own mechanics.
    pub raised: Rgba,
    /// Inset blocks, the hover ground of rows.
    pub panel_soft: Rgba,
    pub panel_mid: Rgba,
    pub panel_strong: Rgba,
    /// Reserved for one statement: something here does not run locally.
    pub panel_cool: Rgba,
    /// The only saturated colour, the only ink: "you can do something here".
    pub ink: Rgba,
    /// Hover of filled ink, nowhere else.
    pub ink_hover: Rgba,
    pub on_ink: Rgba,
    pub prose: Rgba,
    pub muted: Rgba,
    /// A hairline: the rule between rows, fields and blocks.
    pub line: Rgba,
    /// The heavier line that opens a section, and the ring of a quiet control.
    pub rule: Rgba,
    pub faint: Rgba,
    /// The editors' stage, dark and neutral in both themes.
    pub stage: Rgba,
    pub stage_soft: Rgba,
    pub stage_line: Rgba,
    pub stage_ink: Rgba,
    pub stage_muted: Rgba,
    /// The one colour on the stage: the played part of the timeline, a switch that is on.
    pub stage_accent: Rgba,
}

pub const LIGHT: Colors = Colors {
    canvas: hex(0xf8faf8),
    raised: hex(0xffffff),
    panel_soft: hex(0xe0f0e5),
    panel_mid: hex(0xd2e8d9),
    panel_strong: hex(0xc8e1cf),
    panel_cool: hex(0xe5eff3),
    ink: hex(0x0b4a22),
    ink_hover: hex(0x073517),
    on_ink: hex(0xffffff),
    prose: hex(0x111a14),
    muted: hex(0x4e6355),
    line: hex(0xcbd7cf),
    rule: hex(0xa7bca9),
    faint: hex(0x799081),
    stage: hex(0x15181a),
    stage_soft: hex(0x1d2124),
    stage_line: hex(0x515a5d),
    stage_ink: hex(0xeef1f0),
    stage_muted: hex(0xaab5b2),
    stage_accent: hex(0x8fe0a6),
};

pub const DARK: Colors = Colors {
    canvas: hex(0x0a110d),
    raised: hex(0x111a14),
    panel_soft: hex(0x142019),
    panel_mid: hex(0x18271e),
    panel_strong: hex(0x203427),
    panel_cool: hex(0x15242a),
    ink: hex(0xa6ecb9),
    ink_hover: hex(0xc3f4d0),
    on_ink: hex(0x04100a),
    prose: hex(0xe4ede6),
    muted: hex(0xadc2b2),
    line: hex(0x4a5e50),
    rule: hex(0x5d7364),
    faint: hex(0x8ba191),
    stage: hex(0x0d1011),
    stage_soft: hex(0x161a1c),
    stage_line: hex(0x515a5d),
    stage_ink: hex(0xeef1f0),
    stage_muted: hex(0xaab5b2),
    stage_accent: hex(0x8fe0a6),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Light,
    Dark,
}

impl Mode {
    pub fn colors(self) -> Colors {
        match self {
            Mode::Light => LIGHT,
            Mode::Dark => DARK,
        }
    }
}

/// Type: a major third (×1.25) from a 16 px body, and nothing between the steps. Three sizes carry the
/// whole interface: `MICRO` for the uppercase labels only, `SMALL` for dense tool chrome, `BODY` for prose.
pub mod size {
    pub const MICRO: f32 = 11.0;
    pub const SMALL: f32 = 13.0;
    pub const BODY: f32 = 16.0;
    pub const SUBHEADING: f32 = 20.0;
    pub const HEADING_SM: f32 = 25.0;
    pub const HEADING: f32 = 39.0;
}

/// Rounding, only through these: blocks, tiles and popovers take `CARD`; controls take `NAV`, a little
/// tighter so a button inside a block sits concentric with it.
pub mod radius {
    pub const DIALOG: f32 = 20.0;
    pub const CARD: f32 = 16.0;
    pub const NAV: f32 = 10.0;
    pub const PILL: f32 = 999.0;
}

/// The three faces. Public Sans is the printed form; Courier Prime is what the machine entered
/// afterwards — measured values, file names, timecodes, never mono as a costume; the wordmark is one
/// word in one face.
pub mod family {
    pub const SANS: &str = "Public Sans";
    pub const VALUE: &str = "Courier Prime";
    pub const WORDMARK: &str = "Cormorant Garamond";
}
