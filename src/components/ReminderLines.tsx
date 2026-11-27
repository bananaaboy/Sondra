/**
 * What the Kalender says while Sondra is open: a line per due entry, at the
 * lower edge, until it is dismissed. It floats over the page, so it carries the
 * one shadow step things that float carry.
 */

import { dismissReminder, useReminderLines } from '../lib/calendarReminders'
import { Button } from './ui/primitives'

export function ReminderLines() {
  const lines = useReminderLines((state) => state.lines)
  if (lines.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="fixed bottom-[16px] left-[16px] z-40 flex w-[min(360px,calc(100vw-32px))] flex-col gap-[8px]">
      {lines.map((line) => (
        <div key={line.key} className="dock flex items-center gap-[12px] rounded-card bg-raised p-[12px] shadow-lg ring-1 ring-inset ring-rule">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-small font-semibold text-ink" title={line.title}>
              {line.title}
            </span>
            <span className="text-small text-prose">{line.body}</span>
          </span>
          <Button size="sm" variant="quiet" onClick={() => dismissReminder(line.key)}>
            OK
          </Button>
        </div>
      ))}
    </div>
  )
}
