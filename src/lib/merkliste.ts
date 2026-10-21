/**
 * The Merkliste's data: what someone follows, season by season, and what of
 * it they have seen.
 *
 * One store for the two places that use it — the Merkliste tab, where it is
 * looked at and edited, and „Merken" in the downloader, where entries are
 * added and moved on. Before, the list lived inside the downloader's state,
 * and a second tab would have read a copy that was stale the moment either
 * side changed it.
 *
 * Kept in `localStorage` under the key the saved links always used, so
 * nothing saved before is lost, and mirrored into project files.
 */

import { useSyncExternalStore } from 'react'

import { deriveLinkTitle, parseLinkEpisodeInfo } from './download'
import { getProjectToolState, setProjectToolState } from './project'
import type {
  AniworldLanguagePref,
  AudioFilePref,
  AudioOutputFormat,
  VideoFilePref,
} from '../components/panels/DownloaderPanel'

/** Where an entry stands: being watched, for later, finished. */
export type SavedLinkStatus = 'watching' | 'later' | 'done'

/** The shape of an entry's tiles: a film poster (2:3) or a manga volume (5:7). */
export type TileFormat = 'poster' | 'manga'

/** One season of an entry; `number` 0 holds the films. */
export interface MerkSeason {
  number: number
  /** How many episodes (or films) it has, when someone has said so. */
  episodes: number | null
  /** The episode numbers marked as seen. */
  watched: number[]
  /** A name of its own, „Staffel 2" when empty. */
  title?: string
  /** A picture for this season's tile; the entry's cover otherwise. */
  cover?: string
  coverFrame?: CoverFrame
  /**
   * A season shown in parts — „Teil 1", „Teil 2" — each a tile of its own.
   * The episodes keep counting through the season, as the sites number
   * them: a second part of twelve after twelve holds episodes 13 to 24.
   * `episodes` is then the sum of the parts. Only the last part may be of
   * unknown length. Absent, or fewer than two, means one piece.
   */
  parts?: MerkPart[]
}

export interface MerkPart {
  episodes: number | null
  title?: string
  cover?: string
  coverFrame?: CoverFrame
}

/**
 * The part of a cover a 2:3 tile shows: where the picture sits, 0–100 % across
 * and down (as `object-position`), and how far it is zoomed in (1–3). Without
 * one, the middle, unzoomed.
 */
export interface CoverFrame {
  x: number
  y: number
  zoom: number
}

function normalizeFrame(raw: unknown): CoverFrame | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { x, y, zoom } = raw as Partial<CoverFrame>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return undefined
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
  const frame = { x: clamp(x, 0, 100), y: clamp(y, 0, 100), zoom: clamp(zoom, 1, 3) }
  return frame.x === 50 && frame.y === 50 && frame.zoom === 1 ? undefined : frame
}

export interface SavedLinkItem {
  id: string
  /** May be empty: an entry can be followed without anything to load. */
  url: string
  title: string
  language: AniworldLanguagePref
  /** Where someone is: the season (0 = films) and the episode to watch next. */
  season: number
  episode: number | null
  mode: 'video' | 'audio'
  audioFormat: AudioOutputFormat
  videoPref: VideoFilePref
  audioPref: AudioFilePref
  autoTranscribe: boolean
  updatedAt: number
  status?: SavedLinkStatus
  lastOpenedAt?: number
  seasons?: MerkSeason[]
  /** An image address, or a picture stored with the entry (data: URL). */
  cover?: string
  coverFrame?: CoverFrame
  /** Absent means a film poster. */
  tileFormat?: TileFormat
  notes?: string
  /** 0–5; 0 is unrated. */
  rating?: number
}

const KEY = 'sondra:saved_links'
const PROJECT_KEY = 'merkliste'

const uniqueSorted = (numbers: number[]) =>
  Array.from(new Set(numbers.filter((n) => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b)

/**
 * Seen marks as stored: whole numbers, once each, in order — and none past
 * the end of a season whose length is known. „40 von 39" came from a mark
 * one past the end.
 */
const cleanWatched = (numbers: number[], episodes: number | null) =>
  uniqueSorted(numbers).filter((n) => episodes === null || n <= episodes)

function normalize(raw: Partial<SavedLinkItem>): SavedLinkItem {
  const info = parseLinkEpisodeInfo(raw.url || '')
  const season = typeof raw.season === 'number' ? raw.season : info.season
  const episode = raw.episode === null || typeof raw.episode === 'number' ? raw.episode : (info.episode ?? 1)
  const seasons = Array.isArray(raw.seasons)
    ? raw.seasons
        .filter((s): s is MerkSeason => Boolean(s) && typeof s.number === 'number')
        .map((s) => {
          const season: MerkSeason = {
            number: Math.max(0, Math.floor(s.number)),
            episodes: typeof s.episodes === 'number' && s.episodes > 0 ? Math.floor(s.episodes) : null,
            watched: Array.isArray(s.watched) ? s.watched : [],
            ...(s.title ? { title: String(s.title) } : {}),
            ...(s.cover ? { cover: String(s.cover) } : {}),
            ...(s.cover && normalizeFrame(s.coverFrame) ? { coverFrame: normalizeFrame(s.coverFrame) } : {}),
          }
          const parts = Array.isArray(s.parts)
            ? s.parts
                .filter((part): part is MerkPart => Boolean(part) && typeof part === 'object')
                .map((part) => ({
                  episodes: typeof part.episodes === 'number' && part.episodes > 0 ? Math.floor(part.episodes) : null,
                  ...(part.title ? { title: String(part.title) } : {}),
                  ...(part.cover ? { cover: String(part.cover) } : {}),
                  ...(part.cover && normalizeFrame(part.coverFrame) ? { coverFrame: normalizeFrame(part.coverFrame) } : {}),
                }))
            : []
          return parts.length >= 2 ? withParts(season, parts) : { ...season, watched: cleanWatched(season.watched, season.episodes) }
        })
    : undefined
  const item: SavedLinkItem = {
    id: raw.id || `merk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url: raw.url || '',
    title: raw.title || (raw.url ? deriveLinkTitle(raw.url) : 'Ohne Namen'),
    language: raw.language || 'auto',
    season,
    episode,
    mode: raw.mode === 'audio' ? 'audio' : 'video',
    audioFormat: raw.audioFormat || 'mp3',
    videoPref: raw.videoPref || 'untouched',
    audioPref: raw.audioPref || 'high',
    autoTranscribe: Boolean(raw.autoTranscribe),
    updatedAt: raw.updatedAt || Date.now(),
    status: raw.status === 'later' || raw.status === 'done' ? raw.status : 'watching',
    lastOpenedAt: typeof raw.lastOpenedAt === 'number' ? raw.lastOpenedAt : undefined,
    ...(seasons ? { seasons } : {}),
    ...(raw.cover ? { cover: raw.cover } : {}),
    ...(raw.cover && normalizeFrame(raw.coverFrame) ? { coverFrame: normalizeFrame(raw.coverFrame) } : {}),
    ...(raw.tileFormat === 'manga' ? { tileFormat: 'manga' as const } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
    ...(typeof raw.rating === 'number' ? { rating: Math.max(0, Math.min(5, Math.round(raw.rating))) } : {}),
  }
  // A position past the end of its season — saved by „Alle gesehen" before
  // it knew better, or left there by a count made smaller — moves to the
  // first episode not seen. A „Fertig" set by hand stays.
  const length = seasons?.find((s) => s.number === season)?.episodes ?? null
  if (seasons && typeof episode === 'number' && length !== null && episode > length) {
    const settled = settle(item, seasons, season)
    return { ...item, season: settled.season, episode: settled.episode, status: settled.status === 'done' ? 'done' : item.status }
  }
  return item
}

function load(): SavedLinkItem[] {
  // A project opened before this module was first needed already put its
  // list where `getProjectToolState` finds it.
  const fromProject = getProjectToolState<unknown>(PROJECT_KEY)
  if (Array.isArray(fromProject)) return fromProject.map((item) => normalize(item as Partial<SavedLinkItem>))
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.map((item) => normalize(item as Partial<SavedLinkItem>)) : []
  } catch {
    return []
  }
}

let items: SavedLinkItem[] = load()
const listeners = new Set<() => void>()
/** False once the device refused to store the list — a cover too large, most often. */
let lastSaveOk = true

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
    lastSaveOk = true
  } catch {
    lastSaveOk = false
  }
  setProjectToolState(PROJECT_KEY, items)
}
setProjectToolState(PROJECT_KEY, items)

export function merkItems(): SavedLinkItem[] {
  return items
}

/** Replaces the list, or changes it with a function of the current one. */
export function setMerkItems(next: SavedLinkItem[] | ((current: SavedLinkItem[]) => SavedLinkItem[])): boolean {
  items = typeof next === 'function' ? next(items) : next
  persist()
  listeners.forEach((listener) => listener())
  return lastSaveOk
}

export function merkSaveFailed(): boolean {
  return !lastSaveOk
}

export function updateMerkItem(id: string, patch: Partial<SavedLinkItem> | ((item: SavedLinkItem) => Partial<SavedLinkItem>)): boolean {
  return setMerkItems((current) =>
    current.map((item) =>
      item.id === id ? { ...item, ...(typeof patch === 'function' ? patch(item) : patch), updatedAt: Date.now() } : item,
    ),
  )
}

export function createMerkItem(fields: Partial<SavedLinkItem>): SavedLinkItem {
  return normalize(fields)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The list, kept current in whichever component reads it. */
export function useMerkliste(): SavedLinkItem[] {
  return useSyncExternalStore(subscribe, merkItems, merkItems)
}

if (typeof window !== 'undefined') {
  window.addEventListener('sondra:project-loaded', () => {
    const fromProject = getProjectToolState<unknown>(PROJECT_KEY)
    if (Array.isArray(fromProject)) {
      setMerkItems(fromProject.map((item) => normalize(item as Partial<SavedLinkItem>)))
      return
    }
    // Projects saved before the Merkliste had its own key kept the list with
    // the downloader.
    const legacy = getProjectToolState<{ savedLinks?: unknown }>('downloader')?.savedLinks
    if (Array.isArray(legacy)) setMerkItems(legacy.map((item) => normalize(item as Partial<SavedLinkItem>)))
  })
  // Another window of the app changed the list.
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    try {
      const parsed: unknown = event.newValue ? JSON.parse(event.newValue) : []
      if (!Array.isArray(parsed)) return
      items = parsed.map((item) => normalize(item as Partial<SavedLinkItem>))
      listeners.forEach((listener) => listener())
    } catch {
      /* a half-written value; the next event brings the whole one */
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Seasons and progress                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The seasons of an entry, as tiles want them: the ones someone set up, and
 * at least the one they are in. An entry saved before seasons existed had
 * only a position; everything before it counts as seen.
 */
export function seasonsOf(item: SavedLinkItem): MerkSeason[] {
  const list = item.seasons?.length ? [...item.seasons] : []
  if (!list.some((season) => season.number === item.season)) {
    const before = item.episode && item.episode > 1 ? Array.from({ length: item.episode - 1 }, (_, i) => i + 1) : []
    list.push({ number: item.season, episodes: null, watched: item.seasons?.length ? [] : before })
  }
  // Seasons in order, the films after them.
  return list.sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number))
}

export interface SeasonProgress {
  watched: number
  total: number | null
  /** 0–1 when the total is known. */
  fraction: number | null
  /** The first episode not yet seen; the last one when all are. */
  next: number
  /** Every episode is seen (only when the total is known). */
  complete: boolean
}

export function seasonProgress(season: MerkSeason): SeasonProgress {
  const total = season.episodes
  const watched = total === null ? season.watched.length : season.watched.filter((n) => n <= total).length
  let next = 1
  while (season.watched.includes(next)) next += 1
  if (total !== null) next = Math.min(next, total)
  return {
    watched,
    total,
    fraction: total ? Math.min(1, watched / total) : null,
    next,
    complete: total !== null && watched >= total,
  }
}

export function itemProgress(item: SavedLinkItem): { watched: number; total: number | null; fraction: number | null } {
  const seasons = seasonsOf(item)
  const watched = seasons.reduce((sum, season) => sum + seasonProgress(season).watched, 0)
  const known = seasons.every((season) => season.episodes !== null)
  const total = known ? seasons.reduce((sum, season) => sum + (season.episodes ?? 0), 0) : null
  // With one season's size still open, the bar measures the ones that are
  // known instead of staying empty.
  const sized = seasons.filter((season) => season.episodes !== null)
  const sizedTotal = sized.reduce((sum, season) => sum + (season.episodes ?? 0), 0)
  const sizedWatched = sized.reduce((sum, season) => sum + seasonProgress(season).watched, 0)
  return { watched, total, fraction: sizedTotal ? Math.min(1, sizedWatched / sizedTotal) : null }
}

/** The seasons with one of them changed. */
export function withSeason(item: SavedLinkItem, number: number, change: (season: MerkSeason) => MerkSeason | null): MerkSeason[] {
  const seasons = seasonsOf(item)
  const next: MerkSeason[] = []
  for (const season of seasons) {
    if (season.number !== number) {
      next.push(season)
      continue
    }
    const changed = change(season)
    if (changed) next.push({ ...changed, watched: cleanWatched(changed.watched, changed.episodes) })
  }
  return next
}

/** Marks one episode as seen or not. */
export function toggleWatched(item: SavedLinkItem, seasonNumber: number, episode: number): MerkSeason[] {
  return withSeason(item, seasonNumber, (season) => ({
    ...season,
    watched: season.watched.includes(episode) ? season.watched.filter((n) => n !== episode) : [...season.watched, episode],
  }))
}

/** Marks everything up to and including an episode as seen. */
export function watchedUpTo(item: SavedLinkItem, seasonNumber: number, episode: number): MerkSeason[] {
  return withSeason(item, seasonNumber, (season) => ({
    ...season,
    watched: [...season.watched.filter((n) => n > episode), ...Array.from({ length: episode }, (_, i) => i + 1)],
  }))
}

/* -------------------------------------------------------------------------- */
/* Parts of a season                                                           */
/* -------------------------------------------------------------------------- */

/** A part with the episode numbers it holds; `to` is open while its length is. */
export interface SeasonPart extends MerkPart {
  index: number
  from: number
  to: number | null
}

/** The parts of a season in order — one, the whole season, when it is not split. */
export function partsOf(season: MerkSeason): SeasonPart[] {
  if (!season.parts || season.parts.length < 2) {
    return [{ index: 0, from: 1, to: season.episodes, episodes: season.episodes }]
  }
  let from = 1
  return season.parts.map((part, index) => {
    const to = part.episodes === null ? null : from + part.episodes - 1
    const entry: SeasonPart = { ...part, index, from, to }
    from = (to ?? from) + 1
    return entry
  })
}

/** How far a part is seen, counted on its own episodes. */
export function partProgress(season: MerkSeason, part: SeasonPart): SeasonProgress {
  const inside = (n: number) => n >= part.from && (part.to === null || n <= part.to)
  const watched = season.watched.filter(inside).length
  const total = part.episodes
  let next = part.from
  while (season.watched.includes(next)) next += 1
  if (part.to !== null) next = Math.min(next, part.to)
  return {
    watched,
    total,
    fraction: total ? Math.min(1, watched / total) : null,
    next,
    complete: total !== null && watched >= total,
  }
}

/** „Staffel 2 · Teil 1", or the part's own name; the season's name when it is one piece. */
export function partName(season: MerkSeason, part: SeasonPart): string {
  if (!season.parts || season.parts.length < 2) return seasonName(season)
  return part.title || `${seasonName(season)} · Teil ${part.index + 1}`
}

/** The part an episode belongs to. */
export function partOfEpisode(season: MerkSeason, episode: number | null): SeasonPart {
  const parts = partsOf(season)
  if (episode === null) return parts[0]
  return parts.find((part) => episode >= part.from && (part.to === null || episode <= part.to)) ?? parts[parts.length - 1]
}

/**
 * A season with new parts: the length becomes their sum, a part of unknown
 * length before the last gets one episode, and one part left is no split.
 */
export function withParts(season: MerkSeason, parts: MerkPart[]): MerkSeason {
  const { parts: _old, ...rest } = season
  if (parts.length < 2) {
    const only = parts[0]
    const episodes = only ? only.episodes : season.episodes
    // The last part's cover becomes the season's, if the season had none.
    const picture = rest.cover ? { cover: rest.cover, coverFrame: rest.coverFrame } : { cover: only?.cover, coverFrame: only?.coverFrame }
    return { ...rest, ...picture, episodes, watched: cleanWatched(season.watched, episodes) }
  }
  const fixed = parts.map((part, i) => (i < parts.length - 1 && part.episodes === null ? { ...part, episodes: 1 } : part))
  const episodes = fixed.every((part) => part.episodes !== null) ? fixed.reduce((sum, part) => sum + (part.episodes ?? 0), 0) : null
  return { ...rest, parts: fixed, episodes, watched: cleanWatched(season.watched, episodes) }
}

/** The parts as stored, for changing one of them. */
export function storedParts(season: MerkSeason): MerkPart[] {
  return partsOf(season).map(({ episodes, title, cover, coverFrame }) => ({
    episodes,
    ...(title ? { title } : {}),
    ...(cover ? { cover } : {}),
    ...(cover && coverFrame ? { coverFrame } : {}),
  }))
}

/**
 * „In Teile teilen": two parts, the known length halved; an open length
 * keeps what is seen in the first part and leaves the second open.
 */
export function splitSeason(season: MerkSeason): MerkSeason {
  const total = season.episodes
  const highest = season.watched.length ? Math.max(...season.watched) : 0
  const first = total !== null ? Math.max(1, Math.ceil(total / 2)) : Math.max(12, highest)
  const second = total !== null ? Math.max(1, total - first) : null
  return withParts(season, [{ episodes: first }, { episodes: second }])
}

/** Marks a range of a season — a part — as seen, or as not seen. */
export function markRange(item: SavedLinkItem, seasonNumber: number, from: number, to: number, seen: boolean): MerkSeason[] {
  return withSeason(item, seasonNumber, (season) => {
    const rest = season.watched.filter((n) => n < from || n > to)
    return { ...season, watched: seen ? [...rest, ...Array.from({ length: to - from + 1 }, (_, i) => from + i)] : rest }
  })
}

/** Every season has a known length and all of it is seen. */
export function caughtUp(seasons: MerkSeason[]): boolean {
  return seasons.length > 0 && seasons.every((season) => seasonProgress(season).complete)
}

/**
 * Where an entry stands once its seen marks changed: the first episode not
 * yet seen, from the given season on — the seasons after it first, then the
 * gaps left before it. With everything seen there is nothing left to stand
 * at: the entry is finished and stays at the last episode. Before, the
 * position simply went one further, and „Alle gesehen" left a series of 39
 * at „Folge 40".
 */
export function settle(
  item: SavedLinkItem,
  seasons: MerkSeason[],
  from: number,
): Pick<SavedLinkItem, 'seasons' | 'season' | 'episode' | 'status'> {
  const ordered = [...seasons].sort((a, b) => (a.number === 0 ? 1 : b.number === 0 ? -1 : a.number - b.number))
  const start = Math.max(0, ordered.findIndex((season) => season.number === from))
  for (const season of [...ordered.slice(start), ...ordered.slice(0, start)]) {
    const progress = seasonProgress(season)
    if (progress.complete) continue
    const status = !item.status || item.status === 'done' ? 'watching' : item.status
    return { seasons, season: season.number, episode: progress.next, status }
  }
  const last = ordered.find((season) => season.number === from) ?? ordered[ordered.length - 1]
  return { seasons, season: last?.number ?? from, episode: last?.episodes ?? item.episode, status: 'done' }
}

/**
 * „Folge 5 gesehen": everything up to the current episode counts as seen,
 * and the entry moves on to the first one not seen — into the next season
 * when this one is over, and to „Fertig" when nothing is left.
 */
export function advance(item: SavedLinkItem): Pick<SavedLinkItem, 'seasons' | 'season' | 'episode' | 'status'> {
  const seasons = item.episode ? watchedUpTo(item, item.season, item.episode) : seasonsOf(item)
  return settle(item, seasons, item.season)
}

/** „Staffel 2", „Filme", or the season's own name. */
export function seasonName(season: MerkSeason): string {
  if (season.title) return season.title
  return season.number === 0 ? 'Filme' : `Staffel ${season.number}`
}

/* -------------------------------------------------------------------------- */
/* Handing an entry to the downloader                                          */
/* -------------------------------------------------------------------------- */

let pendingLookup: SavedLinkItem | null = null

/**
 * Asks the downloader to look an entry up where it stands. The downloader is
 * a different tab and not mounted while the Merkliste is open; it takes the
 * request when it next renders.
 */
export function requestLookup(item: SavedLinkItem): void {
  pendingLookup = item
}

export function takePendingLookup(): SavedLinkItem | null {
  const item = pendingLookup
  pendingLookup = null
  return item
}

/* -------------------------------------------------------------------------- */
/* Covers                                                                      */
/* -------------------------------------------------------------------------- */

/** Anything a cover can be drawn from. */
export type Picture = HTMLImageElement | HTMLCanvasElement | ImageBitmap

export function pictureSize(picture: Picture): { width: number; height: number } {
  return picture instanceof HTMLImageElement
    ? { width: picture.naturalWidth, height: picture.naturalHeight }
    : { width: picture.width, height: picture.height }
}

/**
 * A picture at half its size, every four pixels drawn as their average.
 * Halving again and again, then one short last step, is how a large picture
 * gets small without the jagged, over-sharpened look of one long jump — the
 * look a 2000 × 3000 poster had when the browser squeezed it into a tile.
 */
export function halve(picture: Picture): HTMLCanvasElement | null {
  const { width, height } = pictureSize(picture)
  if (width < 2 || height < 2) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width / 2)
  canvas.height = Math.round(height / 2)
  const context = canvas.getContext('2d')
  if (!context) return null
  // Plain bilinear: at exactly half, that is the average of each 2 × 2.
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'low'
  context.drawImage(picture, 0, 0, canvas.width, canvas.height)
  return canvas
}

/**
 * A picked image, made small enough to live in the list: at most 720 px on
 * its longer side — a poster comes out 480 × 720, a still 720 × 405, enough
 * to choose a part of it for a tile. Made small in halves (`halve`), then
 * stored as WebP, or JPEG where the browser cannot write WebP. A phone photo
 * straight in would fill the space the browser gives the whole site after
 * two or three covers.
 */
export async function coverFromFile(file: File, longest = 720): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  let source: Picture = bitmap
  for (;;) {
    const size = pictureSize(source)
    if (size.width / 2 < width || size.height / 2 < height) break
    const next = halve(source)
    if (!next) break
    source = next
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Das Bild liess sich nicht verkleinern.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
  bitmap.close()
  const webp = canvas.toDataURL('image/webp', 0.9)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.92)
}

/* -------------------------------------------------------------------------- */
/* Export and import                                                           */
/* -------------------------------------------------------------------------- */

const EXPORT_KIND = 'sondra-merkliste'

/**
 * The whole list as a file of its own: to keep, or to take to another
 * device. Covers chosen from a file travel inside it; covers given as an
 * address stay an address.
 */
export function exportMerkliste(list: SavedLinkItem[] = items): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: 1, exportedAt: new Date().toISOString(), items: list }, null, 2)
}

/** Reads a file `exportMerkliste` wrote (or a bare list of entries). */
export function readMerklisteFile(text: string): SavedLinkItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Die Datei ist keine Merkliste — sie lässt sich nicht als JSON lesen.')
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : null
  if (!list) throw new Error('In der Datei steht keine Merkliste.')
  const entries = list.filter((entry): entry is Partial<SavedLinkItem> => Boolean(entry) && typeof entry === 'object')
  if (entries.length === 0) throw new Error('Die Merkliste in der Datei ist leer.')
  return entries.map((entry) => normalize(entry))
}

export interface MerkImport {
  items: SavedLinkItem[]
  added: number
  updated: number
  /** Entries already the same here. */
  same: number
  /** Entries this device had changed more recently than the file; kept as they are. */
  kept: number
}

/**
 * Brings a file's entries into the list. The same series — same entry, or
 * the same name — is not doubled: whichever side was changed last wins, so
 * reading in an older export never undoes what was ticked off since.
 */
export function mergeMerkliste(current: SavedLinkItem[], incoming: SavedLinkItem[]): MerkImport {
  const next = [...current]
  let added = 0
  let updated = 0
  let same = 0
  let kept = 0
  const nameOf = (item: SavedLinkItem) => item.title.trim().toLowerCase()
  for (const entry of incoming) {
    const index = next.findIndex((item) => item.id === entry.id || nameOf(item) === nameOf(entry))
    if (index === -1) {
      next.push(entry)
      added += 1
    } else if (entry.updatedAt > next[index].updatedAt) {
      next[index] = { ...entry, id: next[index].id }
      updated += 1
    } else if (entry.updatedAt === next[index].updatedAt) {
      same += 1
    } else {
      kept += 1
    }
  }
  return { items: next, added, updated, same, kept }
}

/* -------------------------------------------------------------------------- */
/* Removals and the shared copy                                                */
/* -------------------------------------------------------------------------- */

const REMOVED_KEY = 'sondra:merkliste_removed'

/**
 * When each entry was taken off the list, by id. A copy kept elsewhere — the
 * page in Anytype — still holds a removed entry; without this, the next
 * merge would bring it back.
 */
let removals: Record<string, number> = (() => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
})()

function persistRemovals() {
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(removals))
  } catch {
    // Without it, a removed entry may come back from Anytype once.
  }
}

export function merkRemovals(): Record<string, number> {
  return removals
}

export function noteRemoved(id: string): void {
  removals = { ...removals, [id]: Date.now() }
  persistRemovals()
}

export function noteRestored(id: string): void {
  if (!(id in removals)) return
  const { [id]: _gone, ...rest } = removals
  removals = rest
  persistRemovals()
}

/** Stands in for a picture from a file, which stays on its device. */
export const LOCAL_PICTURE = 'sondra:lokal'

/** An entry as it travels to another device: pictures from files left behind. */
export function travelling(item: SavedLinkItem): SavedLinkItem {
  const away = <T extends { cover?: string; coverFrame?: CoverFrame }>(holder: T): T =>
    holder.cover?.startsWith('data:') ? { ...holder, cover: LOCAL_PICTURE, coverFrame: undefined } : holder
  return {
    ...away(item),
    ...(item.seasons
      ? {
          seasons: item.seasons.map((season) => ({
            ...away(season),
            ...(season.parts ? { parts: season.parts.map((part) => away(part)) } : {}),
          })),
        }
      : {}),
  }
}

/** An arrived entry with this device's own pictures put back where it left them. */
function withLocalPictures(item: SavedLinkItem, local: SavedLinkItem | undefined): SavedLinkItem {
  const back = <T extends { cover?: string; coverFrame?: CoverFrame }>(holder: T, mine: T | undefined): T =>
    holder.cover === LOCAL_PICTURE
      ? mine?.cover?.startsWith('data:')
        ? { ...holder, cover: mine.cover, coverFrame: mine.coverFrame }
        : { ...holder, cover: undefined, coverFrame: undefined }
      : holder
  const localSeasons = local?.seasons ?? []
  return {
    ...back(item, local),
    ...(item.seasons
      ? {
          seasons: item.seasons.map((season) => {
            const mine = localSeasons.find((entry) => entry.number === season.number)
            return {
              ...back(season, mine),
              ...(season.parts ? { parts: season.parts.map((part, i) => back(part, mine?.parts?.[i])) } : {}),
            }
          }),
        }
      : {}),
  }
}

/**
 * This device's list merged with a copy kept elsewhere: per series the side
 * changed last wins (`mergeMerkliste`), what was removed on either side after
 * its last change stays removed, and pictures from files stay where they were
 * chosen.
 */
export function mergeShared(
  current: SavedLinkItem[],
  remote: { items: SavedLinkItem[]; removed: Record<string, number> },
): { items: SavedLinkItem[]; removed: Record<string, number> } {
  const removed = { ...removals }
  for (const [id, at] of Object.entries(remote.removed)) {
    if (typeof at === 'number' && !(removed[id] >= at)) removed[id] = at
  }
  const gone = (item: SavedLinkItem) => removed[item.id] !== undefined && removed[item.id] >= item.updatedAt
  const merged = mergeMerkliste(current, remote.items.filter((item) => !gone(item)))
  const items = merged.items
    .filter((item) => !gone(item))
    .map((item) => withLocalPictures(item, current.find((entry) => entry.id === item.id)))
  return { items, removed }
}

/** Takes the merged removals as this device's own. */
export function adoptRemovals(next: Record<string, number>): void {
  removals = next
  persistRemovals()
}


/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

export interface MerklisteStats {
  totalSeries: number
  watchingCount: number
  laterCount: number
  doneCount: number
  watchingPercent: number
  laterPercent: number
  donePercent: number
  seenTotal: number
  knownTotalEpisodes: number
  knownWatchedEpisodes: number
  openEpisodesCount: number
  overallProgressPercent: number | null
  watchMinutes: number
  watchTime: { short: string; long: string }
  totalSeasons: number
  completedSeasons: number
  filmCount: number
  filmsSeen: number
  ratedCount: number
  avgRating: string | null
  ratingDistribution: { stars: number; count: number }[]
  recentItems: SavedLinkItem[]
}

export function formatWatchMinutes(totalMinutes: number): { short: string; long: string } {
  if (totalMinutes <= 0) return { short: '0 Std.', long: '0 Stunden' }
  const totalHours = Math.round((totalMinutes / 60) * 10) / 10
  const days = Math.floor(totalMinutes / (60 * 24))
  const remMinutes = totalMinutes % (60 * 24)
  const hours = Math.floor(remMinutes / 60)
  const minutes = remMinutes % 60

  const short = totalHours < 1 ? `${totalMinutes} Min.` : `${totalHours.toLocaleString('de-CH')} Std.`
  const parts: string[] = []
  if (days > 0) parts.push(`${days} ${days === 1 ? 'Tag' : 'Tage'}`)
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'Std.' : 'Std.'}`)
  if (minutes > 0) parts.push(`${minutes} Min.`)
  const long = parts.length > 0 ? parts.join(', ') : `${totalHours} Std.`
  return { short, long }
}

export function calculateMerklisteStats(items: SavedLinkItem[]): MerklisteStats {
  const totalSeries = items.length
  const watchingCount = items.filter((i) => (i.status ?? 'watching') === 'watching').length
  const laterCount = items.filter((i) => i.status === 'later').length
  const doneCount = items.filter((i) => i.status === 'done').length

  const watchingPercent = totalSeries > 0 ? Math.round((watchingCount / totalSeries) * 100) : 0
  const laterPercent = totalSeries > 0 ? Math.round((laterCount / totalSeries) * 100) : 0
  const donePercent = totalSeries > 0 ? Math.round((doneCount / totalSeries) * 100) : 0

  const seenTotal = items.reduce((sum, item) => sum + itemProgress(item).watched, 0)

  let knownTotalEpisodes = 0
  let knownWatchedEpisodes = 0
  for (const item of items) {
    const prog = itemProgress(item)
    if (prog.total !== null && prog.total > 0) {
      knownTotalEpisodes += prog.total
      knownWatchedEpisodes += prog.watched
    }
  }

  const openEpisodesCount = Math.max(0, knownTotalEpisodes - knownWatchedEpisodes)
  const overallProgressPercent =
    knownTotalEpisodes > 0 ? Math.min(100, Math.round((knownWatchedEpisodes / knownTotalEpisodes) * 100)) : null

  // Watch time estimate: 24 minutes per episode average (standard for anime & series)
  const watchMinutes = seenTotal * 24
  const watchTime = formatWatchMinutes(watchMinutes)

  let totalSeasons = 0
  let completedSeasons = 0
  let filmCount = 0
  let filmsSeen = 0

  for (const item of items) {
    const seasons = seasonsOf(item)
    for (const season of seasons) {
      if (season.number === 0) {
        filmCount += season.episodes ?? season.watched.length
        filmsSeen += season.watched.length
      } else {
        totalSeasons += 1
        const prog = seasonProgress(season)
        if (prog.complete) {
          completedSeasons += 1
        }
      }
    }
  }

  const ratedItems = items.filter((i) => typeof i.rating === 'number' && i.rating > 0)
  const ratedCount = ratedItems.length
  const avgRating =
    ratedCount > 0
      ? (ratedItems.reduce((sum, i) => sum + (i.rating ?? 0), 0) / ratedCount).toFixed(1)
      : null

  const ratingDistribution = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: ratedItems.filter((i) => Math.round(i.rating ?? 0) === stars).length,
  }))

  const recentItems = [...items]
    .sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
    .slice(0, 3)

  return {
    totalSeries,
    watchingCount,
    laterCount,
    doneCount,
    watchingPercent,
    laterPercent,
    donePercent,
    seenTotal,
    knownTotalEpisodes,
    knownWatchedEpisodes,
    openEpisodesCount,
    overallProgressPercent,
    watchMinutes,
    watchTime,
    totalSeasons,
    completedSeasons,
    filmCount,
    filmsSeen,
    ratedCount,
    avgRating,
    ratingDistribution,
    recentItems,
  }
}
