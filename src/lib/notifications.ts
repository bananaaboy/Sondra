/**
 * Background notifications (Windows system tray / native notifications & Web Notifications)
 * for completed batch downloads and newly released AniWorld/SerienStream episodes.
 */

import { APP_BRIDGE, IN_DESKTOP_APP } from './desktop'

const STORAGE_KEY = 'sondra:notifications'

export interface NotificationPrefs {
  enabled: boolean
  onBatchComplete: boolean
  onNewEpisode: boolean
}

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  onBatchComplete: true,
  onNewEpisode: true,
}

export function getNotificationPrefs(): NotificationPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NotificationPrefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

export function setNotificationPrefs(patch: Partial<NotificationPrefs>): NotificationPrefs {
  const next = { ...getNotificationPrefs(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (IN_DESKTOP_APP) return true
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    const res = await Notification.requestPermission()
    return res === 'granted'
  } catch {
    return false
  }
}

export function sendAppNotification(options: {
  title: string
  body: string
  kind?: 'batch' | 'episode' | 'general'
  onClick?: () => void
}): void {
  const prefs = getNotificationPrefs()
  if (!prefs.enabled) return
  if (options.kind === 'batch' && !prefs.onBatchComplete) return
  if (options.kind === 'episode' && !prefs.onNewEpisode) return

  if (APP_BRIDGE?.notify) {
    void APP_BRIDGE.notify(options.title, options.body)
    return
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(options.title, {
          body: options.body,
          silent: false,
        })
        n.onclick = () => {
          window.focus()
          void APP_BRIDGE?.focusWindow?.()
          options.onClick?.()
        }
      } catch {
        // ignore notification errors
      }
    }
  }
}
