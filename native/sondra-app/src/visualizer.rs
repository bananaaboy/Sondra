//! The visualizer on the stage of a song: bars from the floor, the wave, or a ring — in the stage's one colour,
//! and at rest on its floor colour when nothing plays. The shapes are the web player's (`PlayerPanel.tsx`): bars at
//! a steady pitch of 8 px from the lower seven tenths of the spectrum, a line through the wave, 48 spokes round a
//! ring.

use gpui::{canvas, point, prelude::*, px, Bounds, Corners, IntoElement, Pixels, Rgba};
use sondra_player::VisualizerMode;
use sondra_playback::Spectrum;

/// One shape, as numbers in a box of `width` × `height` — what the canvas then draws. Kept apart from the drawing so a
/// test can look at it.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// Left, top, width, height of each bar.
    Bars(Vec<[f32; 4]>),
    /// A line through these points.
    Line(Vec<[f32; 2]>),
    /// Spokes: from, to.
    Spokes(Vec<([f32; 2], [f32; 2])>),
}

/// The shape for a reading in a box of the given size; with `live` false everything lies on the floor.
pub fn shape(mode: VisualizerMode, spectrum: &Spectrum, live: bool, width: f32, height: f32) -> Shape {
    let (w, h) = (width, height);
    let level = |i: usize, count: usize| -> f32 {
        if !live {
            return 0.0;
        }
        let at = ((i as f32 / count as f32) * spectrum.frequency.len() as f32 * 0.7).floor() as usize;
        f32::from(spectrum.frequency.get(at).copied().unwrap_or(0)) / 255.0
    };
    match mode {
        VisualizerMode::Wave => {
            let points = spectrum.wave.len().max(2);
            Shape::Line(
                (0..points)
                    .map(|i| {
                        let v = if live { (f32::from(spectrum.wave.get(i).copied().unwrap_or(128)) - 128.0) / 128.0 } else { 0.0 };
                        [i as f32 / (points - 1) as f32 * w, h / 2.0 + v * (h / 2.0 - 2.0)]
                    })
                    .collect(),
            )
        }
        VisualizerMode::Radial => {
            let bars = 48;
            let radius = w.min(h) * 0.22;
            let reach = w.min(h) / 2.0 - radius - 2.0;
            Shape::Spokes(
                (0..bars)
                    .map(|i| {
                        let angle = i as f32 / bars as f32 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                        let outer = radius + 3.0 + level(i, bars) * reach.max(0.0);
                        ([w / 2.0 + angle.cos() * radius, h / 2.0 + angle.sin() * radius], [w / 2.0 + angle.cos() * outer, h / 2.0 + angle.sin() * outer])
                    })
                    .collect(),
            )
        }
        VisualizerMode::Bars => {
            let pitch = 8.0;
            let bars = ((w / pitch).floor() as usize).max(8);
            let width = pitch - 3.0;
            Shape::Bars(
                (0..bars)
                    .map(|i| {
                        let bar = (level(i, bars) * h * 0.86).max(2.0);
                        [i as f32 * pitch + (w - bars as f32 * pitch) / 2.0 + 1.5, h - bar, width, bar]
                    })
                    .collect(),
            )
        }
    }
}

/// The element that fills its parent and draws the reading.
pub fn visualizer(mode: VisualizerMode, spectrum: Spectrum, live: bool, accent: Rgba, rest: Rgba) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, _, window, _| {
            let colour = if live { accent } else { rest };
            let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
            if w < 1.0 || h < 1.0 {
                return;
            }
            let at = |x: f32, y: f32| point(bounds.origin.x + px(x), bounds.origin.y + px(y));
            match shape(mode, &spectrum, live, w, h) {
                Shape::Bars(bars) => {
                    for [x, y, bw, bh] in bars {
                        let rect = Bounds { origin: at(x, y), size: gpui::size(px(bw), px(bh)) };
                        window.paint_quad(gpui::fill(rect, colour).corner_radii(Corners { top_left: px(2.), top_right: px(2.), bottom_left: px(0.), bottom_right: px(0.) }));
                    }
                }
                Shape::Line(points) => {
                    let mut path = gpui::PathBuilder::stroke(px(2.));
                    for (n, [x, y]) in points.into_iter().enumerate() {
                        if n == 0 {
                            path.move_to(at(x, y));
                        } else {
                            path.line_to(at(x, y));
                        }
                    }
                    if let Ok(path) = path.build() {
                        window.paint_path(path, colour);
                    }
                }
                Shape::Spokes(spokes) => {
                    for ([x0, y0], [x1, y1]) in spokes {
                        let mut path = gpui::PathBuilder::stroke(px(2.5));
                        path.move_to(at(x0, y0));
                        path.line_to(at(x1, y1));
                        if let Ok(path) = path.build() {
                            window.paint_path(path, colour);
                        }
                    }
                }
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loud() -> Spectrum {
        Spectrum { frequency: vec![255; 1024], wave: (0..1024).map(|i| if i % 2 == 0 { 255 } else { 0 }).collect() }
    }

    #[test]
    fn resting_bars_are_two_pixels_and_loud_ones_nearly_as_tall_as_the_box() {
        let Shape::Bars(rest) = shape(VisualizerMode::Bars, &loud(), false, 400.0, 200.0) else { panic!() };
        assert_eq!(rest.len(), 50);
        assert!(rest.iter().all(|b| (b[3] - 2.0).abs() < 1e-3 && (b[1] + b[3] - 200.0).abs() < 1e-3), "on the floor");
        let Shape::Bars(live) = shape(VisualizerMode::Bars, &loud(), true, 400.0, 200.0) else { panic!() };
        assert!((live[0][3] - 172.0).abs() < 1e-3, "0.86 of the height: {}", live[0][3]);
    }

    #[test]
    fn the_wave_is_flat_at_rest_and_swings_when_live() {
        let Shape::Line(flat) = shape(VisualizerMode::Wave, &loud(), false, 300.0, 100.0) else { panic!() };
        assert!(flat.iter().all(|p| (p[1] - 50.0).abs() < 1e-3));
        let Shape::Line(live) = shape(VisualizerMode::Wave, &loud(), true, 300.0, 100.0) else { panic!() };
        assert!(live.iter().any(|p| p[1] > 90.0) && live.iter().any(|p| p[1] < 10.0));
        assert!((live.last().unwrap()[0] - 300.0).abs() < 1e-3);
    }

    #[test]
    fn the_ring_has_forty_eight_spokes_that_grow_with_the_sound() {
        let Shape::Spokes(rest) = shape(VisualizerMode::Radial, &loud(), false, 200.0, 200.0) else { panic!() };
        let Shape::Spokes(live) = shape(VisualizerMode::Radial, &loud(), true, 200.0, 200.0) else { panic!() };
        assert_eq!((rest.len(), live.len()), (48, 48));
        let length = |s: &([f32; 2], [f32; 2])| ((s.1[0] - s.0[0]).powi(2) + (s.1[1] - s.0[1]).powi(2)).sqrt();
        assert!((length(&rest[0]) - 3.0).abs() < 1e-2);
        assert!(length(&live[0]) > 40.0);
    }
}
