//! A long recording in windows of about half a minute, cut at the quietest point near each boundary so a
//! word is not split in two (`windows` and `quietestPoint` of `workers/transcribe.worker.ts`).

pub const RATE: usize = 16000;
pub const WINDOW: usize = 28 * RATE;
/// How far before a window's end the cut may move to find a pause.
pub const SEEK: usize = 3 * RATE;

/// The quietest 20 ms in `[from, to)`, as a sample index.
pub fn quietest_point(samples: &[f32], from: usize, to: usize) -> usize {
    let frame = RATE / 50;
    let (mut best, mut best_energy) = (to, f64::INFINITY);
    let mut start = from;
    while start + frame <= to {
        let mut energy = 0f64;
        let mut i = start;
        while i < start + frame {
            energy += f64::from(samples[i]) * f64::from(samples[i]);
            i += 4;
        }
        if energy < best_energy {
            best_energy = energy;
            best = start + frame / 2;
        }
        start += frame;
    }
    best
}

pub fn windows(samples: &[f32]) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut start = 0;
    while start < samples.len() {
        let mut end = samples.len().min(start + WINDOW);
        if end < samples.len() {
            end = quietest_point(samples, end - SEEK, end);
        }
        result.push((start, end));
        start = end;
    }
    result
}
