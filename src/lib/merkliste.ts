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

import { deriveLinkTitle, isAniworldUrl, parseLinkEpisodeInfo } from './download'
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
  /** Standard duration in minutes per regular episode (default 24). */
  episodeDuration?: number
  /** Standard duration in minutes for films (default 90). */
  filmDuration?: number
  /** Episode-specific duration exceptions in minutes, keyed as `${season}:${episode}`, e.g. { '1:1': 48 } */
  durations?: Record<string, number>
  /** User-defined tags, e.g. ['Anime', 'Liebling', 'Comedy']. */
  tags?: string[]
  /** Log of watched episodes with timestamps. */
  history?: WatchHistoryEntry[]
  /** Online release info from AniWorld to detect new seasons or episodes. */
  onlineAvailable?: OnlineAvailableInfo
}

export interface WatchHistoryEntry {
  id: string
  season: number
  episode: number
  at: number
}

export interface OnlineAvailableInfo {
  maxSeason: number
  maxEpisode: number
  checkedAt: number
  hasNew?: boolean
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
    ...(typeof raw.episodeDuration === 'number' && raw.episodeDuration > 0 ? { episodeDuration: Math.round(raw.episodeDuration) } : {}),
    ...(typeof raw.filmDuration === 'number' && raw.filmDuration > 0 ? { filmDuration: Math.round(raw.filmDuration) } : {}),
    ...(raw.durations && typeof raw.durations === 'object' ? { durations: raw.durations } : {}),
    ...(Array.isArray(raw.tags)
      ? {
          tags: Array.from(
            new Set(
              raw.tags
                .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                .map((t) => t.trim().replace(/^#+/, '')),
            ),
          ),
        }
      : {}),
    ...(Array.isArray(raw.history)
      ? {
          history: raw.history
            .filter((h): h is WatchHistoryEntry => Boolean(h) && typeof h.season === 'number' && typeof h.episode === 'number')
            .map((h) => ({
              id: h.id || `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              season: Math.max(0, Math.floor(h.season)),
              episode: Math.max(1, Math.floor(h.episode)),
              at: typeof h.at === 'number' ? h.at : Date.now(),
            })),
        }
      : {}),
    ...(raw.onlineAvailable && typeof raw.onlineAvailable === 'object'
      ? {
          onlineAvailable: {
            maxSeason: Math.max(0, Math.floor(Number(raw.onlineAvailable.maxSeason) || 1)),
            maxEpisode: Math.max(1, Math.floor(Number(raw.onlineAvailable.maxEpisode) || 1)),
            checkedAt: typeof raw.onlineAvailable.checkedAt === 'number' ? raw.onlineAvailable.checkedAt : Date.now(),
            hasNew: Boolean(raw.onlineAvailable.hasNew),
          },
        }
      : {}),
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
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, JSON.stringify(items))
      lastSaveOk = true
    } catch {
      lastSaveOk = false
    }
  } else {
    lastSaveOk = true
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
export function advance(
  item: SavedLinkItem,
): Pick<SavedLinkItem, 'seasons' | 'season' | 'episode' | 'status' | 'history'> {
  const seasons = item.episode ? watchedUpTo(item, item.season, item.episode) : seasonsOf(item)
  const settled = settle(item, seasons, item.season)
  const nextHistory: WatchHistoryEntry[] = [
    ...(item.history || []),
    ...(item.episode
      ? [
          {
            id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            season: item.season,
            episode: item.episode,
            at: Date.now(),
          },
        ]
      : []),
  ]
  return { ...settled, history: nextHistory }
}

/** „Staffel 2", „Filme", or the season's own name. */
export function seasonName(season: MerkSeason): string {
  if (season.title) return season.title
  return season.number === 0 ? 'Filme' : `Staffel ${season.number}`
}

/* -------------------------------------------------------------------------- */
/* Handing entries to the downloader                                           */
/* -------------------------------------------------------------------------- */

let pendingLookup: SavedLinkItem | null = null

export interface BatchLookupItem {
  url: string
  title: string
  season: number
  episode: number | null
}

let pendingBatchLookup: BatchLookupItem[] | null = null

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

let pendingOpen: string | null = null

/** Said when a series should open while the Merkliste is already showing. */
export const OPEN_SERIES_EVENT = 'sondra:merkliste-serie'

/**
 * Asks the Merkliste to open one series — from the player, from a notice of
 * a new episode. Taken when the tab next renders, or at once when it shows.
 */
export function requestOpenSeries(id: string): void {
  pendingOpen = id
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_SERIES_EVENT))
}

export function takePendingOpen(): string | null {
  const id = pendingOpen
  pendingOpen = null
  return id
}

/** Transfers multiple episode URLs to the downloader as a batch/queue. */
export function requestBatchLookup(batch: BatchLookupItem[]): void {
  pendingBatchLookup = batch
}

export function takePendingBatchLookup(): BatchLookupItem[] | null {
  const batch = pendingBatchLookup
  pendingBatchLookup = null
  return batch
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

/**
 * Imports anime list from MyAnimeList XML export format.
 */
export function importMalXml(xmlText: string): SavedLinkItem[] {
  const items: SavedLinkItem[] = []
  const animeBlocks = xmlText.match(/<anime>([\s\S]*?)<\/anime>/gi) || []
  for (const block of animeBlocks) {
    const titleMatch = block.match(/<series_title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/series_title>/i)
    if (!titleMatch) continue
    const title = titleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim()
    if (!title) continue

    const epCountMatch = block.match(/<series_episodes>(\d+)<\/series_episodes>/i)
    const episodes = epCountMatch && Number(epCountMatch[1]) > 0 ? Number(epCountMatch[1]) : null

    const watchedMatch = block.match(/<my_watched_episodes>(\d+)<\/my_watched_episodes>/i)
    const watchedCount = watchedMatch ? Number(watchedMatch[1]) : 0

    const scoreMatch = block.match(/<my_score>(\d+)<\/my_score>/i)
    const rawScore = scoreMatch ? Number(scoreMatch[1]) : 0
    const rating = rawScore > 0 ? Math.max(1, Math.min(5, Math.round(rawScore / 2))) : undefined

    const statusMatch = block.match(/<my_status>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/my_status>/i)
    const statusStr = (statusMatch ? statusMatch[1].trim().toLowerCase() : '')
    let status: SavedLinkStatus = 'watching'
    if (statusStr.includes('completed') || statusStr.includes('fertig')) status = 'done'
    else if (statusStr.includes('plan to watch') || statusStr.includes('on-hold') || statusStr.includes('später')) status = 'later'

    const watched = watchedCount > 0 ? Array.from({ length: watchedCount }, (_, i) => i + 1) : []
    const season: MerkSeason = {
      number: 1,
      episodes,
      watched: episodes !== null ? watched.filter((n) => n <= episodes) : watched,
    }

    const nextEp = episodes !== null && watchedCount >= episodes ? episodes : watchedCount + 1

    items.push(
      normalize({
        title,
        status,
        rating,
        season: 1,
        episode: nextEp,
        tags: ['MAL'],
        seasons: [season],
      }),
    )
  }
  return items
}

/**
 * Imports anime list from AniList JSON export format.
 */
export function importAniListJson(jsonText: string): SavedLinkItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  const entries: Record<string, unknown>[] = []
  if (Array.isArray(parsed)) {
    entries.push(...parsed.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object'))
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.entries)) {
      entries.push(...obj.entries.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object'))
    } else if (Array.isArray(obj.lists)) {
      for (const rawList of obj.lists) {
        if (rawList && typeof rawList === 'object') {
          const listObj = rawList as Record<string, unknown>
          if (Array.isArray(listObj.entries)) {
            entries.push(
              ...listObj.entries.filter((p: unknown): p is Record<string, unknown> => Boolean(p) && typeof p === 'object'),
            )
          }
        }
      }
    }
  }

  const items: SavedLinkItem[] = []
  for (const entry of entries) {
    const media = (entry.media && typeof entry.media === 'object' ? entry.media : entry) as Record<string, unknown>
    const titleObj = media.title as Record<string, unknown> | string | undefined
    const title =
      (typeof titleObj === 'object' && titleObj !== null
        ? String(titleObj.userPreferred || titleObj.english || titleObj.romaji || titleObj.native || '')
        : typeof media.title === 'string'
          ? media.title
          : '') || String(entry.title || '')
    if (!title.trim()) continue

    const episodes = typeof media.episodes === 'number' && media.episodes > 0 ? media.episodes : null
    const progress = typeof entry.progress === 'number' && entry.progress >= 0 ? entry.progress : 0

    const rawScore = typeof entry.score === 'number' ? entry.score : typeof entry.scoreRaw === 'number' ? (entry.scoreRaw as number) / 10 : 0
    const rating = rawScore > 0 ? Math.max(1, Math.min(5, Math.round(rawScore <= 5 ? rawScore : rawScore / 2))) : undefined

    const rawStatus = String(entry.status || '').toUpperCase()
    let status: SavedLinkStatus = 'watching'
    if (rawStatus === 'COMPLETED') status = 'done'
    else if (rawStatus === 'PLANNING' || rawStatus === 'PAUSED' || rawStatus === 'DROPPED') status = 'later'

    const coverImg = media.coverImage as Record<string, string> | undefined
    const cover = coverImg?.large || coverImg?.medium || undefined

    const watched = progress > 0 ? Array.from({ length: progress }, (_, i) => i + 1) : []
    const season: MerkSeason = {
      number: 1,
      episodes,
      watched: episodes !== null ? watched.filter((n) => n <= episodes) : watched,
    }
    const nextEp = episodes !== null && progress >= episodes ? episodes : progress + 1

    items.push(
      normalize({
        title: title.trim(),
        status,
        rating,
        cover,
        season: 1,
        episode: nextEp,
        tags: ['AniList'],
        seasons: [season],
      }),
    )
  }
  return items
}

/** Reads a file `exportMerkliste` wrote, or a MyAnimeList XML / AniList JSON file. */
export function readMerklisteFile(text: string): SavedLinkItem[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('<') && (trimmed.includes('<myanimelist') || trimmed.includes('<anime>'))) {
    const mal = importMalXml(trimmed)
    if (mal.length === 0) throw new Error('Die MyAnimeList-Exportdatei enthält keine Anime-Einträge.')
    return mal
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Die Datei ist keine Merkliste — sie lässt sich nicht als JSON lesen.')
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.lists) || (Array.isArray(obj.entries) && !Array.isArray(obj.items))) {
      const anilist = importAniListJson(text)
      if (anilist.length > 0) return anilist
    }
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

/** Collects all distinct tags across items in alphabetical order. */
export function allTags(list: SavedLinkItem[]): string[] {
  const set = new Set<string>()
  for (const item of list) {
    if (Array.isArray(item.tags)) {
      for (const t of item.tags) {
        if (t.trim()) set.add(t.trim())
      }
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
}

/** Returns all watch history entries across items sorted chronologically (newest first). */
export function allHistory(list: SavedLinkItem[]): { item: SavedLinkItem; entry: WatchHistoryEntry }[] {
  const result: { item: SavedLinkItem; entry: WatchHistoryEntry }[] = []
  for (const item of list) {
    if (Array.isArray(item.history)) {
      for (const entry of item.history) {
        result.push({ item, entry })
      }
    }
  }
  return result.sort((a, b) => b.entry.at - a.entry.at)
}

/** Reverts a previously watched episode recorded in the history. */
export function undoWatchHistory(itemId: string, historyEntryId: string): boolean {
  return setMerkItems((current) =>
    current.map((item) => {
      if (item.id !== itemId) return item
      const entry = item.history?.find((h) => h.id === historyEntryId)
      if (!entry) return item
      const remainingHistory = item.history?.filter((h) => h.id !== historyEntryId)
      const seasons = withSeason(item, entry.season, (season) => ({
        ...season,
        watched: season.watched.filter((n) => n !== entry.episode),
      }))
      const settled = settle(item, seasons, entry.season)
      return {
        ...item,
        ...settled,
        history: remainingHistory,
        updatedAt: Date.now(),
      }
    }),
  )
}

/**
 * Queries the local/backend resolver to check if AniWorld has published newer
 * seasons or episodes than currently tracked.
 */
export async function checkOnlineUpdates(item: SavedLinkItem): Promise<OnlineAvailableInfo | null> {
  if (!item.url || !isAniworldUrl(item.url)) return null
  try {
    const res = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url, checkUpdates: true }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      status?: string
      maxSeason?: number
      maxEpisode?: number
      seriesTitle?: string
    }
    if (data.status === 'updates' && typeof data.maxSeason === 'number' && typeof data.maxEpisode === 'number') {
      const hasNew =
        data.maxSeason > item.season ||
        (data.maxSeason === item.season && item.episode !== null && data.maxEpisode > item.episode)
      const info: OnlineAvailableInfo = {
        maxSeason: data.maxSeason,
        maxEpisode: data.maxEpisode,
        checkedAt: Date.now(),
        hasNew,
      }
      // Noted without counting as a change: a check is not something the
      // person did, and a newer time here would let this device's older
      // progress win over the copy in Anytype.
      setMerkItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, onlineAvailable: info } : entry)))
      return info
    }
  } catch {
    // Offline or server not running
  }
  return null
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
  // An entry changed after its removal is back on the list; its removal is
  // spent and need not travel any further.
  for (const item of items) if (removed[item.id] !== undefined) delete removed[item.id]
  return { items, removed }
}

/**
 * The copy kept elsewhere taken as this device's list — what „Aus Anytype
 * laden“ does: its entries replace these, with this device's pictures from
 * files put back where the same entry had one.
 */
export function takeShared(current: SavedLinkItem[], remote: { items: SavedLinkItem[] }): SavedLinkItem[] {
  return remote.items.map((item) => withLocalPictures(item, current.find((entry) => entry.id === item.id)))
}

/** Takes the merged removals as this device's own. */
export function adoptRemovals(next: Record<string, number>): void {
  removals = next
  persistRemovals()
}

/**
 * An entry put back on purpose — the removal undone, a file read in — counts
 * as changed now. Its removal is still noted on the page in Anytype, and
 * only a change after it keeps the next round from taking the entry off
 * again.
 */
const revived = (item: SavedLinkItem, now: number): SavedLinkItem =>
  removals[item.id] !== undefined && removals[item.id] >= item.updatedAt ? { ...item, updatedAt: now } : item

/** A removed entry back where it was. */
export function restoreMerkItem(item: SavedLinkItem, index: number): void {
  const back = revived(item, Date.now())
  noteRestored(item.id)
  setMerkItems((current) => {
    if (current.some((entry) => entry.id === item.id)) return current
    const next = [...current]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, back)
    return next
  })
}

/**
 * A file read in: its entries join the list (`mergeMerkliste`) and stay,
 * also those that were removed here before. Nothing changes when the device
 * cannot store the result.
 */
export function importMerkliste(incoming: SavedLinkItem[]): { result: MerkImport; before: SavedLinkItem[]; saved: boolean } {
  const before = items
  const result = mergeMerkliste(before, incoming)
  const now = Date.now()
  const known = new Set(before.map((item) => item.id))
  result.items = result.items.map((item) => (known.has(item.id) ? item : revived(item, now)))
  if (!setMerkItems(result.items)) {
    setMerkItems(before)
    return { result, before, saved: false }
  }
  for (const item of result.items) if (!known.has(item.id)) noteRestored(item.id)
  return { result, before, saved: true }
}

/**
 * A file read in taken back out, also from the page in Anytype: what it
 * added counts as removed, what it changed is put back as changed now —
 * otherwise the next round would bring the file's version back.
 */
export function revertImport(before: SavedLinkItem[]): void {
  const now = Date.now()
  const earlier = new Set(before.map((item) => item.id))
  for (const item of items) if (!earlier.has(item.id)) noteRemoved(item.id)
  const current = new Map(items.map((item) => [item.id, item]))
  setMerkItems(
    before.map((item) => {
      const later = current.get(item.id)
      return later && later.updatedAt !== item.updatedAt ? { ...item, updatedAt: Math.max(now, later.updatedAt + 1) } : item
    }),
  )
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


/** The duration of an episode in minutes, accounting for film duration and exceptions. */
export function durationOfEpisode(item: SavedLinkItem, seasonNumber: number, episodeNumber: number): number {
  const key = `${seasonNumber}:${episodeNumber}`
  if (item.durations && typeof item.durations[key] === 'number' && item.durations[key] > 0) {
    return Math.round(item.durations[key])
  }
  if (seasonNumber === 0) {
    return item.filmDuration ?? 90
  }
  return item.episodeDuration ?? 24
}

/** The total watched duration of a series in minutes, taking exceptions into account. */
export function itemWatchedMinutes(item: SavedLinkItem): number {
  let minutes = 0
  const seasons = seasonsOf(item)
  for (const season of seasons) {
    for (const ep of season.watched) {
      minutes += durationOfEpisode(item, season.number, ep)
    }
  }
  return minutes
}

/** The remaining duration of unseen episodes in known seasons of a series. */
export function itemRemainingMinutes(item: SavedLinkItem): { minutes: number; known: boolean; remainingCount: number } {
  let minutes = 0
  let allKnown = true
  let remainingCount = 0
  const seasons = seasonsOf(item)
  for (const season of seasons) {
    if (season.episodes === null) {
      allKnown = false
      continue
    }
    for (let ep = 1; ep <= season.episodes; ep++) {
      if (!season.watched.includes(ep)) {
        minutes += durationOfEpisode(item, season.number, ep)
        remainingCount += 1
      }
    }
  }
  return { minutes, known: allKnown, remainingCount }
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

  // Watch time calculated from each episode's duration and exceptions
  const watchMinutes = items.reduce((sum, item) => sum + itemWatchedMinutes(item), 0)
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


/* -------------------------------------------------------------------------- */
/* Sorting, Shuffle & Binge Planning                                          */
/* -------------------------------------------------------------------------- */

export type MerklisteSortOption = 'recent' | 'title' | 'rating' | 'progress' | 'episodes'

export const SORT_OPTIONS: { value: MerklisteSortOption; label: string }[] = [
  { value: 'recent', label: 'Zuletzt aktiv' },
  { value: 'title', label: 'Titel (A–Z)' },
  { value: 'rating', label: 'Beste Bewertung (★)' },
  { value: 'progress', label: 'Höchster Fortschritt (%)' },
  { value: 'episodes', label: 'Meiste Folgen' },
]

export function sortMerkItems(items: SavedLinkItem[], sortBy: MerklisteSortOption): SavedLinkItem[] {
  const copy = [...items]
  switch (sortBy) {
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'de', { sensitivity: 'base' }))
    case 'rating':
      return copy.sort(
        (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt),
      )
    case 'progress':
      return copy.sort((a, b) => {
        const fracA = itemProgress(a).fraction ?? (itemProgress(a).watched > 0 ? 0.01 : 0)
        const fracB = itemProgress(b).fraction ?? (itemProgress(b).watched > 0 ? 0.01 : 0)
        return fracB - fracA || (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt)
      })
    case 'episodes':
      return copy.sort((a, b) => {
        const totA = itemProgress(a).total ?? itemProgress(a).watched
        const totB = itemProgress(b).total ?? itemProgress(b).watched
        return totB - totA
      })
    case 'recent':
    default:
      return copy.sort((a, b) => (b.lastOpenedAt ?? b.updatedAt) - (a.lastOpenedAt ?? a.updatedAt))
  }
}

export function pickRandomCandidate(items: SavedLinkItem[], excludeId?: string): SavedLinkItem | null {
  const unfinished = items.filter((item) => {
    const seasons = seasonsOf(item)
    return !caughtUp(seasons)
  })
  const pool = unfinished.length > 0 ? unfinished : items
  if (pool.length === 0) return null
  const candidates = excludeId && pool.length > 1 ? pool.filter((item) => item.id !== excludeId) : pool
  const index = Math.floor(Math.random() * candidates.length)
  return candidates[index] ?? null
}

export interface BingePlan {
  episodesRemaining: number
  watchTime: { short: string; long: string }
  finishAt1PerDay: string
  finishAt2PerDay: string
  finishAt3PerDay: string
}

export function calculateBingePlan(
  episodesRemaining: number,
  minutesPerEpisode: number = 24,
  exactMinutes?: number,
): BingePlan {
  const count = Math.max(0, episodesRemaining)
  const totalMinutes = typeof exactMinutes === 'number' && exactMinutes > 0 ? exactMinutes : count * minutesPerEpisode
  const watchTime = formatWatchMinutes(totalMinutes)
  const formatDate = (daysAhead: number) => {
    const d = new Date()
    d.setDate(d.getDate() + daysAhead)
    return d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  return {
    episodesRemaining: count,
    watchTime,
    finishAt1PerDay: formatDate(count),
    finishAt2PerDay: formatDate(Math.ceil(count / 2)),
    finishAt3PerDay: formatDate(Math.ceil(count / 3)),
  }
}
