/**
 * Transcripts and subtitles: the page's half of speech recognition.
 *
 * Prepares the audio the way Whisper expects it (one channel, 16 kHz), talks
 * to `workers/transcribe.worker.ts`, and turns the timed segments into the
 * formats people use — plain text, SRT, WebVTT — and into a subtitle track
 * inside the video itself.
 */

import type { TranscribeResponse, TranscriptSegment } from '../workers/protocol'
import type { AudioData } from './wav'

export type { TranscriptSegment }

export interface SpeechModel {
  id: string
  label: string
  hint: string
  /** Download size of the quantised files, for the one-time note. */
  bytes: number
}

export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: 'onnx-community/whisper-base',
    label: 'Schnell',
    hint: 'Gut für klare Sprache. Einmalig rund 80 MB.',
    bytes: 77_000_000,
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Genauer',
    hint: 'Besser bei Dialekt, Musik im Hintergrund und Fachwörtern, aber etwa dreimal langsamer. Einmalig rund 250 MB.',
    bytes: 250_000_000,
  },
]

export const SPEECH_LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto', label: 'Automatisch erkennen' },
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'Englisch' },
  { id: 'fr', label: 'Französisch' },
  { id: 'it', label: 'Italienisch' },
  { id: 'es', label: 'Spanisch' },
  { id: 'pt', label: 'Portugiesisch' },
  { id: 'nl', label: 'Niederländisch' },
  { id: 'pl', label: 'Polnisch' },
  { id: 'tr', label: 'Türkisch' },
  { id: 'sq', label: 'Albanisch' },
  { id: 'sr', label: 'Serbisch' },
  { id: 'hr', label: 'Kroatisch' },
  { id: 'ta', label: 'Tamil' },
]

/** One channel at 16 kHz, resampled by the browser's own resampler. */
export async function toSpeechSamples(audio: AudioData): Promise<Float32Array> {
  const rate = 16000
  const frames = audio.channels[0]?.length ?? 0
  const length = Math.max(1, Math.ceil((frames / audio.sampleRate) * rate))
  const context = new OfflineAudioContext(1, length, rate)
  const buffer = context.createBuffer(1, frames, audio.sampleRate)
  const mono = buffer.getChannelData(0)
  for (const channel of audio.channels) {
    for (let i = 0; i < frames; i += 1) mono[i] += channel[i] / audio.channels.length
  }
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  return (await context.startRendering()).getChannelData(0)
}

let worker: Worker | null = null
let nextId = 1

export interface TranscribeHandlers {
  onLoading?: (loaded: number, total: number) => void
  onProgress?: (fraction: number, doneSeconds: number) => void
  onPartial?: (segments: TranscriptSegment[]) => void
}

/** Runs recognition; rejects with an AbortError when `signal` fires. */
export function transcribe(
  samples: Float32Array,
  options: { model: string; language: string; signal?: AbortSignal } & TranscribeHandlers,
): Promise<TranscriptSegment[]> {
  worker ??= new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url), {
    type: 'module',
    name: 'sondra-sprache',
  })
  const current = worker
  const id = nextId++
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      current.removeEventListener('message', onMessage)
      current.removeEventListener('error', onError)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const onMessage = (event: MessageEvent<TranscribeResponse>) => {
      const message = event.data
      if (message.id !== id) return
      if (message.type === 'loading') options.onLoading?.(message.loaded, message.total)
      else if (message.type === 'progress') options.onProgress?.(message.fraction, message.done)
      else if (message.type === 'partial') options.onPartial?.(message.segments)
      else if (message.type === 'done') {
        cleanup()
        resolve(message.segments)
      } else if (message.type === 'error') {
        cleanup()
        reject(message.aborted ? new DOMException('Abgebrochen', 'AbortError') : new Error(message.message))
      }
    }
    const onError = (event: ErrorEvent) => {
      cleanup()
      worker = null
      current.terminate()
      reject(new Error(event.message || 'Die Spracherkennung ist abgestürzt.'))
    }
    // Between two windows of audio; the current one finishes first.
    const onAbort = () => current.postMessage({ type: 'cancel', id })
    current.addEventListener('message', onMessage)
    current.addEventListener('error', onError)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    current.postMessage({ type: 'transcribe', id, samples, model: options.model, language: options.language }, [samples.buffer])
  })
}

/* -- shaping segments into subtitles --------------------------------------- */

const MAX_LINE = 42
const MAX_CUE = 2 * MAX_LINE

/**
 * Cues a person can read: at most two lines of about 42 characters. A long
 * segment is split at word boundaries, its time shared out by length.
 */
export function toCues(segments: TranscriptSegment[]): TranscriptSegment[] {
  const cues: TranscriptSegment[] = []
  for (const segment of segments) {
    const words = segment.text.split(/\s+/).filter(Boolean)
    const pieces: string[] = []
    let piece = ''
    for (const word of words) {
      if (piece && (piece + ' ' + word).length > MAX_CUE) {
        pieces.push(piece)
        piece = word
      } else piece = piece ? `${piece} ${word}` : word
    }
    if (piece) pieces.push(piece)
    const total = pieces.reduce((sum, text) => sum + text.length, 0) || 1
    let at = segment.start
    for (const text of pieces) {
      const length = ((segment.end - segment.start) * text.length) / total
      cues.push({ start: at, end: at + length, text: wrap(text) })
      at += length
    }
  }
  return cues
}

function wrap(text: string): string {
  if (text.length <= MAX_LINE) return text
  // The space nearest the middle, so the two lines are about equal.
  const middle = text.length / 2
  let best = -1
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ' ' && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`
}

function stamp(seconds: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(seconds * 1000))
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(ms).padStart(3, '0')}`
}

export function toSrt(segments: TranscriptSegment[]): string {
  return toCues(segments)
    .map((cue, index) => `${index + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.text}\n`)
    .join('\n')
}

export function toVtt(segments: TranscriptSegment[]): string {
  return `WEBVTT\n\n${toCues(segments)
    .map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.text}\n`)
    .join('\n')}`
}

/** Plain text, one paragraph per pause of more than two seconds. */
export function toText(segments: TranscriptSegment[]): string {
  let text = ''
  segments.forEach((segment, index) => {
    const gap = index > 0 ? segment.start - segments[index - 1].end : 0
    text += index === 0 ? segment.text : gap > 2 ? `\n\n${segment.text}` : ` ${segment.text}`
  })
  return text.trim() + '\n'
}

/* -- subtitles drawn into the picture --------------------------------------- */

/**
 * Every cue as a transparent PNG strip the width of the video, with the
 * times it shows — FFmpeg lays each one over the picture for exactly that
 * span (`overlay=…:enable=between(t,…)`).
 *
 * Drawn here rather than by FFmpeg's libass, which crashes in the
 * WebAssembly build as soon as it renders a glyph; the browser's own text
 * engine sets Public Sans the way the rest of Sondra does.
 */
export async function renderCueStrips(
  segments: TranscriptSegment[],
  width: number,
  height: number,
  duration: number,
): Promise<{ files: Record<string, Uint8Array>; cues: { file: string; start: number; end: number }[] }> {
  const cues = toCues(segments).filter((cue) => cue.end > cue.start && cue.start < duration)
  const size = Math.max(16, Math.round(Math.min(width, height) * 0.052))
  const line = Math.round(size * 1.3)
  const pad = Math.round(size * 0.45)
  const stripHeight = Math.min(height, Math.round(line * 2 + pad * 2 + height * 0.06))
  const font = `600 ${size}px "Public Sans", system-ui, sans-serif`
  await document.fonts?.load(font).catch(() => undefined)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = stripHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Zeichnen im Browser ist nicht möglich.')

  const png = async () =>
    new Uint8Array(await (await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Bild der Untertitel leer.'))), 'image/png'),
    )).arrayBuffer())

  const files: Record<string, Uint8Array> = {}
  const placed: { file: string; start: number; end: number }[] = []

  for (const [index, cue] of cues.entries()) {
    context.clearRect(0, 0, width, stripHeight)
    context.font = font
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const lines = cue.text.split('\n')
    const bottom = stripHeight - height * 0.06
    lines.forEach((text, at) => {
      const y = bottom - pad - (lines.length - at - 0.5) * line
      const measured = context.measureText(text).width
      // A dark plate behind each line, rounded like the rest of Sondra, so
      // the text reads on snow and on night alike.
      context.fillStyle = 'rgba(0, 0, 0, 0.62)'
      const plateWidth = measured + pad * 2
      context.beginPath()
      context.roundRect(width / 2 - plateWidth / 2, y - line / 2, plateWidth, line, Math.round(size * 0.28))
      context.fill()
      context.fillStyle = '#ffffff'
      context.fillText(text, width / 2, y + size * 0.04)
    })
    files[`sub/${index}.png`] = await png()
    placed.push({ file: `sub/${index}.png`, start: cue.start, end: Math.min(cue.end, duration) })
  }
  return { files, cues: placed }
}

