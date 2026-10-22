/**
 * The folder, once read, for every part of the page: the „Ordner“ tab shows
 * it, and the Merkliste plays from it — „Folge 5 abspielen“ beside „Folge 5
 * laden“ when the file is already on this computer, and the episodes of a
 * season marked that lie in it.
 *
 * Read once per visit, by a click — or by itself when the Merkliste opens
 * and the browser still allows the folder kept from last time (the app, or
 * Chrome's „bei jedem Besuch erlauben“). Only names, sizes and dates are
 * read for that; the files themselves when one is played.
 */

import { useMemo } from 'react'
import { create } from 'zustand'

import { allowed, folderEpisodes, playQueue, rememberFolder, rememberedFolder, scanFileList, scanHandle, type DirectoryHandle, type FolderEpisode, type FolderFile, type FolderScan } from './folder'
import { useMerkliste, type SavedLinkItem } from './merkliste'
import { sendToPlayer } from './player'
import { clearThumbnails } from './thumbnails'
import { useSession } from '../state/store'

export interface FolderState {
  scan: FolderScan | null
  /** The folder being looked at on the page; '' for the top. */
  dir: string
  selected: Set<string>
  anchor: string | null
  /** Files read so far while a folder is being read. */
  scanning: { files: number } | null
  /** The folder kept from last time, once looked up. */
  remembered: DirectoryHandle | null
}

export const useFolder = create<FolderState>(() => ({ scan: null, dir: '', selected: new Set(), anchor: null, scanning: null, remembered: null }))

let abort: AbortController | null = null

/** Reads a folder handed over by the browser and keeps it for next time. */
export async function readFolder(handle: DirectoryHandle): Promise<FolderScan | null> {
  abort?.abort()
  const controller = new AbortController()
  abort = controller
  useFolder.setState({ scanning: { files: 0 } })
  try {
    const scan = await scanHandle(handle, { signal: controller.signal, onProgress: (files) => useFolder.setState({ scanning: { files } }) })
    clearThumbnails()
    useFolder.setState({ scan, dir: '', selected: new Set(), anchor: null, remembered: handle })
    void rememberFolder(handle)
    useSession.getState().log('ordner', `${scan.name}: ${scan.files.length} Dateien gelesen${scan.truncated ? ' (gekürzt)' : ''}`)
    return scan
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  } finally {
    if (abort === controller) {
      abort = null
      useFolder.setState({ scanning: null })
    }
  }
}

export function stopReading(): void {
  abort?.abort()
}

/** A folder from the file picker (Firefox, Safari): read once, not kept. */
export function takeFileList(list: ArrayLike<File>): FolderScan {
  const scan = scanFileList(list)
  clearThumbnails()
  useFolder.setState({ scan, dir: '', selected: new Set(), anchor: null })
  useSession.getState().log('ordner', `${scan.name}: ${scan.files.length} Dateien gelesen`)
  return scan
}

/** Looks up the folder kept from last time, once. */
export async function lookUpRemembered(): Promise<DirectoryHandle | null> {
  const known = useFolder.getState().remembered
  if (known) return known
  const handle = await rememberedFolder()
  if (handle) useFolder.setState({ remembered: handle })
  return handle
}

/**
 * The folder kept from last time, read again. With `ask` (a click) the
 * browser may ask for leave; without it, only when leave is still there.
 */
export async function includeRemembered(ask: boolean): Promise<'read' | 'needs-click' | 'none'> {
  const handle = await lookUpRemembered()
  if (!handle) return 'none'
  if (!(await allowed(handle, 'read', ask))) return 'needs-click'
  return (await readFolder(handle)) ? 'read' : 'none'
}

/** Episodes into the player — the first plays, the rest wait behind it. */
export function playFiles(files: FolderFile[], replace = true): void {
  const playable = files.filter((file) => file.kind === 'video' || file.kind === 'audio')
  if (playable.length === 0) return
  sendToPlayer(
    playable.map((file) => file.file),
    replace,
  )
  useSession.getState().setPanel('player')
}

/** Plays an episode of a series from the folder, with its unseen followers. */
export function playEpisode(episodes: FolderEpisode[], season: number, episode: number): boolean {
  const queue = playQueue(episodes, season, episode)
  if (queue.length === 0) return false
  playFiles(queue.map((entry) => entry.file))
  return true
}

/* -------------------------------------------------------------------------- */
/* The Merkliste's view of it                                                 */
/* -------------------------------------------------------------------------- */

const EMPTY: FolderEpisode[] = []
let cached: { scan: FolderScan | null; items: SavedLinkItem[]; map: Map<string, FolderEpisode[]> } | null = null

/** Every series' episodes in the folder, matched once per folder and list. */
function episodesBySeries(scan: FolderScan | null, items: SavedLinkItem[]): Map<string, FolderEpisode[]> {
  if (cached && cached.scan === scan && cached.items === items) return cached.map
  const map = scan ? folderEpisodes(scan.files, items) : new Map<string, FolderEpisode[]>()
  cached = { scan, items, map }
  return map
}

/** The episodes of one series that lie in the folder, in order; empty without a folder. */
export function useEpisodesInFolder(seriesId: string): FolderEpisode[] {
  const scan = useFolder((state) => state.scan)
  const items = useMerkliste()
  return useMemo(() => episodesBySeries(scan, items).get(seriesId) ?? EMPTY, [scan, items, seriesId])
}

/** How many series of the list have episodes in the folder. */
export function useSeriesInFolderCount(): number {
  const scan = useFolder((state) => state.scan)
  const items = useMerkliste()
  return useMemo(() => episodesBySeries(scan, items).size, [scan, items])
}
