/**
 * Files that are the same file twice — downloaded again, copied into a
 * second folder, saved as „Film (1).mp4“.
 *
 * Only files of exactly the same size can be the same, so most are never
 * read. Of those that remain, files up to 32 MB are compared whole (SHA-256
 * over every byte); larger ones at 32 places spread over the file, 64 KB
 * each — two different films of the very same size do not agree at 32
 * places. The page says which of the two a group was found by.
 *
 * Of each group one is kept: a name without a copy mark („(1)“, „Kopie“,
 * „copy“) before one with, then the oldest — the original, most likely.
 * The rest are what „Doppelte auswählen“ selects.
 */

import type { FolderFile } from './folder'

/** Up to this, the whole file is compared. */
export const WHOLE_LIMIT = 32 * 1024 * 1024
const SAMPLES = 32
const SAMPLE = 64 * 1024

export interface DuplicateGroup {
  size: number
  /** The one to keep first, then the copies. */
  files: FolderFile[]
  /** Compared byte for byte, rather than at 32 places. */
  whole: boolean
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  /** Files read to find them. */
  read: number
  /** Bytes the copies take up. */
  spare: number
}

async function hex(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What a file is compared by: all of it, or 32 slices of it. */
export async function contentKey(file: Blob): Promise<string> {
  if (file.size <= WHOLE_LIMIT) return `g:${await hex(await file.arrayBuffer())}`
  const parts: BlobPart[] = []
  for (let index = 0; index < SAMPLES; index += 1) {
    const start = Math.floor(((file.size - SAMPLE) * index) / (SAMPLES - 1))
    parts.push(file.slice(start, start + SAMPLE))
  }
  return `s:${await hex(await new Blob(parts).arrayBuffer())}`
}

/** „Film (1).mp4“, „Film - Kopie.mp4“, „Film copy 2.mp4“: a copy by its name. */
export function looksLikeCopy(name: string): boolean {
  const stem = name.replace(/\.[^.]+$/, '')
  return /(\(\d+\)|[ _-](kopie|copy|duplikat)( \(?\d+\)?)?)$/i.test(stem.trim())
}

/** The order within a group: the one to keep first. */
export function keepFirst(files: FolderFile[]): FolderFile[] {
  return [...files].sort(
    (a, b) => Number(looksLikeCopy(a.name)) - Number(looksLikeCopy(b.name)) || a.modified - b.modified || a.path.length - b.path.length || a.path.localeCompare(b.path),
  )
}

export async function findDuplicates(
  files: FolderFile[],
  { onProgress, signal, key = (file) => (file.file ? contentKey(file.file) : Promise.resolve(`fern:${file.path}`)) }: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; key?: (file: FolderFile) => Promise<string> } = {},
): Promise<DuplicateReport> {
  const bySize = new Map<number, FolderFile[]>()
  for (const file of files) {
    if (file.size === 0) continue
    const group = bySize.get(file.size)
    if (group) group.push(file)
    else bySize.set(file.size, [file])
  }
  const candidates = [...bySize.values()].filter((group) => group.length > 1)
  const total = candidates.reduce((sum, group) => sum + group.length, 0)
  let done = 0
  const groups: DuplicateGroup[] = []
  for (const group of candidates) {
    const byContent = new Map<string, FolderFile[]>()
    for (const file of group) {
      if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
      let id: string
      try {
        id = await key(file)
      } catch {
        // Unreadable now: not called a copy of anything.
        id = `x:${file.path}`
      }
      const same = byContent.get(id)
      if (same) same.push(file)
      else byContent.set(id, [file])
      done += 1
      onProgress?.(done, total)
    }
    for (const [id, same] of byContent) {
      if (same.length > 1) groups.push({ size: group[0].size, files: keepFirst(same), whole: id.startsWith('g:') })
    }
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1))
  return { groups, read: total, spare: groups.reduce((sum, group) => sum + group.size * (group.files.length - 1), 0) }
}

/** Every copy, without the one kept of each group. */
export function copiesOf(report: DuplicateReport): FolderFile[] {
  return report.groups.flatMap((group) => group.files.slice(1))
}
