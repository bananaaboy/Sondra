/**
 * „Beim Minimieren pausieren“: when the window is minimised, everything that
 * is playing in Sondra stops — the player, the sound editor, the sampler, the
 * previews. Off until switched on; it only pauses, nothing starts again when
 * the window comes back, because a film that begins by itself in a meeting is
 * worse than one that waits.
 *
 * The Windows app says when its window is minimised (`onWindowState`). Where
 * there is no window to ask — a browser tab, the Android app — the page
 * becoming hidden is the nearest thing, so there it also fires when another
 * tab is brought forward; the switch says so.
 */

import { create } from 'zustand'

import { APP_BRIDGE } from './desktop'

const KEY = 'sondra:pausieren-beim-minimieren'

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export const usePauseOnMinimize = create<{ on: boolean }>(() => ({ on: readOn() }))

export function setPauseOnMinimize(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Then only for this visit.
  }
  usePauseOnMinimize.setState({ on })
}

/** True where the app tells when the window is minimised, not only when the page is hidden. */
export const hasWindowEvents = () => typeof APP_BRIDGE?.onWindowState === 'function'

/* -------------------------------------------------------------------------- */
/* What is playing                                                            */
/* -------------------------------------------------------------------------- */

const pausers = new Set<() => void>()

/**
 * Something that plays through Web Audio, not through a media element — the
 * sound editor, the sampler, the sequencer — says how to stop it. Returns the
 * way to take it back.
 */
export function registerPauser(pause: () => void): () => void {
  pausers.add(pause)
  return () => void pausers.delete(pause)
}

/**
 * Media elements that were started and not yet paused. A `new Audio()` that
 * never joins the page (the waveform's own) is not found by looking at the
 * page, so `play()` itself is the one place that sees every one.
 */
const playing = new Set<HTMLMediaElement>()
let tracking = false

function track(): void {
  if (tracking || typeof HTMLMediaElement === 'undefined') return
  tracking = true
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!playing.has(this)) {
      playing.add(this)
      const done = () => void playing.delete(this)
      this.addEventListener('pause', done, { once: true })
      this.addEventListener('ended', done, { once: true })
    }
    return play.call(this)
  }
}

/** Stops everything that plays; says how many things it stopped. */
export function pauseEverything(): number {
  let stopped = 0
  // A film in a picture-in-picture window is meant to go on when its window is minimised.
  const floating = typeof document !== 'undefined' ? document.pictureInPictureElement : null
  for (const element of [...playing]) {
    if (element === floating || element.paused || element.ended) continue
    element.pause()
    stopped += 1
  }
  for (const pause of [...pausers]) {
    try {
      pause()
      stopped += 1
    } catch {
      // One that cannot stop must not keep the others from it.
    }
  }
  return stopped
}

/** Listens, once, for the window being minimised. */
let started = false
export function initPauseOnMinimize(): void {
  if (started || typeof window === 'undefined') return
  started = true
  track()
  const minimised = () => {
    if (usePauseOnMinimize.getState().on) pauseEverything()
  }
  if (APP_BRIDGE?.onWindowState) {
    APP_BRIDGE.onWindowState((state) => {
      if (state === 'minimized') minimised()
    })
    return
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') minimised()
  })
}
