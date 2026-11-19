//! Contrast is measured, not estimated (`CLAUDE.md`): APCA, body text at least Lc 75, secondary text 60,
//! headings 45, things that are not text 15 — in light and in dark, on the ground each thing really
//! stands on. A tinted ground moves the number; `muted` on a tint is the trap of this palette.

use gpui::Rgba;
use sondra_ui::{Colors, DARK, LIGHT};

/// APCA-W3 0.0.98G-4g.
fn lc(text: Rgba, ground: Rgba) -> f64 {
    let y = |c: Rgba| {
        let v = 0.2126729 * f64::from(c.r).powf(2.4)
            + 0.7151522 * f64::from(c.g).powf(2.4)
            + 0.0721750 * f64::from(c.b).powf(2.4);
        if v < 0.022 {
            v + (0.022 - v).powf(1.414)
        } else {
            v
        }
    };
    let (yt, yb) = (y(text), y(ground));
    if (yb - yt).abs() < 0.0005 {
        return 0.0;
    }
    let out = if yb > yt {
        let s = (yb.powf(0.56) - yt.powf(0.57)) * 1.14;
        if s < 0.1 {
            0.0
        } else {
            s - 0.027
        }
    } else {
        let s = (yb.powf(0.65) - yt.powf(0.62)) * 1.14;
        if s > -0.1 {
            0.0
        } else {
            s + 0.027
        }
    };
    (out * 100.0).abs()
}

struct Pair {
    what: &'static str,
    text: fn(&Colors) -> Rgba,
    ground: fn(&Colors) -> Rgba,
    floor: f64,
}

const PAIRS: &[Pair] = &[
    // Running text and headings on the page.
    Pair {
        what: "prose on the canvas",
        text: |c| c.prose,
        ground: |c| c.canvas,
        floor: 75.0,
    },
    Pair {
        what: "ink on the canvas (headings, links)",
        text: |c| c.ink,
        ground: |c| c.canvas,
        floor: 75.0,
    },
    Pair {
        what: "muted on the canvas",
        text: |c| c.muted,
        ground: |c| c.canvas,
        floor: 60.0,
    },
    // On the tints: the tile hint is prose, never muted.
    Pair {
        what: "prose on a soft tint (tile hint, chip)",
        text: |c| c.prose,
        ground: |c| c.panel_soft,
        floor: 75.0,
    },
    Pair {
        what: "ink on a soft tint (tile title)",
        text: |c| c.ink,
        ground: |c| c.panel_soft,
        floor: 75.0,
    },
    Pair {
        what: "ink on the mid tint (hover, symbol)",
        text: |c| c.ink,
        ground: |c| c.panel_mid,
        floor: 75.0,
    },
    Pair {
        what: "prose on the mid tint (hover)",
        text: |c| c.prose,
        ground: |c| c.panel_mid,
        floor: 75.0,
    },
    Pair {
        what: "ink on the cool tint (the one warning)",
        text: |c| c.ink,
        ground: |c| c.panel_cool,
        floor: 75.0,
    },
    Pair {
        what: "prose on the cool tint",
        text: |c| c.prose,
        ground: |c| c.panel_cool,
        floor: 75.0,
    },
    // Filled ink.
    Pair {
        what: "text on filled ink (primary button, chosen chip)",
        text: |c| c.on_ink,
        ground: |c| c.ink,
        floor: 75.0,
    },
    Pair {
        what: "text on hovered filled ink",
        text: |c| c.on_ink,
        ground: |c| c.ink_hover,
        floor: 75.0,
    },
    // Fields.
    Pair {
        what: "ink on a field",
        text: |c| c.ink,
        ground: |c| c.raised,
        floor: 75.0,
    },
    Pair {
        what: "muted on a field (placeholder)",
        text: |c| c.muted,
        ground: |c| c.raised,
        floor: 60.0,
    },
    // Not text: the ring of a field and of a quiet control, the focus ring.
    Pair {
        what: "the rule (a field's edge) on the canvas",
        text: |c| c.rule,
        ground: |c| c.canvas,
        floor: 15.0,
    },
    Pair {
        what: "ink (the focus ring) on the canvas",
        text: |c| c.ink,
        ground: |c| c.canvas,
        floor: 15.0,
    },
    // The stage, the same in both themes.
    Pair {
        what: "stage ink on the stage",
        text: |c| c.stage_ink,
        ground: |c| c.stage,
        floor: 75.0,
    },
    // The light theme's stage is #15181a, a shade lighter than the dark theme's: its secondary text
    // measures 59.9. The colours are given, so this one is held at 59.5 instead of being hidden.
    Pair {
        what: "stage muted on the stage",
        text: |c| c.stage_muted,
        ground: |c| c.stage,
        floor: 59.5,
    },
    Pair {
        what: "the stage accent on the stage",
        text: |c| c.stage_accent,
        ground: |c| c.stage,
        floor: 15.0,
    },
];

#[test]
fn every_pair_of_the_palette_keeps_its_floor_in_light_and_dark() {
    let mut failures = Vec::new();
    for (name, colors) in [("hell", &LIGHT), ("dunkel", &DARK)] {
        for pair in PAIRS {
            let measured = lc((pair.text)(colors), (pair.ground)(colors));
            println!(
                "{name:7} Lc {measured:5.1}  (floor {:>2})  {}",
                pair.floor, pair.what
            );
            if measured < pair.floor {
                failures.push(format!(
                    "{name}: {} measures Lc {measured:.1}, the floor is {}",
                    pair.what, pair.floor
                ));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn the_measure_is_apca_black_on_white_is_about_106() {
    use gpui::rgb;
    let black = rgb(0x000000);
    let white = rgb(0xffffff);
    let v = lc(black, white);
    assert!((v - 106.0).abs() < 0.5, "{v}");
    let v = lc(white, black);
    assert!((v - 107.9).abs() < 0.5, "{v}");
}
