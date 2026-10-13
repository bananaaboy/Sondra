/**
 * Standard MIDI File writer, format 0.
 *
 * A transcription is only useful if it opens in a DAW, and the format is small
 * enough that a library would be more code than this. Everything is one track
 * with a tempo event and note on/off pairs, which is what every DAW imports
 * without asking questions.
 */

import type { Note } from './pitch'

/** Ticks per quarter note. 480 is the common DAW default. */
const TICKS_PER_QUARTER = 480

/**
 * MIDI delta times are variable-length: seven bits per byte, high bit set on
 * every byte but the last.
 */
function variableLength(value: number): number[] {
  const clamped = Math.max(0, Math.round(value))
  const bytes = [clamped & 0x7f]
  let rest = clamped >> 7
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80)
    rest >>= 7
  }
  return bytes
}

function chunk(id: string, body: number[]): number[] {
  const length = body.length
  return [
    ...[...id].map((character) => character.charCodeAt(0)),
    (length >> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
    ...body,
  ]
}

export interface MidiOptions {
  bpm: number
  /** Shown as the track name in most DAWs. */
  trackName?: string
}

/** Renders notes as a `.mid` file. */
export function writeMidi(notes: Note[], options: MidiOptions): Uint8Array<ArrayBuffer> {
  const bpm = options.bpm > 0 ? options.bpm : 120
  const ticksPerSecond = (TICKS_PER_QUARTER * bpm) / 60

  const events: { tick: number; data: number[] }[] = []

  for (const note of notes) {
    const midi = Math.max(0, Math.min(127, Math.round(note.midi)))
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)))
    const on = Math.round(note.startSeconds * ticksPerSecond)
    const off = Math.max(on + 1, Math.round(note.endSeconds * ticksPerSecond))
    events.push({ tick: on, data: [0x90, midi, velocity] })
    // Note-on with velocity 0 is the conventional note-off; using the real
    // note-off status keeps the file readable in editors that show raw events.
    events.push({ tick: off, data: [0x80, midi, 0] })
  }

  // Note-off must precede note-on at the same tick, or a repeated pitch is cut
  // short by its own predecessor.
  events.sort((a, b) => a.tick - b.tick || (a.data[0] & 0xf0) - (b.data[0] & 0xf0))

  const track: number[] = []

  // Tempo, as microseconds per quarter note.
  const microseconds = Math.round(60_000_000 / bpm)
  track.push(
    ...variableLength(0),
    0xff,
    0x51,
    0x03,
    (microseconds >> 16) & 0xff,
    (microseconds >> 8) & 0xff,
    microseconds & 0xff,
  )

  if (options.trackName) {
    const name = [...options.trackName].map((character) => character.charCodeAt(0) & 0x7f).slice(0, 120)
    track.push(...variableLength(0), 0xff, 0x03, name.length, ...name)
  }

  let previousTick = 0
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.data)
    previousTick = event.tick
  }

  track.push(...variableLength(0), 0xff, 0x2f, 0x00) // end of track

  const header = chunk('MThd', [0, 0, 0, 0, (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff])
  const bytes = [...header, ...chunk('MTrk', track)]
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>
}

/* -------------------------------------------------------------------------- */
/* Web MIDI API: Hardware Controller & Pad Triggering                         */
/* -------------------------------------------------------------------------- */

export interface WebMidiHandler {
  onNoteOn: (padIndex: number, velocity: number, note: number) => void
  onNoteOff?: (padIndex: number, note: number) => void
  onStateChange?: (devices: string[]) => void
}

export function isWebMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function'
}

/**
 * Maps incoming MIDI note numbers to pad indices (0..15).
 * Standard MPC / General MIDI Drum notes 36 (C1) through 51 (D#2) map 1:1.
 */
export function midiNoteToPadIndex(note: number): number {
  if (note >= 36 && note <= 51) return note - 36
  if (note >= 48 && note <= 63) return note - 48
  if (note >= 60 && note <= 75) return note - 60
  return ((note % 16) + 16) % 16
}

export interface MidiAccessSubscription {
  devices: string[]
  disconnect: () => void
}

/**
 * Connects to connected MIDI keyboards and drum pads (AKAI MPK Mini, Novation Launchpad, etc.)
 * and routes Note-On / Note-Off messages to the handler.
 */
export async function connectWebMidi(handler: WebMidiHandler): Promise<MidiAccessSubscription | null> {
  if (!isWebMidiSupported()) return null
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false })
    const activeInputs: MIDIInput[] = []

    const attach = (input: MIDIInput) => {
      activeInputs.push(input)
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (!event.data || event.data.length < 3) return
        const status = event.data[0] & 0xf0
        const note = event.data[1]
        const rawVelocity = event.data[2]
        const padIndex = midiNoteToPadIndex(note)

        if (status === 0x90 && rawVelocity > 0) {
          const velocity = Math.max(0.01, Math.min(1, rawVelocity / 127))
          handler.onNoteOn(padIndex, velocity, note)
        } else if (status === 0x80 || (status === 0x90 && rawVelocity === 0)) {
          handler.onNoteOff?.(padIndex, note)
        }
      }
    }

    const getDeviceNames = (): string[] => {
      const names: string[] = []
      for (const input of access.inputs.values()) {
        names.push(input.name || 'MIDI-Eingang')
      }
      return names
    }

    for (const input of access.inputs.values()) {
      attach(input)
    }

    access.onstatechange = () => {
      handler.onStateChange?.(getDeviceNames())
    }

    return {
      devices: getDeviceNames(),
      disconnect: () => {
        for (const input of activeInputs) {
          input.onmidimessage = null
        }
        access.onstatechange = null
      },
    }
  } catch {
    return null
  }
}

