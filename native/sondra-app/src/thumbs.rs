//! The small pictures of the Ordner tiles (`src/lib/thumbnails.ts`): a frame of a film from about 15 % of its
//! length, an image itself, and for films and sounds how long they are. Made in the background, two at a
//! time, in the order the tiles are drawn — a folder of hundreds of films must not start hundreds of FFmpegs.
//! What is made is kept by the file and its size, so another visit to the same folder asks nothing.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;

use gpui::Context;
use sondra_media::thumbnail::{of_audio, of_image, of_video};
use sondra_media::Ffmpeg;
use sondra_merk::folder::AssetKind;

use crate::covers::{render_bytes, Covers};
use crate::shell::Shell;

/// The size a tile's picture is made at, in device pixels (the tile shows it at 232 × 130).
pub const PICTURE: (u32, u32) = (320, 180);
/// How many are made at once.
pub const AT_ONCE: usize = 2;

struct Job {
    key: String,
    path: PathBuf,
    kind: AssetKind,
}

#[derive(Default)]
pub struct Thumbs {
    pub covers: Covers,
    /// How long each file is, where that is known (`Some(None)`: asked, no length).
    pub seconds: HashMap<String, Option<f64>>,
    waiting: VecDeque<Job>,
    running: usize,
}

pub type SharedThumbs = Rc<RefCell<Thumbs>>;

/// What stands for a file in the cache: where it is and how big.
pub fn key_of(path: &std::path::Path, size: u64, modified: i64) -> String {
    format!("{}|{size}|{modified}", path.display())
}

impl Thumbs {
    /// The state of a file's picture: made (`Some(Some)`), could not be made (`Some(None)`), or not yet. A file
    /// not asked for yet is put in the queue.
    pub fn ask(&mut self, key: &str, path: PathBuf, kind: AssetKind) -> Option<Option<std::sync::Arc<gpui::RenderImage>>> {
        if let Some(state) = self.covers.get(key) {
            return Some(state);
        }
        if self.covers.begin(key) {
            self.waiting.push_back(Job { key: key.to_owned(), path, kind });
        }
        None
    }

    /// Forgets what is waiting (another folder is open); what runs is let finish.
    pub fn clear_waiting(&mut self) {
        self.waiting.clear();
    }

    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }

    pub fn running(&self) -> usize {
        self.running
    }
}

impl Shell {
    /// Starts what is waiting, up to two at a time; each one that ends starts the next.
    pub(crate) fn pump_thumbs(&mut self, cx: &mut Context<Self>) {
        loop {
            let job = {
                let mut t = self.folder.thumbs.borrow_mut();
                if t.running >= AT_ONCE {
                    return;
                }
                let Some(job) = t.waiting.pop_front() else { return };
                t.running += 1;
                job
            };
            let key = job.key.clone();
            Self::in_background(
                cx,
                move || {
                    let thumb = match job.kind {
                        AssetKind::Image => of_image(&job.path),
                        AssetKind::Video => Ffmpeg::locate().map(|ff| of_video(&ff, &job.path, PICTURE.0)).unwrap_or_default(),
                        AssetKind::Audio => Ffmpeg::locate().map(|ff| of_audio(&ff, &job.path)).unwrap_or_default(),
                        _ => Default::default(),
                    };
                    let made = thumb.picture.as_deref().and_then(|bytes| render_bytes(bytes, None, PICTURE.0, PICTURE.1));
                    (made, thumb.seconds)
                },
                move |shell, (made, seconds), cx| {
                    {
                        let mut t = shell.folder.thumbs.borrow_mut();
                        t.running = t.running.saturating_sub(1);
                        t.covers.finish(&key, made);
                        t.seconds.insert(key, seconds);
                    }
                    shell.pump_thumbs(cx);
                    cx.notify();
                },
            );
        }
    }

    /// For tests: the lengths found so far, shortest first.
    pub fn thumb_seconds(&self) -> Vec<f64> {
        let mut all: Vec<f64> = self.folder.thumbs.borrow().seconds.values().filter_map(|s| *s).collect();
        all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        all
    }

    /// For tests: how many pictures are made, and how many wait.
    pub fn thumbs_state(&self) -> (usize, usize) {
        let t = self.folder.thumbs.borrow();
        (t.covers.ready(), t.waiting())
    }
}

/// „3:07“ or „1:02:30“.
pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_length_is_said_the_short_way() {
        assert_eq!(clock(7.0), "0:07");
        assert_eq!(clock(187.4), "3:07");
        assert_eq!(clock(3750.0), "1:02:30");
    }
}
