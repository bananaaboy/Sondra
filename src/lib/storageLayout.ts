/**
 * Where a downloaded episode lies below the target folder — the same layout
 * for a folder on this computer or a NAS and for a WebDAV folder.
 *
 * Two schemes. „Sondra“ is the one Drive uses (`Serie / Staffel 1 / …`, films
 * in „Filme“). „Jellyfin & Plex“ is what those media servers scan for
 * (`Serie / Season 01 / …`, films in „Specials“), so a folder on a NAS can be
 * handed to them as it is.
 */

import { seasonFolderName, seriesFolderName } from './folder'

export type FolderScheme = 'sondra' | 'jellyfin'

export const FOLDER_SCHEMES: { id: FolderScheme; label: string; example: string }[] = [
  { id: 'sondra', label: 'Sondra', example: 'Serie / Staffel 1 / …' },
  { id: 'jellyfin', label: 'Jellyfin & Plex', example: 'Serie / Season 01 / …' },
]

/** A season's folder under the series' folder. */
export function seasonDirName(season: number, scheme: FolderScheme): string {
  if (scheme === 'jellyfin') return season === 0 ? 'Specials' : `Season ${String(season).padStart(2, '0')}`
  return seasonFolderName(season)
}

/**
 * The folders below the target for one download, as a slash path — or `''`
 * for a download that belongs to no series (it lies in the target itself).
 */
export function episodeFolder(title: string | null | undefined, season: number | null | undefined, scheme: FolderScheme): string {
  const name = title?.trim()
  if (!name) return ''
  const series = seriesFolderName(name)
  return typeof season === 'number' && Number.isInteger(season) && season >= 0 ? `${series}/${seasonDirName(season, scheme)}` : series
}
