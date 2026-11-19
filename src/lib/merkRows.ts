/**
 * The words on one line of the Merkliste: where a series stands and what is left of it. Pure — no
 * React, no storage — so the native client can be held to the same sentences.
 */

import { parseLinkEpisodeInfo } from './download'
import { caughtUp, itemProgress, itemRemainingMinutes, seasonsOf, type SavedLinkItem, type SavedLinkStatus } from './merkliste'
import { lengthLabel } from './watchPlan'

export const statusOf = (item: SavedLinkItem): SavedLinkStatus => item.status ?? 'watching'

/**
 * What kind of numbering an address carries: seasons and episodes
 * (`series`), a place in a playlist (`list`), or none — a single video, where
 * season and episode controls would do nothing.
 */
export function episodeKindOf(url: string): 'series' | 'list' | null {
  if (!url.trim()) return null
  if (!parseLinkEpisodeInfo(url).isEpisodicUrl) return null
  const seasonal = /staffel|season|filme?(?:\/|-|$)|\/s\d{1,2}e\d{1,3}/i.test(url)
  return /[?&](?:list|index)=/i.test(url) && !seasonal ? 'list' : 'series'
}

/** Where an entry stands, in words: „Staffel 2, Folge 8", „Film 3", „Staffel 1, alle Folgen". */
export function positionLabel(season: number, episode: number | null, kind: 'series' | 'list' = 'series'): string {
  if (kind === 'list') return episode ? `Nr. ${episode}` : 'ganze Liste'
  if (season === 0) return episode ? `Film ${episode}` : 'Alle Filme'
  return episode ? `Staffel ${season}, Folge ${episode}` : `Staffel ${season}, alle Folgen`
}

/** Where a series stands, as a line of the list. */
export function standLabel(item: SavedLinkItem): string {
  const status = statusOf(item)
  const seasons = seasonsOf(item)
  const kind = episodeKindOf(item.url) ?? 'series'
  if (caughtUp(seasons)) return 'Alles gesehen'
  if (status === 'done') return `${itemProgress(item).watched} gesehen`
  if (status === 'later' && itemProgress(item).watched === 0) return 'Nicht angefangen'
  return positionLabel(item.season, item.episode, kind)
}

/** „noch 6 · 2 Std. 15 Min.“: what is left of a series, in episodes and time. */
export function leftLabel(item: SavedLinkItem): string | null {
  const left = itemRemainingMinutes(item)
  if (!left.remainingCount) return null
  return `noch ${left.remainingCount} · ${lengthLabel(left.minutes)}${left.known ? '' : ' +'}`
}
