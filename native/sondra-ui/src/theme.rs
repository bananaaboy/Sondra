//! The palette, the type and the radii of the native app („Vorführkabine“, 20.11.2026): the room is dark,
//! only the plate the page sits on is lit, and mint is the projector's light. The colours are the web
//! app's family (Waldschwarz, forest ink, mint); the light theme is the same booth with the lights up.

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
    /// The room: the window's own ground and the rack on its left. The darkest step in the dark theme.
    pub room: Rgba,
    /// The plate the page sits on („Leinwand“): one step lighter than the room, the lit thing.
    pub canvas: Rgba,
    /// The catch-light on the plate's upper edge, and the edge of what floats over it.
    pub plate_edge: Rgba,
    /// Fields: one step above the plate.
    pub raised: Rgba,
    /// Inset blocks, tiles, quiet buttons, the hover ground of rows.
    pub panel_soft: Rgba,
    pub panel_mid: Rgba,
    pub panel_strong: Rgba,
    /// Reserved for one statement: something here does not run locally.
    pub panel_cool: Rgba,
    /// The projector's light, the only saturated colour: what can be done, and where you are.
    pub ink: Rgba,
    /// Hover of filled ink, nowhere else.
    pub ink_hover: Rgba,
    pub on_ink: Rgba,
    /// Ink thinned onto the ground: a chosen filter, the chosen place in the rack.
    pub ink_wash: Rgba,
    pub prose: Rgba,
    pub muted: Rgba,
    /// A hairline: the rule between rows, fields and blocks.
    pub line: Rgba,
    /// The edge of a field and of a quiet control.
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

/// „Saallicht an“: the booth with the lights up. The plate is near-white, the room a grey-green step below.
pub const LIGHT: Colors = Colors {
    room: hex(0xe7ede8),
    canvas: hex(0xf9fbf9),
    plate_edge: hex(0xffffff),
    raised: hex(0xffffff),
    panel_soft: hex(0xe6f1e9),
    panel_mid: hex(0xd8e9dd),
    panel_strong: hex(0xc8e1cf),
    panel_cool: hex(0xe5eff3),
    ink: hex(0x0b4a22),
    ink_hover: hex(0x073517),
    on_ink: hex(0xffffff),
    ink_wash: hex(0xd3eadb),
    prose: hex(0x111a14),
    muted: hex(0x4e6355),
    line: hex(0xd5dfd8),
    rule: hex(0xa7bca9),
    faint: hex(0x799081),
    stage: hex(0x15181a),
    stage_soft: hex(0x1d2124),
    stage_line: hex(0x515a5d),
    stage_ink: hex(0xeef1f0),
    stage_muted: hex(0xaab5b2),
    stage_accent: hex(0x8fe0a6),
};

/// The default: the booth with the house lights down. Waldschwarz in steps — room, plate, field, tint —
/// and mint as the one light. Measured in `tests/contrast.rs`.
pub const DARK: Colors = Colors {
    room: hex(0x050806),
    canvas: hex(0x111a14),
    plate_edge: hex(0x223328),
    raised: hex(0x152019),
    panel_soft: hex(0x18251d),
    panel_mid: hex(0x1e2f25),
    panel_strong: hex(0x273b2f),
    panel_cool: hex(0x13242b),
    ink: hex(0xa6ecb9),
    ink_hover: hex(0xc3f4d0),
    on_ink: hex(0x04100a),
    ink_wash: hex(0x1c3726),
    prose: hex(0xe6eee8),
    muted: hex(0xabc0af),
    line: hex(0x253629),
    rule: hex(0x4d6656),
    faint: hex(0x7f9686),
    stage: hex(0x0b0e0f),
    stage_soft: hex(0x151a1b),
    stage_line: hex(0x515a5d),
    stage_ink: hex(0xeef1f0),
    stage_muted: hex(0xaab5b2),
    stage_accent: hex(0x8fe0a6),
};

/// Dark is the default (the user's word, 20.11.2026); light stays one switch away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    Light,
    #[default]
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

/// Type at desktop size: 15 px for running text and controls, 14 px for dense chrome, and page titles far
/// above them — rank by scale contrast, not by colour. (Barlow is narrow and sits small: at 14/13 px the
/// window read as „sehr klein“, the user's word on 21.11.2026.)
pub mod size {
    pub const MICRO: f32 = 12.0;
    pub const SMALL: f32 = 14.0;
    pub const BODY: f32 = 15.0;
    pub const SUBHEADING: f32 = 19.0;
    pub const HEADING_SM: f32 = 28.0;
    pub const HEADING: f32 = 38.0;
}

/// Rounding, only through these: the plate and blocks take `CARD`; controls take `NAV`; the window's
/// floating things take `DIALOG`.
pub mod radius {
    pub const DIALOG: f32 = 20.0;
    pub const CARD: f32 = 14.0;
    pub const PLATE: f32 = 16.0;
    pub const NAV: f32 = 10.0;
    pub const PILL: f32 = 999.0;
}

/// The three faces. Barlow is the label on the booth's equipment; Courier Prime is the typed reel label —
/// measured values, file names, timecodes, never mono as a costume; the wordmark is one word in one face.
pub mod family {
    pub const SANS: &str = "Barlow";
    pub const VALUE: &str = "Courier Prime";
    pub const WORDMARK: &str = "Cormorant Garamond";
}
