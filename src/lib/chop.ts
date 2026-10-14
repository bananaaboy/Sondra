/**
 * Where to cut — one plan for every way of cutting.
 *
 * The chopper used to have four buttons, each with one or two fixed settings
 * baked into a different function. Material is more varied than that: a drum
 * break wants its hits, a vocal take wants its phrases between the breaths, a
 * pad wants bars, a field recording wants equal stretches. And the same few
 * questions come up for all of them — keep a little air before the hit, never
 * leave a slice too short to play, cut only inside this stretch.
 *
 * So there is one settings object and one planner. It returns the slices, not
 * just the cut points, because one method (cutting at silence, leaving the
 * silence out) does not tile the file. The panel draws the plan on the stage
 * before anything is cut, which is only bearable because the expensive part —
 * the spectral flux of the whole file — is computed once per file and kept.
 */

import { detectSilence } from './edit'
import { magnitudeOf, stft } from './fft'
import { beatGrid, snapToZeroCrossing } from './tempo'
import { mixToMono, type AudioData } from './wav'

export type ChopMethod = 'auto' | 'hits' | 'grid' | 'even' | 'length' | 'silence'

export interface ChopSettings {
  method: ChopMethod
  /** Hits and auto: how far above its surroundings a hit must stand, 0.5 – 3. */
  sensitivity: number
  /** Hits: the shortest distance between two cuts. */
  minGapMs: number
  /** Auto: how many of the strongest hits. Even: how many parts. */
  count: number
  /** Grid: tempo, slice length in beats (⅓ and ⅔ are triplets), and a shift. */
  bpm: number
  beatsPerSlice: number
  gridOffsetMs: number
  /** Length: every slice this long. */
  lengthMs: number
  /** Silence: what counts as quiet, and for how long. */
  silenceDb: number
  silenceMs: number
  /** Silence: leave the quiet out, so a pad starts with its sound and ends with it. */
  dropSilence: boolean
  /** Every method: each cut this much earlier, so the run-up to a hit stays on its pad. */
  preRollMs: number
  /** Every method: a slice shorter than this joins the one before it. */
  minLengthMs: number
  /** Every method: cuts move to the nearest rising zero crossing. */
  snap: boolean
}

export const DEFAULT_CHOP: ChopSettings = {
  method: 'hits',
  sensitivity: 1.4,
  minGapMs: 80,
  count: 16,
  bpm: 120,
  beatsPerSlice: 1,
  gridOffsetMs: 0,
  lengthMs: 500,
  silenceDb: -45,
  silenceMs: 120,
  dropSilence: true,
  preRollMs: 0,
  minLengthMs: 30,
  snap: true,
}

export interface PlannedSlice {
  start: number
  end: number
}

export interface ChopPlan {
  slices: PlannedSlice[]
  /** More slices were found than are worth laying out; the rest were dropped. */
  capped: boolean
}

/** More than this is not a kit any more, and the waveform cannot show it. */
export const MAX_PLANNED = 128

/* -------------------------------------------------------------------------- */
/* Spectral flux, once per file                                                */
/* -------------------------------------------------------------------------- */

interface Flux {
  flux: Float32Array
  secondsPerFrame: number
  /** The local mean around each frame, for the adaptive threshold. */
  mean: Float32Array
}

const FFT_SIZE = 1024
const HOP = 256
const fluxCache = new WeakMap<AudioData, Flux>()

/**
 * Rising spectral energy per frame — it spikes exactly where a new sound
 * starts. Kept per file: the planner runs on every slider move.
 */
function fluxOf(audio: AudioData): Flux | null {
  const cached = fluxCache.get(audio)
  if (cached) return cached
  const mono = mixToMono(audio).channels[0]
  if (mono.length < FFT_SIZE * 2) return null
  const spec = stft(mono, FFT_SIZE, HOP)
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
  // A running mean over ±24 frames, so a quiet passage still yields hits and a
  // loud one does not yield hundreds.
  const window = 24
  const mean = new Float32Array(frames)
  let total = 0
  let from = 0
  let to = 0
  for (let f = 0; f < frames; f += 1) {
    const wantFrom = Math.max(0, f - window)
    const wantTo = Math.min(frames, f + window)
    while (to < wantTo) total += flux[to++]
    while (from < wantFrom) total -= flux[from++]
    mean[f] = total / Math.max(1, to - from)
  }
  const result = { flux, secondsPerFrame: HOP / audio.sampleRate, mean }
  fluxCache.set(audio, result)
  return result
}

/** Peaks of the flux that stand out from their surroundings, with their strength. */
function hits(audio: AudioData, sensitivity: number, minGapSeconds: number): { time: number; score: number }[] {
  const data = fluxOf(audio)
  if (!data) return []
  const { flux, mean, secondsPerFrame } = data
  const gap = Math.max(1, Math.round(minGapSeconds / secondsPerFrame))
  const found: { time: number; score: number }[] = []
  let last = -gap
  for (let f = 1; f < flux.length; f += 1) {
    const peak = flux[f] > flux[f - 1] && (f + 1 >= flux.length || flux[f] >= flux[f + 1])
    if (!peak || f - last < gap) continue
    const ratio = mean[f] > 0 ? flux[f] / mean[f] : 0
    if (ratio > sensitivity) {
      found.push({ time: f * secondsPerFrame, score: ratio * flux[f] })
      last = f
    }
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

export interface PlanContext {
  /** Cut only inside this stretch; the rest of the file is left alone. */
  range?: { start: number; end: number } | null
  /** Where the detected tempo puts its first beat. */
  tempoOffsetSeconds?: number
}

export function planChop(audio: AudioData, settings: ChopSettings, { range = null, tempoOffsetSeconds = 0 }: PlanContext = {}): ChopPlan {
  const duration = (audio.channels[0]?.length ?? 0) / audio.sampleRate
  const from = Math.max(0, Math.min(duration, range?.start ?? 0))
  const to = Math.max(from, Math.min(duration, range?.end ?? duration))
  if (to - from < 0.01) return { slices: [], capped: false }
  const inside = (at: number) => at > from + 1e-4 && at < to - 1e-4

  // Silence with the gaps left out is the one method that does not tile.
  if (settings.method === 'silence' && settings.dropSilence) {
    const sounding = soundingRanges(audio, settings, from, to)
    const preRoll = settings.preRollMs / 1000
    const slices = sounding
      .map((part) => ({
        start: snapped(audio, settings, Math.max(from, part.start - preRoll)),
        end: part.end,
      }))
      .filter((part) => part.end - part.start >= settings.minLengthMs / 1000)
    return cap(slices)
  }

  let points: number[]
  switch (settings.method) {
    case 'auto': {
      const strongest = hits(audio, settings.sensitivity, 0.06)
        .filter((hit) => inside(hit.time))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, settings.count - 1))
      points = strongest.map((hit) => hit.time)
      break
    }
    case 'hits':
      points = hits(audio, settings.sensitivity, settings.minGapMs / 1000)
        .map((hit) => hit.time)
        .filter(inside)
      break
    case 'grid':
      points = beatGrid({
        bpm: settings.bpm,
        offsetSeconds: tempoOffsetSeconds + settings.gridOffsetMs / 1000,
        beatsPerSlice: settings.beatsPerSlice,
        durationSeconds: duration,
      }).filter(inside)
      break
    case 'even': {
      const parts = Math.max(1, Math.round(settings.count))
      points = Array.from({ length: parts - 1 }, (_, index) => from + ((to - from) * (index + 1)) / parts)
      break
    }
    case 'length': {
      const step = Math.max(0.01, settings.lengthMs / 1000)
      points = []
      for (let at = from + step; at < to - 1e-4 && points.length < MAX_PLANNED * 4; at += step) points.push(at)
      break
    }
    case 'silence':
      points = soundingRanges(audio, settings, from, to)
        .map((part) => part.start)
        .filter(inside)
      break
  }

  // Grid and equal parts are positions in time, not sounds: a run-up before
  // them would only shift the grid. The others move to keep the attack.
  const preRoll = settings.method === 'grid' || settings.method === 'even' || settings.method === 'length' ? 0 : settings.preRollMs / 1000
  const cuts = [...new Set(points.map((at) => snapped(audio, settings, Math.max(from, at - preRoll))))]
    .filter(inside)
    .sort((a, b) => a - b)

  const edges = [from, ...cuts, to]
  const slices: PlannedSlice[] = []
  const shortest = Math.max(0.015, settings.minLengthMs / 1000)
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const slice = { start: edges[index], end: edges[index + 1] }
    // Too short to be a pad: it joins the slice before it, or — at the very
    // start — the one after.
    if (slice.end - slice.start < shortest && slices.length > 0) {
      slices[slices.length - 1].end = slice.end
    } else {
      slices.push(slice)
    }
  }
  if (slices.length > 1 && slices[0].end - slices[0].start < shortest) {
    slices[1].start = slices[0].start
    slices.shift()
  }
  return cap(slices)
}

function snapped(audio: AudioData, settings: ChopSettings, at: number): number {
  return settings.snap ? snapToZeroCrossing(audio, at) : at
}

function cap(slices: PlannedSlice[]): ChopPlan {
  return slices.length > MAX_PLANNED ? { slices: slices.slice(0, MAX_PLANNED), capped: true } : { slices, capped: false }
}

/** The stretches between silences, inside the range. */
function soundingRanges(audio: AudioData, settings: ChopSettings, from: number, to: number): PlannedSlice[] {
  const quiet = detectSilence(audio, settings.silenceDb, Math.max(0.02, settings.silenceMs / 1000))
  const sounding: PlannedSlice[] = []
  let cursor = from
  for (const gap of quiet) {
    if (gap.endSeconds <= from) continue
    if (gap.startSeconds >= to) break
    if (gap.startSeconds > cursor) sounding.push({ start: cursor, end: Math.min(to, gap.startSeconds) })
    cursor = Math.max(cursor, gap.endSeconds)
  }
  if (cursor < to) sounding.push({ start: cursor, end: to })
  return sounding.filter((part) => part.end - part.start > 0.01)
}

/** What the plan does, in words, for the log and the button. */
export function describeMethod(settings: ChopSettings): string {
  switch (settings.method) {
    case 'auto':
      return `Die ${settings.count} stärksten Schläge`
    case 'hits':
      return 'Anschläge'
    case 'grid':
      return `Raster ${Math.round(settings.bpm)} BPM`
    case 'even':
      return `${settings.count} gleiche Teile`
    case 'length':
      return `Je ${settings.lengthMs} ms`
    case 'silence':
      return settings.dropSilence ? 'Zwischen Stille, ohne die Stille' : 'An der Stille'
  }
}
