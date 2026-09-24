/**
 * Web Audio bridge and sample-level editing helpers.
 *
 * Decoding goes through the browser's own decoder first — it is hardware
 * accelerated and costs nothing to call. Only when the browser refuses a
 * container (Opus in Matroska, AC-3, odd AVI variants) does the caller fall
 * back to FFmpeg, which is why `decodeAudio` reports *why* it failed rather
 * than swallowing the error.
 */

import { fromAudioBuffer, type AudioData } from './wav'

export { mixToMono } from './wav'

let sharedContext: AudioContext | null = null

type SinkContext = AudioContext & {
  sinkId?: string | { type: string }
  setSinkId?: (id: string | { type: 'none' }) => Promise<void>
}

/**
 * Where playback stands, for the app's log: the desktop app has no console
 * anyone reads, and "no sound" is otherwise a guess between a dozen causes.
 */
export function audioReport(context: AudioContext = getAudioContext()): string {
  const sink = (context as SinkContext).sinkId
  return (
    `Ton: ${context.state}, ${context.sampleRate} Hz, Ausgang ${typeof sink === 'string' ? sink || 'Standard' : (sink?.type ?? '?')}` +
    `, Latenz ${Math.round((context.baseLatency + (context.outputLatency || 0)) * 1000)} ms`
  )
}

const note = (message: string) => {
  // The app writes lines that start with [Sondra] into sondra.log.
  if (/\bElectron\//.test(navigator.userAgent)) console.info(`[Sondra] ${message}`)
}

/** Whether the person picked an output in the Mikrofon tool; then it stays. */
let pinnedOutput = false
export function pinOutput(pinned: boolean) {
  pinnedOutput = pinned
}

/**
 * A single lazily created AudioContext. A closed one is replaced — every
 * sound in Sondra goes through this one context, and a dead one would
 * silence all of it for the rest of the session.
 */
export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext()
    note(`erstellt — ${audioReport(sharedContext)}`)
    watchDevices()
  }
  return sharedContext
}

export async function resumeAudioContext(): Promise<void> {
  const context = getAudioContext()
  if (context.state !== 'running') {
    try {
      await context.resume()
    } catch (failure) {
      note(`fortsetzen fehlgeschlagen: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
    note(`fortgesetzt — ${audioReport(context)}`)
  }
}

/**
 * Opens the context with the first click or key anywhere, so the output
 * device is open before the first play button — and the log has a line
 * about the sound even when nothing ever played.
 */
if (typeof window !== 'undefined') {
  const early = () => {
    window.removeEventListener('pointerdown', early, true)
    window.removeEventListener('keydown', early, true)
    void resumeAudioContext()
  }
  window.addEventListener('pointerdown', early, true)
  window.addEventListener('keydown', early, true)
}

let watching = false

/**
 * Headphones plugged in, a Bluetooth speaker connected, Windows switching its
 * default: a context opened on the old device can keep playing into it —
 * or into nothing. When the devices change and no output was picked by hand,
 * the context is sent away and back to the default, which reopens it on
 * whatever the default is now.
 */
function watchDevices() {
  if (watching || typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return
  watching = true
  navigator.mediaDevices.addEventListener('devicechange', () => {
    const context = sharedContext as SinkContext | null
    if (!context || pinnedOutput || !context.setSinkId) return
    void (async () => {
      try {
        await context.setSinkId!({ type: 'none' })
        await context.setSinkId!('')
        note(`Geräte geändert, Standardausgang neu geöffnet — ${audioReport(context)}`)
      } catch (failure) {
        note(`Geräte geändert, Ausgang nicht neu geöffnet: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
    })()
  })
}

/** One second of a quiet A, to hear whether and where Sondra's sound comes out. */
export async function playTestTone(): Promise<string> {
  await resumeAudioContext()
  const context = getAudioContext()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = 440
  const now = context.currentTime
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.2, now + 0.02)
  gain.gain.setValueAtTime(0.2, now + 0.9)
  gain.gain.linearRampToValueAtTime(0, now + 1)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 1.05)
  const report = audioReport(context)
  note(`Testton — ${report}`)
  return report
}

/** Decodes any container the browser understands into planar floats. */
export async function decodeWithBrowser(bytes: ArrayBuffer): Promise<AudioData> {
  const context = getAudioContext()
  // decodeAudioData detaches the buffer it is given, so hand it a copy.
  const buffer = await context.decodeAudioData(bytes.slice(0))
  return fromAudioBuffer(buffer)
}

export function toAudioBuffer(audio: AudioData, context: BaseAudioContext): AudioBuffer {
  const frames = audio.channels[0]?.length ?? 0
  const buffer = context.createBuffer(Math.max(1, audio.channels.length), Math.max(1, frames), audio.sampleRate)
  audio.channels.forEach((channel, index) => buffer.copyToChannel(channel, index))
  return buffer
}

/* -------------------------------------------------------------------------- */
/* Sample-level edits                                                          */
/* -------------------------------------------------------------------------- */

/** Extracts `[startSeconds, endSeconds)` as a new buffer. */
export function sliceAudio(audio: AudioData, startSeconds: number, endSeconds: number): AudioData {
  const frames = audio.channels[0]?.length ?? 0
  const start = Math.max(0, Math.min(frames, Math.floor(startSeconds * audio.sampleRate)))
  const end = Math.max(start, Math.min(frames, Math.ceil(endSeconds * audio.sampleRate)))
  return {
    channels: audio.channels.map((channel) => new Float32Array(channel.subarray(start, end))),
    sampleRate: audio.sampleRate,
  }
}

/** Equal-power fades at the slice boundaries, to kill edge clicks. */
export function applyFades(audio: AudioData, fadeInSeconds: number, fadeOutSeconds: number): AudioData {
  const frames = audio.channels[0]?.length ?? 0
  const fadeIn = Math.min(frames, Math.round(fadeInSeconds * audio.sampleRate))
  const fadeOut = Math.min(frames - fadeIn, Math.round(fadeOutSeconds * audio.sampleRate))

  const channels = audio.channels.map((channel) => {
    const out = new Float32Array(channel)
    for (let i = 0; i < fadeIn; i += 1) out[i] *= Math.sin((Math.PI / 2) * (i / fadeIn))
    for (let i = 0; i < fadeOut; i += 1) {
      const at = frames - 1 - i
      out[at] *= Math.sin((Math.PI / 2) * (i / fadeOut))
    }
    return out
  })
  return { channels, sampleRate: audio.sampleRate }
}

export function reverseAudio(audio: AudioData): AudioData {
  return {
    channels: audio.channels.map((channel) => {
      const out = new Float32Array(channel.length)
      for (let i = 0; i < channel.length; i += 1) out[i] = channel[channel.length - 1 - i]
      return out
    }),
    sampleRate: audio.sampleRate,
  }
}

export function applyGain(audio: AudioData, gain: number): AudioData {
  return {
    channels: audio.channels.map((channel) => {
      const out = new Float32Array(channel.length)
      for (let i = 0; i < channel.length; i += 1) out[i] = channel[i] * gain
      return out
    }),
    sampleRate: audio.sampleRate,
  }
}

/** Scales so the loudest sample lands exactly on `targetDbfs`. */
export function normalizePeak(audio: AudioData, targetDbfs = -0.3): AudioData {
  let peak = 0
  for (const channel of audio.channels) {
    for (let i = 0; i < channel.length; i += 1) peak = Math.max(peak, Math.abs(channel[i]))
  }
  if (peak <= 0) return audio
  return applyGain(audio, 10 ** (targetDbfs / 20) / peak)
}

/**
 * Peak envelope for waveform drawing: min and max per pixel column.
 * Drawing from the raw samples would push millions of points at the canvas.
 */
export function peakEnvelope(audio: AudioData, buckets: number): { min: Float32Array; max: Float32Array } {
  const frames = audio.channels[0]?.length ?? 0
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)
  if (frames === 0) return { min, max }

  const perBucket = frames / buckets
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * perBucket)
    const end = Math.min(frames, Math.ceil((b + 1) * perBucket))
    let lo = 0
    let hi = 0
    for (let i = start; i < end; i += 1) {
      for (const channel of audio.channels) {
        const value = channel[i]
        if (value < lo) lo = value
        if (value > hi) hi = value
      }
    }
    min[b] = lo
    max[b] = hi
  }
  return { min, max }
}
