/**
 * Pads and patterns: how one slice sounds when it is hit, and how a grid of
 * hits becomes a beat.
 *
 * The same `startVoice` plays a pad under a finger, a step in the running
 * sequencer and a step in the offline bounce, so what is heard while building
 * a pattern is exactly what ends up in the WAV. Timing goes through the audio
 * clock (`when`), never through `setTimeout`, which drifts by whole
 * milliseconds and is audible as a lazy hi-hat.
 */

import type { Note } from './pitch'
import { writeMidi } from './midi'
import { fromAudioBuffer, type AudioData } from './wav'

export type PlayMode = 'oneshot' | 'gate' | 'loop'

export interface Slice {
  id: string
  start: number
  end: number
  semitones: number
  gainDb: number
  reverse: boolean
  mode: PlayMode
  /** −1 hard left … 1 hard right. */
  pan: number
  /** Fade-in at each hit, milliseconds. */
  attackMs: number
  /** Fade-out at the end of each hit, milliseconds. */
  releaseMs: number
}

export const SLICE_DEFAULTS = { semitones: 0, gainDb: 0, reverse: false, pan: 0, attackMs: 0, releaseMs: 0 }

const dbToGain = (db: number) => (db <= -96 ? 0 : 10 ** (db / 20))

export interface Voice {
  source: AudioBufferSourceNode
  gain: GainNode
  /** Stops the voice with a short fade, at `when` or now. */
  stop: (when?: number) => void
}

/**
 * Starts one hit of a slice at `when` on `context`.
 *
 * `holdSeconds` bounds gate and loop pads — in the sequencer that is the step
 * or the time to the next hit; under a finger it is left open and the pad is
 * stopped when the key comes up.
 */
export function startVoice(
  context: BaseAudioContext,
  destination: AudioNode,
  slice: Slice,
  buffers: { forward: AudioBuffer; reversed: AudioBuffer | null },
  when: number,
  holdSeconds?: number,
): Voice {
  const source = context.createBufferSource()
  const reversed = slice.reverse && buffers.reversed
  source.buffer = reversed ? buffers.reversed : buffers.forward
  const total = buffers.forward.duration
  const offset = reversed ? total - slice.end : slice.start
  const length = Math.max(0.005, slice.end - slice.start)
  const rate = 2 ** (slice.semitones / 12)
  source.playbackRate.value = rate

  const gain = context.createGain()
  const level = dbToGain(slice.gainDb)
  const attack = slice.attackMs / 1000
  const release = slice.releaseMs / 1000
  if (attack > 0) {
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(level, when + attack)
  } else {
    gain.gain.setValueAtTime(level, when)
  }

  let node: AudioNode = gain
  if (slice.pan !== 0 && 'createStereoPanner' in context) {
    const panner = context.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, slice.pan))
    gain.connect(panner)
    node = panner
  }
  source.connect(gain)
  node.connect(destination)

  // How long the hit sounds in real time, before any release is added.
  const natural = length / rate
  const lasts =
    slice.mode === 'oneshot' ? natural : holdSeconds !== undefined ? holdSeconds : slice.mode === 'loop' ? Infinity : natural

  if (slice.mode === 'loop') {
    source.loop = true
    source.loopStart = offset
    source.loopEnd = offset + length
    source.start(when, offset)
  } else {
    source.start(when, offset, length)
  }

  if (Number.isFinite(lasts)) {
    const fade = Math.max(0.004, Math.min(release || 0.004, lasts))
    const end = when + lasts
    gain.gain.setValueAtTime(level, Math.max(when + attack, end - fade))
    gain.gain.linearRampToValueAtTime(0, end)
    source.stop(end + 0.01)
  }

  return {
    source,
    gain,
    stop: (at) => {
      const time = Math.max(at ?? context.currentTime, context.currentTime)
      try {
        gain.gain.cancelScheduledValues(time)
        gain.gain.setValueAtTime(gain.gain.value, time)
        gain.gain.linearRampToValueAtTime(0, time + Math.max(0.006, release))
        source.stop(time + Math.max(0.006, release) + 0.01)
      } catch {
        /* already stopped */
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Patterns                                                                    */
/* -------------------------------------------------------------------------- */

export interface Pattern {
  steps: number
  bpm: number
  /** 0 is straight; 0.5 pushes every second sixteenth half a step late. */
  swing: number
  /** Slice id → which steps are on. */
  cells: Record<string, boolean[]>
  muted: Record<string, boolean>
}

export const stepSeconds = (bpm: number) => 60 / bpm / 4

/** When step `index` falls, relative to the start of the pattern. */
export function stepTime(index: number, bpm: number, swing: number): number {
  const step = stepSeconds(bpm)
  return index * step + (index % 2 === 1 ? swing * step : 0)
}

/** The hits of one pass, in order, with how long each may ring. */
export function patternHits(slices: Slice[], pattern: Pattern): { slice: Slice; row: number; step: number; at: number; hold: number }[] {
  const length = pattern.steps * stepSeconds(pattern.bpm)
  const hits: { slice: Slice; row: number; step: number; at: number; hold: number }[] = []
  slices.forEach((slice, row) => {
    if (pattern.muted[slice.id]) return
    const cells = pattern.cells[slice.id] ?? []
    const on = cells.map((value, step) => (value ? step : -1)).filter((step) => step >= 0 && step < pattern.steps)
    on.forEach((step, index) => {
      const at = stepTime(step, pattern.bpm, pattern.swing)
      // A gate lasts one step; a loop until the row's next hit (wrapping).
      const next = index + 1 < on.length ? stepTime(on[index + 1], pattern.bpm, pattern.swing) : length + stepTime(on[0], pattern.bpm, pattern.swing)
      const hold = slice.mode === 'gate' ? stepSeconds(pattern.bpm) : next - at
      hits.push({ slice, row, step, at, hold })
    })
  })
  return hits.sort((a, b) => a.at - b.at)
}

/**
 * Renders `loops` passes offline. The ring-out past the end is folded back
 * onto the start, so the file loops without a gap and without a cut-off tail.
 */
export async function bouncePattern(
  slices: Slice[],
  pattern: Pattern,
  buffers: { forward: AudioBuffer; reversed: AudioBuffer | null },
  loops: number,
  choke: boolean,
): Promise<AudioData> {
  const rate = buffers.forward.sampleRate
  const passSeconds = pattern.steps * stepSeconds(pattern.bpm)
  const tailSeconds = 2
  const frames = Math.ceil((passSeconds * loops + tailSeconds) * rate)
  const context = new OfflineAudioContext(2, frames, rate)
  const hits = patternHits(slices, pattern)
  const lastVoice = new Map<number, Voice>()
  for (let pass = 0; pass < loops; pass += 1) {
    for (const hit of hits) {
      const when = pass * passSeconds + hit.at
      if (choke) lastVoice.get(hit.row)?.stop(when)
      const voice = startVoice(context, context.destination, hit.slice, buffers, when, hit.slice.mode === 'oneshot' ? undefined : hit.hold)
      lastVoice.set(hit.row, voice)
    }
  }
  const rendered = fromAudioBuffer(await context.startRendering())
  const length = Math.round(passSeconds * loops * rate)
  const channels = rendered.channels.map((channel) => {
    const out = new Float32Array(length)
    out.set(channel.subarray(0, length))
    for (let i = length; i < channel.length; i += 1) out[(i - length) % length] += channel[i]
    for (let i = 0; i < length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]))
    return out
  })
  return { channels, sampleRate: rate }
}

/**
 * The pattern as MIDI: one note per row, from C1 up — the layout drum racks
 * and FL Studio's FPC expect — one step long.
 */
export function patternToMidi(slices: Slice[], pattern: Pattern, loops = 1): Uint8Array<ArrayBuffer> {
  const hits = patternHits(slices, pattern)
  const passSeconds = pattern.steps * stepSeconds(pattern.bpm)
  const notes: Note[] = []
  for (let pass = 0; pass < loops; pass += 1) {
    for (const hit of hits) {
      const start = pass * passSeconds + hit.at
      notes.push({ midi: 36 + hit.row, startSeconds: start, endSeconds: start + stepSeconds(pattern.bpm) * 0.9, velocity: 100 })
    }
  }
  return writeMidi(notes, { bpm: pattern.bpm, trackName: 'Sondra Pattern' })
}

/** A first beat to start from: kick, snare on two and four, eighth hats. */
export function starterPattern(slices: Slice[], steps: number): Record<string, boolean[]> {
  const cells: Record<string, boolean[]> = {}
  const rows = slices.slice(0, 3)
  rows.forEach((slice, row) => {
    cells[slice.id] = Array.from({ length: steps }, (_, step) =>
      row === 0 ? step % 8 === 0 || step % 16 === 10 : row === 1 ? step % 8 === 4 : step % 2 === 0,
    )
  })
  return cells
}
