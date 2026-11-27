/**
 * „Danach“ beside a download: nothing, shut down, hibernate — one choice, set
 * for this run only (it is never kept: a switch left on from yesterday would
 * turn the computer off at the next download nobody was waiting for). Only the
 * Windows app shows it. When the downloads are done, a countdown of a minute
 * says so and can be stopped; closing it or Escape stops it too.
 */

import { useEffect, useRef, useState } from 'react'

import { POWER_COUNTDOWN_SECONDS, POWER_OPTIONS, powerVerb, runPower, usePowerAvailable, type PowerAfter } from '../lib/power'
import { Button, Dialog, Select } from './ui/primitives'

export function PowerAfterSelect({ value, onChange, className = '' }: { value: PowerAfter; onChange: (next: PowerAfter) => void; className?: string }) {
  const available = usePowerAvailable()
  if (!available) return null
  return (
    <label className={`flex items-center gap-[8px] text-small text-prose ${className}`}>
      Danach
      <Select value={value} onChange={(event) => onChange(event.target.value as PowerAfter)} className="w-auto! py-[6px]">
        {POWER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  )
}

export function PowerCountdown({
  action,
  done,
  failed,
  onCancel,
  onFinished,
}: {
  action: Exclude<PowerAfter, 'none'> | null
  done: number
  failed: number
  onCancel: () => void
  /** Told after the countdown ran out and Windows was asked, so the choice resets. */
  onFinished: () => void
}) {
  const [left, setLeft] = useState(POWER_COUNTDOWN_SECONDS)
  const [problem, setProblem] = useState<string | null>(null)
  const fired = useRef(false)

  useEffect(() => {
    if (!action) return
    fired.current = false
    setLeft(POWER_COUNTDOWN_SECONDS)
    setProblem(null)
    const timer = window.setInterval(() => setLeft((seconds) => Math.max(0, seconds - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [action])

  const go = async () => {
    if (!action || fired.current) return
    fired.current = true
    const result = await runPower(action)
    if (result.ok) onFinished()
    else setProblem(result.message)
  }

  useEffect(() => {
    if (action && left === 0) void go()
    // `go` reads only refs and props that do not change while the countdown runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, action])

  const what = action === 'hibernate' ? 'Ruhezustand' : 'Herunterfahren'
  return (
    <Dialog open={action !== null} onClose={onCancel} title={what} size="md">
      <div className="flex flex-col gap-[16px]" role="alertdialog" aria-live="polite">
        {problem ? (
          <>
            <p className="m-0 text-body font-medium text-ink">{problem}</p>
            <div>
              <Button onClick={onCancel}>Schliessen</Button>
            </div>
          </>
        ) : (
          <>
            <p className="m-0 text-body text-ink">
              {done} {done === 1 ? 'Download ist' : 'Downloads sind'} fertig{failed > 0 ? `, ${failed} fehlgeschlagen` : ''}. In{' '}
              <span className="value font-semibold">{left}</span> {left === 1 ? 'Sekunde' : 'Sekunden'} {powerVerb(action ?? 'shutdown')}.
            </p>
            <div className="h-[4px] overflow-hidden rounded-pill bg-line" aria-hidden>
              <div className="h-full bg-ink" style={{ width: `${(left / POWER_COUNTDOWN_SECONDS) * 100}%`, transition: 'width 1s linear' }} />
            </div>
            <div className="flex flex-wrap items-center gap-[12px]">
              <Button onClick={onCancel}>Abbrechen</Button>
              <Button variant="quiet" onClick={() => void go()}>
                Jetzt
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
