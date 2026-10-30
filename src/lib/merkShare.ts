/**
 * Sharing the Merkliste, read-only: the list goes into the address itself —
 * deflated and made URL-safe — so nothing is uploaded and nothing is kept on
 * a server; whoever opens the link sees it in their own browser and may add it
 * to their own list. Titles, status, rating and how far one is: not the
 * addresses the episodes come from, not notes, not covers.
 */

import { itemProgress, type SavedLinkItem, type SavedLinkStatus } from './merkliste'

export interface SharedItem {
  title: string
  status?: SavedLinkStatus
  rating?: number
  season?: number
  episode?: number
  /** Episodes seen, as a number. */
  seen?: number
}

export interface SharedList {
  v: 1
  /** Whose list: a name the sharer typed, short. */
  name: string
  items: SharedItem[]
}

/** The hash a shared list travels in. */
export const SHARE_PREFIX = '#geteilt='
/** A link longer than this is cut off by chats and mail programs; the file is offered instead. */
export const LINK_MAX = 8000
const MAX_ITEMS = 500
const MAX_TITLE = 120
const MAX_NAME = 40
/** What a link may unpack to: more is not a list, it is a bomb. */
const MAX_JSON = 512 * 1024
const STATUSES: SavedLinkStatus[] = ['watching', 'later', 'paused', 'done', 'dropped']

export function shareableList(items: SavedLinkItem[], name: string, options: { progress?: boolean } = {}): SharedList {
  const progress = options.progress !== false
  return {
    v: 1,
    name: name.trim().slice(0, MAX_NAME),
    items: items.slice(0, MAX_ITEMS).map((item) => ({
      title: item.title.slice(0, MAX_TITLE),
      ...(item.status && item.status !== 'watching' ? { status: item.status } : {}),
      ...(progress && typeof item.rating === 'number' && item.rating > 0 ? { rating: item.rating } : {}),
      ...(progress ? { season: item.season, ...(typeof item.episode === 'number' ? { episode: item.episode } : {}), seen: itemProgress(item).watched } : {}),
    })),
  }
}

/* -------------------------------------------------------------------------- */
/* In the address                                                             */
/* -------------------------------------------------------------------------- */

const toBase64Url = (bytes: Uint8Array): string => {
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const bytes = new Uint8Array(plain.length)
  for (let i = 0; i < plain.length; i += 1) bytes[i] = plain.charCodeAt(i)
  return bytes
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  void writer.write(bytes).then(() => writer.close()).catch(() => undefined)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    all.set(chunk, at)
    at += chunk.byteLength
  }
  return all
}

export async function encodeShare(list: SharedList): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(list)) as Uint8Array<ArrayBuffer>
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw'), MAX_JSON * 2))
}

export async function shareLink(list: SharedList, origin: string): Promise<string> {
  return `${origin.replace(/\/+$/, '')}/${SHARE_PREFIX}${await encodeShare(list)}`
}

/** The text after `#geteilt=` in an address, or null. */
export function sharedFromHash(hash: string): string | null {
  return hash.startsWith(SHARE_PREFIX) && hash.length > SHARE_PREFIX.length ? hash.slice(SHARE_PREFIX.length) : null
}

/**
 * A list out of a link, believed only as far as it is plain data: the sizes
 * are capped, every field is checked, and anything else is thrown away. Null
 * when it is not a list at all.
 */
export async function decodeShare(text: string): Promise<SharedList | null> {
  try {
    if (text.length > LINK_MAX * 4 || !/^[\w-]+$/.test(text)) return null
    const json = new TextDecoder().decode(await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw'), MAX_JSON))
    const raw = JSON.parse(json) as Partial<SharedList>
    if (raw.v !== 1 || !Array.isArray(raw.items)) return null
    const items: SharedItem[] = []
    for (const entry of raw.items.slice(0, MAX_ITEMS)) {
      if (!entry || typeof entry !== 'object' || typeof entry.title !== 'string') continue
      const title = entry.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE)
      if (!title) continue
      const whole = (value: unknown, max: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined)
      const status = STATUSES.includes(entry.status as SavedLinkStatus) ? (entry.status as SavedLinkStatus) : undefined
      const rating = whole(entry.rating, 5)
      const season = whole(entry.season, 1000)
      const episode = whole(entry.episode, 10_000)
      const seen = whole(entry.seen, 100_000)
      items.push({
        title,
        ...(status ? { status } : {}),
        ...(rating ? { rating } : {}),
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
        ...(seen !== undefined ? { seen } : {}),
      })
    }
    return { v: 1, name: typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME) : '', items }
  } catch {
    return null
  }
}

/** What would be new on this list: titles it does not hold yet, compared without case and accents. */
export function newFromShared(list: SharedList, current: SavedLinkItem[]): SharedItem[] {
  const key = (title: string) => title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim()
  const have = new Set(current.map((item) => key(item.title)))
  const added = new Set<string>()
  return list.items.filter((item) => {
    const k = key(item.title)
    if (have.has(k) || added.has(k)) return false
    added.add(k)
    return true
  })
}
