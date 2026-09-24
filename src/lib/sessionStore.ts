/**
 * The session on this device: its files kept in the browser's own storage
 * (IndexedDB), so closing the tab, the app or an update's restart no longer
 * throws them away.
 *
 * Nothing leaves the machine — IndexedDB belongs to this origin on this
 * device. It can be switched off (`setKeepSession(false)`), which also
 * deletes what was kept; that switch is the old „closing is the delete
 * button“ for anyone on a shared computer.
 *
 * Every tab or app window is its own session. On start, the most recent
 * earlier session with files is offered, not loaded: the person decides
 * („Wiederherstellen“ / „Verwerfen“). Until they do, this session is saved
 * beside it rather than over it. Older sessions than the offered one are
 * cleared on start, so storage does not grow without end.
 *
 * Decoded audio is not stored — it is several times the size of the file and
 * is decoded again on demand. Only the bytes as they arrived, and what the
 * session needs to show them.
 */

import type { Asset, AssetKind } from '../state/store'

const DB_NAME = 'sondra-sitzung'
const VERSION = 1
const KEEP_KEY = 'sondra:sitzung-behalten'

interface StoredAsset {
  key: string
  session: string
  id: string
  name: string
  mime: string
  kind: AssetKind
  sizeBytes: number
  durationSeconds: number | null
  origin: Asset['origin']
  createdAt: number
  order: number
  bytes: Blob
}

interface StoredSession {
  id: string
  updatedAt: number
  activeAssetId: string | null
  count: number
  bytes: number
}

export interface SavedSession {
  id: string
  updatedAt: number
  count: number
  bytes: number
}

/** This tab's session. */
export const SESSION_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}-${Math.random()}`

export function keepSession(): boolean {
  try {
    return localStorage.getItem(KEEP_KEY) !== 'nein'
  } catch {
    return true
  }
}

let database: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Dieser Browser hat keinen Speicher für Dateien (IndexedDB).'))
      return
    }
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      const assets = db.createObjectStore('assets', { keyPath: 'key' })
      assets.createIndex('session', 'session')
      db.createObjectStore('sessions', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB lässt sich nicht öffnen.'))
    request.onblocked = () => reject(new Error('IndexedDB ist von einem anderen Tab blockiert.'))
  })
  database.catch(() => {
    database = null
  })
  return database
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Speichern fehlgeschlagen.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Speichern abgebrochen.'))
  })
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function allSessions(db: IDBDatabase): Promise<StoredSession[]> {
  const transaction = db.transaction('sessions', 'readonly')
  const sessions = await result(transaction.objectStore('sessions').getAll() as IDBRequest<StoredSession[]>)
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function deleteSession(db: IDBDatabase, id: string): Promise<void> {
  const transaction = db.transaction(['assets', 'sessions'], 'readwrite')
  const assets = transaction.objectStore('assets')
  const keys = await result(assets.index('session').getAllKeys(IDBKeyRange.only(id)))
  for (const key of keys) assets.delete(key)
  transaction.objectStore('sessions').delete(id)
  await done(transaction)
}

/**
 * The earlier session worth offering, if any. Clears everything older than
 * it — and empty leftovers — on the way.
 */
export async function findSavedSession(): Promise<SavedSession | null> {
  if (!keepSession()) return null
  const db = await open()
  const others = (await allSessions(db)).filter((session) => session.id !== SESSION_ID)
  const [latest, ...older] = others.filter((session) => session.count > 0)
  for (const session of [...older, ...others.filter((entry) => entry.count === 0)]) {
    await deleteSession(db, session.id).catch(() => undefined)
  }
  return latest ? { id: latest.id, updatedAt: latest.updatedAt, count: latest.count, bytes: latest.bytes } : null
}

/** Reads a saved session's files back, in their order. */
export async function loadSession(id: string): Promise<{ assets: Asset[]; activeAssetId: string | null }> {
  const db = await open()
  const transaction = db.transaction(['assets', 'sessions'], 'readonly')
  const stored = await result(
    transaction.objectStore('assets').index('session').getAll(IDBKeyRange.only(id)) as IDBRequest<StoredAsset[]>,
  )
  const session = await result(transaction.objectStore('sessions').get(id) as IDBRequest<StoredSession | undefined>)
  const assets: Asset[] = []
  for (const entry of stored.sort((a, b) => a.order - b.order)) {
    assets.push({
      id: entry.id,
      name: entry.name,
      bytes: new Uint8Array(await entry.bytes.arrayBuffer()),
      mime: entry.mime,
      sizeBytes: entry.sizeBytes,
      kind: entry.kind,
      audio: null,
      durationSeconds: entry.durationSeconds,
      origin: entry.origin,
      createdAt: entry.createdAt,
    })
  }
  return { assets, activeAssetId: session?.activeAssetId ?? null }
}

export async function discardSession(id: string): Promise<void> {
  const db = await open()
  await deleteSession(db, id)
}

/** Everything kept on this device, every session. */
export async function clearAllSessions(): Promise<void> {
  const db = await open()
  const transaction = db.transaction(['assets', 'sessions'], 'readwrite')
  transaction.objectStore('assets').clear()
  transaction.objectStore('sessions').clear()
  await done(transaction)
}

export async function setKeepSession(keep: boolean): Promise<void> {
  try {
    localStorage.setItem(KEEP_KEY, keep ? 'ja' : 'nein')
  } catch {
    /* the default (keep) applies */
  }
  if (!keep) await clearAllSessions().catch(() => undefined)
}

/** Which bytes each asset had when it was last written, to skip unchanged ones. */
const written = new Map<string, Uint8Array>()

/**
 * Brings this session's stored copy in line with `assets`: new or changed
 * files are written, removed ones deleted. Decoding a file (which only fills
 * in `audio`) writes nothing.
 */
export async function saveSession(assets: readonly Asset[], activeAssetId: string | null): Promise<void> {
  const db = await open()
  const transaction = db.transaction(['assets', 'sessions'], 'readwrite')
  const store = transaction.objectStore('assets')
  const present = new Set(assets.map((asset) => asset.id))

  for (const [id] of written) {
    if (!present.has(id)) {
      store.delete(`${SESSION_ID}:${id}`)
      written.delete(id)
    }
  }
  assets.forEach((asset, order) => {
    if (written.get(asset.id) === asset.bytes) return
    const record: StoredAsset = {
      key: `${SESSION_ID}:${asset.id}`,
      session: SESSION_ID,
      id: asset.id,
      name: asset.name,
      mime: asset.mime,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      durationSeconds: asset.durationSeconds,
      origin: asset.origin,
      createdAt: asset.createdAt,
      order,
      bytes: new Blob([asset.bytes.buffer instanceof ArrayBuffer ? (asset.bytes as Uint8Array<ArrayBuffer>) : asset.bytes.slice()], {
        type: asset.mime,
      }),
    }
    store.put(record)
    written.set(asset.id, asset.bytes)
  })
  const session: StoredSession = {
    id: SESSION_ID,
    updatedAt: Date.now(),
    activeAssetId,
    count: assets.length,
    bytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
  }
  if (assets.length === 0) transaction.objectStore('sessions').delete(SESSION_ID)
  else transaction.objectStore('sessions').put(session)
  try {
    await done(transaction)
  } catch (failure) {
    // Nothing of this batch is on disk; try every file again next time.
    written.clear()
    throw failure
  }
}

/** Asks the browser not to evict what is kept here when space runs low. */
export function askToPersist(): void {
  void navigator.storage?.persist?.().catch(() => undefined)
}
