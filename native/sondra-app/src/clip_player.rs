//! Plays a stretch of a sound held in memory, for the editors: no file, no FFmpeg — the samples are brought
//! to the sound card's rate and channels and put in its queue, and what has been heard says where the
//! playhead is. Where there is no sound card the silent stand-in keeps the time, so a page behaves the same
//! (and a test can watch it).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use sondra_audio::{Output, Shared};
use sondra_media::audio::AudioData;
use sondra_media::edit::resample_audio;

pub struct ClipPlayer {
    _out: Output,
    shared: Shared,
    stop: Arc<AtomicBool>,
    pushed: Arc<AtomicBool>,
    from: f64,
    thread: Option<JoinHandle<()>>,
}

impl ClipPlayer {
    /// Starts playing `audio` from `from` to `to` seconds.
    pub fn start(audio: &AudioData, from: f64, to: f64) -> ClipPlayer {
        let out = Output::open(1.0);
        let shared = out.shared();
        let part = sondra_media::effects::copy_range(audio, from, to);
        let part = resample_audio(&part, shared.rate());
        let channels = shared.channels();
        let frames = part.frames();
        let mut interleaved = Vec::with_capacity(frames * channels);
        for i in 0..frames {
            for c in 0..channels {
                interleaved.push(part.channels[c.min(part.channels.len() - 1)][i]);
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        let pushed = Arc::new(AtomicBool::new(false));
        let (s, st, p) = (shared.clone(), stop.clone(), pushed.clone());
        let thread = std::thread::spawn(move || {
            for chunk in interleaved.chunks(8192 * channels.max(1)) {
                if !s.push(chunk, &st) {
                    break;
                }
            }
            p.store(true, Ordering::SeqCst);
        });
        ClipPlayer { _out: out, shared, stop, pushed, from, thread: Some(thread) }
    }

    /// Where the sound is now, in seconds from the start of the take.
    pub fn position(&self) -> f64 {
        self.from + self.shared.heard()
    }

    /// Everything was put in line and has been heard.
    pub fn finished(&self) -> bool {
        self.pushed.load(Ordering::SeqCst) && self.shared.buffered() < 0.02
    }
}

impl Drop for ClipPlayer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
