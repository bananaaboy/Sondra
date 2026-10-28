/**
 * Screen wake lock for long jobs.
 *
 * Separating a forty-minute recording takes minutes. If the machine sleeps
 * halfway through, the tab is suspended and the work is lost — there is no
 * server holding a copy, which is the whole point. So the screen is held awake
 * while a job runs, and released the moment it finishes.
 */

type Sentinel = { release(): Promise<void>; addEventListener(type: 'release', handler: () => void): void }
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }

let sentinel: Sentinel | null = null
let holders = 0

export function wakeLockSupported(): boolean {
  return (typeof navigator !== 'undefined' && 'wakeLock' in navigator) || (typeof window !== 'undefined' && Boolean(window.sondraApp?.setPowerSaveBlocker))
}

/**
 * Holds the screen awake until the returned function is called.
 * Nested calls are counted, so two jobs at once release only once.
 */
export async function holdScreenAwake(): Promise<() => void> {
  holders += 1

  if (holders === 1 && typeof window !== 'undefined' && window.sondraApp?.setPowerSaveBlocker) {
    void window.sondraApp.setPowerSaveBlocker(true).catch(() => undefined)
  }

  const nav = navigator as WakeLockNavigator
  if (nav.wakeLock && !sentinel) {
    try {
      sentinel = await nav.wakeLock.request('screen')
      // The browser drops the lock when the tab is hidden; do not fight it.
      sentinel.addEventListener('release', () => {
        sentinel = null
      })
    } catch {
      // Denied, or the device has no screen to keep awake. Not worth reporting:
      // the job runs either way.
    }
  }

  let released = false
  return () => {
    if (released) return
    released = true
    holders = Math.max(0, holders - 1)
    if (holders === 0) {
      if (typeof window !== 'undefined' && window.sondraApp?.setPowerSaveBlocker) {
        void window.sondraApp.setPowerSaveBlocker(false).catch(() => undefined)
      }
      if (sentinel) {
        void sentinel.release().catch(() => undefined)
        sentinel = null
      }
    }
  }
}
