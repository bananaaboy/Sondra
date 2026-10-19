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

export type SoundKind = 'sample' | 'warm' | 'sub808' | 'epiano' | 'pluck' | 'lead'

export const SOUND_LABELS: Record<SoundKind, string> = {
  sample: 'Pad-Sample',
  warm: 'Warm-Filter',
  sub808: '808 Bass',
  epiano: 'E-Piano',
  pluck: 'Synth-Pluck',
  lead: 'Soft-Lead',
}

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
  /** Timbre in the sequencer / piano roll. */
  sound?: SoundKind
}

export const SLICE_DEFAULTS = {
  semitones: 0,
  gainDb: 0,
  reverse: false,
  pan: 0,
  attackMs: 0,
  releaseMs: 0,
  sound: 'sample' as SoundKind,
}

const dbToGain = (db: number) => (db <= -96 ? 0 : 10 ** (db / 20))

export interface Voice {
  source: AudioScheduledSourceNode
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
  velocity = 1,
): Voice {
  const sound: SoundKind = slice.sound ?? 'sample'
  const velGain = Math.max(0.01, Math.min(1, velocity))
  const level = dbToGain(slice.gainDb) * velGain
  const attack = slice.attackMs / 1000
  const release = slice.releaseMs / 1000

  const gain = context.createGain()
  if (attack > 0) {
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(level, when + attack)
  } else {
    gain.gain.setValueAtTime(level, when)
  }

  let outputNode: AudioNode = gain
  if (slice.pan !== 0 && 'createStereoPanner' in context) {
    const panner = context.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, slice.pan))
    gain.connect(panner)
    outputNode = panner
  }
  outputNode.connect(destination)

  // Built-in studio synth voices for melodic Piano-Roll playback & bounce
  if (sound !== 'sample' && sound !== 'warm') {
    const baseFreq = (sound === 'sub808' ? 65.41 : 261.63) * 2 ** (slice.semitones / 12)
    const lasts = holdSeconds !== undefined ? Math.max(0.08, holdSeconds) : sound === 'sub808' ? 0.65 : 0.45
    const end = when + lasts
    const fade = Math.max(0.015, Math.min(release || (sound === 'pluck' ? 0.08 : 0.04), lasts * 0.6))

    const osc = context.createOscillator()
    const extraOscs: OscillatorNode[] = []
    let voiceInput: AudioNode = gain

    if (sound === 'sub808') {
      osc.type = 'sine'
      osc.frequency.setValueAtTime(baseFreq * 2.1, when)
      osc.frequency.exponentialRampToValueAtTime(Math.max(24, baseFreq), when + 0.045)
      const subFilter = context.createBiquadFilter()
      subFilter.type = 'lowpass'
      subFilter.frequency.setValueAtTime(240, when)
      subFilter.connect(gain)
      voiceInput = subFilter
    } else if (sound === 'epiano') {
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(baseFreq, when)
      const tine = context.createOscillator()
      const tineGain = context.createGain()
      tine.type = 'sine'
      tine.frequency.setValueAtTime(baseFreq * 4, when)
      tineGain.gain.setValueAtTime(0.22 * velGain, when)
      tineGain.gain.exponentialRampToValueAtTime(0.001, when + Math.min(0.18, lasts))
      tine.connect(tineGain)
      tineGain.connect(gain)
      tine.start(when)
      tine.stop(end + 0.02)
      extraOscs.push(tine)
      const lp = context.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(2400, when)
      lp.connect(gain)
      voiceInput = lp
    } else if (sound === 'pluck') {
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(baseFreq, when)
      const lp = context.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.setValueAtTime(2.2, when)
      lp.frequency.setValueAtTime(Math.min(12000, baseFreq * 9), when)
      lp.frequency.exponentialRampToValueAtTime(Math.max(180, baseFreq * 1.4), when + Math.min(0.16, lasts))
      lp.connect(gain)
      voiceInput = lp
    } else {
      // 'lead'
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(baseFreq, when)
      const detuned = context.createOscillator()
      const detunedGain = context.createGain()
      detuned.type = 'triangle'
      detuned.frequency.setValueAtTime(baseFreq * 1.004, when)
      detunedGain.gain.setValueAtTime(0.55, when)
      detuned.connect(detunedGain)
      const lp = context.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(Math.min(9000, baseFreq * 5), when)
      detunedGain.connect(lp)
      lp.connect(gain)
      detuned.start(when)
      detuned.stop(end + 0.02)
      extraOscs.push(detuned)
      voiceInput = lp
    }

    osc.connect(voiceInput)
    gain.gain.setValueAtTime(level * 0.7, Math.max(when + attack, end - fade))
    gain.gain.linearRampToValueAtTime(0, end)
    osc.start(when)
    osc.stop(end + 0.02)

    return {
      source: osc,
      gain,
      stop: (at) => {
        const time = Math.max(at ?? context.currentTime, context.currentTime)
        try {
          gain.gain.cancelScheduledValues(time)
          gain.gain.setValueAtTime(gain.gain.value, time)
          gain.gain.linearRampToValueAtTime(0, time + Math.max(0.008, release))
          osc.stop(time + Math.max(0.008, release) + 0.01)
          for (const extra of extraOscs) extra.stop(time + Math.max(0.008, release) + 0.01)
        } catch {
          /* already stopped */
        }
      },
    }
  }

  const source = context.createBufferSource()
  const reversed = slice.reverse && buffers.reversed
  source.buffer = reversed ? buffers.reversed : buffers.forward
  const total = buffers.forward.duration
  const offset = reversed ? total - slice.end : slice.start
  const length = Math.max(0.005, slice.end - slice.start)
  const rate = 2 ** (slice.semitones / 12)
  source.playbackRate.value = rate

  if (sound === 'warm') {
    const warmFilter = context.createBiquadFilter()
    warmFilter.type = 'lowpass'
    warmFilter.frequency.setValueAtTime(1750, when)
    warmFilter.Q.setValueAtTime(0.85, when)
    source.connect(warmFilter)
    warmFilter.connect(gain)
  } else {
    source.connect(gain)
  }

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

/** One note in a pad's piano roll. */
export interface RollNote {
  step: number
  /** In steps; the pad sounds for exactly this long. */
  length: number
  /** Relative to the pad's own pitch. */
  semitone: number
  /** Relative velocity 0.1 .. 1.0 (default 0.85). */
  velocity?: number
}

export interface Pattern {
  steps: number
  bpm: number
  /** 0 is straight; 0.5 pushes every second sixteenth half a step late. */
  swing: number
  /** Slice id → which steps are on. */
  cells: Record<string, boolean[]>
  /**
   * Slice id → its piano roll. A pad with an entry here plays its notes and
   * not its steps — as in FL Studio, where a channel is either stepped or
   * rolled, never both at once.
   */
  notes: Record<string, RollNote[]>
  muted: Record<string, boolean>
}

export const hasRoll = (pattern: Pattern, id: string) => pattern.notes[id] !== undefined

/** The steps of a pad, as notes at its own pitch — how a roll starts out. */
export function cellsToNotes(cells: boolean[] | undefined): RollNote[] {
  return (cells ?? []).flatMap((on, step) => (on ? [{ step, length: 1, semitone: 0 }] : []))
}

/** Longer or shorter pattern: a second bar repeats the first, a shorter one keeps the start. */
export function resizeNotes(notes: RollNote[], from: number, to: number): RollNote[] {
  const kept = notes.filter((note) => note.step < to).map((note) => ({ ...note, length: Math.min(note.length, to - note.step) }))
  if (to <= from) return kept
  const copies: RollNote[] = []
  for (let offset = from; offset < to; offset += from) {
    for (const note of notes) if (note.step + offset < to) copies.push({ ...note, step: note.step + offset })
  }
  return [...kept, ...copies]
}

export const stepSeconds = (bpm: number) => 60 / bpm / 4

/** When step `index` falls, relative to the start of the pattern. */
export function stepTime(index: number, bpm: number, swing: number): number {
  const step = stepSeconds(bpm)
  return index * step + (index % 2 === 1 ? swing * step : 0)
}

export interface Hit {
  /** The pad as this hit plays it: a roll note carries its pitch in here. */
  slice: Slice
  row: number
  step: number
  at: number
  hold: number
  velocity: number
  /** Which voice this hit replaces when pads choke: the row, or row and note. */
  voice: string
}

/** The hits of one pass, in order, with how long each may ring. */
export function patternHits(slices: Slice[], pattern: Pattern): Hit[] {
  const length = pattern.steps * stepSeconds(pattern.bpm)
  const hits: Hit[] = []
  slices.forEach((slice, row) => {
    if (pattern.muted[slice.id]) return
    const roll = pattern.notes[slice.id]
    if (roll) {
      // A roll note sounds as long as it is drawn — a key held on a piano.
      // Loops keep looping for that long; everything else becomes a gate.
      for (const note of roll) {
        if (note.step >= pattern.steps) continue
        const at = stepTime(note.step, pattern.bpm, pattern.swing)
        const end = note.step + note.length >= pattern.steps ? length : stepTime(note.step + note.length, pattern.bpm, pattern.swing)
        hits.push({
          slice: { ...slice, semitones: slice.semitones + note.semitone, mode: slice.mode === 'loop' ? 'loop' : 'gate' },
          row,
          step: note.step,
          at,
          hold: Math.max(0.01, end - at),
          velocity: note.velocity ?? 0.9,
          voice: `${row}:${note.semitone}`,
        })
      }
      return
    }
    const cells = pattern.cells[slice.id] ?? []
    const on = cells.map((value, step) => (value ? step : -1)).filter((step) => step >= 0 && step < pattern.steps)
    on.forEach((step, index) => {
      const at = stepTime(step, pattern.bpm, pattern.swing)
      // A gate lasts one step; a loop until the row's next hit (wrapping).
      const next = index + 1 < on.length ? stepTime(on[index + 1], pattern.bpm, pattern.swing) : length + stepTime(on[0], pattern.bpm, pattern.swing)
      const hold = slice.mode === 'gate' ? stepSeconds(pattern.bpm) : next - at
      hits.push({ slice, row, step, at, hold, velocity: 1, voice: String(row) })
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
  const lastVoice = new Map<string, Voice>()
  for (let pass = 0; pass < loops; pass += 1) {
    for (const hit of hits) {
      const when = pass * passSeconds + hit.at
      if (choke) lastVoice.get(hit.voice)?.stop(when)
      const voice = startVoice(context, context.destination, hit.slice, buffers, when, hit.slice.mode === 'oneshot' ? undefined : hit.hold, hit.velocity)
      lastVoice.set(hit.voice, voice)
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
 * The pattern as MIDI: one note per stepped row, from C1 up — the layout drum
 * racks and FL Studio's FPC expect — one step long. Rolled pads are melodies
 * and keep their notes, around C4 for the pad's own pitch.
 */
export function patternToMidi(slices: Slice[], pattern: Pattern, loops = 1): Uint8Array<ArrayBuffer> {
  const hits = patternHits(slices, pattern)
  const passSeconds = pattern.steps * stepSeconds(pattern.bpm)
  const notes: Note[] = []
  for (let pass = 0; pass < loops; pass += 1) {
    for (const hit of hits) {
      const start = pass * passSeconds + hit.at
      const rolled = hasRoll(pattern, slices[hit.row].id)
      notes.push({
        midi: rolled ? 60 + hit.slice.semitones - slices[hit.row].semitones : 36 + hit.row,
        startSeconds: start,
        endSeconds: start + (rolled ? hit.hold : stepSeconds(pattern.bpm) * 0.9),
        velocity: Math.max(1, Math.min(127, Math.round(hit.velocity * 110))),
      })
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
