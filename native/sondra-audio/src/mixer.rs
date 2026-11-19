//! What goes to the speakers, and what has been heard. No device in here: it is handed a buffer to fill and
//! says how many frames of real sound went into it.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

/// A frame is one sample for every channel; time is counted in frames.
struct State {
    /// Interleaved samples waiting to be heard.
    queue: VecDeque<f32>,
    /// Frames heard since the last `clear` (silence is not counted: the clock stands still when the
    /// sound has run out, as a film does that waits for its decoder).
    heard_frames: u64,
    paused: bool,
    volume: f32,
    /// How much may wait in the queue, in samples; a producer waits when it is full.
    capacity: usize,
}

/// The queue between the decoder and the speakers, with its clock. Cloned handles share one queue.
#[derive(Clone)]
pub struct Shared {
    inner: Arc<(Mutex<State>, Condvar)>,
    channels: usize,
    rate: u32,
}

impl Shared {
    /// A queue for `channels` channels at `rate` frames a second, holding about `seconds` of sound.
    pub fn new(rate: u32, channels: usize, seconds: f32) -> Shared {
        let capacity = ((rate as f32 * seconds) as usize).max(1) * channels.max(1);
        Shared {
            inner: Arc::new((
                Mutex::new(State { queue: VecDeque::new(), heard_frames: 0, paused: false, volume: 1.0, capacity }),
                Condvar::new(),
            )),
            channels: channels.max(1),
            rate,
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Puts samples (interleaved, as many channels as the queue has) in line; waits while the queue is full
    /// — a decoder that runs ahead waits for the speakers, which is what keeps it from eating the memory.
    /// Returns `false` when `stop` was raised while waiting.
    pub fn push(&self, samples: &[f32], stop: &std::sync::atomic::AtomicBool) -> bool {
        let (lock, cv) = &*self.inner;
        let mut state = lock.lock().expect("lock");
        let mut rest = samples;
        while !rest.is_empty() {
            if stop.load(std::sync::atomic::Ordering::Relaxed) {
                return false;
            }
            let room = state.capacity.saturating_sub(state.queue.len());
            if room == 0 {
                // Woken by the speakers taking sound, or after a short while to look at `stop` again.
                let (s, _) = cv.wait_timeout(state, std::time::Duration::from_millis(50)).expect("lock");
                state = s;
                continue;
            }
            let take = room.min(rest.len());
            state.queue.extend(&rest[..take]);
            rest = &rest[take..];
        }
        true
    }

    /// Throws away what has not been heard yet and starts the clock at zero: a jump to another place.
    pub fn clear(&self) {
        let (lock, cv) = &*self.inner;
        let mut state = lock.lock().expect("lock");
        state.queue.clear();
        state.heard_frames = 0;
        cv.notify_all();
    }

    pub fn set_volume(&self, volume: f32) {
        self.inner.0.lock().expect("lock").volume = volume.clamp(0.0, 4.0);
    }

    pub fn volume(&self) -> f32 {
        self.inner.0.lock().expect("lock").volume
    }

    pub fn set_paused(&self, paused: bool) {
        self.inner.0.lock().expect("lock").paused = paused;
    }

    pub fn paused(&self) -> bool {
        self.inner.0.lock().expect("lock").paused
    }

    /// Seconds of sound heard since the last `clear`.
    pub fn heard(&self) -> f64 {
        self.inner.0.lock().expect("lock").heard_frames as f64 / self.rate as f64
    }

    /// Seconds of sound waiting to be heard.
    pub fn buffered(&self) -> f64 {
        let state = self.inner.0.lock().expect("lock");
        state.queue.len() as f64 / (self.channels as f64 * self.rate as f64)
    }
}

/// Fills the buffers the sound card asks for.
pub struct Mixer {
    shared: Shared,
}

impl Mixer {
    pub fn new(shared: Shared) -> Mixer {
        Mixer { shared }
    }

    /// Fills `out` (interleaved, the channels of the queue): sound from the queue at the volume, silence for
    /// what is missing or while paused. Returns the frames of real sound that went in.
    pub fn fill(&mut self, out: &mut [f32]) -> usize {
        let (lock, cv) = &*self.shared.inner;
        let mut state = lock.lock().expect("lock");
        if state.paused {
            out.fill(0.0);
            return 0;
        }
        let volume = state.volume;
        let take = out.len().min(state.queue.len());
        // Whole frames only: a half frame would shift the channels from then on.
        let take = take - take % self.shared.channels;
        for (slot, sample) in out[..take].iter_mut().zip(state.queue.drain(..take)) {
            *slot = sample * volume;
        }
        out[take..].fill(0.0);
        let frames = take / self.shared.channels;
        state.heard_frames += frames as u64;
        cv.notify_all();
        frames
    }
}
