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
  notes?: string
  /** 0–5; 0 is unrated. */
  rating?: number
}

const KEY = 'sondra:saved_links'
const PROJECT_KEY = 'merkliste'

const uniqueSorted = (numbers: number[]) =>
  Array.from(new Set(numbers.filter((n) => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b)

function normalize(raw: Partial<SavedLinkItem>): SavedLinkItem {
  const info = parseLinkEpisodeInfo(raw.url || '')
  const season = typeof raw.season === 'number' ? raw.season : info.season
  const episode = raw.episode === null || typeof raw.episode === 'number' ? raw.episode : (info.episode ?? 1)
  const seasons = Array.isArray(raw.seasons)
    ? raw.seasons
        .filter((s): s is MerkSeason => Boolean(s) && typeof s.number === 'number')
        .map((s) => ({
          number: Math.max(0, Math.floor(s.number)),
          episodes: typeof s.episodes === 'number' && s.episodes > 0 ? Math.floor(s.episodes) : null,
          watched: uniqueSorted(Array.isArray(s.watched) ? s.watched : []),
          ...(s.title ? { title: String(s.title) } : {}),
          ...(s.cover ? { cover: String(s.cover) } : {}),
        }))
    : undefined
  return {
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
    ...(raw.notes ? { notes: raw.notes } : {}),
    ...(typeof raw.rating === 'number' ? { rating: Math.max(0, Math.min(5, Math.round(raw.rating))) } : {}),
  }
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
  /** The first episode not yet seen. */
  next: number
  /** Every episode is seen (only when the total is known). */
  complete: boolean
}

export function seasonProgress(season: MerkSeason): SeasonProgress {
  const watched = season.watched.length
  const total = season.episodes
  let next = 1
  while (season.watched.includes(next)) next += 1
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
  const watched = seasons.reduce((sum, season) => sum + season.watched.length, 0)
  const known = seasons.every((season) => season.episodes !== null)
  const total = known ? seasons.reduce((sum, season) => sum + (season.episodes ?? 0), 0) : null
  // With one season's size still open, the bar measures the ones that are
  // known instead of staying empty.
  const sized = seasons.filter((season) => season.episodes !== null)
  const sizedTotal = sized.reduce((sum, season) => sum + (season.episodes ?? 0), 0)
  const sizedWatched = sized.reduce((sum, season) => sum + Math.min(season.watched.length, season.episodes ?? 0), 0)
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
    if (changed) next.push({ ...changed, watched: uniqueSorted(changed.watched) })
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

/**
 * „Weiter": the current episode counts as seen and the position moves to the
 * next one — into the next season when this one is known to be over.
 */
export function advance(item: SavedLinkItem): Pick<SavedLinkItem, 'seasons' | 'season' | 'episode'> {
  const current = item.episode ?? 0
  let seasons = item.episode ? watchedUpTo(item, item.season, item.episode) : seasonsOf(item)
  const thisSeason = seasons.find((season) => season.number === item.season)
  const total = thisSeason?.episodes ?? null
  if (total !== null && current >= total && item.season > 0) {
    const following = item.season + 1
    if (!seasons.some((season) => season.number === following)) {
      seasons = [...seasons, { number: following, episodes: null, watched: [] }]
    }
    return { seasons, season: following, episode: 1 }
  }
  return { seasons, season: item.season, episode: current + 1 }
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

/**
 * A picked image, made small enough to live in the list: at most 480 px
 * wide, as JPEG. A phone photo straight in would fill the space the browser
 * gives the whole site after two or three covers.
 */
export async function coverFromFile(file: File, maxWidth = 480): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxWidth / bitmap.width)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Das Bild liess sich nicht verkleinern.')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}
