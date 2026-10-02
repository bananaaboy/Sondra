/**
 * Warms FFmpeg in the background, without standing in front of the app.
 *
 * The core is thirty-odd megabytes and most tools here need it sooner or
 * later, so it is worth having on hand before the first conversion. What it is
 * not worth is a closed door: this used to be a full-screen gate
 * (`BootGate`) that held the entire site — including the two thirds of it that
 * never touch FFmpeg, like stems, loudness, harmony and the chopper — until
 * the download finished. Visiting the site meant watching a progress bar.
 *
 * Nothing is lost by letting it run behind the page. Every panel already
 * awaits `loadFfmpeg()` itself and shows its own busy state while it waits, so
 * a tool pressed before the core has landed reports the wait where the wait
 * actually is, and a failure surfaces as that tool's error rather than as a
 * wall. The current state stays readable under „Unter der Haube".
 */

import { useEffect } from 'react'

import { loadFfmpeg } from '../lib/ffmpegClient'

/**
 * After the page has settled, not during its first second: fetching and
 * compiling thirty megabytes competed with the first paint and the first
 * clicks for the same cores. A tool that needs the core earlier asks for it
 * itself and gets the same shared load.
 */
const SETTLE_MS = 2500

export function useFfmpegPrefetch() {
  useEffect(() => {
    // Failures surface through the boot state and through whichever panel
    // needs the core; there is nothing to do with the rejection here.
    const start = () => void loadFfmpeg().catch(() => {})
    let idle: number | null = null
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(start, { timeout: 3000 })
      else start()
    }, SETTLE_MS)
    return () => {
      window.clearTimeout(timer)
      if (idle !== null) window.cancelIdleCallback(idle)
    }
  }, [])
}
