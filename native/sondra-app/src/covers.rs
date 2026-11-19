//! The pictures of the Merkliste: a cover with the part its frame chooses, drawn at the size it is shown.
//! The rule is `CoverImage.tsx`'s (`drawCover`): the part `object-fit: cover`, `object-position` and a scale
//! around that point would show, worked out here and made from a pyramid of halvings, so that a poster shown
//! small is not a picture thrown down in one step (which looks over-sharpened).
//!
//! A cover is a data URL (a picture the person chose, kept small) or an address on the web; both are read in
//! the background, once, and what is made is kept by what it was made for.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use base64::Engine as _;
use gpui::RenderImage;
use image::imageops::{crop_imm, resize, FilterType};
use image::{Frame as ImageFrame, RgbaImage};
use smallvec::smallvec;
use sondra_merk::model::CoverFrame;

/// What `drawCover` shows of a picture of `src_w × src_h` in a box of `w × h`: the part to take, as
/// (x, y, width, height) in the picture's own pixels.
pub fn cover_part(src_w: f64, src_h: f64, frame: Option<CoverFrame>, w: f64, h: f64) -> (f64, f64, f64, f64) {
    let (x, y, zoom) = frame.map_or((50.0, 50.0, 1.0), |f| (f.x, f.y, f.zoom));
    let zoom = zoom.max(1.0);
    let fit = (w / src_w).max(h / src_h);
    let left = (w - src_w * fit) * (x / 100.0);
    let top = (h - src_h * fit) * (y / 100.0);
    let origin_x = w * (x / 100.0);
    let origin_y = h * (y / 100.0);
    let sw = w / zoom / fit;
    let sh = h / zoom / fit;
    let sx = (src_w - sw).min(0f64.max((origin_x * (1.0 - 1.0 / zoom) - left) / fit));
    let sy = (src_h - sh).min(0f64.max((origin_y * (1.0 - 1.0 / zoom) - top) / fit));
    (sx, sy, sw, sh)
}

/// The cover's bytes: out of a data URL, or fetched. `None` for anything else (a local picture on another
/// device is a marker, not a picture).
fn bytes_of(src: &str) -> Option<Vec<u8>> {
    if let Some(rest) = src.strip_prefix("data:") {
        let (head, data) = rest.split_once(',')?;
        return if head.ends_with(";base64") { base64::engine::general_purpose::STANDARD.decode(data.trim()).ok() } else { Some(data.as_bytes().to_vec()) };
    }
    if src.starts_with("https://") || src.starts_with("http://") {
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(20))).build().into();
        let mut response = agent.get(src).call().ok()?;
        return response.body_mut().with_config().limit(12 * 1024 * 1024).read_to_vec().ok();
    }
    None
}

/// The picture for a box of `w × h` device pixels, as BGRA (what the window takes).
pub fn render_cover(src: &str, frame: Option<CoverFrame>, w: u32, h: u32) -> Option<RgbaImage> {
    render_bytes(&bytes_of(src)?, frame, w, h)
}

/// The same from the bytes of a picture (a file's own, or a frame FFmpeg cut out of a film).
pub fn render_bytes(bytes: &[u8], frame: Option<CoverFrame>, w: u32, h: u32) -> Option<RgbaImage> {
    let decoded = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (mut level, mut scale) = (decoded, 1.0f64);
    let (src_w, src_h) = (f64::from(level.width()), f64::from(level.height()));
    let (sx, sy, sw, sh) = cover_part(src_w, src_h, frame, f64::from(w), f64::from(h));
    // The half-size step whose part is still at least as large as the box.
    let step = if sw > f64::from(w) { (sw / f64::from(w)).log2().floor() as u32 } else { 0 };
    for _ in 0..step {
        let (nw, nh) = ((level.width() / 2).max(1), (level.height() / 2).max(1));
        if nw < 2 || nh < 2 {
            break;
        }
        level = resize(&level, nw, nh, FilterType::Triangle);
        scale /= 2.0;
    }
    let (lx, ly) = ((sx * scale).max(0.0), (sy * scale).max(0.0));
    let (lw, lh) = ((sw * scale).max(1.0), (sh * scale).max(1.0));
    let (cx, cy) = (lx.round() as u32, ly.round() as u32);
    let (cw, ch) = ((lw.round() as u32).max(1).min(level.width().saturating_sub(cx).max(1)), (lh.round() as u32).max(1).min(level.height().saturating_sub(cy).max(1)));
    let part = crop_imm(&level, cx.min(level.width().saturating_sub(1)), cy.min(level.height().saturating_sub(1)), cw, ch).to_image();
    let mut out = resize(&part, w, h, FilterType::Lanczos3);
    // The window wants BGRA.
    for px in out.pixels_mut() {
        px.0.swap(0, 2);
    }
    Some(out)
}

enum Slot {
    Loading,
    Ready(Option<Arc<RenderImage>>),
}

/// What has been made for the covers shown, by what it was made for.
#[derive(Default)]
pub struct Covers {
    slots: HashMap<String, Slot>,
    /// Pictures a clearing-out has let go of: the window frees them at its next draw.
    pub trash: Vec<Arc<RenderImage>>,
}

pub type SharedCovers = Rc<RefCell<Covers>>;

/// How many pictures are kept; more than a shelf and a page of lists need.
const KEEP: usize = 600;

impl Covers {
    pub fn key(src: &str, frame: Option<CoverFrame>, w: u32, h: u32) -> String {
        let f = frame.map_or("-".to_string(), |f| format!("{},{},{}", f.x, f.y, f.zoom));
        format!("{w}x{h}|{f}|{src}")
    }

    /// `Some(Some(picture))` made, `Some(None)` could not be made, `None` not asked for yet or still coming.
    pub fn get(&self, key: &str) -> Option<Option<Arc<RenderImage>>> {
        match self.slots.get(key) {
            Some(Slot::Ready(r)) => Some(r.clone()),
            _ => None,
        }
    }

    /// Whether this should be started: not asked for yet. Marks it as coming.
    pub fn begin(&mut self, key: &str) -> bool {
        if self.slots.contains_key(key) {
            return false;
        }
        if self.slots.len() >= KEEP {
            // Clear out what is no longer shown the simple way: everything made; what is shown is made again.
            for (_, slot) in self.slots.drain() {
                if let Slot::Ready(Some(img)) = slot {
                    self.trash.push(img);
                }
            }
        }
        self.slots.insert(key.to_string(), Slot::Loading);
        true
    }

    /// How many are asked for in all.
    pub fn asked(&self) -> usize {
        self.slots.len()
    }

    /// How many are made and can be shown.
    pub fn ready(&self) -> usize {
        self.slots.values().filter(|s| matches!(s, Slot::Ready(Some(_)))).count()
    }

    pub fn finish(&mut self, key: &str, made: Option<RgbaImage>) {
        let image = made.map(|buffer| Arc::new(RenderImage::new(smallvec![ImageFrame::new(buffer)])));
        self.slots.insert(key.to_string(), Slot::Ready(image));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(x: f64, y: f64, zoom: f64) -> Option<CoverFrame> {
        Some(CoverFrame { x, y, zoom })
    }

    #[test]
    fn the_part_a_frame_chooses_is_the_one_the_web_app_draws() {
        // A poster in its own shape: all of it.
        assert_eq!(cover_part(200.0, 300.0, None, 100.0, 150.0), (0.0, 0.0, 200.0, 300.0));
        // Twice as close, in the middle: the middle half.
        let (sx, sy, sw, sh) = cover_part(200.0, 300.0, frame(50.0, 50.0, 2.0), 100.0, 150.0);
        assert_eq!((sx, sy, sw, sh), (50.0, 75.0, 100.0, 150.0));
        // A wide picture in a tall box: its middle strip, or its left edge when the frame says so.
        let (sx, _, sw, sh) = cover_part(600.0, 300.0, None, 100.0, 150.0);
        assert_eq!((sx, sw, sh), (200.0, 200.0, 300.0));
        let (sx, ..) = cover_part(600.0, 300.0, frame(0.0, 50.0, 1.0), 100.0, 150.0);
        assert_eq!(sx, 0.0);
        let (sx, ..) = cover_part(600.0, 300.0, frame(100.0, 50.0, 1.0), 100.0, 150.0);
        assert_eq!(sx, 400.0);
        // The part never leaves the picture, whatever the frame says.
        let (sx, sy, sw, sh) = cover_part(200.0, 300.0, frame(0.0, 100.0, 3.0), 100.0, 150.0);
        assert!(sx >= 0.0 && sy >= 0.0 && sx + sw <= 200.0 + 1e-9 && sy + sh <= 300.0 + 1e-9);
    }

    fn data_url(width: u32, height: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> String {
        let mut img = RgbaImage::new(width, height);
        for (x, y, p) in img.enumerate_pixels_mut() {
            p.0 = paint(x, y);
        }
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[test]
    fn a_cover_is_made_at_the_size_it_is_shown_with_the_chosen_part() {
        // Left half red, right half blue, in a wide picture.
        let src = data_url(600, 300, |x, _| if x < 300 { [255, 0, 0, 255] } else { [0, 0, 255, 255] });
        let left = render_cover(&src, frame(0.0, 50.0, 1.0), 40, 60).unwrap();
        assert_eq!((left.width(), left.height()), (40, 60));
        // BGRA: red is B=0 G=0 R=255 → bytes [0, 0, 255, 255].
        assert_eq!(left.get_pixel(20, 30).0, [0, 0, 255, 255], "the left edge of the picture is red");
        let right = render_cover(&src, frame(100.0, 50.0, 1.0), 40, 60).unwrap();
        assert_eq!(right.get_pixel(20, 30).0, [255, 0, 0, 255], "the right edge is blue");
        // Nothing that is not a picture is made.
        assert!(render_cover("data:image/png;base64,AAAA", None, 10, 10).is_none());
        assert!(render_cover("local", None, 10, 10).is_none());
    }

    #[test]
    fn a_big_cover_in_a_small_box_goes_down_in_halvings() {
        let src = data_url(1200, 1800, |x, y| [(x % 256) as u8, (y % 256) as u8, 40, 255]);
        let small = render_cover(&src, None, 60, 90).unwrap();
        assert_eq!((small.width(), small.height()), (60, 90));
    }
}
