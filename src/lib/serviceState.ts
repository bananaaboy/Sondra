/**
 * Whether an extraction service is connected, kept where anything can see it.
 *
 * The connection used to live inside the downloader panel, which meant the one
 * question people actually have — am I connected or not — could only be
 * answered by opening the right tab, switching the right toggle on and reading
 * a line halfway down a card. That is not an answer, that is a scavenger hunt.
 *
 * So the state moves out here, next to the other facts about this session, and
 * the capability strip can show it on every tab. Same subscribe-and-notify shape
 * as the FFmpeg status, for the same reason: several places need to read it and
 * none of them should own it.
 */

import type { ServiceInfo } from './service'

export interface ServiceConnection {
  /** The address in use, or null when nothing has answered. */
  endpoint: string | null
  info: ServiceInfo | null
  /** The page is currently looking for one on this machine. */
  searching: boolean
  /** The feature is switched on at all. */
  enabled: boolean
  /**
   * The service's Api-Key, if it wants one. Held here, in memory, so the
   * address field can use it too — and never written anywhere: a credential
   * in localStorage outlives the tab and is readable by anything on the origin.
   */
  apiKey: string | null
}

type Handler = (state: ServiceConnection) => void

const handlers = new Set<Handler>()

/**
 * On from the start when this page is served from the visitor's own machine —
 * the desktop app, or the page the yt-dlp bridge hands out. Whoever runs Sondra
 * locally has already set it up on purpose, and a service on this machine is
 * the one they started; asking again on every load only added a step. A page
 * from the internet still starts with it off.
 */
const servedLocally =
  typeof window !== 'undefined' && /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname)

let state: ServiceConnection = { endpoint: null, info: null, searching: false, enabled: servedLocally, apiKey: null }

export function serviceConnection(): ServiceConnection {
  return state
}

/** Subscribe to connection changes. Fires immediately with the current state. */
export function onServiceConnection(handler: Handler): () => void {
  handlers.add(handler)
  handler(state)
  return () => {
    handlers.delete(handler)
  }
}

export function setServiceConnection(patch: Partial<ServiceConnection>): void {
  state = { ...state, ...patch }
  handlers.forEach((handler) => handler(state))
}
