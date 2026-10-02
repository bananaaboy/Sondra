/**
 * Speech to text with Whisper, on this machine, off the page's thread.
 *
 * transformers.js runs the model with onnxruntime-web. The model itself comes
 * from Hugging Face the first time — only the model files, never the audio —
 * and is kept in the browser's cache after that, so later runs and offline
 * use need no network. The runtime's WebAssembly is bundled with Sondra
 * rather than fetched from the CDN transformers.js would otherwise use.
 *
 * The audio is cut into windows of about half a minute at the quietest point
 * near each boundary, so a word is not split in two, and every window reports
 * progress and can be cancelled between windows.
 */

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import ortMjs from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from '../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url'

import type { TranscribeRequest, TranscribeResponse, TranscriptSegment } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (message: TranscribeResponse) => scope.postMessage(message)

env.allowLocalModels = false
env.useBrowserCache = true
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }

const RATE = 16000
const WINDOW = 28 * RATE
/** How far before a window's end the cut may move to find a pause. */
const SEEK = 3 * RATE

let loaded: { model: string; run: AutomaticSpeechRecognitionPipeline } | null = null
const cancelled = new Set<number>()

async function recognizer(model: string, id: number): Promise<AutomaticSpeechRecognitionPipeline> {
  if (loaded?.model === model) return loaded.run
  loaded = null
  const files = new Map<string, { loaded: number; total: number }>()
  const run = (await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (event: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (event.status !== 'progress' || !event.file) return
      files.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 })
      let done = 0
      let total = 0
      for (const entry of files.values()) {
        done += entry.loaded
        total += entry.total
      }
      post({ type: 'loading', id, loaded: done, total })
    },
  })) as AutomaticSpeechRecognitionPipeline
  loaded = { model, run }
  return run
}

/** The quietest 20 ms in [from, to), as a sample index. */
function quietestPoint(samples: Float32Array, from: number, to: number): number {
  const frame = RATE / 50
  let best = to
  let bestEnergy = Infinity
  for (let start = from; start + frame <= to; start += frame) {
    let energy = 0
    for (let i = start; i < start + frame; i += 4) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + frame / 2
    }
  }
  return Math.floor(best)
}

function windows(samples: Float32Array): [number, number][] {
  const result: [number, number][] = []
  let start = 0
  while (start < samples.length) {
    let end = Math.min(samples.length, start + WINDOW)
    if (end < samples.length) end = quietestPoint(samples, end - SEEK, end)
    result.push([start, end])
    start = end
  }
  return result
}

scope.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    cancelled.add(request.id)
    return
  }
  const { id, samples, model, language } = request
  try {
    const run = await recognizer(model, id)
    const parts = windows(samples)
    const segments: TranscriptSegment[] = []
    for (const [index, [from, to]] of parts.entries()) {
      if (cancelled.has(id)) throw new DOMException('Abgebrochen', 'AbortError')
      post({ type: 'progress', id, fraction: index / parts.length, done: from / RATE })
      const output = await run(samples.subarray(from, to), {
        language: language === 'auto' ? undefined : language,
        task: 'transcribe',
        return_timestamps: true,
      })
      const result = Array.isArray(output) ? output[0] : output
      const offset = from / RATE
      const length = (to - from) / RATE
      for (const chunk of result.chunks ?? []) {
        const text = chunk.text.trim()
        if (!text) continue
        const [start, end] = chunk.timestamp
        segments.push({
          start: offset + (start ?? 0),
          end: offset + Math.min(length, end ?? length),
          text,
        })
      }
      if (!result.chunks?.length && result.text.trim()) {
        segments.push({ start: offset, end: offset + length, text: result.text.trim() })
      }
      post({ type: 'partial', id, segments: [...segments] })
    }
    post({ type: 'done', id, segments })
  } catch (failure) {
    const aborted = failure instanceof DOMException && failure.name === 'AbortError'
    post({ type: 'error', id, message: aborted ? 'Abgebrochen' : failure instanceof Error ? failure.message : String(failure), aborted })
  } finally {
    cancelled.delete(id)
  }
}
