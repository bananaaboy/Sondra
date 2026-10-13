/**
 * The operations a waveform editor needs, built on the ones already here.
 *
 * `sliceAudio`, `applyFades`, `reverseAudio`, `pitchShift` and `stretchAudio`
 * existed for the sampler and the harmony panel; what was missing was the
 * plain, unglamorous half — gain, silence, joining, channels, sample rate.
 * None of it is clever, and all of it is the difference between a set of
 * analysis tools and something you can actually edit a take in.
 *
 * Every function returns new audio and never touches its input: the editor
 * keeps a history for undo, and that only works if nothing is mutated.
 */

import type { AudioData, Samples } from './wav'
import { resampleByRatio } from './timestretch'

const buffer = (length: number): Samples => new Float32Array(length) as Samples

/** AudioData carries no length of its own; the channels are the length. */
export const frameCount = (audio: AudioData): number => audio.channels[0]?.length ?? 0
export const durationOf = (audio: AudioData): number => frameCount(audio) / audio.sampleRate

const shaped = (audio: AudioData, channels: Samples[]): AudioData => ({
  sampleRate: audio.sampleRate,
  channels,
})

/** Decibels to a linear factor. −∞ is silence. */
export const dbToGain = (db: number) => (db <= -96 ? 0 : 10 ** (db / 20))

/* -------------------------------------------------------------------------- */
/* Level                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Multiplies the level, optionally only inside a range.
 *
 * Not clamped. Clipping is a real thing people sometimes want to see rather
 * than have silently prevented, and the panel shows the resulting peak so it
 * is visible rather than hidden.
 */
export function applyGain(audio: AudioData, db: number, from = 0, to = Infinity): AudioData {
  const factor = dbToGain(db)
  const frames = frameCount(audio)
  const start = Math.max(0, Math.floor(from * audio.sampleRate))
  const end = Math.min(frames, Math.ceil(to * audio.sampleRate))
  const channels = audio.channels.map((source) => {
    const next = buffer(frames)
    next.set(source)
    for (let i = start; i < end; i += 1) next[i] = source[i] * factor
    return next
  })
  return shaped(audio, channels)
}

/** The loudest sample, in dBFS. −Infinity for digital silence. */
export function peakDb(audio: AudioData): number {
  let peak = 0
  for (const channel of audio.channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = Math.abs(channel[i])
      if (value > peak) peak = value
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}

/** Scales so the loudest sample lands exactly on `targetDb`. */
export function normalizePeak(audio: AudioData, targetDb = -0.3): AudioData {
  const current = peakDb(audio)
  if (!Number.isFinite(current)) return audio
  return applyGain(audio, targetDb - current)
}

/* -------------------------------------------------------------------------- */
/* Silence                                                                     */
/* -------------------------------------------------------------------------- */

export interface SilenceRange {
  startSeconds: number
  endSeconds: number
}

/**
 * Where the recording is quieter than `thresholdDb` for long enough to matter.
 *
 * Measured on a short sliding window rather than per sample: a single sample
 * crossing zero is not silence, and a gate that thinks so chatters. Ranges
 * shorter than `minimumSeconds` are dropped, which is what keeps the gaps
 * between words from being treated as pauses worth cutting.
 */
export function detectSilence(
  audio: AudioData,
  thresholdDb = -50,
  minimumSeconds = 0.35,
): SilenceRange[] {
  const threshold = dbToGain(thresholdDb)
  const frames = frameCount(audio)
  const window = Math.max(1, Math.round(audio.sampleRate * 0.02))
  const ranges: SilenceRange[] = []
  let quietFrom: number | null = null

  for (let at = 0; at < frames; at += window) {
    const until = Math.min(frames, at + window)
    let peak = 0
    for (const channel of audio.channels) {
      for (let i = at; i < until; i += 1) {
        const value = Math.abs(channel[i])
        if (value > peak) peak = value
      }
    }

    if (peak < threshold) {
      if (quietFrom === null) quietFrom = at
    } else if (quietFrom !== null) {
      ranges.push({ startSeconds: quietFrom / audio.sampleRate, endSeconds: at / audio.sampleRate })
      quietFrom = null
    }
  }
  if (quietFrom !== null) {
    ranges.push({ startSeconds: quietFrom / audio.sampleRate, endSeconds: frames / audio.sampleRate })
  }

  return ranges.filter((range) => range.endSeconds - range.startSeconds >= minimumSeconds)
}

/**
 * Removes the silence, keeping a little of it.
 *
 * `padSeconds` of the quiet is left at each edge on purpose: cutting exactly
 * at the threshold clips the decay of whatever came before and the breath
 * before whatever comes next, and the result sounds spliced.
 */
export function removeSilence(
  audio: AudioData,
  thresholdDb = -50,
  minimumSeconds = 0.35,
  padSeconds = 0.05,
): AudioData {
  const silence = detectSilence(audio, thresholdDb, minimumSeconds)
  if (silence.length === 0) return audio

  const total = durationOf(audio)
  const keep: SilenceRange[] = []
  let cursor = 0
  for (const range of silence) {
    const cutFrom = Math.min(total, range.startSeconds + padSeconds)
    const cutTo = Math.max(0, range.endSeconds - padSeconds)
    if (cutFrom > cursor) keep.push({ startSeconds: cursor, endSeconds: cutFrom })
    cursor = Math.max(cursor, cutTo)
  }
  if (cursor < total) keep.push({ startSeconds: cursor, endSeconds: total })

  return joinRanges(audio, keep)
}

/** Keeps only the named stretches, in order, end to end. */
export function joinRanges(audio: AudioData, ranges: SilenceRange[]): AudioData {
  const frames = frameCount(audio)
  const spans = ranges
    .map((range) => ({
      from: Math.max(0, Math.floor(range.startSeconds * audio.sampleRate)),
      to: Math.min(frames, Math.ceil(range.endSeconds * audio.sampleRate)),
    }))
    .filter((span) => span.to > span.from)

  const length = spans.reduce((sum, span) => sum + (span.to - span.from), 0)
  const channels = audio.channels.map((source) => {
    const next = buffer(length)
    let at = 0
    for (const span of spans) {
      next.set(source.subarray(span.from, span.to), at)
      at += span.to - span.from
    }
    return next
  })
  return shaped(audio, channels)
}

/** Everything except the named stretch. */
export function cutRange(audio: AudioData, from: number, to: number): AudioData {
  return joinRanges(audio, [
    { startSeconds: 0, endSeconds: from },
    { startSeconds: to, endSeconds: durationOf(audio) },
  ])
}

/* -------------------------------------------------------------------------- */
/* Joining                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Puts several recordings end to end.
 *
 * Sample rates and channel counts are made to match the first one, because the
 * alternative is a file that plays at the wrong speed halfway through — a
 * failure that sounds like a broken export rather than a mismatched input.
 */
export function concatAudio(parts: AudioData[], crossfadeSeconds = 0): AudioData {
  const usable = parts.filter((part) => frameCount(part) > 0)
  if (usable.length === 0) throw new Error('Nichts zum Aneinanderhängen.')
  if (usable.length === 1) return usable[0]

  const first = usable[0]
  const aligned = usable.map((part) => setChannels(resampleAudio(part, first.sampleRate), first.channels.length))

  const fade = Math.max(0, Math.round(crossfadeSeconds * first.sampleRate))
  const length =
    aligned.reduce((sum, part) => sum + frameCount(part), 0) - fade * (aligned.length - 1)
  const channels = Array.from({ length: first.channels.length }, () => buffer(Math.max(1, length)))

  let at = 0
  for (const [index, part] of aligned.entries()) {
    for (let c = 0; c < channels.length; c += 1) {
      const source = part.channels[c]
      const frames = frameCount(part)
      for (let i = 0; i < frames; i += 1) {
        const target = at + i
        if (target >= channels[c].length) break
        // Inside the overlap both sides are weighted, so the sum stays level
        // instead of dipping or doubling where they meet.
        if (index > 0 && i < fade) {
          const ramp = i / fade
          channels[c][target] = channels[c][target] * (1 - ramp) + source[i] * ramp
        } else {
          channels[c][target] = source[i]
        }
      }
    }
    at += frameCount(part) - (index < aligned.length - 1 ? fade : 0)
  }

  return shaped(first, channels)
}

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/** Folds to mono or spreads to stereo, whichever was asked for. */
export function setChannels(audio: AudioData, count: number): AudioData {
  if (audio.channels.length === count) return audio

  const frames = frameCount(audio)
  if (count === 1) {
    const mixed = buffer(frames)
    for (const channel of audio.channels) {
      for (let i = 0; i < frames; i += 1) mixed[i] += channel[i] / audio.channels.length
    }
    return shaped(audio, [mixed])
  }

  const channels = Array.from({ length: count }, (_, index) => {
    const source = audio.channels[Math.min(index, audio.channels.length - 1)]
    const copy = buffer(frames)
    copy.set(source)
    return copy
  })
  return shaped(audio, channels)
}

/**
 * Changes the sample rate.
 *
 * Linear interpolation through `resampleByRatio`, which is what the sampler
 * already uses for transposing. Good enough going down by a small factor and
 * for anything musical; a studio conversion from 96 to 44.1 deserves better
 * filtering, and the panel says so rather than pretending otherwise.
 */
export function resampleAudio(audio: AudioData, targetRate: number): AudioData {
  if (targetRate === audio.sampleRate || targetRate <= 0) return audio
  const ratio = audio.sampleRate / targetRate
  return { sampleRate: targetRate, channels: audio.channels.map((c) => resampleByRatio(c, ratio)) }
}

/** Swaps left and right, or silences one side. */
export function channelTrick(audio: AudioData, mode: 'swap' | 'left' | 'right'): AudioData {
  if (audio.channels.length < 2) return audio
  const [left, right] = audio.channels
  const pick = (source: Samples) => {
    const copy = buffer(frameCount(audio))
    copy.set(source)
    return copy
  }
  if (mode === 'swap') return shaped(audio, [pick(right), pick(left)])
  if (mode === 'left') return shaped(audio, [pick(left), pick(left)])
  return shaped(audio, [pick(right), pick(right)])
}

/**
 * Removes DC offset by subtracting the mean of each channel.
 */
export function removeDcOffset(audio: AudioData): AudioData {
  return {
    sampleRate: audio.sampleRate,
    channels: audio.channels.map((channel) => {
      let sum = 0
      const len = channel.length
      if (len === 0) return new Float32Array(0)
      for (let i = 0; i < len; i += 1) {
        sum += channel[i]
      }
      const mean = sum / len
      const out = new Float32Array(len)
      for (let i = 0; i < len; i += 1) {
        out[i] = channel[i] - mean
      }
      return out
    }),
  }
}
