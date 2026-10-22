/**
 * A folder of one's own, as Sondra sees it: every file in it read once,
 * then shown, sorted, filtered and selected without touching the disk again.
 *
 * Two ways in. Edge, Chrome and the app hand over the folder itself (File
 * System Access): it can be opened again next time with one click, and a
 * file in it can be deleted after asking. Firefox and Safari only take a
 * folder through the file picker, read once; the page says what that means.
 * Nothing is read beyond names, sizes and dates until a file is looked at,
 * and nothing leaves the device.
 *
 * The listing, sorting and selecting are plain functions, so
 * `scripts/verify-folder.mts` checks them under Node.
 */

import { kindFromMime, type AssetKind } from '../state/store'
import { alreadySeen, matchEpisode } from './episodeMatch'
import { seasonsOf, type SavedLinkItem } from './merkliste'

/* -------------------------------------------------------------------------- */
/* What the folder API offers, typed as far as it is used                      */
/* -------------------------------------------------------------------------- */

export interface FileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
}
export interface DirectoryHandle {
  kind: 'directory'
  name: string
  values(): AsyncIterable<FileHandle | DirectoryHandle>
  getDirectoryHandle(name: string): Promise<DirectoryHandle>
  removeEntry(name: string): Promise<void>
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

type PickerWindow = Window & { showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandle> }

/** Edge, Chrome and the app: the folder itself, to open again and to delete in. */
export const canPickFolder = typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function'

/* -------------------------------------------------------------------------- */
/* The scan                                                                   */
/* -------------------------------------------------------------------------- */

export interface FolderFile {
  /** Inside the chosen folder, with `/`: „Staffel 1/Frieren S01E01.mkv“. */
  path: string
  name: string
  /** The folder it is in, relative; '' for the top. */
  dir: string
  size: number
  modified: number
  kind: AssetKind
  file: File
  /** The folder holding it, where it can be deleted from; only with the folder API. */
  parent?: DirectoryHandle
}

export interface FolderScan {
  name: string
  files: FolderFile[]
  /** Every folder inside, relative, '' included. */
  dirs: string[]
  /** The folder itself, when the browser handed it over. */
  handle?: DirectoryHandle
  /** Stopped at `SCAN_LIMIT` files. */
  truncated: boolean
}

/** More than this, and the folder is rather a drive: the scan stops and says so. */
export const SCAN_LIMIT = 20_000

/** Hidden files and the ones systems leave behind are not anybody's media. */
const SKIPPED = /^(\.|desktop\.ini$|thumbs\.db$|\$recycle\.bin$|system volume information$)/i

function entry(file: File, path: string, parent?: DirectoryHandle): FolderFile {
  const at = path.lastIndexOf('/')
  return {
    path,
    name: file.name,
    dir: at >= 0 ? path.slice(0, at) : '',
    size: file.size,
    modified: file.lastModified,
    kind: kindFromMime(file.type, file.name),
    file,
    parent,
  }
}

/** Every file in a folder handed over by the browser, its subfolders included. */
export async function scanHandle(
  root: DirectoryHandle,
  { onProgress, signal }: { onProgress?: (files: number) => void; signal?: AbortSignal } = {},
): Promise<FolderScan> {
  const files: FolderFile[] = []
  const dirs: string[] = ['']
  let truncated = false
  const walk = async (dir: DirectoryHandle, prefix: string) => {
    for await (const child of dir.values()) {
      if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      if (files.length >= SCAN_LIMIT) {
        truncated = true
        return
      }
      if (SKIPPED.test(child.name)) continue
      const path = prefix ? `${prefix}/${child.name}` : child.name
      if (child.kind === 'directory') {
        dirs.push(path)
        await walk(child, path)
      } else {
        try {
          files.push(entry(await child.getFile(), path, dir))
        } catch {
          // Locked or gone since the listing: not shown.
        }
        if (files.length % 200 === 0) onProgress?.(files.length)
      }
    }
  }
  await walk(root, '')
  onProgress?.(files.length)
  return { name: root.name, files, dirs, handle: root, truncated }
}

/** A folder from the file picker (`webkitdirectory`): each file knows its path below the folder. */
export function scanFileList(list: ArrayLike<File>): FolderScan {
  const all = Array.from(list)
  const first = (all[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ?? ''
  const name = first.split('/')[0] || 'Ordner'
  const files: FolderFile[] = []
  const dirs = new Set<string>([''])
  for (const file of all.slice(0, SCAN_LIMIT)) {
    const relative = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name
    if (relative.split('/').some((part) => SKIPPED.test(part))) continue
    const item = entry(file, relative)
    files.push(item)
    // Every folder on the way, so empty-looking middles can still be walked through.
    let dir = item.dir
    while (dir) {
      dirs.add(dir)
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    }
  }
  return { name, files, dirs: [...dirs].sort(), truncated: all.length > SCAN_LIMIT }
}

/** The scan without some files — after they were deleted. */
export function withoutFiles(scan: FolderScan, paths: Set<string>): FolderScan {
  return { ...scan, files: scan.files.filter((file) => !paths.has(file.path)) }
}

/* -------------------------------------------------------------------------- */
/* What is shown                                                              */
/* -------------------------------------------------------------------------- */

export type SortKey = 'name' | 'modified' | 'size' | 'kind'
export type KindFilter = 'alle' | 'video' | 'audio' | 'image' | 'andere'

export interface ListingOptions {
  /** The folder being looked at; '' for the top. */
  dir: string
  /** All files below it, not only those directly in it. */
  deep: boolean
  filter: KindFilter
  query: string
  sort: SortKey
  descending: boolean
}

export interface DirSummary {
  path: string
  name: string
  /** Files in it and below. */
  count: number
  size: number
}

export interface Listing {
  dirs: DirSummary[]
  files: FolderFile[]
  /** Per kind, of the files in view before the kind filter, for the filter's labels. */
  counts: Record<KindFilter, number>
}

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' })
/** Lower case, no accents: „Café“ is found by „cafe“. */
const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const KIND_ORDER: Record<AssetKind, number> = { video: 0, audio: 1, image: 2, document: 3, archive: 4, unknown: 5 }

export function kindMatches(kind: AssetKind, filter: KindFilter): boolean {
  if (filter === 'alle') return true
  if (filter === 'andere') return kind !== 'video' && kind !== 'audio' && kind !== 'image'
  return kind === filter
}

export function sortFiles(files: FolderFile[], sort: SortKey, descending: boolean): FolderFile[] {
  const by: Record<SortKey, (a: FolderFile, b: FolderFile) => number> = {
    name: (a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path),
    modified: (a, b) => a.modified - b.modified || collator.compare(a.name, b.name),
    size: (a, b) => a.size - b.size || collator.compare(a.name, b.name),
    kind: (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.name, b.name),
  }
  const sorted = [...files].sort(by[sort])
  return descending ? sorted.reverse() : sorted
}

const inside = (dir: string, path: string) => (dir === '' ? true : path === dir || path.startsWith(`${dir}/`))

/** What one folder of the scan shows: its subfolders, then its files, filtered and sorted. */
export function listing(scan: FolderScan, options: ListingOptions): Listing {
  const query = plain(options.query.trim())
  const searched = scan.files.filter((file) => {
    if (options.deep || query ? !inside(options.dir, file.dir) : file.dir !== options.dir) return false
    return !query || plain(file.name).includes(query)
  })
  const counts: Record<KindFilter, number> = { alle: searched.length, video: 0, audio: 0, image: 0, andere: 0 }
  for (const file of searched) {
    if (file.kind === 'video' || file.kind === 'audio' || file.kind === 'image') counts[file.kind] += 1
    else counts.andere += 1
  }
  const files = sortFiles(
    searched.filter((file) => kindMatches(file.kind, options.filter)),
    options.sort,
    options.descending,
  )

  // Subfolders only when browsing one level at a time.
  const dirs: DirSummary[] = []
  if (!options.deep && !query) {
    const depth = options.dir === '' ? 0 : options.dir.split('/').length
    for (const path of scan.dirs) {
      if (!path || !inside(options.dir, path) || path.split('/').length !== depth + 1) continue
      let count = 0
      let size = 0
      for (const file of scan.files) {
        if (inside(path, file.dir)) {
          count += 1
          size += file.size
        }
      }
      dirs.push({ path, name: path.slice(path.lastIndexOf('/') + 1), count, size })
    }
    dirs.sort((a, b) => collator.compare(a.name, b.name))
  }
  return { dirs, files, counts }
}

/** „Anime / Frieren / Staffel 1“ as steps to click back through. */
export function crumbs(scanName: string, dir: string): { label: string; path: string }[] {
  const steps = [{ label: scanName, path: '' }]
  if (!dir) return steps
  const parts = dir.split('/')
  parts.forEach((part, index) => steps.push({ label: part, path: parts.slice(0, index + 1).join('/') }))
  return steps
}

/* -------------------------------------------------------------------------- */
/* Selecting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The selection after a click: alone, added or taken away (Ctrl/Cmd), or
 * the run from the last click to this one in the order shown (Shift) —
 * the way every file manager does it.
 */
export function clickSelect(
  selected: ReadonlySet<string>,
  order: readonly string[],
  anchor: string | null,
  path: string,
  { toggle, range }: { toggle: boolean; range: boolean },
): { selected: Set<string>; anchor: string } {
  if (range && anchor !== null && order.includes(anchor)) {
    const from = order.indexOf(anchor)
    const to = order.indexOf(path)
    const run = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    const next = toggle ? new Set(selected) : new Set<string>()
    for (const item of run) next.add(item)
    return { selected: next, anchor }
  }
  if (toggle) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return { selected: next, anchor: path }
  }
  return { selected: new Set([path]), anchor: path }
}

/* -------------------------------------------------------------------------- */
/* Episodes of the Merkliste in the folder                                    */
/* -------------------------------------------------------------------------- */

export interface FolderEpisode {
  file: FolderFile
  season: number
  episode: number
  seen: boolean
}

export interface FolderSeries {
  item: SavedLinkItem
  episodes: FolderEpisode[]
  /** The episode to watch next, when it is in the folder. */
  next: FolderEpisode | null
  /** What comes after it in the folder, in order: the queue for the player. */
  queue: FolderEpisode[]
}

/** The file each episode belongs to, for the badges on the tiles. */
export function episodeOf(file: FolderFile, items: SavedLinkItem[]): FolderEpisode | null {
  if (file.kind !== 'video' && file.kind !== 'audio') return null
  const match = matchEpisode(file.name, items)
  return match ? { file, season: match.season, episode: match.episode, seen: alreadySeen(match) } : null
}

/**
 * Series of the Merkliste that have episodes in the folder, with the next
 * one to watch: where the list stands, else the first unseen one after the
 * last seen, else the first unseen at all. Finished and unmatched files
 * play no part; a series with nothing left unseen here is left out.
 */
export function folderSeries(files: FolderFile[], items: SavedLinkItem[]): FolderSeries[] {
  const bySeries = new Map<string, { item: SavedLinkItem; episodes: Map<string, FolderEpisode> }>()
  for (const file of files) {
    const found = episodeOf(file, items)
    if (!found) continue
    const match = matchEpisode(file.name, items)!
    const group = bySeries.get(match.item.id) ?? { item: match.item, episodes: new Map() }
    // The same episode twice (two qualities): the larger file.
    const key = `${found.season}:${found.episode}`
    const before = group.episodes.get(key)
    if (!before || before.file.size < file.size) group.episodes.set(key, found)
    bySeries.set(match.item.id, group)
  }
  const result: FolderSeries[] = []
  for (const { item, episodes } of bySeries.values()) {
    const list = [...episodes.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
    const unseen = list.filter((entry) => !entry.seen)
    if (unseen.length === 0) continue
    const stand = item.season !== null && item.episode !== null ? list.find((entry) => entry.season === item.season && entry.episode === item.episode && !entry.seen) : undefined
    const lastSeen = [...list].reverse().find((entry) => entry.seen)
    const next =
      stand ??
      (lastSeen ? unseen.find((entry) => entry.season > lastSeen.season || (entry.season === lastSeen.season && entry.episode > lastSeen.episode)) : undefined) ??
      unseen[0]
    const at = list.indexOf(next)
    result.push({ item, episodes: list, next, queue: list.slice(at).filter((entry) => !entry.seen) })
  }
  // The series being watched first, then by title.
  return result.sort((a, b) => Number(b.item.status === 'watching') - Number(a.item.status === 'watching') || collator.compare(a.item.title, b.item.title))
}

/** The seasons a series is known to have, for „Staffel 1 · Folge 4 von 12“. */
export function episodesInSeason(item: SavedLinkItem, season: number): number | null {
  return seasonsOf(item).find((entry) => entry.number === season)?.episodes ?? null
}

/* -------------------------------------------------------------------------- */
/* The folder kept for next time                                              */
/* -------------------------------------------------------------------------- */

const DB = 'sondra-ordner'
const STORE = 'ordner'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Keeps the folder (the handle, not its files) to offer it again; IndexedDB stores handles as they are. */
export async function rememberFolder(handle: DirectoryHandle | null): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      if (handle) transaction.objectStore(STORE).put(handle, 'zuletzt')
      else transaction.objectStore(STORE).delete('zuletzt')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Private window or storage blocked: the folder is asked for next time.
  }
}

export async function rememberedFolder(): Promise<DirectoryHandle | null> {
  try {
    const db = await openDb()
    const handle = await new Promise<DirectoryHandle | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('zuletzt')
      request.onsuccess = () => resolve((request.result as DirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return handle
  } catch {
    return null
  }
}

/**
 * Leave to read (or to change) the folder. Asking needs a click — a folder
 * kept from last time is only offered with a button, never opened by itself.
 */
export async function allowed(handle: DirectoryHandle, mode: 'read' | 'readwrite', ask: boolean): Promise<boolean> {
  try {
    if (!handle.queryPermission) return true
    if ((await handle.queryPermission({ mode })) === 'granted') return true
    if (!ask || !handle.requestPermission) return false
    return (await handle.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}

export async function pickFolder(): Promise<DirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker
  if (!picker) return null
  try {
    return await picker({ id: 'sondra-ordner', mode: 'read' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/** Deletes files from disk; what could not be deleted is said, the rest is gone. */
export async function deleteFiles(files: FolderFile[]): Promise<{ deleted: FolderFile[]; failed: { file: FolderFile; reason: string }[] }> {
  const deleted: FolderFile[] = []
  const failed: { file: FolderFile; reason: string }[] = []
  for (const file of files) {
    if (!file.parent) {
      failed.push({ file, reason: 'In diesem Browser kann Sondra im Ordner nichts löschen.' })
      continue
    }
    try {
      await file.parent.removeEntry(file.name)
      deleted.push(file)
    } catch (error) {
      failed.push({ file, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { deleted, failed }
}
