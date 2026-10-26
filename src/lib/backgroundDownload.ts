/**
 * Background downloading helpers:
 * - Keeps OS and screen awake via Screen Wake Lock API and Electron powerSaveBlocker
 * - Updates browser tab title with progress percent and title
 * - Updates Windows taskbar progress in the Electron app
 * - Audio chime on download completion (custom synthesized Web Audio tone)
 */

import { APP_BRIDGE } from './desktop'

const CHIME_PREF_KEY = 'sondra:download_chime'

export function getDownloadChimeEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  try {
    const val = localStorage.getItem(CHIME_PREF_KEY)
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

export function setDownloadChimeEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CHIME_PREF_KEY, enabled ? 'true' : 'false')
  } catch {
    // ignore
  }
}

let wakeLockSentinel: any = null
let wakeLockRequested = false

export async function acquireWakeLock(): Promise<void> {
  wakeLockRequested = true
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
  try {
    if (!wakeLockSentinel || wakeLockSentinel.released) {
      wakeLockSentinel = await (navigator as any).wakeLock.request('screen')
      wakeLockSentinel.addEventListener?.('release', () => {
        wakeLockSentinel = null
      })
    }
  } catch {
    // WakeLock may fail if device is low on battery or in background
  }
}

export async function releaseWakeLock(): Promise<void> {
  wakeLockRequested = false
  try {
    if (wakeLockSentinel && !wakeLockSentinel.released) {
      await wakeLockSentinel.release()
      wakeLockSentinel = null
    }
  } catch {
    // ignore
  }
}

// Re-acquire wakeLock if user switches back to the tab while downloads are active
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLockRequested) {
      void acquireWakeLock()
    }
  })
}

let defaultDocumentTitle: string | null = null

export function updateDownloadProgressState(options: {
  activeCount: number
  totalCount: number
  fraction: number // 0 to 1
  currentName?: string | null
}): void {
  const { activeCount, fraction, currentName } = options

  if (typeof document !== 'undefined') {
    if (defaultDocumentTitle === null) {
      defaultDocumentTitle = document.title || 'Sondra'
    }
  }

  if (activeCount > 0) {
    const percent = Math.round(Math.max(0, Math.min(100, fraction * 100)))
    const label = currentName ? `${percent}% · ${currentName}` : `${percent}% (${activeCount} aktiv)`

    if (typeof document !== 'undefined') {
      document.title = `⬇ ${label} — Sondra`
    }

    if (APP_BRIDGE?.setProgressBar) {
      void APP_BRIDGE.setProgressBar(Math.max(0, Math.min(1, fraction)))
    }
    if (APP_BRIDGE?.setPowerSaveBlocker) {
      void APP_BRIDGE.setPowerSaveBlocker(true)
    }
    void acquireWakeLock()
  } else {
    if (typeof document !== 'undefined' && defaultDocumentTitle) {
      document.title = defaultDocumentTitle
    }

    if (APP_BRIDGE?.setProgressBar) {
      void APP_BRIDGE.setProgressBar(-1)
    }
    if (APP_BRIDGE?.setPowerSaveBlocker) {
      void APP_BRIDGE.setPowerSaveBlocker(false)
    }
    void releaseWakeLock()
  }
}

/**
 * Plays a short, pleasant completion chime using Web Audio API.
 */
export function playCompletionChime(): void {
  if (!getDownloadChimeEnabled()) return
  if (typeof window === 'undefined') return

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const now = ctx.currentTime

    // Two warm, soft sine tones (E5 ~ 659 Hz, then A5 ~ 880 Hz)
    const notes = [659.25, 880.0]
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + idx * 0.12)
      gain.gain.setValueAtTime(0, now + idx * 0.12)
      gain.gain.linearRampToValueAtTime(0.12, now + idx * 0.12 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.12 + 0.45)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + idx * 0.12)
      osc.stop(now + idx * 0.12 + 0.48)
    })

    setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 1200)
  } catch {
    // Audio context may be restricted before user interaction
  }
}
