/**
 * „Bis wohin?“: how much there is to watch from where someone stands to a
 * point they choose in a series — episodes, time, and when they get there at
 * a pace, or what pace gets them there by a date.
 *
 * Pure functions over a Merkliste entry, so the numbers can be checked
 * without a page (`npm run verify:merkliste`). Every figure is counted from
 * the entry itself: the episodes it knows, the lengths it was given, the
 * history of what was ticked off. Where it does not know — a season without
 * a number of episodes — the result says so instead of guessing.
 */

import {
  durationOfEpisode,
  OPENING_DEFAULT,
  seasonName,
  seasonsOf,
  type MerkGoal,
  type MerkSeason,
  type SavedLinkItem,
} from './merkliste'

export interface PlanPoint {
  season: number
  episode: number
}

export interface PlanOptions {
  /** From where the entry stands (what is seen does not count), or from the first episode. */
  from: 'stand' | 'start'
  /** Playback speed, as in the player: 1 to 2. */
  speed: number
  /** Seconds of opening skipped in each episode (not in films); 0 for none. */
  skipOpening: number
}

export const PLAN_DEFAULTS: PlanOptions = { from: 'stand', speed: 1, skipOpening: 0 }

/** A stretch of a season's episodes that share one state, for drawing the line. */
export interface PlanRun {
  kind: 'seen' | 'planned' | 'open'
  from: number
  to: number
}

export interface PlanSeason {
  number: number
  name: string
  /** Episodes on the line: the known number, else as far as anything reaches. */
  count: number
  known: boolean
  runs: PlanRun[]
}

export interface WatchPlan {
  /** Episodes still to watch up to and including the target. */
  episodes: number
  /** Their time after speed and skipped openings, in whole minutes. */
  minutes: number
  /** Their plain length, as the entry gives it. */
  rawMinutes: number
  /** The first one to watch. */
  first: PlanPoint | null
  /** Seasons on the way without a number of episodes: counted without them, so the result is a least. */
  unknown: number[]
  /** Planned episodes with a length of their own (Bearbeiten → Dauer). */
  exceptions: number
  /** Planned films among the episodes. */
  films: number
  /** The target lies behind the stand: nothing left to watch to get there. */
  behind: boolean
  bar: PlanSeason[]
}

/** Seasons in their order of watching: 1, 2, 3 …, the films after them. */
const rank = (season: number) => (season === 0 ? Number.MAX_SAFE_INTEGER : season)
const before = (a: PlanPoint, b: PlanPoint) => rank(a.season) < rank(b.season) || (a.season === b.season && a.episode < b.episode)

/** Where the entry stands, as a point: the episode to watch next. */
export function standPoint(item: SavedLinkItem): PlanPoint {
  return { season: item.season, episode: item.episode ?? 1 }
}

/** The last episode the entry knows of: the end of its last season with a length (films not counted). */
export function lastPoint(item: SavedLinkItem): PlanPoint | null {
  const regular = seasonsOf(item).filter((season) => season.number > 0)
  for (let i = regular.length - 1; i >= 0; i -= 1) {
    const season = regular[i]
    const end = season.episodes ?? (season.watched.length ? Math.max(...season.watched) : null)
    if (end) return { season: season.number, episode: end }
  }
  return null
}

/** The end of the season the entry stands in, if its length is known. */
export function seasonEnd(item: SavedLinkItem, seasonNumber = item.season): PlanPoint | null {
  const season = seasonsOf(item).find((entry) => entry.number === seasonNumber)
  return season?.episodes ? { season: season.number, episode: season.episodes } : null
}

/**
 * The opening skipped per episode, and where its length comes from: learned
 * by ear in the player (the middle of what was found), set on the series, or
 * the player's own setting.
 */
export function openingOf(item: SavedLinkItem, fallback = OPENING_DEFAULT): { seconds: number; source: 'heard' | 'series' | 'player' } {
  const heard = (item.intros ?? []).map((intro) => intro.seconds).filter((s) => s > 0).sort((a, b) => a - b)
  if (heard.length) return { seconds: Math.round(heard[Math.floor(heard.length / 2)]), source: 'heard' }
  if (item.opening) return { seconds: item.opening, source: 'series' }
  return { seconds: fallback, source: 'player' }
}

export function watchPlan(item: SavedLinkItem, target: PlanPoint, options: PlanOptions = PLAN_DEFAULTS): WatchPlan {
  const seasons = seasonsOf(item)
  const stand = standPoint(item)
  const fromStand = options.from === 'stand'
  let episodes = 0
  let rawMinutes = 0
  let minutes = 0
  let exceptions = 0
  let films = 0
  let first: PlanPoint | null = null
  const unknown: number[] = []
  const bar: PlanSeason[] = []

  const counts = (season: MerkSeason, episode: number) => {
    const point = { season: season.number, episode }
    if (before(target, point)) return false
    if (fromStand && (before(point, stand) || season.watched.includes(episode))) return false
    return true
  }

  for (const season of seasons) {
    const known = season.episodes !== null
    const reach = Math.max(
      season.episodes ?? 0,
      season.watched.length ? Math.max(...season.watched) : 0,
      season.number === target.season ? target.episode : 0,
      season.number === stand.season ? stand.episode : 0,
    )
    // A season of unknown length that the plan runs through, not up to a point in it.
    const through = rank(season.number) < rank(target.season) && (!fromStand || rank(season.number) >= rank(stand.season))
    if (!known && through) unknown.push(season.number)
    // Inside a season of unknown length nothing past what is known is counted.
    const last = known ? (season.episodes as number) : season.number === target.season ? target.episode : fromStand ? 0 : reach
    const runs: PlanRun[] = []
    const count = Math.max(reach, 1)
    for (let episode = 1; episode <= count; episode += 1) {
      const planned = episode <= last && counts(season, episode)
      const kind: PlanRun['kind'] = planned ? 'planned' : season.watched.includes(episode) ? 'seen' : 'open'
      const run = runs[runs.length - 1]
      if (run && run.kind === kind && run.to === episode - 1) run.to = episode
      else runs.push({ kind, from: episode, to: episode })
      if (!planned) continue
      episodes += 1
      if (!first) first = { season: season.number, episode }
      const length = durationOfEpisode(item, season.number, episode)
      rawMinutes += length
      if (item.durations?.[`${season.number}:${episode}`]) exceptions += 1
      if (season.number === 0) {
        films += 1
        minutes += length
      } else {
        // An opening is never more than half an episode.
        minutes += Math.max(length / 2, length - options.skipOpening / 60)
      }
    }
    // Films only stand on the line when they are the goal or already seen.
    if (season.number === 0 && target.season !== 0 && !season.watched.length) continue
    bar.push({ number: season.number, name: seasonName(season), count, known, runs })
  }

  const speed = Math.min(2, Math.max(1, options.speed || 1))
  return {
    episodes,
    minutes: Math.round(minutes / speed),
    rawMinutes: Math.round(rawMinutes),
    first,
    unknown,
    exceptions,
    films,
    behind: episodes === 0 && fromStand && (before(target, stand) || isSeen(seasons, target)),
    bar,
  }
}

function isSeen(seasons: MerkSeason[], point: PlanPoint): boolean {
  return seasons.some((season) => season.number === point.season && season.watched.includes(point.episode))
}

/* -------------------------------------------------------------------------- */
/* Pace and dates                                                              */
/* -------------------------------------------------------------------------- */

export type PaceUnit = 'day' | 'week'

const DAY = 86_400_000

/** Midnight of a day, local time. */
export function startOfDay(time: number | Date): Date {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date
}

/** Whole days from one day to another (0 for the same day). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY)
}

/** „2026-11-14“ as a local day, or null. */
export function parseDay(text: string | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text ?? '')
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

/** A local day as „2026-11-14“, for a date field. */
export function dayText(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * When the last of `episodes` is watched at a pace, starting today: the
 * number of days it takes (today counting as the first) and that day.
 */
export function finishAt(episodes: number, rate: number, unit: PaceUnit, today = new Date()): { days: number; date: Date } {
  const perDay = Math.max(0.01, unit === 'week' ? rate / 7 : rate)
  const days = episodes <= 0 ? 0 : Math.ceil(episodes / perDay - 1e-9)
  const date = startOfDay(today)
  date.setDate(date.getDate() + Math.max(0, days - 1))
  return { days, date }
}

/**
 * What it takes to have watched `episodes` (of `minutes`) by a day, today
 * included: per day, and per week when that reads better (under one a day).
 */
export function paceFor(episodes: number, minutes: number, by: Date, today = new Date()): { days: number; perDay: number; perWeek: number; minutesPerDay: number } | null {
  const days = daysBetween(today, by) + 1
  if (days < 1) return null
  return { days, perDay: episodes / days, perWeek: (episodes / days) * 7, minutesPerDay: minutes / days }
}

/**
 * How fast this series was watched lately: the episodes ticked off in the
 * last four weeks, over the days since the first of them (a week at least,
 * so one evening's binge is not taken for a habit). Null below two.
 */
export function recentPace(item: SavedLinkItem, now = Date.now()): { perDay: number; count: number; days: number } | null {
  const since = now - 28 * DAY
  const recent = (item.history ?? []).filter((entry) => entry.at >= since && entry.at <= now)
  if (recent.length < 2) return null
  const oldest = Math.min(...recent.map((entry) => entry.at))
  const days = Math.min(28, Math.max(7, Math.ceil((now - oldest) / DAY)))
  return { perDay: recent.length / days, count: recent.length, days }
}

/** A pace as the stepper shows it: whole episodes, per day from one a day, else per week. */
export function paceSetting(perDay: number): { rate: number; unit: PaceUnit } {
  if (perDay >= 1) return { rate: Math.max(1, Math.round(perDay)), unit: 'day' }
  return { rate: Math.max(1, Math.round(perDay * 7)), unit: 'week' }
}

/* -------------------------------------------------------------------------- */
/* A goal kept on the entry                                                    */
/* -------------------------------------------------------------------------- */

export interface GoalState {
  /** Episodes still to watch to reach it. */
  left: number
  minutes: number
  reached: boolean
  /** With a date: the days left (today counting), and the pace that gets there. */
  days: number | null
  perDay: number | null
  /** With a date: episodes ahead of an even pace since it was set (negative: behind). */
  ahead: number | null
  overdue: boolean
}

export function goalState(item: SavedLinkItem, goal: MerkGoal, options: PlanOptions = PLAN_DEFAULTS, today = new Date()): GoalState {
  const plan = watchPlan(item, goal, { ...options, from: 'stand' })
  const reached = plan.episodes === 0
  const by = parseDay(goal.by)
  if (!by || reached) {
    return { left: plan.episodes, minutes: plan.minutes, reached, days: null, perDay: null, ahead: null, overdue: false }
  }
  const days = daysBetween(today, by) + 1
  const overdue = days < 1
  // Where an even pace from the day it was set would have them by now.
  const total = Math.max(1, daysBetween(new Date(goal.setAt), by) + 1)
  const gone = Math.min(total, Math.max(0, daysBetween(new Date(goal.setAt), today)))
  const expectedLeft = goal.count ? goal.count * (1 - gone / total) : null
  return {
    left: plan.episodes,
    minutes: plan.minutes,
    reached,
    days: overdue ? 0 : days,
    perDay: overdue ? null : plan.episodes / days,
    ahead: expectedLeft === null ? null : Math.round(expectedLeft - plan.episodes),
    overdue,
  }
}

/** „Staffel 3, Folge 12“, „Film 2“. */
export function pointLabel(point: PlanPoint): string {
  return point.season === 0 ? `Film ${point.episode}` : `Staffel ${point.season}, Folge ${point.episode}`
}

/** „1,5“, „2“ — a number the way it is read here. */
export function decimal(value: number, digits = 1): string {
  return value.toLocaleString('de-CH', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

/** „3 Std. 12 Min.“, „45 Min.“, „2 Tage 4 Std.“ — a length of watching time. */
export function lengthLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} Min.`
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const rest = total % 60
  if (days > 0) return `${days} ${days === 1 ? 'Tag' : 'Tage'}${hours ? ` ${hours} Std.` : ''}`
  return `${hours} Std.${rest ? ` ${rest} Min.` : ''}`
}

/** „Do., 20. Nov.“, with the year when it is not this one; „heute“, „morgen“. */
export function dayLabel(date: Date, today = new Date()): string {
  const diff = daysBetween(today, date)
  if (diff === 0) return 'heute'
  if (diff === 1) return 'morgen'
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** „in 3 Tagen“, „in 2 Wochen“, „in 4 Monaten“. */
export function inLabel(days: number): string {
  if (days <= 1) return 'heute'
  if (days === 2) return 'morgen'
  if (days < 14) return `in ${days - 1} Tagen`
  if (days < 63) return `in ${Math.round((days - 1) / 7)} Wochen`
  return `in ${Math.round((days - 1) / 30.4)} Monaten`
}
