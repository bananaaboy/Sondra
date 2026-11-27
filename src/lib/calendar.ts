/**
 * The Kalender: the week at a glance — the series that come out on a day of
 * the week (entered on the Merkliste's entry, never guessed) and the
 * person's own entries with a date, a time, a repeat and a reminder.
 *
 * Dates are calendar dates, `YYYY-MM-DD` as the person sees them, and every
 * step between them is made on the date, never on milliseconds: a week is
 * seven dates, also the one in which the clocks change (29 March and 25
 * October 2026 in Europe). A time is `HH:MM` on the clock of the wall it was
 * entered on. Weeks start on Monday.
 *
 * Reminders fire while Sondra is open — there is no server to wake a closed
 * program — and each occurrence at most once.
 */

import { create } from 'zustand'

import type { Airing } from './merkliste'

export type Repeat = 'none' | 'daily' | 'weekly'

export interface CalEvent {
  id: string
  title: string
  /** The first (or only) day, `YYYY-MM-DD`. */
  date: string
  time?: string
  endTime?: string
  repeat: Repeat
  note?: string
  /** Minutes before `time` (0 = at the time); needs a time. */
  remind?: number
  updatedAt: number
}

/** What the Kalender needs of a series: not the whole entry. */
export interface AiringSeries {
  id: string
  title: string
  airing?: Airing
  status?: string
}

/** One line of a day: an event of the person's or a series that comes out. */
export interface DayItem {
  /** Unique for the day: `event:<id>` or `series:<id>`. */
  key: string
  kind: 'event' | 'series'
  /** The event's or the series' id. */
  id: string
  title: string
  date: string
  time?: string
  endTime?: string
  note?: string
  remind?: number
  repeat?: Repeat
}

export const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
export const WEEKDAYS_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag']
const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
const MONTHS_SHORT = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.']

export const REMIND_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Keine' },
  { value: 0, label: 'Zur Uhrzeit' },
  { value: 10, label: '10 Minuten vorher' },
  { value: 30, label: '30 Minuten vorher' },
  { value: 60, label: '1 Stunde vorher' },
  { value: 1440, label: '1 Tag vorher' },
]

export const REPEAT_OPTIONS: { value: Repeat; label: string }[] = [
  { value: 'none', label: 'Einmalig' },
  { value: 'daily', label: 'Jeden Tag' },
  { value: 'weekly', label: 'Jede Woche' },
]

/* -- Dates ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0')

export function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
}

/** A date as `{ y, m, d }`, or `null` for anything that is not a real calendar day. */
export function parseYmd(text: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? { y, m, d } : null
}

/** `n` days on, on the calendar — not 24 hours on the clock. */
export function addDays(ymd: string, n: number): string {
  const parts = parseYmd(ymd)
  if (!parts) return ymd
  const moved = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n))
  return formatYmd(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate())
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(ymd: string): number {
  const parts = parseYmd(ymd)
  if (!parts) return 0
  return (new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay() + 6) % 7
}

/** The Monday of the week a date is in. */
export function weekStart(ymd: string): string {
  return addDays(ymd, -weekdayOf(ymd))
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index))
}

/** Today on this wall's clock. */
export function todayYmd(now: Date = new Date()): string {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export const isTime = (text: unknown): text is string => typeof text === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(text)

/** The moment a date and a clock time name on this wall: 18:00 stays 18:00 in the week the clocks change. */
export function startsAt(ymd: string, time: string): Date {
  const parts = parseYmd(ymd)
  const [hours, minutes] = isTime(time) ? time.split(':').map(Number) : [0, 0]
  return parts ? new Date(parts.y, parts.m - 1, parts.d, hours, minutes) : new Date(NaN)
}

/** „Mo 24“. */
export const dayHeading = (ymd: string) => `${WEEKDAYS_SHORT[weekdayOf(ymd)]} ${parseYmd(ymd)?.d ?? ''}`

/** „Montag, 24. November 2026“. */
export function dayLong(ymd: string): string {
  const parts = parseYmd(ymd)
  return parts ? `${WEEKDAYS_LONG[weekdayOf(ymd)]}, ${parts.d}. ${MONTHS_LONG[parts.m - 1]} ${parts.y}` : ymd
}

/** „24.–30. November 2026“, „30. Nov. – 5. Dez. 2026“, across a year too. */
export function weekLabel(start: string): string {
  const a = parseYmd(start)
  const b = parseYmd(addDays(start, 6))
  if (!a || !b) return start
  if (a.y === b.y && a.m === b.m) return `${a.d}.–${b.d}. ${MONTHS_LONG[a.m - 1]} ${a.y}`
  if (a.y === b.y) return `${a.d}. ${MONTHS_SHORT[a.m - 1]} – ${b.d}. ${MONTHS_SHORT[b.m - 1]} ${a.y}`
  return `${a.d}. ${MONTHS_SHORT[a.m - 1]} ${a.y} – ${b.d}. ${MONTHS_SHORT[b.m - 1]} ${b.y}`
}

/* -- What lies on a day ------------------------------------------------------- */

/** True when an event takes place on a date. */
export function occursOn(event: Pick<CalEvent, 'date' | 'repeat'>, ymd: string): boolean {
  if (ymd < event.date) return false
  if (event.repeat === 'daily') return true
  if (event.repeat === 'weekly') return weekdayOf(ymd) === weekdayOf(event.date)
  return ymd === event.date
}

/** A series is in the Kalender while it is being watched and has a day. */
const airsOn = (series: AiringSeries, ymd: string) =>
  Boolean(series.airing) && (series.status ?? 'watching') === 'watching' && series.airing!.weekday === weekdayOf(ymd)

/** Everything on one day, the entries without a time first, then by the clock. */
export function itemsOn(ymd: string, events: CalEvent[], series: AiringSeries[]): DayItem[] {
  const own: DayItem[] = events
    .filter((event) => occursOn(event, ymd))
    .map((event) => ({
      key: `event:${event.id}`,
      kind: 'event' as const,
      id: event.id,
      title: event.title,
      date: ymd,
      ...(event.time ? { time: event.time } : {}),
      ...(event.endTime ? { endTime: event.endTime } : {}),
      ...(event.note ? { note: event.note } : {}),
      ...(event.remind !== undefined ? { remind: event.remind } : {}),
      repeat: event.repeat,
    }))
  const airing: DayItem[] = series
    .filter((entry) => airsOn(entry, ymd))
    .map((entry) => ({
      key: `series:${entry.id}`,
      kind: 'series' as const,
      id: entry.id,
      title: entry.title,
      date: ymd,
      ...(entry.airing?.time ? { time: entry.airing.time } : {}),
      ...(entry.airing?.remind !== undefined ? { remind: entry.airing.remind } : {}),
    }))
  return [...own, ...airing].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title, 'de'))
}

/* -- Reminders ---------------------------------------------------------------- */

/** How long after its time an entry still reminds: a start of Sondra a little late is no reason to say nothing. */
export const REMIND_GRACE_MS = 30 * 60_000

export interface DueReminder {
  /** `kind:id@date`: one per occurrence, so it is told once. */
  key: string
  title: string
  body: string
  at: Date
}

/** The reminders that are due now and have not been told yet; each occurrence is looked at on three days, the one before and after included. */
export function dueReminders(now: Date, events: CalEvent[], series: AiringSeries[], told: Record<string, number>): DueReminder[] {
  const today = todayYmd(now)
  const due: DueReminder[] = []
  for (const ymd of [addDays(today, -1), today, addDays(today, 1)]) {
    for (const item of itemsOn(ymd, events, series)) {
      if (item.remind === undefined || !isTime(item.time)) continue
      const key = `${item.key}@${ymd}`
      if (told[key] !== undefined) continue
      const at = startsAt(ymd, item.time)
      const from = at.getTime() - item.remind * 60_000
      if (now.getTime() < from || now.getTime() > at.getTime() + REMIND_GRACE_MS) continue
      due.push({
        key,
        title: item.kind === 'series' ? `Heute: ${item.title}` : item.title,
        body:
          item.remind === 0 || now.getTime() >= at.getTime()
            ? `Jetzt, ${item.time} Uhr`
            : `Um ${item.time} Uhr${item.remind >= 60 ? '' : `, in ${Math.max(1, Math.round((at.getTime() - now.getTime()) / 60_000))} Min.`}`,
        at,
      })
    }
  }
  return due.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/* -- The person's own entries -------------------------------------------------- */

const KEY = 'sondra:kalender'
const TOLD_KEY = 'sondra:kalender:erinnert'
/** More than this is a mistake, not a calendar. */
export const EVENTS_MAX = 500

/** One stored entry, checked: anything that is no entry gives `null`. */
export function normalizeEvent(raw: unknown): CalEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Partial<CalEvent>
  const title = typeof entry.title === 'string' ? entry.title.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 120) : ''
  if (!title || typeof entry.date !== 'string' || !parseYmd(entry.date)) return null
  const time = isTime(entry.time) ? entry.time : undefined
  const endTime = time && isTime(entry.endTime) && entry.endTime > time ? entry.endTime : undefined
  const repeat: Repeat = entry.repeat === 'daily' || entry.repeat === 'weekly' ? entry.repeat : 'none'
  const note = typeof entry.note === 'string' ? entry.note.replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim().slice(0, 500) : ''
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id.slice(0, 60) : `kal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    date: entry.date,
    ...(time ? { time } : {}),
    ...(endTime ? { endTime } : {}),
    repeat,
    ...(note ? { note } : {}),
    // A reminder needs a time to be before.
    ...(time && typeof entry.remind === 'number' && Number.isInteger(entry.remind) && entry.remind >= 0 && entry.remind <= 7 * 1440 ? { remind: entry.remind } : {}),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
  }
}

function read(): CalEvent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.map(normalizeEvent).filter((entry): entry is CalEvent => entry !== null).slice(0, EVENTS_MAX) : []
  } catch {
    return []
  }
}

const initial = typeof localStorage === 'undefined' ? [] : read()
export const useCalendar = create<{ events: CalEvent[]; saveFailed: boolean }>(() => ({ events: initial, saveFailed: false }))

function write(events: CalEvent[]): void {
  let saveFailed = false
  try {
    localStorage.setItem(KEY, JSON.stringify(events))
  } catch {
    saveFailed = true
  }
  useCalendar.setState({ events, saveFailed })
}

/** Adds or replaces an entry; returns it as stored, or `null` when it is no entry. */
export function saveEvent(raw: Partial<CalEvent>): CalEvent | null {
  const entry = normalizeEvent({ ...raw, updatedAt: Date.now() })
  if (!entry) return null
  const others = useCalendar.getState().events.filter((existing) => existing.id !== entry.id)
  if (others.length >= EVENTS_MAX) return null
  write([...others, entry])
  return entry
}

export function deleteEvent(id: string): void {
  write(useCalendar.getState().events.filter((entry) => entry.id !== id))
}

/* -- Told reminders ------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60_000

export function toldReminders(now = Date.now()): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOLD_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    // A week is long enough to remember; older ones only fill the store.
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, at]) => typeof at === 'number' && now - at < 7 * DAY_MS)) as Record<string, number>
  } catch {
    return {}
  }
}

export function rememberReminders(keys: string[], now = Date.now()): void {
  try {
    localStorage.setItem(TOLD_KEY, JSON.stringify({ ...toldReminders(now), ...Object.fromEntries(keys.map((key) => [key, now])) }))
  } catch {
    // Without it a reminder may come once more after a restart.
  }
}
