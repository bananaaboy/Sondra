/**
 * Sondra as an app from the browser: Edge's and Chrome's own install.
 *
 * The Windows setup is not signed yet, and Smart App Control does not run
 * unsigned programs at all — no warning to click past, just a refusal. An
 * app installed from the browser is the browser, which is signed; it gets
 * its own window, a Start menu entry and the file associations from the
 * manifest, and it runs wherever the site runs.
 *
 * The browser offers the install through `beforeinstallprompt`, once, early
 * in the page's life. It is kept here from the first moment so the dialog
 * can use it whenever it is opened.
 */

import { useEffect, useState } from 'react'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/** True when this page is already running as the installed app. */
export const RUNNING_AS_APP =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches)

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Kept for the dialog instead of the browser's own bar at the bottom.
    event.preventDefault()
    deferred = event as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installed = true
    notify()
  })
}

export function useBrowserInstall(): {
  /** The browser will install on a click. */
  available: boolean
  installed: boolean
  install: () => Promise<boolean>
} {
  const [, rerender] = useState(0)
  useEffect(() => {
    const listener = () => rerender((value) => value + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return {
    available: deferred !== null,
    installed: installed || RUNNING_AS_APP,
    install: async () => {
      const event = deferred
      if (!event) return false
      await event.prompt()
      const { outcome } = await event.userChoice
      // The event can be used once; the browser offers a new one if needed.
      deferred = null
      notify()
      return outcome === 'accepted'
    },
  }
}
