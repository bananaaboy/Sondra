//! Iterative radix-2 FFT plus a short-time Fourier transform built on it. A port of `src/lib/fft.ts`,
//! the shared front end of stem separation, speech enhancement, chroma and key detection.

use std::f64::consts::PI;

pub struct Fft {
    pub size: usize,
    cos: Vec<f64>,
    sin: Vec<f64>,
    reverse: Vec<u32>,
}

impl Fft {
    /// `size` must be a power of two.
    pub fn new(size: usize) -> Result<Self, &'static str> {
        if size < 2 || size & (size - 1) != 0 {
            return Err("FFT-Größe muss eine Zweierpotenz sein");
        }
        let levels = size.trailing_zeros();
        let half = size / 2;
        let cos = (0..half)
            .map(|i| (2.0 * PI * i as f64 / size as f64).cos())
            .collect();
        let sin = (0..half)
            .map(|i| (2.0 * PI * i as f64 / size as f64).sin())
            .collect();
        // Bit-reversal permutation table.
        let reverse = (0..size)
            .map(|i| {
                let (mut x, mut r) = (i as u32, 0u32);
                for _ in 0..levels {
                    r = (r << 1) | (x & 1);
                    x >>= 1;
                }
                r
            })
            .collect();
        Ok(Self {
            size,
            cos,
            sin,
            reverse,
        })
    }

    /// In-place complex FFT (decimation in time).
    pub fn forward(&self, real: &mut [f64], imag: &mut [f64]) {
        self.transform(real, imag);
    }

    /// In-place inverse FFT, scaled by 1/N so `inverse(forward(x)) == x`.
    pub fn inverse(&self, real: &mut [f64], imag: &mut [f64]) {
        // conj → forward → conj → scale, by swapping the two halves.
        self.transform(imag, real);
        let scale = 1.0 / self.size as f64;
        for i in 0..self.size {
            real[i] *= scale;
            imag[i] *= scale;
        }
    }

    fn transform(&self, real: &mut [f64], imag: &mut [f64]) {
        let n = self.size;
        for i in 0..n {
            let j = self.reverse[i] as usize;
            if j > i {
                real.swap(i, j);
                imag.swap(i, j);
            }
        }
        let mut span = 2;
        while span <= n {
            let half = span / 2;
            let step = n / span;
            let mut i = 0;
            while i < n {
                let mut k = 0;
                for j in i..i + half {
                    let l = j + half;
                    let (wr, wi) = (self.cos[k], -self.sin[k]);
                    let tr = real[l] * wr - imag[l] * wi;
                    let ti = real[l] * wi + imag[l] * wr;
                    real[l] = real[j] - tr;
                    imag[l] = imag[j] - ti;
                    real[j] += tr;
                    imag[j] += ti;
                    k += step;
                }
                i += span;
            }
            span *= 2;
        }
    }
}

/// Periodic Hann window — the correct flavour for spectral analysis.
pub fn hann_window(size: usize) -> Vec<f64> {
    (0..size)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / size as f64).cos())
        .collect()
}

/// Square-root Hann. Applied on analysis *and* synthesis it gives exact weighted-overlap-add
/// reconstruction at 75 % overlap.
pub fn sqrt_hann_window(size: usize) -> Vec<f64> {
    hann_window(size).into_iter().map(f64::sqrt).collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Spectrogram {
    /// `frames × bins` real parts, frame-major.
    pub real: Vec<f32>,
    pub imag: Vec<f32>,
    pub frames: usize,
    /// Non-redundant bin count, `fft_size / 2 + 1`.
    pub bins: usize,
    pub fft_size: usize,
    pub hop_size: usize,
    /// Samples the signal was reflected by at the head, for exact undo.
    pub padding: usize,
    pub length: usize,
}

/// Forward STFT with centred frames (the signal is reflected at both edges so that frame `t` is
/// centred on sample `t * hop`).
pub fn stft(signal: &[f32], fft_size: usize, hop_size: usize) -> Result<Spectrogram, &'static str> {
    let fft = Fft::new(fft_size)?;
    let window = sqrt_hann_window(fft_size);
    let padding = fft_size / 2;
    let frames = 1.max(signal.len().div_ceil(hop_size) + 1);
    let bins = fft_size / 2 + 1;
    let len = signal.len() as isize;

    let mut real = vec![0.0f32; frames * bins];
    let mut imag = vec![0.0f32; frames * bins];
    let mut re = vec![0.0f64; fft_size];
    let mut im = vec![0.0f64; fft_size];

    for f in 0..frames {
        let start = (f * hop_size) as isize - padding as isize;
        im.fill(0.0);
        for i in 0..fft_size {
            let at = start + i as isize;
            // Reflect at the boundaries rather than zero-padding, which would show up as a click.
            let mut sample = 0.0f32;
            if at >= 0 && at < len {
                sample = signal[at as usize];
            } else if at < 0 && -at < len {
                sample = signal[(-at) as usize];
            } else if at >= len {
                let mirrored = 2 * len - at - 2;
                if mirrored >= 0 && mirrored < len {
                    sample = signal[mirrored as usize];
                }
            }
            re[i] = f64::from(sample) * window[i];
        }
        fft.forward(&mut re, &mut im);
        let offset = f * bins;
        for b in 0..bins {
            real[offset + b] = re[b] as f32;
            imag[offset + b] = im[b] as f32;
        }
    }
    Ok(Spectrogram {
        real,
        imag,
        frames,
        bins,
        fft_size,
        hop_size,
        padding,
        length: signal.len(),
    })
}

/// Inverse STFT with weighted overlap-add and window-sum normalisation.
pub fn istft(spec: &Spectrogram) -> Result<Vec<f32>, &'static str> {
    let Spectrogram {
        frames,
        bins,
        fft_size,
        hop_size,
        padding,
        length,
        ..
    } = *spec;
    let fft = Fft::new(fft_size)?;
    let window = sqrt_hann_window(fft_size);

    let mut output = vec![0.0f64; length + fft_size];
    let mut weight = vec![0.0f64; length + fft_size];
    let mut re = vec![0.0f64; fft_size];
    let mut im = vec![0.0f64; fft_size];

    for f in 0..frames {
        let offset = f * bins;
        for b in 0..bins {
            re[b] = f64::from(spec.real[offset + b]);
            im[b] = f64::from(spec.imag[offset + b]);
        }
        // Rebuild the conjugate-symmetric upper half before inverting.
        for b in bins..fft_size {
            re[b] = f64::from(spec.real[offset + (fft_size - b)]);
            im[b] = -f64::from(spec.imag[offset + (fft_size - b)]);
        }
        fft.inverse(&mut re, &mut im);

        let start = (f * hop_size) as isize - padding as isize;
        for i in 0..fft_size {
            let at = start + i as isize;
            if at < 0 || at as usize >= output.len() {
                continue;
            }
            output[at as usize] += re[i] * window[i];
            weight[at as usize] += window[i] * window[i];
        }
    }
    Ok((0..length)
        .map(|i| {
            if weight[i] > 1e-8 {
                (output[i] / weight[i]) as f32
            } else {
                0.0
            }
        })
        .collect())
}

/// Per-bin magnitude of a spectrogram, reused by every masking algorithm.
pub fn magnitude_of(spec: &Spectrogram) -> Vec<f32> {
    spec.real
        .iter()
        .zip(&spec.imag)
        .map(|(r, i)| f64::hypot(f64::from(*r), f64::from(*i)) as f32)
        .collect()
}

/// Applies a real-valued mask to a spectrogram, returning a new one.
pub fn apply_mask(spec: &Spectrogram, mask: &[f32]) -> Spectrogram {
    let mut out = spec.clone();
    for (i, m) in mask.iter().enumerate().take(spec.real.len()) {
        out.real[i] = spec.real[i] * m;
        out.imag[i] = spec.imag[i] * m;
    }
    out
}
