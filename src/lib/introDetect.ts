/**
 * The opening of a series, from the player's side: the first eight minutes
 * of an episode decoded to plain sound (FFmpeg, reading the file where it
 * lies), handed to `workers/intro.worker.ts`, and the answer kept.
 *
 * Learning takes two episodes of the series; the opening they share goes
 * to the Merkliste with the series. Finding it in an episode takes one, and
 * where it was found is kept on this device per file, so a film watched
 * again does not decode again.
 */

import { runFfmpegOnDisk } from './ffmpegClient'
import { PRINT_RATE } from './introPrint'
import type { IntroRequest, IntroResponse } from '../workers/intro.worker'

/** How much of an episode is listened to: openings come within the first minutes. */
export const HEAD_SECONDS = 480

/** The first minutes of a file as mono 16-bit sound at the fingerprint's rate. */
export async function decodeHead(source: Blob, name: string, signal?: AbortSignal, onProgress?: (fraction: number) => void): Promise<Int16Array> {
  // A plain name for FFmpeg's file system; the extension tells it the container.
  const extension = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0] ?? '.bin'
  const { files } = await runFfmpegOnDisk({
    source,
    name: `folge${extension.toLowerCase()}`,
    args: (input) => ['-hide_banner', '-i', input, '-t', String(HEAD_SECONDS), '-vn', '-sn', '-ac', '1', '-ar', String(PRINT_RATE), '-f', 's16le', 'kopf.pcm'],
    output: ['kopf.pcm'],
    signal,
    onProgress,
    stallSeconds: 90,
  })
  const bytes = files['kopf.pcm']
  if (!bytes || bytes.byteLength < PRINT_RATE * 2 * 20) throw new Error('Zu wenig Ton in der Datei, um einen Vorspann zu finden.')
  // Its own, aligned buffer: the bytes may sit at any offset of a larger one.
  const samples = new Int16Array(Math.floor(bytes.byteLength / 2))
  new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.length * 2))
  return samples
}

let worker: Worker | null = null
let nextId = 1

/** A request without its id, kept apart per kind. */
type Ask = IntroRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never

function ask(request: Ask, transfer: Transferable[]): Promise<IntroResponse> {
  worker ??= new Worker(new URL('../workers/intro.worker.ts', import.meta.url), { type: 'module' })
  const running = worker
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<IntroResponse>) => {
      if (event.data.id !== id) return
      running.removeEventListener('message', onMessage)
      running.removeEventListener('error', onError)
      resolve(event.data)
    }
    const onError = (event: ErrorEvent) => {
      running.removeEventListener('message', onMessage)
      running.removeEventListener('error', onError)
      worker = null
      running.terminate()
      reject(new Error(event.message || 'Die Erkennung ist abgestürzt.'))
    }
    running.addEventListener('message', onMessage)
    running.addEventListener('error', onError)
    running.postMessage({ ...request, id } as IntroRequest, transfer)
  })
}

export interface LearnedIntro {
  print: string
  seconds: number
  /** Where it starts in the first and the second episode. */
  a: number
  b: number
}

/** The opening two episodes share, or null when they share none. */
export async function learnIntro(a: Int16Array, b: Int16Array): Promise<LearnedIntro | null> {
  const answer = await ask({ kind: 'learn', a, b }, [a.buffer, b.buffer])
  if (!answer.ok) throw new Error(answer.message)
  return answer.kind === 'learn' ? answer.found : null
}

export interface FoundIntro {
  start: number
  end: number
}

/** Where one of a series' openings sits in an episode, or null when none is in its first minutes. */
export async function findIntro(prints: string[], pcm: Int16Array): Promise<FoundIntro | null> {
  const answer = await ask({ kind: 'locate', prints, pcm }, [pcm.buffer])
  if (!answer.ok) throw new Error(answer.message)
  return answer.kind === 'locate' && answer.found ? { start: answer.found.start, end: answer.found.end } : null
}

/* -------------------------------------------------------------------------- */
/* Kept on this device                                                        */
/* -------------------------------------------------------------------------- */

const FOUND_KEY = 'sondra:abspielen:vorspann'

/** A short mark of a series' fingerprints, so a newly learned opening is looked for again. */
export function printTag(prints: string[]): string {
  const text = prints.join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(36)}${prints.length}`
}

type Kept = Record<string, { tag: string; start: number; end: number } | { tag: string; none: true }>

function readKept(): Kept {
  try {
    const saved = JSON.parse(localStorage.getItem(FOUND_KEY) ?? '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

const fileKey = (item: { name: string; size: number }) => `${item.name}|${item.size}`

/** Where the opening was found in this file before, for these fingerprints: a span, „none“, or unknown. */
export function keptIntro(item: { name: string; size: number }, prints: string[]): FoundIntro | 'none' | null {
  const kept = readKept()[fileKey(item)]
  if (!kept || kept.tag !== printTag(prints)) return null
  return 'none' in kept ? 'none' : { start: kept.start, end: kept.end }
}

export function keepIntro(item: { name: string; size: number }, prints: string[], found: FoundIntro | null): void {
  try {
    const kept = readKept()
    const tag = printTag(prints)
    delete kept[fileKey(item)]
    kept[fileKey(item)] = found ? { tag, start: found.start, end: found.end } : { tag, none: true }
    localStorage.setItem(FOUND_KEY, JSON.stringify(Object.fromEntries(Object.entries(kept).slice(-200))))
  } catch {
    /* only saves a second decode */
  }
}
