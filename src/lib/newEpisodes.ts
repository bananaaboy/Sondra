/**
 * Neue Folgen melden — in the app, in the background.
 *
 * Every three hours (and a minute after the start) each series „Am Schauen“
 * with an AniWorld address is checked, one after another with a pause
 * between, through the app's own `/api/resolve` (`checkOnlineUpdates`). When
 * the newest episode there is later than at the previous check, Windows
 * shows a notice; a click on it brings Sondra forward with the series open.
 *
 * The first check of a series only notes where it stands — otherwise every
 * series one is behind on would announce itself at once. Each episode is
 * announced once (`sondra:neue_folgen_gemeldet`). Off with the switch in the
 * Merkliste (`sondra:neue_folgen`).
 */

import { APP_BRIDGE } from './desktop'
import { checkOnlineUpdates, merkItems, requestOpenSeries, type OnlineAvailableInfo, type SavedLinkItem } from './merkliste'
import { isAniworldUrl } from './download'

const ON_KEY = 'sondra:neue_folgen'
const TOLD_KEY = 'sondra:neue_folgen_gemeldet'
const FIRST_MS = 60_000
const EVERY_MS = 3 * 60 * 60 * 1000
/** Between two series: a person browsing, not a crawler. */
const PAUSE_MS = 2_000

/** True in the app, where the check runs on this computer and Windows shows the notice. */
export const newEpisodesAvailable = Boolean(APP_BRIDGE)

export function newEpisodesOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) !== 'false'
  } catch {
    return true
  }
}

export function setNewEpisodesOn(on: boolean): void {
  try {
    localStorage.setItem(ON_KEY, on ? 'true' : 'false')
  } catch {
    // Only a preference.
  }
}

function told(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOLD_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function remember(id: string, key: string): void {
  try {
    localStorage.setItem(TOLD_KEY, JSON.stringify({ ...told(), [id]: key }))
  } catch {
    // Without it, the same episode may be announced once more.
  }
}

const keyOf = (info: OnlineAvailableInfo) => `${info.maxSeason}x${info.maxEpisode}`

/** True when `next` names a later episode than `before`. */
export function laterRelease(before: OnlineAvailableInfo | undefined, next: OnlineAvailableInfo): boolean {
  if (!before) return false
  return next.maxSeason > before.maxSeason || (next.maxSeason === before.maxSeason && next.maxEpisode > before.maxEpisode)
}

/** The series worth checking: being watched, on AniWorld. */
export function watchedOnAniworld(items: SavedLinkItem[]): SavedLinkItem[] {
  return items.filter((item) => (item.status ?? 'watching') === 'watching' && item.url && isAniworldUrl(item.url))
}

function announce(item: SavedLinkItem, info: OnlineAvailableInfo, open: (id: string) => void): void {
  if (typeof Notification === 'undefined' || Notification.permission === 'denied') return
  const where = `Staffel ${info.maxSeason}, Folge ${info.maxEpisode}`
  const notice = new Notification(`Neue Folge: ${item.title}`, {
    body: `${where} ist auf AniWorld erschienen.`,
    tag: `sondra-neu-${item.id}`,
  })
  notice.onclick = () => {
    void APP_BRIDGE?.focusWindow?.()
    window.focus()
    open(item.id)
    notice.close()
  }
}

let running = false

/** One round over the list; returns how many were announced. */
export async function checkNewEpisodes(open: (id: string) => void): Promise<number> {
  if (running) return 0
  running = true
  let count = 0
  try {
    const seen = told()
    for (const [index, item] of watchedOnAniworld(merkItems()).entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS))
      if (!newEpisodesOn()) break
      // The entry as it stands now — a sync may have changed it meanwhile.
      const current = merkItems().find((entry) => entry.id === item.id)
      if (!current) continue
      const before = current.onlineAvailable
      const info = await checkOnlineUpdates(current)
      if (!info) continue
      const key = keyOf(info)
      if (!before) {
        remember(current.id, key)
        continue
      }
      if (laterRelease(before, info) && seen[current.id] !== key) {
        announce(current, info, open)
        remember(current.id, key)
        count += 1
      }
    }
  } finally {
    running = false
  }
  return count
}

/** Starts the rounds; the returned function stops them. */
export function watchNewEpisodes(openSeries: (id: string) => void): () => void {
  if (!newEpisodesAvailable) return () => {}
  const round = () => {
    if (newEpisodesOn()) void checkNewEpisodes(openSeries)
  }
  const first = window.setTimeout(round, FIRST_MS)
  const every = window.setInterval(round, EVERY_MS)
  return () => {
    window.clearTimeout(first)
    window.clearInterval(every)
  }
}

/** Opens a series in the Merkliste from anywhere in the app. */
export function openSeriesFromNotice(setPanel: (panel: 'merkliste') => void): (id: string) => void {
  return (id) => {
    requestOpenSeries(id)
    setPanel('merkliste')
  }
}
