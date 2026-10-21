/**
 * Which Merkliste episode a played file is — read from its name.
 *
 * „Frieren S01E13.mkv“, „Frieren.1x13.1080p.mkv“, „[Gruppe] Frieren - 13
 * (1080p).mkv“, „Frieren Staffel 1 Folge 13.mp4“: the series is the part
 * before the numbers, matched against the titles on the list; the season is
 * taken from the name where it says one, else from the entry. Played to
 * 90 %, the player ticks that one episode off (`seenEpisode`), never others
 * and never off again.
 */

import { seasonsOf, settle, type MerkSeason, type SavedLinkItem, type WatchHistoryEntry } from './merkliste'

export interface EpisodeGuess {
  /** The name before the numbers, tidied. */
  title: string
  /** Null where the name gives none — anime counts episodes straight through. */
  season: number | null
  episode: number
}

export interface EpisodeMatch {
  item: SavedLinkItem
  season: number
  episode: number
}

/** How far into a file counts as seen. */
export const SEEN_AT = 0.9

const tidy = (text: string) =>
  text
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–—:·|]+$/g, '')
    .replace(/^[\s\-–—:·|]+/g, '')
    .trim()

/** Lowercase letters and digits only, accents dropped — for comparing names. */
export function normalTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Series, season and episode from a file name, or null when it names none. */
export function guessEpisode(fileName: string): EpisodeGuess | null {
  // The extension, release groups in brackets, and what follows the numbers
  // (resolution, codec) say nothing about the series.
  const stem = fileName.replace(/\.[a-z0-9]{2,5}$/i, '')
  const plain = stem
    .replace(/^\s*(\[[^\]]*\]\s*)+/, '')
    .replace(/\[[^\]]*\]|\((?:[^)]*\b(?:\d{3,4}p|x26[45]|hevc|web|bluray|dub|sub)\b[^)]*)\)/gi, ' ')
    .replace(/[._]+/g, ' ')

  const patterns: [RegExp, (m: RegExpExecArray) => { season: number | null; episode: number }][] = [
    [/\bS(\d{1,2})\s?E(\d{1,4})\b/i, (m) => ({ season: Number(m[1]), episode: Number(m[2]) })],
    [/\b(\d{1,2})x(\d{1,3})\b/i, (m) => ({ season: Number(m[1]), episode: Number(m[2]) })],
    [/\bStaffel\s*(\d{1,2})\D{0,8}?(?:Folge|Episode|Ep)\s*(\d{1,4})\b/i, (m) => ({ season: Number(m[1]), episode: Number(m[2]) })],
    [/\bSeason\s*(\d{1,2})\D{0,8}?(?:Episode|Ep)\s*(\d{1,4})\b/i, (m) => ({ season: Number(m[1]), episode: Number(m[2]) })],
    [/\b(?:Folge|Episode|Ep)\.?\s*(\d{1,4})\b/i, (m) => ({ season: null, episode: Number(m[1]) })],
    // Anime: „Titel - 13“, „Titel - 13v2“.
    [/\s[-–]\s(\d{1,4})(?:v\d)?\b/, (m) => ({ season: null, episode: Number(m[1]) })],
  ]
  for (const [pattern, read] of patterns) {
    const match = pattern.exec(plain)
    if (!match) continue
    const title = tidy(plain.slice(0, match.index))
    const { season, episode } = read(match)
    if (!title || episode < 1) continue
    return { title, season, episode }
  }
  // Last: „Titel 13“ — a bare number at the very end.
  const bare = /^(.*\D)\s(\d{1,3})\s*$/.exec(tidy(plain))
  if (bare && tidy(bare[1])) return { title: tidy(bare[1]), season: null, episode: Number(bare[2]) }
  return null
}

/**
 * The season an episode without one belongs to: the only season there is,
 * the one the entry stands at when the number fits it, or — counting
 * straight through known seasons — the one it falls into.
 */
function seasonFor(item: SavedLinkItem, episode: number): { season: number; episode: number } | null {
  const regular = seasonsOf(item)
    .filter((season) => season.number > 0)
    .sort((a, b) => a.number - b.number)
  if (regular.length === 0) return { season: 1, episode }
  if (regular.length === 1) return { season: regular[0].number, episode }
  const here = regular.find((season) => season.number === item.season)
  if (here && (here.episodes === null || episode <= here.episodes)) return { season: here.number, episode }
  let before = 0
  for (const season of regular) {
    if (season.episodes === null) return null
    if (episode <= before + season.episodes) return { season: season.number, episode: episode - before }
    before += season.episodes
  }
  return null
}

/** The entry and episode a file is, when its name and the list agree. */
export function matchEpisode(fileName: string, items: SavedLinkItem[]): EpisodeMatch | null {
  const guess = guessEpisode(fileName)
  if (!guess) return null
  const wanted = normalTitle(guess.title)
  if (wanted.length < 2) return null
  // The longest title that is the file's name or stands at its start wins:
  // „Mob Psycho 100 II“ over „Mob Psycho 100“.
  let best: SavedLinkItem | null = null
  for (const item of items) {
    const title = normalTitle(item.title)
    if (title.length < 2) continue
    const fits = wanted === title || wanted.startsWith(`${title} `) || title.startsWith(`${wanted} `)
    if (fits && (!best || title.length > normalTitle(best.title).length)) best = item
  }
  if (!best) return null
  const place = guess.season !== null ? { season: guess.season, episode: guess.episode } : seasonFor(best, guess.episode)
  if (!place) return null
  // A number past the known end is not an episode of this season.
  const season = seasonsOf(best).find((entry) => entry.number === place.season)
  if (season?.episodes != null && place.episode > season.episodes) return null
  return { item: best, season: place.season, episode: place.episode }
}

/** True when this episode is already ticked off. */
export function alreadySeen(match: EpisodeMatch): boolean {
  return seasonsOf(match.item).some((season) => season.number === match.season && season.watched.includes(match.episode))
}

/**
 * One episode seen, as the player reports it: ticked — a season it names
 * that the entry lacks is added — and the place settles on the first
 * episode not yet seen.
 */
export function seenEpisode(
  item: SavedLinkItem,
  seasonNumber: number,
  episode: number,
): Pick<SavedLinkItem, 'seasons' | 'season' | 'episode' | 'status' | 'history'> {
  const seasons: MerkSeason[] = seasonsOf(item).some((season) => season.number === seasonNumber)
    ? seasonsOf(item).map((season) =>
        season.number === seasonNumber ? { ...season, watched: [...new Set([...season.watched, episode])].sort((a, b) => a - b) } : season,
      )
    : [...seasonsOf(item), { number: seasonNumber, episodes: null, watched: [episode] }]
  const settled = settle(item, seasons, seasonNumber)
  const entry: WatchHistoryEntry = {
    id: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    season: seasonNumber,
    episode,
    at: Date.now(),
  }
  return { ...settled, history: [...(item.history ?? []), entry] }
}
