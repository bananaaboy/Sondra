/**
 * Sharing the Merkliste, read-only: the list goes into the address itself —
 * packed small, deflated and made URL-safe — so nothing is uploaded and nothing
 * is kept on a server; whoever opens the link sees it in their own browser and
 * may add it to their own list. Titles, status, rating, how far one is and, if
 * asked for, a small picture of each cover: not the addresses the episodes come
 * from, not notes.
 *
 * A link has only so much room (chats cut long ones off), so a list that does
 * not fit travels as several links, each with its place in the whole, which the
 * other side gathers. The same bytes are also a file, `.sondra-liste`, for what
 * is too big even for that.
 *
 * The packing (version 2) is binary and in columns — titles, flags, ratings, the
 * few numbers that are not the usual — so a link stays as short as it can; v1
 * links — the same list as JSON — still open.
 */

import { itemProgress, type SavedLinkItem, type SavedLinkStatus, type TileFormat } from './merkliste'
import { THUMB_MAX, thumbUrl, validThumb } from './shareCover'

export interface SharedItem {
  title: string
  status?: SavedLinkStatus
  rating?: number
  season?: number
  episode?: number
  /** Episodes seen, as a number. */
  seen?: number
  /** The picture of its cover, as `shareCover` makes and reads it. */
  thumb?: Uint8Array
  tile?: TileFormat
}

export interface SharedList {
  v: 2
  /** Whose list: a name the sharer typed, short. */
  name: string
  items: SharedItem[]
}

/** The hash a shared list travels in — as short as it can be, since every character is one the link has less room for. */
export const SHARE_PREFIX = '#g='
/** What the first links were called; they open as before. */
const LEGACY_PREFIX = '#geteilt='
/** One link up to this long; chats, mail programs and some messengers cut off what is longer. */
export const LINK_MAX = 2000
/** What a link made for a QR code may hold, so the code stays easy to read off a screen. */
export const QR_LINK_MAX = 1100
/** More parts than this is not a thing to send in messages: the file is offered. */
export const MAX_PARTS = 40
const MAX_ITEMS = 500
const MAX_TITLE = 120
const MAX_NAME = 40
/** What a link or file may unpack to: more is not a list, it is a bomb. */
const MAX_PAYLOAD = 16 * 1024 * 1024
const STATUSES: SavedLinkStatus[] = ['watching', 'later', 'paused', 'done', 'dropped']

export function shareableList(
  items: SavedLinkItem[],
  name: string,
  options: { progress?: boolean; thumbs?: ReadonlyMap<string, Uint8Array> } = {},
): SharedList {
  const progress = options.progress !== false
  return {
    v: 2,
    name: name.trim().slice(0, MAX_NAME),
    items: items.slice(0, MAX_ITEMS).map((item) => {
      const thumb = options.thumbs?.get(item.id)
      return {
        title: item.title.slice(0, MAX_TITLE),
        ...(item.status && item.status !== 'watching' ? { status: item.status } : {}),
        ...(progress && typeof item.rating === 'number' && item.rating > 0 ? { rating: item.rating } : {}),
        ...(progress ? { season: item.season, ...(typeof item.episode === 'number' ? { episode: item.episode } : {}), seen: itemProgress(item).watched } : {}),
        ...(thumb ? { thumb, ...(item.tileFormat === 'manga' ? { tile: 'manga' as const } : {}) } : {}),
      }
    }),
  }
}

/* -------------------------------------------------------------------------- */
/* Packing                                                                     */
/* -------------------------------------------------------------------------- */

class Writer {
  private bytes: number[] = []
  byte(value: number): void {
    this.bytes.push(value & 0xff)
  }
  varint(value: number): void {
    let rest = Math.max(0, Math.floor(value))
    while (rest >= 0x80) {
      this.bytes.push((rest % 0x80) | 0x80)
      rest = Math.floor(rest / 0x80)
    }
    this.bytes.push(rest)
  }
  raw(data: Uint8Array): void {
    for (const value of data) this.bytes.push(value)
  }
  text(value: string): void {
    const data = new TextEncoder().encode(value)
    this.varint(data.length)
    this.raw(data)
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

class Reader {
  at: number
  constructor(private bytes: Uint8Array, start = 0) {
    this.at = start
  }
  byte(): number {
    if (this.at >= this.bytes.length) throw new Error('short')
    return this.bytes[this.at++]
  }
  varint(): number {
    let value = 0
    for (let step = 0; step < 5; step += 1) {
      const next = this.byte()
      value += (next & 0x7f) * 0x80 ** step
      if (!(next & 0x80)) return value
    }
    throw new Error('long')
  }
  take(count: number): Uint8Array {
    if (count < 0 || this.at + count > this.bytes.length) throw new Error('short')
    const part = this.bytes.subarray(this.at, this.at + count)
    this.at += count
    return part
  }
  text(maxBytes: number): string {
    const length = this.varint()
    if (length > maxBytes) throw new Error('long')
    return new TextDecoder().decode(this.take(length))
  }
}

const clean = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
const whole = (value: unknown, max: number) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined)

/**
 * The list as bytes, before deflating — in columns, not by entry: all the
 * titles, then every entry's flags, then every rating, then the numbers that
 * differ from the usual, then the pictures. Alike bytes side by side is what
 * deflate shrinks best, and what is the usual (Staffel 1, Folge 1, nothing seen,
 * Am Schauen, no rating, no picture) costs nothing but its flag.
 */
export function packList(list: SharedList): Uint8Array {
  const items = list.items.slice(0, MAX_ITEMS)
  // With progress left out, the three fields are missing everywhere; with it, a missing one is the usual.
  const progress = items.some((item) => item.season !== undefined || item.episode !== undefined || item.seen !== undefined)
  const out = new Writer()
  out.byte(2)
  out.byte(progress ? 1 : 0)
  out.text(list.name.slice(0, MAX_NAME))
  out.varint(items.length)
  out.text(items.map((item) => item.title.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TITLE)).join('\n'))
  const flags: number[] = []
  const ratings: number[] = []
  const seasons: number[] = []
  const episodes: number[] = []
  const seen: number[] = []
  const thumbs: Uint8Array[] = []
  for (const item of items) {
    const status = Math.max(0, STATUSES.indexOf(item.status ?? 'watching'))
    const season = progress ? (whole(item.season, 1000) ?? 1) : 1
    const episode = progress ? (whole(item.episode, 10_000) ?? 1) : 1
    const watched = progress ? (whole(item.seen, 100_000) ?? 0) : 0
    const thumb = item.thumb && validThumb(item.thumb) ? item.thumb : null
    flags.push((season !== 1 ? 1 : 0) | (episode !== 1 ? 2 : 0) | (watched !== 0 ? 4 : 0) | (thumb ? 8 : 0) | (item.tile === 'manga' ? 16 : 0) | (status << 5))
    ratings.push(whole(item.rating, 5) ?? 0)
    if (season !== 1) seasons.push(season)
    if (episode !== 1) episodes.push(episode)
    if (watched !== 0) seen.push(watched)
    if (thumb) thumbs.push(thumb)
  }
  out.raw(Uint8Array.from(flags))
  out.raw(Uint8Array.from(ratings))
  for (const value of [...seasons, ...episodes, ...seen]) out.varint(value)
  for (const thumb of thumbs) {
    out.varint(thumb.length)
    out.raw(thumb)
  }
  return out.done()
}

/** A list from the old JSON packing (v1), checked field by field. */
function fromJson(text: string): SharedList | null {
  const raw = JSON.parse(text) as { v?: unknown; name?: unknown; items?: unknown }
  if (raw.v !== 1 || !Array.isArray(raw.items)) return null
  const items: SharedItem[] = []
  for (const entry of raw.items.slice(0, MAX_ITEMS) as Partial<SharedItem>[]) {
    if (!entry || typeof entry !== 'object' || typeof entry.title !== 'string') continue
    const title = clean(entry.title, MAX_TITLE)
    if (!title) continue
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
  return { v: 2, name: typeof raw.name === 'string' ? clean(raw.name, MAX_NAME) : '', items }
}

/**
 * A list out of bytes, believed only as far as it is plain data: the sizes
 * are capped, every field is checked, a picture must be one, and anything else
 * is thrown away. Null when it is not a list at all.
 */
export function unpackList(bytes: Uint8Array): SharedList | null {
  try {
    if (bytes[0] === 0x7b) return fromJson(new TextDecoder().decode(bytes))
    if (bytes[0] !== 2) return null
    const read = new Reader(bytes, 1)
    const progress = (read.byte() & 1) === 1
    const name = clean(read.text(MAX_NAME * 4), MAX_NAME)
    const count = read.varint()
    if (count > MAX_ITEMS) return null
    const block = read.text(MAX_ITEMS * (MAX_TITLE * 4 + 1))
    const titles = count === 0 ? [] : block.split('\n')
    if (titles.length !== count || (count === 0 && block !== '')) return null
    const flags = read.take(count)
    const ratings = read.take(count)
    // The numbers that differ from the usual, column by column, in the order of the flags.
    const column = (bit: number, max: number) => {
      const values = new Map<number, number | undefined>()
      for (let n = 0; n < count; n += 1) if (flags[n] & bit) values.set(n, whole(read.varint(), max))
      return values
    }
    const seasons = column(1, 1000)
    const episodes = column(2, 10_000)
    const seen = column(4, 100_000)
    const items: SharedItem[] = []
    for (let n = 0; n < count; n += 1) {
      let thumb: Uint8Array | undefined
      if (flags[n] & 8) {
        const length = read.varint()
        if (length > THUMB_MAX) throw new Error('long')
        const blob = read.take(length).slice()
        if (validThumb(blob)) thumb = blob
      }
      const title = clean(titles[n], MAX_TITLE)
      if (!title) continue
      const status = STATUSES[flags[n] >> 5]
      const rating = whole(ratings[n], 5)
      const season = progress ? (flags[n] & 1 ? seasons.get(n) : 1) : undefined
      const episode = progress ? (flags[n] & 2 ? episodes.get(n) : 1) : undefined
      const watched = progress ? (flags[n] & 4 ? seen.get(n) : 0) : undefined
      items.push({
        title,
        ...(status && status !== 'watching' ? { status } : {}),
        ...(rating ? { rating } : {}),
        ...(season !== undefined ? { season } : {}),
        ...(episode !== undefined ? { episode } : {}),
        ...(watched !== undefined ? { seen: watched } : {}),
        ...(thumb ? { thumb, ...(flags[n] & 16 ? { tile: 'manga' as const } : {}) } : {}),
      })
    }
    return { v: 2, name, items }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Deflate and base 64                                                         */
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

const deflate = (bytes: Uint8Array) => pipe(Uint8Array.from(bytes), new CompressionStream('deflate-raw'), MAX_PAYLOAD * 2)
const inflate = (bytes: Uint8Array) => pipe(Uint8Array.from(bytes), new DecompressionStream('deflate-raw'), MAX_PAYLOAD)

/* -------------------------------------------------------------------------- */
/* In the address                                                              */
/* -------------------------------------------------------------------------- */

/** The packed list as the text a link carries. */
export async function encodeShare(list: SharedList): Promise<string> {
  return toBase64Url(await deflate(packList(list)))
}

/** FNV-1a, as four base-36 characters: names a list's parts, so parts of two lists sent about the same time do not mix. */
function nameOf(text: string): string {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(4, '0').slice(-4)
}

const PART = /^([0-9a-z]{4})\.(\d{1,2})\.(\d{1,2})\.([\w-]+)$/

/**
 * The links that carry a list: one when it fits in `max` characters, else as
 * many parts as it takes, each `<name>.<n>.<of>.<data>` after the hash. Empty
 * when even that is more than `MAX_PARTS` — a file is the way then.
 */
export async function shareLinks(list: SharedList, origin: string, max = LINK_MAX): Promise<string[]> {
  const base = `${origin.replace(/\/+$/, '')}/${SHARE_PREFIX}`
  const text = await encodeShare(list)
  if (base.length + text.length <= max) return [base + text]
  const name = nameOf(text)
  const room = Math.max(200, max - base.length - `${name}.00.00.`.length)
  const parts = Math.ceil(text.length / room)
  if (parts > MAX_PARTS) return []
  return Array.from({ length: parts }, (_, index) => `${base}${name}.${index + 1}.${parts}.${text.slice(index * room, (index + 1) * room)}`)
}

/** One link only, for what fits in one; null when it does not. */
export async function shareLink(list: SharedList, origin: string): Promise<string> {
  const links = await shareLinks(list, origin, Number.MAX_SAFE_INTEGER)
  return links[0]
}

/** The text after `#g=` (or the older `#geteilt=`) in an address, or null. */
export function sharedFromHash(hash: string): string | null {
  for (const prefix of [SHARE_PREFIX, LEGACY_PREFIX]) if (hash.startsWith(prefix) && hash.length > prefix.length) return hash.slice(prefix.length)
  return null
}

/**
 * A list out of what a whole link carries, or null. Parts are put together
 * first by `readShared`.
 */
export async function decodeShare(text: string): Promise<SharedList | null> {
  try {
    if (text.length > MAX_PARTS * LINK_MAX || !/^[\w-]+$/.test(text)) return null
    return unpackList(await inflate(fromBase64Url(text)))
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Gathering parts                                                             */
/* -------------------------------------------------------------------------- */

interface Gathered {
  of: number
  got: Record<string, string>
  at: number
}

/** Where parts wait for the rest: the page's own storage, or whatever a test hands in. */
export interface PartStore {
  read(): Record<string, Gathered>
  write(all: Record<string, Gathered>): void
}

const PARTS_KEY = 'sondra:geteilt:teile'
/** A list sent in parts is opened within a day or two, or not at all. */
const PARTS_KEPT = 2 * 24 * 60 * 60 * 1000

export const browserParts: PartStore = {
  read() {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PARTS_KEY) ?? '{}')
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Gathered>) : {}
    } catch {
      return {}
    }
  },
  write(all) {
    try {
      localStorage.setItem(PARTS_KEY, JSON.stringify(all))
    } catch {
      // Nothing to keep parts in: the list then has to come in one link.
    }
  },
}

export type Reading = { kind: 'list'; list: SharedList } | { kind: 'parts'; got: number[]; of: number } | { kind: 'broken' }

/** What an address carries: a list, one more part of a list that is not whole yet, or nothing readable. */
export async function readShared(text: string, store: PartStore = browserParts, now = Date.now()): Promise<Reading> {
  const part = PART.exec(text)
  if (!part) {
    const list = await decodeShare(text)
    return list ? { kind: 'list', list } : { kind: 'broken' }
  }
  const [, name, nText, ofText, data] = part
  const n = Number(nText)
  const of = Number(ofText)
  if (of < 2 || of > MAX_PARTS || n < 1 || n > of) return { kind: 'broken' }
  const all = store.read()
  for (const key of Object.keys(all)) if (!(now - all[key].at < PARTS_KEPT) || typeof all[key].got !== 'object') delete all[key]
  const here = all[name] && all[name].of === of ? all[name] : { of, got: {}, at: now }
  here.got[String(n)] = data
  here.at = now
  all[name] = here
  const have = Object.keys(here.got).map(Number).sort((a, b) => a - b)
  if (have.length < of) {
    store.write(all)
    return { kind: 'parts', got: have, of }
  }
  delete all[name]
  store.write(all)
  const list = await decodeShare(Array.from({ length: of }, (_, index) => here.got[String(index + 1)] ?? '').join(''))
  return list ? { kind: 'list', list } : { kind: 'broken' }
}

/* -------------------------------------------------------------------------- */
/* As a file                                                                   */
/* -------------------------------------------------------------------------- */

export const SHARE_FILE_EXT = '.sondra-liste'
const MAGIC = [0x53, 0x4c, 0x53, 0x54] // „SLST“
/** A file this big is not a list. */
const MAX_FILE = 12 * 1024 * 1024

export const isShareFile = (file: { name: string }) => /\.sondra-liste$/i.test(file.name)

/**
 * A file that arrived by any door (dropped, picked, opened with Sondra, shared
 * from a phone) is handed to the dialog that shows a shared list. One that came
 * before the dialog was there waits for it.
 */
const waiting: Uint8Array[] = []
const listeners = new Set<(bytes: Uint8Array) => void>()

export function offerSharedFile(bytes: Uint8Array): void {
  if (listeners.size === 0) waiting.push(bytes)
  for (const listener of listeners) listener(bytes)
}

export function onSharedFile(listener: (bytes: Uint8Array) => void): () => void {
  listeners.add(listener)
  for (const bytes of waiting.splice(0)) listener(bytes)
  return () => listeners.delete(listener)
}

export const shareFileName = () => `Sondra-Merkliste-${new Date().toISOString().slice(0, 10)}${SHARE_FILE_EXT}`

export async function shareFile(list: SharedList): Promise<Uint8Array> {
  return Uint8Array.from([...MAGIC, ...(await deflate(packList(list)))])
}

export async function readShareFile(bytes: Uint8Array): Promise<SharedList | null> {
  try {
    if (bytes.length > MAX_FILE || bytes.length < 6 || !MAGIC.every((value, index) => bytes[index] === value)) return null
    return unpackList(await inflate(bytes.subarray(4)))
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* As text                                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_WORD: Record<SavedLinkStatus, string> = { watching: 'Am Schauen', later: 'Später', paused: 'Pausiert', done: 'Fertig', dropped: 'Abgebrochen' }

/** One line per series — „Frieren – S1E12 – 4/5“ — that anyone reads, with or without Sondra, then the links. */
export function shareText(list: SharedList, links: string[] = []): string {
  const lines = list.items.map((item) => {
    const place =
      item.season === undefined ? '' : item.season === 0 ? `Film ${item.episode ?? 1}` : `S${item.season}E${item.episode ?? 1}`
    const parts = [item.title, place, item.rating ? `${item.rating}/5` : '', item.status && item.status !== 'watching' ? STATUS_WORD[item.status] : '']
    return `• ${parts.filter(Boolean).join(' – ')}`
  })
  const head = `${list.name ? `Merkliste von ${list.name}` : 'Merkliste'} (${list.items.length}):`
  const tail =
    links.length === 0
      ? []
      : links.length === 1
        ? ['', `In Sondra öffnen: ${links[0]}`]
        : ['', `In Sondra öffnen — alle ${links.length} Links nacheinander öffnen:`, ...links.map((link, index) => `${index + 1}/${links.length} ${link}`)]
  return [head, ...lines, ...tail].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Against one's own list                                                      */
/* -------------------------------------------------------------------------- */

/** A title as it is compared: without case and accents. */
export const titleKey = (title: string): string => title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim()

export interface Comparison {
  /** On both lists. */
  both: SharedItem[]
  /** Only on the shared one: what this list could take. */
  fresh: SharedItem[]
  /** Titles only this list has. */
  onlyMine: number
}

export function compareShared(list: SharedList, current: SavedLinkItem[]): Comparison {
  const mine = new Set(current.map((item) => titleKey(item.title)))
  const seen = new Set<string>()
  const both: SharedItem[] = []
  const fresh: SharedItem[] = []
  for (const item of list.items) {
    const key = titleKey(item.title)
    if (seen.has(key)) continue
    seen.add(key)
    ;(mine.has(key) ? both : fresh).push(item)
  }
  return { both, fresh, onlyMine: [...mine].filter((key) => !seen.has(key)).length }
}

/** What would be new on this list: titles it does not hold yet. */
export function newFromShared(list: SharedList, current: SavedLinkItem[]): SharedItem[] {
  return compareShared(list, current).fresh
}

/**
 * The fields for a new entry from a shared one: as it stands there, or — for
 * „Später“ — as something not started. The cover is the little picture that
 * came along, made an address here.
 */
export function entryFromShared(item: SharedItem, how: 'wie dort' | 'später'): Partial<SavedLinkItem> {
  const cover = item.thumb ? thumbUrl(item.thumb, item.tile ?? 'poster') : null
  return {
    title: item.title,
    ...(cover ? { cover, ...(item.tile === 'manga' ? { tileFormat: 'manga' as const } : {}) } : {}),
    ...(how === 'später'
      ? { status: 'later' as const }
      : {
          ...(item.status ? { status: item.status } : {}),
          ...(item.rating ? { rating: item.rating } : {}),
          ...(item.season !== undefined ? { season: item.season } : {}),
          ...(item.episode !== undefined ? { episode: item.episode } : {}),
        }),
  }
}
