//! Pictures in a shared list (`src/lib/shareCover.ts`): each cover as a small picture of its own inside the link or
//! the file — the part of the cover the tile shows (`coverFrame`), at the tile's shape, in three sizes: „Winzig“
//! (6 × 9, brightness and colour in 33 bytes), „Klein“ (40 × 60) and „Gross“ (96 × 144) as JPEG under a weight.
//! A cover from a file is taken from the entry; one at an address is fetched once (as the website does where the
//! server allows it). What has no picture goes without one, and the window says so.

use std::collections::HashMap;

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use sondra_merk::cover::{pack_raw, KIND_JPEG, RAW_H, RAW_W, THUMB_MAX};
use sondra_merk::{CoverFrame, Item};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tier {
    Winzig,
    Klein,
    Gross,
}

pub const TIERS: [(Tier, &str, &str); 3] = [(Tier::Winzig, "Winzig", "Farben und Umrisse"), (Tier::Klein, "Klein", "40 × 60"), (Tier::Gross, "Gross", "96 × 144")];

/// The cover an entry shows as its poster: its own, or the first a season or a part of it has.
pub fn cover_of(item: &Item) -> Option<(String, Option<CoverFrame>)> {
    if let Some(cover) = &item.cover {
        return Some((cover.clone(), item.cover_frame));
    }
    for season in item.seasons.as_deref().unwrap_or_default() {
        if let Some(cover) = &season.cover {
            return Some((cover.clone(), season.cover_frame));
        }
        for part in season.parts.as_deref().unwrap_or_default() {
            if let Some(cover) = &part.cover {
                return Some((cover.clone(), part.cover_frame));
            }
        }
    }
    None
}

/// The pixels of a cover: a `data:` address in the entry, or one fetched (a few seconds at most).
fn picture_of(src: &str) -> Option<DynamicImage> {
    use base64::Engine;
    let bytes = if let Some(rest) = src.strip_prefix("data:") {
        let (_, data) = rest.split_once(";base64,")?;
        base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?
    } else if src.starts_with("https://") || src.starts_with("http://") {
        let agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(8))).build().new_agent();
        let mut response = agent.get(src).call().ok()?;
        response.body_mut().with_config().limit(12 * 1024 * 1024).read_to_vec().ok()?
    } else {
        return None;
    };
    image::load_from_memory(&bytes).ok()
}

/// The part of a w × h box's picture a frame chooses, as `object-fit: cover` with `object-position` would show it.
pub fn crop_of(width: f64, height: f64, w: f64, h: f64, frame: Option<CoverFrame>) -> (f64, f64, f64, f64) {
    let (x, y, zoom) = frame.map_or((50.0, 50.0, 1.0), |f| (f.x, f.y, f.zoom.max(1.0)));
    let fit = (w / width).max(h / height);
    let left = (w - width * fit) * (x / 100.0);
    let top = (h - height * fit) * (y / 100.0);
    let sw = w / zoom / fit;
    let sh = h / zoom / fit;
    let sx = ((w * (x / 100.0) * (1.0 - 1.0 / zoom) - left) / fit).max(0.0).min(width - sw);
    let sy = ((h * (y / 100.0) * (1.0 - 1.0 / zoom) - top) / fit).max(0.0).min(height - sh);
    (sx, sy, sw, sh)
}

fn drawn(picture: &DynamicImage, frame: Option<CoverFrame>, w: u32, h: u32) -> DynamicImage {
    let (width, height) = picture.dimensions();
    let (sx, sy, sw, sh) = crop_of(width as f64, height as f64, w as f64, h as f64, frame);
    let part = picture.crop_imm(sx.round() as u32, sy.round() as u32, (sw.round() as u32).max(1), (sh.round() as u32).max(1));
    part.resize_exact(w, h, FilterType::Lanczos3)
}

/// The picture of a cover at a size, kind byte first; `None` when there is none to be had.
pub fn thumb_of(src: &str, frame: Option<CoverFrame>, manga: bool, tier: Tier) -> Option<Vec<u8>> {
    let picture = picture_of(src)?;
    if tier == Tier::Winzig {
        let small = drawn(&picture, frame, RAW_W as u32, RAW_H as u32);
        return pack_raw(small.to_rgba8().as_raw());
    }
    let (width, limit) = if tier == Tier::Klein { (40u32, 1100usize) } else { (96, 4500) };
    let height = (width as f64 * sondra_merk::cover::aspect(manga)).round() as u32;
    let rgb = drawn(&picture, frame, width, height).to_rgb8();
    let mut quality = if tier == Tier::Klein { 35u8 } else { 55 };
    let body = loop {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&rgb).ok()?;
        if out.len() <= limit || quality <= 14 {
            break out;
        }
        quality -= 10;
    };
    (body.len() < THUMB_MAX).then(|| [vec![KIND_JPEG], body].concat())
}

/// The pictures of these entries at a size: by id, only those that have one.
pub fn thumbs_for(items: &[Item], tier: Tier) -> HashMap<String, Vec<u8>> {
    items
        .iter()
        .filter_map(|item| {
            let (src, frame) = cover_of(item)?;
            let manga = item.tile_format.as_deref() == Some("manga");
            thumb_of(&src, frame, manga, tier).map(|t| (item.id.clone(), t))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_cover(w: u32, h: u32) -> String {
        use base64::Engine;
        let picture = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 120]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&picture).unwrap();
        format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out))
    }

    #[test]
    fn each_size_is_a_picture_the_reader_believes() {
        let src = data_cover(300, 450);
        let tiny = thumb_of(&src, None, false, Tier::Winzig).unwrap();
        assert_eq!(tiny.len(), sondra_merk::cover::RAW_BYTES);
        let small = thumb_of(&src, None, false, Tier::Klein).unwrap();
        let big = thumb_of(&src, None, false, Tier::Gross).unwrap();
        for t in [&tiny, &small, &big] {
            assert!(sondra_merk::cover::valid_thumb(t), "{}", t.len());
        }
        assert!(small.len() <= 1101 + 200 && big.len() > small.len());
        assert!(thumb_of("nichts", None, false, Tier::Klein).is_none());
    }

    #[test]
    fn the_frame_chooses_the_part_as_a_tile_shows_it() {
        // A wide picture in a tall box: the middle without a frame, the left edge at x = 0.
        let (sx, _, sw, sh) = crop_of(400.0, 200.0, 40.0, 60.0, None);
        assert!((sw / sh - 40.0 / 60.0).abs() < 1e-9);
        assert!((sx - (400.0 - sw) / 2.0).abs() < 1e-6);
        let (sx, ..) = crop_of(400.0, 200.0, 40.0, 60.0, Some(CoverFrame { x: 0.0, y: 50.0, zoom: 1.0 }));
        assert!(sx.abs() < 1e-6);
    }
}
