/**
 * Voice over music, with the music stepping back whenever someone speaks —
 * what radio calls ducking and every podcast editor does by hand.
 *
 * The voice is measured in 10 ms frames. Speech is what rises clearly above
 * the recording's own floor: the threshold sits between the quiet tenth and
 * the loud twentieth of the frames, and "sensitivity" moves it towards the
 * floor. A short hold bridges the gaps between words, and the music starts
 * moving a little before the first syllable so it is never stepped on. The
 * gain glides down with the attack time and back up with the release, in
 * decibels, which is how the ear hears a fade.
 *
 * Plain JS on the decoded samples: a five-minute mix is a few hundred
 * milliseconds, quick enough to redo on every slider move and listen again.
 */

import { resampleAudio } from './edit'
import type { AudioData, Samples } from './wav'

export interface DuckSettings {
  /** The music's level under no speech, relative to the file. */
  musicDb: number
  /** How far the music drops while someone speaks. */
  duckDb: number
  /** 0…1; higher catches quieter speech. */
  sensitivity: number
  attackMs: number
  releaseMs: number
  /** Music alone before the voice starts. */
  leadIn: number
  /** Music after the voice ends, fading out over that time. */
  tail: number
  /** Repeat the music when it is shorter than the mix. */
  loopMusic: boolean
}

export const DEFAULT_DUCK: DuckSettings = {
  musicDb: -14,
  duckDb: 12,
  sensitivity: 0.5,
  attackMs: 120,
  releaseMs: 600,
  leadIn: 2,
  tail: 3,
  loopMusic: true,
}

export interface DuckReport {
  voiceSeconds: number
  speechSeconds: number
  thresholdDb: number
  totalSeconds: number
  /** Before the safety trim. */
  peakDb: number
  /** How much the whole mix was turned down to stay under -1 dBFS. */
  trimDb: number
}

export interface DuckResult {
  audio: AudioData
  /** Per 10 ms of the output: the voice level in dB, -100 where silent. */
  voiceDb: Float32Array
  /** Per 10 ms of the output: the music's gain in dB. */
  musicGainDb: Float32Array
  report: DuckReport
}

const FRAME_SECONDS = 0.01
const HOLD_SECONDS = 0.25
const CEILING_DB = -1

function percentile(values: number[], fraction: number): number {
  if (!values.length) return -100
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

/** The voice's level per frame, all channels together. */
function frameLevels(voice: AudioData, frame: number): Float32Array {
  const length = voice.channels[0]?.length ?? 0
  const count = Math.ceil(length / frame)
  const levels = new Float32Array(count)
  for (let f = 0; f < count; f += 1) {
    let sum = 0
    let n = 0
    for (const channel of voice.channels) {
      for (let i = f * frame; i < Math.min(length, (f + 1) * frame); i += 1) {
        sum += channel[i] * channel[i]
        n += 1
      }
    }
    levels[f] = n ? 10 * Math.log10(sum / n + 1e-12) : -100
  }
  return levels
}

export function mixWithDucking(voiceIn: AudioData, musicIn: AudioData, settings: DuckSettings): DuckResult {
  const rate = voiceIn.sampleRate
  const voice = voiceIn
  const music = resampleAudio(musicIn, rate)
  const frame = Math.round(rate * FRAME_SECONDS)
  const voiceFrames = voice.channels[0]?.length ?? 0
  const musicFrames = music.channels[0]?.length ?? 0
  const lead = Math.round(Math.max(0, settings.leadIn) * rate)
  const tail = Math.round(Math.max(0, settings.tail) * rate)
  const total = lead + voiceFrames + tail

  // Where the voice speaks.
  const levels = frameLevels(voice, frame)
  const audible = Array.from(levels).filter((level) => level > -90)
  const floor = percentile(audible, 0.1)
  const loud = percentile(audible, 0.95)
  const threshold = loud - (loud - floor) * (0.25 + 0.6 * Math.min(1, Math.max(0, settings.sensitivity)))
  const speaking = new Uint8Array(levels.length)
  const hold = Math.round(HOLD_SECONDS / FRAME_SECONDS)
  const ahead = Math.max(1, Math.round(settings.attackMs / 1000 / FRAME_SECONDS))
  for (let f = 0; f < levels.length; f += 1) {
    if (levels[f] <= threshold) continue
    for (let g = Math.max(0, f - ahead); g <= Math.min(levels.length - 1, f + hold); g += 1) speaking[g] = 1
  }

  // What counts as speaking is the held span, gaps between words included.
  const speechFrames = speaking.reduce((sum, value) => sum + value, 0)

  // The music's gain per output frame, gliding in dB.
  const outFrames = Math.ceil(total / frame) + 1
  const musicGainDb = new Float32Array(outFrames)
  const voiceDb = new Float32Array(outFrames).fill(-100)
  const leadFrames = lead / frame
  const down = 1 - Math.exp(-FRAME_SECONDS / Math.max(0.005, settings.attackMs / 1000))
  const up = 1 - Math.exp(-FRAME_SECONDS / Math.max(0.005, settings.releaseMs / 1000))
  let duck = 0
  const tailStart = (lead + voiceFrames) / frame
  const tailFrames = tail / frame
  for (let f = 0; f < outFrames; f += 1) {
    const v = Math.floor(f - leadFrames)
    const talking = v >= 0 && v < speaking.length && speaking[v] === 1
    if (v >= 0 && v < levels.length) voiceDb[f] = levels[v]
    const target = talking ? -Math.max(0, settings.duckDb) : 0
    duck += (target - duck) * (target < duck ? down : up)
    let fade = 0
    if (tailFrames > 0 && f > tailStart) fade = 20 * Math.log10(Math.max(1e-5, 1 - (f - tailStart) / tailFrames))
    musicGainDb[f] = settings.musicDb + duck + fade
  }

  // The mix: voice in the middle of the timeline, music under all of it.
  const channels = 2
  const out: Samples[] = Array.from({ length: channels }, () => new Float32Array(total))
  // Linear gains per frame, interpolated per sample: a power per sample would
  // cost more than the whole rest of the mix.
  const musicGain = musicGainDb.map((db) => 10 ** (db / 20))
  const voiceChannel = (c: number) => voice.channels[Math.min(c, voice.channels.length - 1)]
  const musicChannel = (c: number) => music.channels[Math.min(c, music.channels.length - 1)]
  for (let c = 0; c < channels; c += 1) {
    const target = out[c]
    const v = voiceChannel(c)
    const m = musicChannel(c)
    for (let i = 0; i < total; i += 1) {
      const position = i / frame
      const f = Math.floor(position)
      const t = position - f
      const gain = musicGain[f] + (musicGain[Math.min(outFrames - 1, f + 1)] - musicGain[f]) * t
      const mi = settings.loopMusic && musicFrames > 0 ? i % musicFrames : i
      const musicSample = m && mi < musicFrames ? m[mi] : 0
      const vi = i - lead
      const voiceSample = v && vi >= 0 && vi < voiceFrames ? v[vi] : 0
      target[i] = voiceSample + musicSample * gain
    }
  }

  // Never over full scale: the whole mix steps down if it has to.
  let peak = 0
  for (const channel of out) for (let i = 0; i < channel.length; i += 1) peak = Math.max(peak, Math.abs(channel[i]))
  const peakDb = 20 * Math.log10(peak + 1e-12)
  const trimDb = peakDb > CEILING_DB ? peakDb - CEILING_DB : 0
  if (trimDb > 0) {
    const gain = 10 ** (-trimDb / 20)
    for (const channel of out) for (let i = 0; i < channel.length; i += 1) channel[i] *= gain
  }

  return {
    audio: { channels: out, sampleRate: rate },
    voiceDb,
    musicGainDb,
    report: {
      voiceSeconds: voiceFrames / rate,
      speechSeconds: speechFrames * FRAME_SECONDS,
      thresholdDb: threshold,
      totalSeconds: total / rate,
      peakDb,
      trimDb,
    },
  }
}
