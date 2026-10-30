/**
 * The server a person puts in for devices in different networks.
 *
 * Between two networks the devices find each other only with the help of a
 * server that tells each its address (STUN) or, where even that is not enough,
 * carries the traffic (TURN). Sondra ships none — a stranger's server in the
 * code would see every connection of everyone — so there is a field, empty,
 * for one the person trusts or runs.
 *
 * The addresses are kept on this device. A TURN password is not: it stays in
 * memory until the page closes, and is asked again next time.
 */

import { create } from 'zustand'

const KEY = 'sondra:geraete:server'

export interface ServerSettings {
  /** `stun:host:3478` — an address, nothing secret. */
  stun: string
  /** `turn:host:3478` or `turns:…`. */
  turn: string
  user: string
  /** In memory only. */
  password: string
}

const EMPTY: ServerSettings = { stun: '', turn: '', user: '', password: '' }

const STUN_SCHEMES = /^(stun|stuns):/i
const TURN_SCHEMES = /^(turn|turns):/i

/** What is wrong with an address, in words; null when it is fine (or empty). */
export function serverProblem(address: string, kind: 'stun' | 'turn'): string | null {
  const text = address.trim()
  if (!text) return null
  if (text.length > 200) return 'Die Adresse ist zu lang.'
  const scheme = kind === 'stun' ? STUN_SCHEMES : TURN_SCHEMES
  if (!scheme.test(text)) return kind === 'stun' ? 'Sie beginnt mit „stun:“, etwa stun:beispiel.de:3478.' : 'Sie beginnt mit „turn:“ oder „turns:“, etwa turn:beispiel.de:3478.'
  const rest = text.replace(scheme, '').split('?')[0]
  if (!/^[\w.[\]:-]+$/.test(rest) || rest.startsWith(':')) return 'Nach dem Anfang folgt der Rechnername, wenn nötig mit :Port.'
  return null
}

/** The `iceServers` a connection is made with: nothing, until someone put something in. */
export function iceServersFor(settings: ServerSettings): RTCIceServer[] {
  const servers: RTCIceServer[] = []
  if (settings.stun.trim() && !serverProblem(settings.stun, 'stun')) servers.push({ urls: settings.stun.trim() })
  if (settings.turn.trim() && !serverProblem(settings.turn, 'turn')) {
    servers.push({ urls: settings.turn.trim(), ...(settings.user ? { username: settings.user, credential: settings.password } : {}) })
  }
  return servers
}

function read(): ServerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ServerSettings>
    return {
      stun: typeof saved.stun === 'string' ? saved.stun : '',
      turn: typeof saved.turn === 'string' ? saved.turn : '',
      user: typeof saved.user === 'string' ? saved.user : '',
      password: '',
    }
  } catch {
    return EMPTY
  }
}

export const useServers = create<ServerSettings>(() => read())

export function setServers(next: ServerSettings): void {
  useServers.setState(next)
  try {
    // Never the password.
    const { stun, turn, user } = next
    if (!stun && !turn && !user) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify({ stun, turn, user }))
  } catch {
    // Then only for this visit.
  }
}

export const currentIceServers = (): RTCIceServer[] => iceServersFor(useServers.getState())
