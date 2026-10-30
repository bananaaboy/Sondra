/**
 * Subtitles for the films and episodes of a folder: found beside them, or made
 * here with the speech model that runs in the browser, and written next to the
 * file as `Name.srt` — which the player finds again by itself.
 *
 * Nothing is looked up online: a subtitle database would be someone else's
 * server told what one watches. What exists beside the file is used; what does
 * not is listened for, on this device.
 */

import { runFfmpegOnDisk } from './ffmpegClient'
import { toCues, toSrt, transcribe, type TranscriptSegment } from './transcribe'

/** The sound of a file as the speech model wants it: mono, 16 kHz, floating point. Read from disk in slices, never copied whole. */
export async function speechSamplesOf(file: Blob, name: string, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<Float32Array> {
  const extension = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0].toLowerCase() ?? '.bin'
  const { files } = await runFfmpegOnDisk({
    source: file,
    name: `ton${extension}`,
    args: (input) => ['-hide_banner', '-i', input, '-vn', '-sn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'ton.raw'],
    output: ['ton.raw'],
    signal,
    onProgress,
    stallSeconds: 120,
  })
  const bytes = files['ton.raw']
  if (!bytes || bytes.byteLength < 16000 * 4 * 2) throw new Error('In der Datei ist kaum Ton zu hören.')
  // Its own aligned buffer: the bytes may sit at any offset of a larger one.
  const samples = new Float32Array(Math.floor(bytes.byteLength / 4))
  new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 4))
  return samples
}

export { subtitleNameFor, subtitlesBeside } from './subtitleFiles'

export interface ListenHandlers {
  onStage?: (stage: { kind: 'sound'; fraction: number } | { kind: 'loading'; loaded: number; total: number } | { kind: 'listening'; fraction: number }) => void
}

/** The subtitle text for a file, listened for on this device. */
export async function listenTo(
  file: Blob,
  name: string,
  { model, language, signal, onStage }: { model: string; language: string; signal?: AbortSignal } & ListenHandlers,
): Promise<{ srt: string; cues: number }> {
  const samples = await speechSamplesOf(file, name, signal, (fraction) => onStage?.({ kind: 'sound', fraction }))
  const segments: TranscriptSegment[] = await transcribe(samples, {
    model,
    language,
    signal,
    onLoading: (loaded, total) => onStage?.({ kind: 'loading', loaded, total }),
    onProgress: (fraction) => onStage?.({ kind: 'listening', fraction }),
  })
  const cues = toCues(segments).filter((cue) => cue.text.trim())
  if (cues.length === 0) throw new Error('Es wurde keine Sprache erkannt.')
  return { srt: toSrt(cues), cues: cues.length }
}
