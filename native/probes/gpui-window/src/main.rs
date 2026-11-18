//! Probe for Welle 0b: GPUI on Windows.
//!
//! Opens a window, draws German text in Sondra's colours, and shows a 1080p
//! "video" surface that gets a new frame on every animation frame, the way a
//! player would. After a few seconds it writes how many frames per second it
//! managed to `probe-result.txt` and exits. The CI takes a screenshot in the
//! middle of the run.
//!
//! GPUI takes pixels as BGRA, which is also what FFmpeg can hand over directly.

use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    div, img, prelude::*, px, rgb, size, App, Application, Bounds, Context, ObjectFit, RenderImage,
    Window, WindowBounds, WindowOptions,
};
use image::{Frame, RgbaImage};
use smallvec::smallvec;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const RUN_FOR: Duration = Duration::from_secs(12);

/// One moving test pattern, 1920 × 1080 BGRA.
fn make_frame(tick: u32) -> Arc<RenderImage> {
    let mut pixels = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    let shift = (tick * 6) % WIDTH;
    for y in 0..HEIGHT {
        let row = (y * WIDTH * 4) as usize;
        for x in 0..WIDTH {
            let at = row + (x * 4) as usize;
            let bar = ((x + shift) % WIDTH) as f32 / WIDTH as f32;
            pixels[at] = (bar * 255.0) as u8; // B
            pixels[at + 1] = (y * 255 / HEIGHT) as u8; // G
            pixels[at + 2] = 255 - (bar * 255.0) as u8; // R
            pixels[at + 3] = 255;
        }
    }
    let buffer = RgbaImage::from_raw(WIDTH, HEIGHT, pixels).expect("buffer matches size");
    Arc::new(RenderImage::new(smallvec![Frame::new(buffer)]))
}

struct Probe {
    shown: Option<Arc<RenderImage>>,
    frames: u64,
    started: Instant,
    make_ms: f64,
}

impl Render for Probe {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let made = Instant::now();
        let next = make_frame(self.frames as u32);
        self.make_ms += made.elapsed().as_secs_f64() * 1000.0;
        if let Some(old) = self.shown.replace(next.clone()) {
            let _ = window.drop_image(old);
        }
        self.frames += 1;

        let elapsed = self.started.elapsed();
        if elapsed >= RUN_FOR {
            let seconds = elapsed.as_secs_f64();
            let report = format!(
                "frames: {}\nseconds: {:.2}\nfps: {:.1}\nms to make one frame on the CPU: {:.2}\nframe size: {}x{} BGRA ({} MB)\n",
                self.frames,
                seconds,
                self.frames as f64 / seconds,
                self.make_ms / self.frames as f64,
                WIDTH,
                HEIGHT,
                WIDTH * HEIGHT * 4 / 1_000_000,
            );
            let _ = std::fs::write("probe-result.txt", &report);
            println!("{report}");
            cx.quit();
        } else {
            window.request_animation_frame();
        }

        div()
            .size_full()
            .bg(rgb(0x14201a))
            .flex()
            .flex_col()
            .p_4()
            .gap_2()
            .child(
                div()
                    .text_color(rgb(0xf2efe6))
                    .text_size(px(28.))
                    .child("Sondra — Größe, Straße, Übung, ÄÖÜ äöü ß · 1 234,5 MB"),
            )
            .child(
                div()
                    .text_color(rgb(0xb9c4bb))
                    .text_size(px(16.))
                    .child("Probe: ein 1080p-Bild pro Frame, so wie es ein Player zeigen würde."),
            )
            .child(div().flex_1().child(img(next).size_full().object_fit(ObjectFit::Contain)))
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| Probe {
                    shown: None,
                    frames: 0,
                    started: Instant::now(),
                    make_ms: 0.0,
                })
            },
        )
        .expect("a window opens");
        cx.activate(true);
    });
}
