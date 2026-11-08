/**
 * What the „Ordner“ page remembers about a folder on this device: how it was
 * set (order, tiles or list, groups) and when it was last looked at — the
 * one for „wie beim letzten Mal“, the other for „Neu seit dem letzten
 * Besuch“. Nothing about the files themselves, and nothing leaves the device.
 *
 * Keyed by where the folder came from and its name, kept to the most recent
 * few, so a lot of folders never fill the storage.
 */

export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The last settings: what a folder looked at for the first time starts with. */
export const PREFS_KEY = 'sondra:ordner'
const PER_FOLDER = 'sondra:ordner:je'
const VISITS = 'sondra:ordner:besuch'
/** Folders remembered; the oldest are forgotten first. */
export const KEEP = 40

type Table<T> = Record<string, T>

function readTable<T>(store: Store, key: string): Table<T> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Table<T>) : {}
  } catch {
    return {}
  }
}

function writeTable<T>(store: Store, key: string, table: Table<T>): void {
  try {
    store.setItem(key, JSON.stringify(table))
  } catch {
    /* only a convenience: private window, storage full */
  }
}

/** The key put last, the oldest ones gone beyond `KEEP`. */
function put<T>(table: Table<T>, key: string, value: T): Table<T> {
  const next = { ...table }
  delete next[key]
  next[key] = value
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[old]
  return next
}

/** A folder's key: this device's or Drive's, and its name. */
export const folderKey = (name: string, source?: 'drive') => `${source ?? 'geraet'}:${name}`

/** The settings of this folder over the last ones used anywhere, over the defaults. */
export function prefsFor<P extends object>(defaults: P, key: string, store: Store): P {
  const last = readTable<unknown>(store, PREFS_KEY)
  const mine = readTable<Partial<P>>(store, PER_FOLDER)[key]
  const merged = { ...defaults, ...(last as Partial<P>), ...(mine && typeof mine === 'object' ? mine : {}) }
  // Only what the defaults know: a key from some other version is dropped.
  return Object.fromEntries(Object.keys(defaults).map((name) => [name, (merged as Record<string, unknown>)[name]])) as P
}

/** The settings just chosen: for this folder, and as the start for the next one. */
export function savePrefs<P extends object>(key: string | null, prefs: P, store: Store): void {
  try {
    store.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* only a convenience */
  }
  if (key) writeTable(store, PER_FOLDER, put(readTable<P>(store, PER_FOLDER), key, prefs))
}

/** What each folder's last visit was *before* this session came to it. */
const sessionStart = new Map<string, number | null>()

/**
 * The time of the visit before this one, or null for a first one; the
 * visit just starting is written down. Asked again in the same session it
 * gives the same answer — leaving the tab and coming back is no new visit.
 */
export function lastVisit(key: string, now: number, store: Store, session: Map<string, number | null> = sessionStart): number | null {
  if (session.has(key)) return session.get(key) ?? null
  const table = readTable<number>(store, VISITS)
  const before = typeof table[key] === 'number' ? table[key] : null
  session.set(key, before)
  writeTable(store, VISITS, put(table, key, now))
  return before
}
