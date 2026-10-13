/**
 * Onset detection by spectral flux.
 *
 * Slicing a break by ear is fine for eight bars and tedious for eighty. Flux —
 * the sum of positive frame-to-frame change across the spectrum — spikes exactly
 * where a new sound starts, which is what a sampler wants to cut on.
 */

import { magnitudeOf, stft } from './fft'
import { mixToMono, type AudioData } from './wav'

export interface OnsetOptions {
  /** Higher keeps only the clearest hits. */
  sensitivity: number
  /** Shortest gap between two slices, in seconds. */
  minimumGapSeconds: number
  fftSize: number
  hopSize: number
}

export const DEFAULT_ONSETS: OnsetOptions = {
  sensitivity: 1.4,
  minimumGapSeconds: 0.08,
  fftSize: 1024,
  hopSize: 256,
}

/** Returns onset positions in seconds, always including the start of the file. */
export function detectOnsets(audio: AudioData, options: OnsetOptions = DEFAULT_ONSETS): number[] {
  const mono = mixToMono(audio).channels[0]
  if (mono.length < options.fftSize * 2) return [0]

  const spec = stft(mono, options.fftSize, options.hopSize)
  const magnitude = magnitudeOf(spec)
  const { frames, bins } = spec

  const flux = new Float32Array(frames)
  for (let f = 1; f < frames; f += 1) {
    let sum = 0
    for (let b = 0; b < bins; b += 1) {
      // Only rising energy counts — a decay is not a new event.
      const delta = magnitude[f * bins + b] - magnitude[(f - 1) * bins + b]
      if (delta > 0) sum += delta
    }
    flux[f] = sum
  }

  // An adaptive threshold tracks the local level, so a quiet passage still
  // yields slices and a loud one does not yield hundreds.
  const window = 24
  const onsets: number[] = []
  const secondsPerFrame = options.hopSize / audio.sampleRate
  const minimumGapFrames = Math.max(1, Math.round(options.minimumGapSeconds / secondsPerFrame))
  let lastOnset = -minimumGapFrames

  for (let f = 1; f < frames; f += 1) {
    const from = Math.max(0, f - window)
    const to = Math.min(frames, f + window)
    let mean = 0
    for (let i = from; i < to; i += 1) mean += flux[i]
    mean /= to - from

    const isPeak = flux[f] > flux[f - 1] && (f + 1 >= frames || flux[f] >= flux[f + 1])
    if (isPeak && flux[f] > mean * options.sensitivity && f - lastOnset >= minimumGapFrames) {
      onsets.push(f * secondsPerFrame)
      lastOnset = f
    }
  }

  if (onsets.length === 0 || onsets[0] > 0.02) onsets.unshift(0)
  return onsets
}

/** Even division, for material that is already on a grid. */
export function divideEvenly(durationSeconds: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (durationSeconds * i) / count)
}

/**
 * Detects the most prominent onsets and returns at most `padCount` (default: 16)
 * sorted chronologically, suitable for 16-pad MPC-style mapping.
 */
export function detectAutoChop16(audio: AudioData, sensitivity = 1.4, padCount = 16): number[] {
  const mono = mixToMono(audio).channels[0]
  if (mono.length < 1024 * 2) return [0]

  const spec = stft(mono, 1024, 256)
  const magnitude = magnitudeOf(spec)
  const { frames, bins } = spec

  const flux = new Float32Array(frames)
  for (let f = 1; f < frames; f += 1) {
    let sum = 0
    for (let b = 0; b < bins; b += 1) {
      const delta = magnitude[f * bins + b] - magnitude[(f - 1) * bins + b]
      if (delta > 0) sum += delta
    }
    flux[f] = sum
  }

  const window = 24
  const secondsPerFrame = 256 / audio.sampleRate
  const minimumGapFrames = Math.max(1, Math.round(0.06 / secondsPerFrame))

  interface Candidate {
    time: number
    score: number
  }
  const candidates: Candidate[] = []

  let lastOnset = -minimumGapFrames
  for (let f = 1; f < frames; f += 1) {
    const from = Math.max(0, f - window)
    const to = Math.min(frames, f + window)
    let mean = 0
    for (let i = from; i < to; i += 1) mean += flux[i]
    mean /= to - from

    const isPeak = flux[f] > flux[f - 1] && (f + 1 >= frames || flux[f] >= flux[f + 1])
    const ratio = mean > 0 ? flux[f] / mean : 0
    if (isPeak && ratio > sensitivity && f - lastOnset >= minimumGapFrames) {
      candidates.push({ time: f * secondsPerFrame, score: ratio * flux[f] })
      lastOnset = f
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  const chosen = candidates.slice(0, padCount - 1).map((c) => c.time)
  chosen.push(0)
  chosen.sort((a, b) => a - b)

  const result: number[] = []
  for (const t of chosen) {
    if (result.length === 0 || t - result[result.length - 1] >= 0.05) {
      result.push(t)
    }
  }

  return result.slice(0, padCount)
}
