/// <reference lib="webworker" />
/**
 * Finding the opening, away from the page: the fingerprints of two
 * episodes and the stretch they share, or where a known opening sits in
 * one more. A few hundred milliseconds of arithmetic each — enough to make
 * a playing film stutter if it ran beside it.
 */

import { decodePrint, encodePrint, fingerprint, locate, longestShared, PRINT_FPS, slice } from '../lib/introPrint'

export type IntroRequest =
  | { id: number; kind: 'learn'; a: Int16Array; b: Int16Array }
  | { id: number; kind: 'locate'; prints: string[]; pcm: Int16Array }

export type IntroResponse =
  | { id: number; ok: true; kind: 'learn'; found: { print: string; seconds: number; a: number; b: number } | null }
  | { id: number; ok: true; kind: 'locate'; found: { start: number; end: number; score: number } | null }
  | { id: number; ok: false; message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<IntroRequest>) => {
  const request = event.data
  try {
    if (request.kind === 'learn') {
      const a = fingerprint(request.a)
      const shared = longestShared(a, fingerprint(request.b))
      const found = shared
        ? { print: encodePrint(slice(a, shared.a, shared.frames)), seconds: shared.frames / PRINT_FPS, a: shared.a / PRINT_FPS, b: shared.b / PRINT_FPS }
        : null
      scope.postMessage({ id: request.id, ok: true, kind: 'learn', found } satisfies IntroResponse)
    } else {
      // Each opening the series has; the one that fits best.
      const target = fingerprint(request.pcm)
      let found: { start: number; end: number; score: number } | null = null
      for (const print of request.prints) {
        const reference = decodePrint(print)
        const hit = reference ? locate(reference, target) : null
        if (hit && reference && (!found || hit.score > found.score)) {
          found = { start: hit.at / PRINT_FPS, end: (hit.at + reference.bits.length) / PRINT_FPS, score: hit.score }
        }
      }
      scope.postMessage({ id: request.id, ok: true, kind: 'locate', found } satisfies IntroResponse)
    }
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) } satisfies IntroResponse)
  }
}
