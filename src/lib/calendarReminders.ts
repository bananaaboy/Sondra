/**
 * Reminders of the Kalender, while Sondra is open: every half minute the
 * entries that are due and not yet told say so — a notice of the system where
 * there is one (Windows in the app, the browser where it was allowed), a line
 * in the page itself that always shows, and a notice on the phone if one is
 * set up. Each occurrence is told once; entries more than half an hour past
 * their time are not told at all, so a start of Sondra after a night does not
 * read out the whole night.
 */

import { create } from 'zustand'

import { dueReminders, rememberReminders, toldReminders, useCalendar, type DueReminder } from './calendar'
import { merkItems } from './merkliste'
import { sendAppNotification } from './notifications'

const EVERY_MS = 30_000
/** At most this many lines wait in the page; more would be a wall. */
const SHOWN_MAX = 3

export const useReminderLines = create<{ lines: { key: string; title: string; body: string }[] }>(() => ({ lines: [] }))

export function dismissReminder(key: string): void {
  useReminderLines.setState((state) => ({ lines: state.lines.filter((line) => line.key !== key) }))
}

/** One round; returns what was told. */
export function remindNow(now: Date = new Date()): DueReminder[] {
  const due = dueReminders(now, useCalendar.getState().events, merkItems(), toldReminders(now.getTime()))
  if (due.length === 0) return []
  rememberReminders(due.map((entry) => entry.key), now.getTime())
  useReminderLines.setState((state) => ({
    lines: [...state.lines, ...due.map(({ key, title, body }) => ({ key, title, body }))].slice(-SHOWN_MAX),
  }))
  for (const entry of due) sendAppNotification({ title: entry.title, body: entry.body, kind: 'general', push: 'reminders' })
  return due
}

/** Starts the rounds; the returned function stops them. */
export function watchCalendarReminders(): () => void {
  const first = window.setTimeout(() => remindNow(), 3_000)
  const every = window.setInterval(() => remindNow(), EVERY_MS)
  return () => {
    window.clearTimeout(first)
    window.clearInterval(every)
  }
}
