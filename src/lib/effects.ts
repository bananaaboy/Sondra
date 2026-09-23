/**
 * Sound-shaping for the audio editor: filters, EQ, dynamics, noise, space,
 * and the clipboard-style edits that work on a range.
 *
 * Everything takes an AudioData and returns a new one; the editor keeps the
 * old one for undo. Filters are the RBJ cookbook biquads run per channel in
 * plain JS, the compressor detects on the linked channels so a stereo image
 * does not wander, and reverb is the only thing that goes through the Web
 * Audio engine, because a long convolution is what that engine is good at.
 */

import { setChannels } from './edit'
import { noiseProfile, reduceNoise } from './micCalibrate'
import type { AudioData, Samples } from './wav'

const dbToGain = (db: number) => 10 ** (db / 20)
const frames = (audio: AudioData) => audio.channels[0]?.length ?? 0
const at = (audio: AudioData, seconds: number) =>
  Math.max(0, Math.min(frames(audio), Math.round(seconds * audio.sampleRate)))

/* -------------------------------------------------------------------------- */
/* Biquads                                                                     */
/* -------------------------------------------------------------------------- */

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function highpass(rate: number, hz: number, q: number): Biquad {
  const w = (2 * Math.PI * hz) / rate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

function lowpass(rate: number, hz: number, q: number): Biquad {
  const w = (2 * Math.PI * hz) / rate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

function shelf(rate: number, hz: number, gainDb: number, high: boolean): Biquad {
  const A = 10 ** (gainDb / 40)
  const w = (2 * Math.PI * hz) / rate
  const cos = Math.cos(w)
  const alpha = (Math.sin(w) / 2) * Math.SQRT2 // shelf slope 1
  const root = 2 * Math.sqrt(A) * alpha
  if (!high) {
    return normalise(
      A * (A + 1 - (A - 1) * cos + root),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - root),
      A + 1 + (A - 1) * cos + root,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - root,
    )
  }
  return normalise(
    A * (A + 1 + (A - 1) * cos + root),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - root),
    A + 1 - (A - 1) * cos + root,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - root,
  )
}

function run(input: Float32Array, f: Biquad): Samples {
  const out = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i]
    const y = f.b0 * x + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

const eachChannel = (audio: AudioData, fn: (channel: Float32Array) => Samples): AudioData => ({
  channels: audio.channels.map(fn),
  sampleRate: audio.sampleRate,
})

/** Removes what lies below `hz`, 24 dB per octave. */
export function highpassFilter(audio: AudioData, hz: number): AudioData {
  const rate = audio.sampleRate
  return eachChannel(audio, (c) => run(run(c, highpass(rate, hz, 0.5412)), highpass(rate, hz, 1.3066)))
}

/** Removes what lies above `hz`, 24 dB per octave. */
export function lowpassFilter(audio: AudioData, hz: number): AudioData {
  const rate = audio.sampleRate
  const top = Math.min(hz, rate / 2 - 100)
  return eachChannel(audio, (c) => run(run(c, lowpass(rate, top, 0.5412)), lowpass(rate, top, 1.3066)))
}

/** Two shelves: bass around 120 Hz, treble around 6 kHz. */
export function shelfEq(audio: AudioData, bassDb: number, trebleDb: number): AudioData {
  const rate = audio.sampleRate
  return eachChannel(audio, (c) => {
    let out: Samples = new Float32Array(c)
    if (bassDb !== 0) out = run(out, shelf(rate, 120, bassDb, false))
    if (trebleDb !== 0) out = run(out, shelf(rate, Math.min(6000, rate / 2 - 500), trebleDb, true))
    return out
  })
}

/* -------------------------------------------------------------------------- */
/* Dynamics                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Feed-forward RMS compressor, channels linked, soft knee. With `makeup`, the
 * average gain it took away is given back so the result is not just quieter.
 */
export function compressAudio(
  audio: AudioData,
  thresholdDb: number,
  ratio: number,
  { attackMs = 10, releaseMs = 150, makeup = true }: { attackMs?: number; releaseMs?: number; makeup?: boolean } = {},
): { audio: AudioData; maxReductionDb: number; makeupDb: number } {
  const rate = audio.sampleRate
  const n = frames(audio)
  const attack = Math.exp(-1 / (rate * attackMs * 0.001))
  const release = Math.exp(-1 / (rate * releaseMs * 0.001))
  const rms = Math.exp(-1 / (rate * 0.01))
  const knee = 6
  const gains = new Float32Array(n)
  let power = 0
  let reduction = 0
  let maxReduction = 0
  let reductionSum = 0
  for (let i = 0; i < n; i += 1) {
    let square = 0
    for (const channel of audio.channels) square = Math.max(square, channel[i] * channel[i])
    power = rms * power + (1 - rms) * square
    const level = power > 1e-20 ? 10 * Math.log10(power) : -200
    const over = level - thresholdDb
    let wanted = 0
    if (over > knee / 2) wanted = over * (1 - 1 / ratio)
    else if (over > -knee / 2) wanted = ((over + knee / 2) ** 2 / (2 * knee)) * (1 - 1 / ratio)
    reduction = wanted > reduction ? attack * reduction + (1 - attack) * wanted : release * reduction + (1 - release) * wanted
    if (reduction > maxReduction) maxReduction = reduction
    reductionSum += reduction
    gains[i] = reduction
  }
  // Make-up is half the average reduction: enough to sound level, not so much
  // that the loud parts come back over where they were.
  const makeupDb = makeup && n ? (reductionSum / n) * 0.5 : 0
  const channels = audio.channels.map((channel) => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i += 1) out[i] = Math.max(-1, Math.min(1, channel[i] * dbToGain(makeupDb - gains[i])))
    return out
  })
  return { audio: { channels, sampleRate: rate }, maxReductionDb: maxReduction, makeupDb }
}

/* -------------------------------------------------------------------------- */
/* Noise                                                                       */
/* -------------------------------------------------------------------------- */

/** What the quiet part sounds like, bin by bin, from the first channel mixed. */
export function learnNoise(sample: AudioData): Float32Array {
  const n = frames(sample)
  const mono = new Float32Array(n)
  for (const channel of sample.channels) for (let i = 0; i < n; i += 1) mono[i] += channel[i] / sample.channels.length
  return noiseProfile(mono)
}

export function removeNoise(audio: AudioData, profile: Float32Array, maxCutDb: number): AudioData {
  return eachChannel(audio, (channel) => reduceNoise(channel, profile, maxCutDb))
}

/* -------------------------------------------------------------------------- */
/* Space                                                                       */
/* -------------------------------------------------------------------------- */

/** A feedback echo. `extend` lets the repeats ring out past the end. */
export function echo(audio: AudioData, delayMs: number, feedback: number, mix: number, extend: boolean): AudioData {
  const rate = audio.sampleRate
  const delay = Math.max(1, Math.round((delayMs / 1000) * rate))
  const tail = extend ? Math.min(Math.round(rate * 6), Math.round(delay * Math.log(0.001) / Math.log(Math.max(0.05, feedback)))) : 0
  const n = frames(audio)
  return eachChannel(audio, (channel) => {
    const out = new Float32Array(n + tail)
    const line = new Float32Array(n + tail)
    for (let i = 0; i < n + tail; i += 1) {
      const dry = i < n ? channel[i] : 0
      const echoed = i >= delay ? line[i - delay] : 0
      line[i] = dry + echoed * feedback
      out[i] = Math.max(-1, Math.min(1, dry + echoed * mix))
    }
    return out
  })
}

/** Convolution reverb with a generated room: decaying, decorrelated noise. */
export async function reverb(audio: AudioData, seconds: number, mix: number, extend: boolean): Promise<AudioData> {
  const rate = audio.sampleRate
  const n = frames(audio)
  const length = n + (extend ? Math.round(seconds * rate) : 0)
  const channelCount = Math.max(2, audio.channels.length)
  const context = new OfflineAudioContext(channelCount, length, rate)

  const irLength = Math.max(1, Math.round(seconds * rate))
  const ir = context.createBuffer(2, irLength, rate)
  for (let c = 0; c < 2; c += 1) {
    const data = ir.getChannelData(c)
    let seed = 12345 + c * 999
    for (let i = 0; i < irLength; i += 1) {
      seed = (seed * 16807) % 2147483647
      const noise = (seed / 2147483647) * 2 - 1
      data[i] = noise * Math.exp((-6.9 * i) / irLength)
    }
  }

  const input = context.createBuffer(audio.channels.length, n, rate)
  audio.channels.forEach((channel, index) => input.copyToChannel(new Float32Array(channel), index))
  const source = context.createBufferSource()
  source.buffer = input
  const convolver = context.createConvolver()
  convolver.buffer = ir
  const wet = context.createGain()
  wet.gain.value = mix * 0.5
  const dry = context.createGain()
  dry.gain.value = 1
  source.connect(dry).connect(context.destination)
  source.connect(convolver).connect(wet).connect(context.destination)
  source.start()
  const rendered = await context.startRendering()
  const channels = Array.from({ length: audio.channels.length === 1 ? 2 : audio.channels.length }, (_, index) => {
    const data = new Float32Array(rendered.getChannelData(index))
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(-1, Math.min(1, data[i]))
    return data
  })
  return { channels, sampleRate: rate }
}

/* -------------------------------------------------------------------------- */
/* Ranges and the clipboard                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Runs `fn` on a range only, and puts the result back with 5 ms crossfades at
 * both seams — a filter switched on and off mid-waveform would otherwise
 * leave a step, and a step clicks.
 */
export async function processRange(
  audio: AudioData,
  from: number,
  to: number,
  fn: (part: AudioData) => AudioData | Promise<AudioData>,
): Promise<AudioData> {
  const start = at(audio, from)
  const end = at(audio, to)
  if (end - start < 2) return audio
  const part: AudioData = { channels: audio.channels.map((c) => c.slice(start, end)), sampleRate: audio.sampleRate }
  const processed = setChannels(await fn(part), audio.channels.length)
  const fade = Math.min(Math.round(audio.sampleRate * 0.005), Math.floor((end - start) / 2))
  const channels = audio.channels.map((channel, index) => {
    const out = new Float32Array(channel)
    const next = processed.channels[index]
    for (let i = start; i < end; i += 1) {
      const k = i - start
      const wet = k < fade ? k / fade : end - 1 - i < fade ? (end - 1 - i) / fade : 1
      out[i] = channel[i] * (1 - wet) + (next[k] ?? 0) * wet
    }
    return out
  })
  return { channels, sampleRate: audio.sampleRate }
}

export function copyRange(audio: AudioData, from: number, to: number): AudioData {
  const start = at(audio, from)
  const end = at(audio, to)
  return { channels: audio.channels.map((c) => c.slice(start, end)), sampleRate: audio.sampleRate }
}

/** Puts `clip` in at `seconds`, pushing everything after it back. */
export function insertAt(audio: AudioData, seconds: number, clip: AudioData): AudioData {
  const index = at(audio, seconds)
  const fitted = setChannels(clip, audio.channels.length)
  const length = frames(fitted)
  const channels = audio.channels.map((channel, c) => {
    const out = new Float32Array(channel.length + length)
    out.set(channel.subarray(0, index), 0)
    out.set(fitted.channels[c], index)
    out.set(channel.subarray(index), index + length)
    return out
  })
  return { channels, sampleRate: audio.sampleRate }
}

export function insertSilence(audio: AudioData, seconds: number, length: number): AudioData {
  const silent = Math.round(length * audio.sampleRate)
  return insertAt(audio, seconds, {
    channels: audio.channels.map(() => new Float32Array(silent)),
    sampleRate: audio.sampleRate,
  })
}

/** The selection, played twice in a row. */
export function duplicateRange(audio: AudioData, from: number, to: number): AudioData {
  return insertAt(audio, to, copyRange(audio, from, to))
}

/** Silence over a range, with 5 ms ramps so the edges do not click. */
export function muteRange(audio: AudioData, from: number, to: number): AudioData {
  const start = at(audio, from)
  const end = at(audio, to)
  const ramp = Math.min(Math.round(audio.sampleRate * 0.005), Math.floor((end - start) / 2))
  return eachChannel(audio, (channel) => {
    const out = new Float32Array(channel)
    for (let i = start; i < end; i += 1) {
      const k = i - start
      const keep = k < ramp ? 1 - k / ramp : end - 1 - i < ramp ? 1 - (end - 1 - i) / ramp : 0
      out[i] = channel[i] * keep
    }
    return out
  })
}

/** A fade across the whole selection: silence to full, or full to silence. */
export function fadeRange(audio: AudioData, from: number, to: number, direction: 'in' | 'out'): AudioData {
  const start = at(audio, from)
  const end = at(audio, to)
  const span = Math.max(1, end - start)
  return eachChannel(audio, (channel) => {
    const out = new Float32Array(channel)
    for (let i = start; i < end; i += 1) {
      const t = (i - start) / span
      // An equal-power curve: a linear fade sounds as if it drops off early.
      const gain = direction === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2)
      out[i] = channel[i] * gain
    }
    return out
  })
}
