/**
 * Keeps the session's files on this device and offers the last session back.
 *
 * Saving follows the session a moment behind (a burst of edits is one write)
 * and flushes when the page is hidden — closing a tab, the app quitting for
 * an update. The offer lives in a small store of its own so the start page,
 * an empty tool and the file menu can all show it.
 */

import { useEffect } from 'react'
import { create } from 'zustand'

import { formatBytes } from '../lib/format'
import {
  askToPersist,
  discardSession,
  findSavedSession,
  keepSession,
  loadSession,
  saveSession,
  setKeepSession,
  type SavedSession,
} from '../lib/sessionStore'
import { useSession } from '../state/store'

interface KeptState {
  keep: boolean
  /** A write is under way — worth saying before a tab is closed on it. */
  saving: boolean
  offer: SavedSession | null
  restoring: boolean
  error: string | null
  setKeep: (keep: boolean) => Promise<void>
  restore: () => Promise<void>
  discard: () => Promise<void>
}

const SAVE_AFTER_MS = 800

let flush: (() => void) | null = null

export const useKept = create<KeptState>((set, get) => ({
  keep: keepSession(),
  saving: false,
  offer: null,
  restoring: false,
  error: null,

  setKeep: async (keep) => {
    await setKeepSession(keep)
    set({ keep, offer: keep ? get().offer : null, error: null })
    if (keep) flush?.()
  },

  restore: async () => {
    const offer = get().offer
    if (!offer) return
    set({ restoring: true, error: null })
    try {
      const { assets, activeAssetId } = await loadSession(offer.id)
      const session = useSession.getState()
      const known = new Set(session.assets.map((asset) => asset.id))
      const fresh = assets.filter((asset) => !known.has(asset.id))
      useSession.setState({
        assets: [...fresh, ...session.assets],
        activeAssetId: session.activeAssetId ?? activeAssetId ?? fresh.at(-1)?.id ?? null,
      })
      session.log('sitzung', `${fresh.length} Datei(en) der letzten Sitzung wiederhergestellt`)
      // Written again under this session first, then the old copy goes —
      // never a moment with the files in neither.
      const now = useSession.getState()
      await saveSession(now.assets, now.activeAssetId)
      await discardSession(offer.id)
      set({ offer: null, restoring: false })
    } catch (failure) {
      set({ restoring: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  },

  discard: async () => {
    const offer = get().offer
    set({ offer: null })
    if (offer) await discardSession(offer.id).catch(() => undefined)
  },
}))

/** A line for the offer: „3 Dateien, 48 MB, von gestern 18:04“. */
export function describeOffer(offer: SavedSession): string {
  const when = new Date(offer.updatedAt)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  const time = when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  const day =
    when.toDateString() === today.toDateString()
      ? `heute ${time}`
      : when.toDateString() === yesterday.toDateString()
        ? `gestern ${time}`
        : `${when.toLocaleDateString('de-DE')} ${time}`
  return `${offer.count} ${offer.count === 1 ? 'Datei' : 'Dateien'}, ${formatBytes(offer.bytes)}, von ${day}`
}

/** Mounted once, in App. */
export function useKeptSession() {
  useEffect(() => {
    let cancelled = false
    if (keepSession()) {
      askToPersist()
      void findSavedSession()
        .then((offer) => {
          if (!cancelled) useKept.setState({ offer })
        })
        .catch(() => undefined)
    }

    let timer: number | null = null
    let writes = 0
    const save = () => {
      timer = null
      if (!useKept.getState().keep) return
      const { assets, activeAssetId, log } = useSession.getState()
      writes += 1
      useKept.setState({ saving: true })
      void saveSession(assets, activeAssetId)
        .catch((failure) => {
          log('sitzung', `Sitzung nicht gespeichert: ${failure instanceof Error ? failure.message : String(failure)}`, 'warn')
        })
        .finally(() => {
          writes -= 1
          if (writes === 0 && timer === null) useKept.setState({ saving: false })
        })
    }
    flush = () => {
      if (timer !== null) window.clearTimeout(timer)
      save()
    }
    const unsubscribe = useSession.subscribe((state, previous) => {
      if (state.assets === previous.assets && state.activeAssetId === previous.activeAssetId) return
      if (timer !== null) window.clearTimeout(timer)
      if (useKept.getState().keep) useKept.setState({ saving: true })
      timer = window.setTimeout(save, SAVE_AFTER_MS)
    })
    const onHide = () => {
      if (timer !== null) flush?.()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)
    return () => {
      cancelled = true
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      flush = null
    }
  }, [])
}
