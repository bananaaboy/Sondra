//! The biggest open question of the plan: can a decoded film be shown in a GPUI window, on a real
//! desktop, at the speed of a film? GPUI draws pictures, not video; the way that exists on every system is
//! to hand it each frame as a picture. This probe measures what that costs, with FFmpeg's own test
//! pictures (no file needed):
//!
//!   1. 1280 × 720 at 30 frames a second, in real time, for 6 seconds — does a film of that size play
//!      without dropping frames?
//!   2. 1920 × 1080 as fast as the window takes it, for 4 seconds — how many frames a second can the
//!      path carry at all (the headroom)?
//!
//! The numbers go to `videoprobe.json` next to the program and to the screen; the window closes itself.
//!
//!   cargo run --release --example videoprobe -p sondra-ui      (FFmpeg on the PATH, or `FFMPEG=…`)

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    div, img, prelude::*, px, size, App, Application, Bounds, Context, ImageSource, ObjectFit,
    RenderImage, Window, WindowBounds, WindowOptions,
};
use image::{Frame, RgbaImage};
use smallvec::smallvec;

struct Phase {
    name: &'static str,
    width: u32,
    height: u32,
    /// Frames a second asked of the source; `real_time` holds it to that speed.
    rate: u32,
    real_time: bool,
    seconds: u32,
}

const PHASES: [Phase; 2] = [
    Phase { name: "720p30, in real time", width: 1280, height: 720, rate: 30, real_time: true, seconds: 6 },
    Phase { name: "1080p, as fast as it goes", width: 1920, height: 1080, rate: 1000, real_time: false, seconds: 4 },
];

#[derive(Default, Clone)]
struct Numbers {
    name: String,
    width: u32,
    height: u32,
    /// Frames the decoder handed over, and frames drawn.
    decoded: u64,
    shown: u64,
    /// Time spent making each picture the window can draw, in milliseconds.
    make_ms: Vec<f32>,
    /// Gaps between two drawn frames, in milliseconds.
    gaps_ms: Vec<f32>,
    seconds: f32,
}

struct Source {
    frames: Receiver<Vec<u8>>,
    /// How many frames the reader thread has taken from FFmpeg (updated as it reads).
    decoded: Arc<std::sync::atomic::AtomicU64>,
}

fn start(phase: &Phase) -> Source {
    let ffmpeg = std::env::var("FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-v", "error"]);
    if phase.real_time {
        cmd.arg("-re");
    }
    cmd.args([
        "-f",
        "lavfi",
        "-i",
        &format!("testsrc2=size={}x{}:rate={}", phase.width, phase.height, phase.rate),
        "-t",
        &phase.seconds.to_string(),
        "-pix_fmt",
        "bgra",
        "-f",
        "rawvideo",
        "-",
    ]);
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("FFmpeg starts");
    let mut out = child.stdout.take().expect("a pipe");
    let bytes = (phase.width * phase.height * 4) as usize;
    let (tx, rx) = sync_channel::<Vec<u8>>(3);
    let decoded = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = decoded.clone();
    std::thread::spawn(move || {
        loop {
            let mut frame = vec![0u8; bytes];
            if out.read_exact(&mut frame).is_err() {
                break;
            }
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // A full channel means the window is behind: wait, as a player waits for its clock.
            if tx.send(frame).is_err() {
                break;
            }
        }
        let _ = child.wait();
    });
    Source { frames: rx, decoded }
}

struct Probe {
    phase: usize,
    source: Source,
    started: Instant,
    current: Option<Arc<RenderImage>>,
    last_shown: Option<Instant>,
    numbers: Vec<Numbers>,
    done: bool,
}

impl Probe {
    fn new() -> Probe {
        let mut numbers = Vec::new();
        numbers.push(Numbers { name: PHASES[0].name.into(), width: PHASES[0].width, height: PHASES[0].height, ..Default::default() });
        Probe { phase: 0, source: start(&PHASES[0]), started: Instant::now(), current: None, last_shown: None, numbers, done: false }
    }

    fn next_phase(&mut self) {
        let n = self.numbers.last_mut().expect("a phase");
        n.decoded = self.source.decoded.load(std::sync::atomic::Ordering::Relaxed);
        n.seconds = self.started.elapsed().as_secs_f32();
        if self.phase + 1 >= PHASES.len() {
            self.done = true;
            return;
        }
        self.phase += 1;
        let p = &PHASES[self.phase];
        self.numbers.push(Numbers { name: p.name.into(), width: p.width, height: p.height, ..Default::default() });
        self.source = start(p);
        self.started = Instant::now();
        self.last_shown = None;
    }
}

fn percentile(values: &[f32], p: f32) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    sorted[(((sorted.len() - 1) as f32) * p).round() as usize]
}

impl Render for Probe {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let phase = &PHASES[self.phase.min(PHASES.len() - 1)];
        // The newest frame the decoder has; older ones that piled up are not drawn (a player drops them).
        let mut newest = None;
        while let Ok(frame) = self.source.frames.try_recv() {
            newest = Some(frame);
        }
        if let Some(bytes) = newest {
            let t = Instant::now();
            let buffer = RgbaImage::from_raw(phase.width, phase.height, bytes).expect("a whole frame");
            let image = Arc::new(RenderImage::new(smallvec![Frame::new(buffer)]));
            let n = self.numbers.last_mut().expect("a phase");
            n.make_ms.push(t.elapsed().as_secs_f32() * 1000.0);
            n.shown += 1;
            if let Some(last) = self.last_shown.replace(Instant::now()) {
                n.gaps_ms.push(last.elapsed().as_secs_f32() * 1000.0);
            }
            if let Some(old) = self.current.replace(image) {
                let _ = window.drop_image(old);
            }
        }
        if self.started.elapsed() > Duration::from_secs(phase.seconds as u64 + 2) && !self.done {
            self.next_phase();
        }
        if self.done {
            let json = serde_json::json!(self.numbers.iter().map(|n| {
                serde_json::json!({
                    "phase": n.name,
                    "size": format!("{}x{}", n.width, n.height),
                    "seconds": n.seconds,
                    "decoded": n.decoded,
                    "shown": n.shown,
                    "shown_per_second": n.shown as f32 / n.seconds.max(0.001),
                    "make_ms_mean": n.make_ms.iter().sum::<f32>() / n.make_ms.len().max(1) as f32,
                    "make_ms_p95": percentile(&n.make_ms, 0.95),
                    "gap_ms_mean": n.gaps_ms.iter().sum::<f32>() / n.gaps_ms.len().max(1) as f32,
                    "gap_ms_p95": percentile(&n.gaps_ms, 0.95),
                    "gap_ms_max": percentile(&n.gaps_ms, 1.0),
                })
            }).collect::<Vec<_>>());
            let text = serde_json::to_string_pretty(&json).unwrap();
            println!("{text}");
            let _ = std::fs::write("videoprobe.json", &text);
            cx.quit();
        }
        // Draw again at once: the window takes frames as fast as the screen asks for them.
        let me = cx.entity_id();
        window.on_next_frame(move |_, cx| cx.notify(me));
        let c = sondra_ui::LIGHT;
        let shown = self.numbers.last().map_or(0, |n| n.shown);
        div()
            .size_full()
            .bg(c.stage)
            .flex()
            .flex_col()
            .child(div().p(px(8.)).text_color(c.stage_ink).child(format!("{} — {} frames shown", phase.name, shown)))
            .child(match &self.current {
                Some(image) => img(ImageSource::Render(image.clone())).object_fit(ObjectFit::Contain).size_full().into_any_element(),
                None => div().into_any_element(),
            })
    }
}

fn main() {
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.), px(760.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| cx.new(|_| Probe::new()),
        )
        .expect("a window opens");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
