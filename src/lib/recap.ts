/**
 * „Rückblick“: what was watched in a year, from the dates the Merkliste keeps
 * with every episode ticked off (`history`). Nothing here is guessed: an
 * episode counts for the day it was marked, and an episode marked twice
 * counts once. Where the dates only start recently, the recap says since
 * when — a year with three weeks in it is not a year of watching.
 */

import { durationOfEpisode, type SavedLinkItem } from './merkliste'

export interface Recap {
  year: number
  episodes: number
  minutes: number
  /** Episodes per month, January first. */
  byMonth: number[]
  busiestMonth: { month: number; episodes: number } | null
  /** Most watched in a day, and the longest run of days in a row with at least one. */
  busiestDay: { day: string; episodes: number } | null
  streak: number
  /** The five series with the most episodes this year. */
  top: { id: string; title: string; episodes: number; minutes: number }[]
  /** Series that went to „Fertig“ and whose last episode was in this year. */
  finished: number
}

const dayKey = (at: number) => {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Years with at least one dated episode, newest first. */
export function recapYears(items: SavedLinkItem[]): number[] {
  const years = new Set<number>()
  for (const item of items) for (const entry of item.history ?? []) if (Number.isFinite(entry.at)) years.add(new Date(entry.at).getFullYear())
  return [...years].sort((a, b) => b - a)
}

/** The first day anything was dated; null when nothing is. */
export function recordedSince(items: SavedLinkItem[]): number | null {
  let first: number | null = null
  for (const item of items) for (const entry of item.history ?? []) if (Number.isFinite(entry.at) && (first === null || entry.at < first)) first = entry.at
  return first
}

export function yearRecap(items: SavedLinkItem[], year: number): Recap {
  const byMonth = new Array<number>(12).fill(0)
  const perDay = new Map<string, number>()
  const perItem = new Map<string, { title: string; episodes: number; minutes: number }>()
  let minutes = 0
  let episodes = 0
  let finished = 0
  for (const item of items) {
    // An episode ticked twice is one episode: the first time in this year counts.
    const seen = new Set<string>()
    let last = 0
    for (const entry of [...(item.history ?? [])].sort((a, b) => a.at - b.at)) {
      if (!Number.isFinite(entry.at)) continue
      last = Math.max(last, entry.at)
      if (new Date(entry.at).getFullYear() !== year) continue
      const key = `${entry.season}:${entry.episode}`
      if (seen.has(key)) continue
      seen.add(key)
      const length = durationOfEpisode(item, entry.season, entry.episode)
      episodes += 1
      minutes += length
      byMonth[new Date(entry.at).getMonth()] += 1
      perDay.set(dayKey(entry.at), (perDay.get(dayKey(entry.at)) ?? 0) + 1)
      const row = perItem.get(item.id) ?? { title: item.title, episodes: 0, minutes: 0 }
      row.episodes += 1
      row.minutes += length
      perItem.set(item.id, row)
    }
    if (item.status === 'done' && seen.size > 0 && last > 0 && new Date(last).getFullYear() === year) finished += 1
  }
  const monthMax = Math.max(...byMonth)
  let busiestDay: Recap['busiestDay'] = null
  for (const [day, count] of perDay) if (!busiestDay || count > busiestDay.episodes) busiestDay = { day, episodes: count }
  // Longest run of consecutive days.
  const days = [...perDay.keys()].sort()
  let streak = 0
  let run = 0
  let before: Date | null = null
  for (const day of days) {
    const [y, m, d] = day.split('-').map(Number)
    const date = new Date(y, m - 1, d, 12)
    run = before && Math.round((date.getTime() - before.getTime()) / 86_400_000) === 1 ? run + 1 : 1
    streak = Math.max(streak, run)
    before = date
  }
  return {
    year,
    episodes,
    minutes,
    byMonth,
    busiestMonth: monthMax > 0 ? { month: byMonth.indexOf(monthMax), episodes: monthMax } : null,
    busiestDay,
    streak,
    top: [...perItem.entries()]
      .map(([id, row]) => ({ id, ...row }))
      .sort((a, b) => b.episodes - a.episodes || b.minutes - a.minutes || a.title.localeCompare(b.title, 'de'))
      .slice(0, 5),
    finished,
  }
}
