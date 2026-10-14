/**
 * Stem separation that runs with no model download and no network access.
 *
 * The default engine combines two classical, well-understood techniques:
 *
 *  1. Harmonic/percussive source separation (Fitzgerald 2010) — median filtering
 *     a magnitude spectrogram along time suppresses transients and leaves the
 *     harmonic layer; median filtering along frequency does the opposite. Drums
 *     fall out of the percussive layer.
 *  2. Centre-channel estimation — in almost every mix, lead vocals sit dead
 *     centre, so the per-bin similarity between left and right is a good vocal
 *     likelihood. Combined with a vocal-range band weight it isolates the lead.
 *
 * The four affinities are normalised per bin, so the stems sum back to the
 * original signal sample for sample rather than drifting apart.
 *
 * A neural model can be plugged in on top — see `./onnx.ts`. This module is the
 * fallback that always works, offline, on any machine.
 */

import { applyMask, istft, magnitudeOf, stft, type Spectrogram } from './fft'
import type { AudioData } from './wav'

export const STEM_IDS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemId = (typeof STEM_IDS)[number]

export const STEM_LABELS: Record<StemId, string> = {
  vocals: 'Gesang',
  drums: 'Schlagzeug',
  bass: 'Bass',
  other: 'Übriges',
}

export interface SeparationOptions {
  fftSize: number
  hopSize: number
  /** Median filter length along time, in frames. Longer = smoother harmonics. */
  timeKernel: number
  /** Median filter length along frequency, in bins. */
  freqKernel: number
  /** Mask sharpness. 1 is soft, 2 is Wiener-like, higher approaches binary. */
  maskExponent: number
  /** 0 keeps a wide vocal image, 1 only keeps the dead-centre signal. */
  vocalFocus: number
  /** Chunk length, which bounds peak memory regardless of file length. */
  segmentSeconds: number
  /** Crossfade between chunks. */
  overlapSeconds: number
}

export const DEFAULT_SEPARATION: SeparationOptions = {
  fftSize: 4096,
  hopSize: 1024,
  timeKernel: 17,
  freqKernel: 17,
  maskExponent: 2.8,
  vocalFocus: 0.65,
  segmentSeconds: 24,
  overlapSeconds: 1,
}

type Progress = (fraction: number, note?: string) => void

/* -------------------------------------------------------------------------- */
/* Sliding median                                                              */
/* -------------------------------------------------------------------------- */

/** Removes one occurrence of `value` from a sorted window of length `k`. */
function sortedRemove(window: Float32Array, k: number, value: number): void {
  let lo = 0
  let hi = k - 1
  let index = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (window[mid] === value) {
      index = mid
      break
    }
    if (window[mid] < value) lo = mid + 1
    else hi = mid - 1
  }
  if (index < 0) index = Math.min(lo, k - 1)
  window.copyWithin(index, index + 1, k)
}

/** Inserts `value` into a sorted window that currently holds `k - 1` entries. */
function sortedInsert(window: Float32Array, k: number, value: number): void {
  let lo = 0
  let hi = k - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (window[mid] < value) lo = mid + 1
    else hi = mid
  }
  window.copyWithin(lo + 1, lo, k - 1)
  window[lo] = value
}

/**
 * Median filter along one strided axis of a 2-D array, with edge replication.
 *
 * The window is kept sorted between steps, so each output costs one removal and
 * one insertion instead of a fresh sort.
 */
function medianFilterAxis(
  source: Float32Array,
  target: Float32Array,
  base: number,
  stride: number,
  count: number,
  k: number,
  window: Float32Array,
): void {
  const half = k >> 1
  const at = (i: number) => source[base + Math.min(count - 1, Math.max(0, i)) * stride]

  for (let i = 0; i < k; i += 1) window[i] = at(i - half)
  window.subarray(0, k).sort()

  for (let i = 0; i < count; i += 1) {
    target[base + i * stride] = window[half]
    if (i === count - 1) break
    sortedRemove(window, k, at(i - half))
    sortedInsert(window, k, at(i + half + 1))
  }
}

/** Harmonic estimate: median across time, per frequency bin. */
function medianOverTime(mag: Float32Array, frames: number, bins: number, k: number): Float32Array {
  const out = new Float32Array(mag.length)
  const window = new Float32Array(k)
  for (let b = 0; b < bins; b += 1) medianFilterAxis(mag, out, b, bins, frames, k, window)
  return out
}

/** Percussive estimate: median across frequency, per frame. */
function medianOverFrequency(mag: Float32Array, frames: number, bins: number, k: number): Float32Array {
  const out = new Float32Array(mag.length)
  const window = new Float32Array(k)
  for (let f = 0; f < frames; f += 1) medianFilterAxis(mag, out, f * bins, 1, bins, k, window)
  return out
}

/* -------------------------------------------------------------------------- */
/* Band weights                                                                */
/* -------------------------------------------------------------------------- */

/** Raised-cosine ramp from 0 at `from` to 1 at `to`. */
function ramp(value: number, from: number, to: number): number {
  if (value <= from) return 0
  if (value >= to) return 1
  return 0.5 - 0.5 * Math.cos((Math.PI * (value - from)) / (to - from))
}

interface BandWeights {
  vocal: Float32Array
  bass: Float32Array
}

function bandWeights(bins: number, fftSize: number, sampleRate: number): BandWeights {
  const vocal = new Float32Array(bins)
  const bass = new Float32Array(bins)
  for (let b = 0; b < bins; b += 1) {
    const hz = (b * sampleRate) / fftSize
    // Lead vocals: nothing below the male fundamental, full through the
    // formant range, tapering across sibilance rather than cutting it off.
    vocal[b] = ramp(hz, 70, 200) * (1 - 0.75 * ramp(hz, 7000, 16000))
    // Bass: the region where bass guitar and kick fundamentals live.
    bass[b] = 1 - ramp(hz, 110, 380)
  }
  return { vocal, bass }
}

/* -------------------------------------------------------------------------- */
/* Mask construction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds one normalised mask per stem for a single chunk.
 *
 * `specs` holds one spectrogram per input channel; masks are shared across
 * channels so the stereo image of each stem stays intact.
 */
function buildMasks(
  specs: Spectrogram[],
  sampleRate: number,
  options: SeparationOptions,
): Record<StemId, Float32Array> {
  const { frames, bins, fftSize } = specs[0]
  const cells = frames * bins
  const magnitudes = specs.map(magnitudeOf)

  // Analysis runs on the channel sum, so every stem sees the same decomposition.
  const summed = new Float32Array(cells)
  for (const mag of magnitudes) {
    for (let i = 0; i < cells; i += 1) summed[i] += mag[i]
  }

  const harmonic = medianOverTime(summed, frames, bins, options.timeKernel | 1)
  const percussive = medianOverFrequency(summed, frames, bins, options.freqKernel | 1)

  const { vocal, bass } = bandWeights(bins, fftSize, sampleRate)
  const stereo = specs.length >= 2
  const exponent = options.maskExponent
  const focus = options.vocalFocus
  const epsilon = 1e-10

  const masks: Record<StemId, Float32Array> = {
    vocals: new Float32Array(cells),
    drums: new Float32Array(cells),
    bass: new Float32Array(cells),
    other: new Float32Array(cells),
  }

  const left = specs[0]
  const right = stereo ? specs[1] : specs[0]

  for (let f = 0; f < frames; f += 1) {
    const rowOffset = f * bins
    for (let b = 0; b < bins; b += 1) {
      const i = rowOffset + b

      const h = harmonic[i] ** exponent
      const p = percussive[i] ** exponent
      const hp = h + p + epsilon
      const harmonicShare = h / hp
      const percussiveShare = p / hp

      // How close to the centre of the image this bin sits. Mono material has
      // no image to measure, so it stays neutral and the band weights lead.
      let centred = 0.5
      if (stereo) {
        const dr = left.real[i] - right.real[i]
        const di = left.imag[i] - right.imag[i]
        const difference = Math.hypot(dr, di)
        const total = Math.hypot(left.real[i], left.imag[i]) + Math.hypot(right.real[i], right.imag[i])
        centred = total > epsilon ? 1 - difference / total : 0.5
        // `focus` sharpens the centre estimate towards a hard gate.
        centred = Math.max(0, Math.min(1, (centred - focus * 0.5) / (1 - focus * 0.5 + epsilon)))
      }

      const vocalBand = vocal[b]
      const bassBand = bass[b]
      const nonBass = 1 - bassBand

      // Non-linear contrast enhancement for stereo centre purity
      const centrePurity = Math.pow(centred, 1.8 + focus * 1.4)
      const hScore = Math.pow(harmonicShare, 1.2)
      const pScore = Math.pow(percussiveShare, 1.2)

      const vocalScore = hScore * centrePurity * vocalBand * nonBass
      // Bass carries the pluck as well as the note, so it draws on both layers.
      const bassScore = (0.85 * hScore + 0.15 * pScore) * bassBand
      const drumScore = pScore * (1 - 0.65 * bassBand)
      const otherScore = hScore * (1 - centrePurity * vocalBand) * nonBass

      const total = vocalScore + bassScore + drumScore + otherScore + epsilon
      // Soft thresholding / contrast sharpening
      const v = Math.pow(vocalScore / total, 1.15)
      const bs = Math.pow(bassScore / total, 1.15)
      const d = Math.pow(drumScore / total, 1.15)
      const o = Math.pow(otherScore / total, 1.15)
      const sum = v + bs + d + o + epsilon

      masks.vocals[i] = v / sum
      masks.bass[i] = bs / sum
      masks.drums[i] = d / sum
      masks.other[i] = o / sum
    }
  }

  return masks
}

/* -------------------------------------------------------------------------- */
/* Chunked driver                                                              */
/* -------------------------------------------------------------------------- */

export type SeparationResult = Record<StemId, AudioData>

/**
 * Separates `audio` into four stems.
 *
 * Work is chunked so peak memory depends on `segmentSeconds`, not on the length
 * of the file — an hour-long recording uses the same memory as a three-minute
 * one. Chunks are linearly crossfaded, which reconstructs exactly because the
 * two sides of an overlap carry the same signal.
 */
export function separate(
  audio: AudioData,
  options: SeparationOptions = DEFAULT_SEPARATION,
  onProgress?: Progress,
): SeparationResult {
  const { sampleRate } = audio
  const frames = audio.channels[0]?.length ?? 0
  const channelCount = audio.channels.length

  const result = Object.fromEntries(
    STEM_IDS.map((id) => [
      id,
      { channels: Array.from({ length: channelCount }, () => new Float32Array(frames)), sampleRate },
    ]),
  ) as SeparationResult

  if (frames === 0) return result

  const overlap = Math.max(options.fftSize, Math.round(options.overlapSeconds * sampleRate))
  const segment = Math.max(overlap * 3, Math.round(options.segmentSeconds * sampleRate))
  const step = segment - overlap
  const segmentCount = Math.max(1, Math.ceil((frames - overlap) / step))

  for (let s = 0; s < segmentCount; s += 1) {
    const start = s * step
    const end = Math.min(frames, start + segment)
    const length = end - start
    if (length <= 0) break

    const slices = audio.channels.map((channel) => channel.subarray(start, end))
    const specs = slices.map((slice) => stft(slice, options.fftSize, options.hopSize))
    const masks = buildMasks(specs, sampleRate, options)

    for (const id of STEM_IDS) {
      for (let c = 0; c < channelCount; c += 1) {
        const rendered = istft(applyMask(specs[c], masks[id]))
        const target = result[id].channels[c]
        for (let i = 0; i < length; i += 1) {
          // Fade the head of every chunk but the first, and the tail of every
          // chunk but the last, so the crossfades sum to unity.
          let weight = 1
          if (s > 0 && i < overlap) weight = i / overlap
          if (s < segmentCount - 1 && i >= length - overlap && end < frames) {
            weight = Math.min(weight, (length - i) / overlap)
          }
          target[start + i] += rendered[i] * weight
        }
      }
    }

    onProgress?.((s + 1) / segmentCount, `Segment ${s + 1} von ${segmentCount}`)
  }

  return result
}

/**
 * Karaoke-style split. Derived by subtraction rather than by a second mask pass,
 * so vocals and instrumental add back to exactly the input.
 */
export function toInstrumental(original: AudioData, vocals: AudioData): AudioData {
  const channels = original.channels.map((channel, c) => {
    const out = new Float32Array(channel.length)
    const vocalChannel = vocals.channels[c]
    for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] - (vocalChannel?.[i] ?? 0)
    return out
  })
  return { channels, sampleRate: original.sampleRate }
}
