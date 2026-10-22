/**
 * Finding the opening of a series by ear.
 *
 * Two episodes of a series share their opening, note for note, wherever it
 * sits — after a cold open of four minutes or at the very start. So the
 * sound of the first minutes of each is turned into a fingerprint, ten
 * frames a second of 32 bits each, and the longest stretch the two have in
 * common is the opening. Kept with the series, that stretch is then found
 * again in every other episode, and „Vorspann überspringen" appears exactly
 * while it plays and jumps to its end.
 *
 * The fingerprint is the one Haitsma and Kalker described for audio
 * identification (2002): energies in 33 bands between 300 and 2000 Hz, and
 * per band the sign of how the difference to its neighbour changed since
 * the frame before. It survives another encode, another loudness and a bit
 * of noise; it does not survive a different song, which is the point.
 * Quiet frames carry no tune and never count as a match — two episodes that
 * both begin with silence have not just shared an opening.
 *
 * Pure and synchronous, so `scripts/verify-intro.mts` checks it under Node;
 * in the page it runs in `workers/intro.worker.ts`.
 */

import { Fft } from './fft'

/** The rate the sound is decoded at for this; the bands end at 2000 Hz. */
export const PRINT_RATE = 8000
/** Frames per second of the fingerprint. */
export const PRINT_FPS = 10
const HOP = PRINT_RATE / PRINT_FPS
const WINDOW = 2048
const BANDS = 33
const LOW = 300
const HIGH = 2000
/** Bits that may differ for two frames still to count as the same. */
const MAX_ERRORS = 10
/** A gap of this many frames without a match ends a shared stretch. */
const MAX_GAP = 20
/** The windows, in frames, over which a stretch's ends must match densely: three seconds, then one. */
const EDGE_WINDOWS = [30, 10]
const EDGE_DENSITY = 0.6
/** Openings are between these lengths, in seconds. */
export const INTRO_MIN = 15
export const INTRO_MAX = 200

export interface Print {
  /** One 32-bit word per frame. */
  bits: Uint32Array
  /** Frames too quiet to carry a tune: never a match. */
  quiet: Uint8Array
}

/** The fingerprint of mono sound at `PRINT_RATE`. */
export function fingerprint(samples: Float32Array | Int16Array): Print {
  const scale = samples instanceof Int16Array ? 1 / 32768 : 1
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP) + 1)
  const bits = new Uint32Array(frames)
  const quiet = new Uint8Array(frames)
  const fft = new Fft(WINDOW)
  const real = new Float64Array(WINDOW)
  const imag = new Float64Array(WINDOW)
  const hann = new Float64Array(WINDOW)
  for (let i = 0; i < WINDOW; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))

  // Band edges as FFT bins, spaced evenly on a log scale.
  const edges = new Int32Array(BANDS + 1)
  for (let band = 0; band <= BANDS; band += 1) {
    const hz = LOW * (HIGH / LOW) ** (band / BANDS)
    edges[band] = Math.round((hz / PRINT_RATE) * WINDOW)
  }

  let previous = new Float64Array(BANDS)
  let current = new Float64Array(BANDS)
  const levels = new Float64Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * HOP
    for (let i = 0; i < WINDOW; i += 1) {
      real[i] = samples[offset + i] * scale * hann[i]
      imag[i] = 0
    }
    fft.forward(real, imag)
    let total = 0
    for (let band = 0; band < BANDS; band += 1) {
      let energy = 0
      const to = Math.max(edges[band] + 1, edges[band + 1])
      for (let bin = edges[band]; bin < to; bin += 1) energy += real[bin] * real[bin] + imag[bin] * imag[bin]
      current[band] = energy
      total += energy
    }
    levels[frame] = total
    let word = 0
    if (frame > 0) {
      for (let band = 0; band < BANDS - 1; band += 1) {
        const change = current[band] - current[band + 1] - (previous[band] - previous[band + 1])
        if (change > 0) word |= 1 << band
      }
    }
    bits[frame] = word >>> 0
    const swap = previous
    previous = current
    current = swap
  }

  // Quiet against this file's own loudness, so a soft mix is not all quiet.
  const sorted = Float64Array.from(levels).sort()
  const typical = sorted.length ? sorted[Math.floor(sorted.length * 0.6)] : 0
  const floor = Math.max(typical * 0.002, 1e-6)
  for (let frame = 0; frame < frames; frame += 1) if (levels[frame] < floor) quiet[frame] = 1
  if (frames > 0) quiet[0] = 1
  return { bits, quiet }
}

function errors(a: number, b: number): number {
  let x = (a ^ b) >>> 0
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

const matches = (a: Print, i: number, b: Print, j: number) => !a.quiet[i] && !b.quiet[j] && errors(a.bits[i], b.bits[j]) <= MAX_ERRORS

export interface Shared {
  /** Where the stretch is in the first file, and in the second, in frames. */
  a: number
  b: number
  frames: number
  /** The share of its frames that matched. */
  score: number
  /** Frames that matched: what ranks one stretch over another. */
  matched: number
}

/**
 * The stretch two fingerprints share most of, if one lasts long enough to
 * be an opening: every alignment of the two is walked, and along it
 * matching frames are joined while no gap is longer than two seconds. Ranked
 * by frames that matched, not by length: a piece of background music that
 * comes back under different dialogue matches in patches, an opening in one
 * piece.
 */
export function longestShared(a: Print, b: Print, minSeconds = INTRO_MIN, maxSeconds = INTRO_MAX): Shared | null {
  const min = minSeconds * PRINT_FPS
  const max = maxSeconds * PRINT_FPS
  let best: Shared | null = null
  const na = a.bits.length
  const nb = b.bits.length
  for (let shift = -(na - min); shift <= nb - min; shift += 1) {
    // Frame i of a lies against frame i + shift of b.
    const from = Math.max(0, -shift)
    const to = Math.min(na, nb - shift)
    let start = -1
    let last = -1
    let count = 0
    const close = () => {
      if (start < 0) return
      const frames = last - start + 1
      const score = count / frames
      if (frames >= min && frames <= max && score >= 0.5 && (best === null || count > best.matched)) {
        best = { a: start, b: start + shift, frames, score, matched: count }
      }
    }
    for (let i = from; i < to; i += 1) {
      if (matches(a, i, b, i + shift)) {
        if (start < 0 || i - last > MAX_GAP) {
          close()
          start = i
          count = 0
        }
        last = i
        count += 1
      }
    }
    close()
  }
  return best ? trimmed(a, b, best, min) : null
}

/**
 * The stretch without its loose ends. Music that comes back under other
 * dialogue right after an opening still matches in patches, enough to join
 * on; an opening matches nearly frame for frame. So each end moves inward
 * until the three seconds next to it match densely, and then until the one
 * second next to it does — the coarse pass alone left a second of the
 * patchy part on.
 */
function trimmed(a: Print, b: Print, found: Shared, min: number): Shared | null {
  const shift = found.b - found.a
  const hits = new Uint8Array(found.frames)
  for (let k = 0; k < found.frames; k += 1) hits[k] = matches(a, found.a + k, b, found.a + k + shift) ? 1 : 0
  const dense = (k: number, window: number) => {
    let count = 0
    let seen = 0
    for (let j = k; j < k + window && j < found.frames; j += 1) {
      seen += 1
      count += hits[j]
    }
    return seen > 0 && count / seen >= EDGE_DENSITY
  }
  let start = 0
  let end = found.frames - 1
  for (const window of EDGE_WINDOWS) {
    while (start < end && !(hits[start] && dense(start, window))) start += 1
    while (end > start && !(hits[end] && dense(Math.max(start, end - window + 1), window))) end -= 1
  }
  const frames = end - start + 1
  if (frames < min) return null
  let matched = 0
  for (let k = start; k <= end; k += 1) matched += hits[k]
  return { a: found.a + start, b: found.b + start, frames, score: matched / frames, matched }
}

/** Where a known opening lies in a file: its first frame and how well it matched, or null. */
export function locate(reference: Print, target: Print): { at: number; score: number } | null {
  const n = reference.bits.length
  if (n === 0 || target.bits.length < n * 0.6) return null
  let usable = 0
  for (let k = 0; k < n; k += 1) if (!reference.quiet[k]) usable += 1
  if (usable < n * 0.5) return null
  let best: { at: number; score: number } | null = null
  // The opening may run past the end of what was decoded, by a little.
  const last = target.bits.length - Math.floor(n * 0.6)
  for (let at = 0; at <= last; at += 1) {
    let hits = 0
    let seen = 0
    for (let k = 0; k < n && at + k < target.bits.length; k += 1) {
      if (reference.quiet[k]) continue
      seen += 1
      if (matches(reference, k, target, at + k)) hits += 1
    }
    const score = seen ? hits / usable : 0
    if (!best || score > best.score) best = { at, score }
  }
  return best && best.score >= 0.35 ? best : null
}

/** A stretch of a fingerprint, to keep as the series' opening. */
export function slice(print: Print, from: number, frames: number): Print {
  return { bits: print.bits.slice(from, from + frames), quiet: print.quiet.slice(from, from + frames) }
}

/**
 * The opening as text, for the Merkliste (and with it Anytype and Drive):
 * five bytes a frame — the word and whether it is quiet — in base64.
 */
export function encodePrint(print: Print): string {
  const bytes = new Uint8Array(print.bits.length * 5)
  for (let i = 0; i < print.bits.length; i += 1) {
    const word = print.bits[i]
    bytes[i * 5] = word & 0xff
    bytes[i * 5 + 1] = (word >>> 8) & 0xff
    bytes[i * 5 + 2] = (word >>> 16) & 0xff
    bytes[i * 5 + 3] = (word >>> 24) & 0xff
    bytes[i * 5 + 4] = print.quiet[i]
  }
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export function decodePrint(text: string): Print | null {
  try {
    const raw = atob(text)
    if (raw.length === 0 || raw.length % 5 !== 0) return null
    const frames = raw.length / 5
    const bits = new Uint32Array(frames)
    const quiet = new Uint8Array(frames)
    for (let i = 0; i < frames; i += 1) {
      bits[i] =
        (raw.charCodeAt(i * 5) | (raw.charCodeAt(i * 5 + 1) << 8) | (raw.charCodeAt(i * 5 + 2) << 16) | (raw.charCodeAt(i * 5 + 3) << 24)) >>> 0
      quiet[i] = raw.charCodeAt(i * 5 + 4) ? 1 : 0
    }
    return { bits, quiet }
  } catch {
    return null
  }
}
