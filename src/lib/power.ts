/**
 * „Danach herunterfahren“ — the page's side (desktop/power.mjs). Only the
 * Windows app can do it; elsewhere there is no control at all rather than a
 * dead one. The page names an action; the app knows the command.
 */

import { useEffect, useState } from 'react'

import { APP_BRIDGE, IN_DESKTOP_APP } from './desktop'

export type PowerAfter = 'none' | 'shutdown' | 'hibernate'

/** The seconds a person has to say no. */
export const POWER_COUNTDOWN_SECONDS = 60

export const POWER_OPTIONS: { value: PowerAfter; label: string }[] = [
  { value: 'none', label: 'Nichts' },
  { value: 'shutdown', label: 'Herunterfahren' },
  { value: 'hibernate', label: 'Ruhezustand' },
]

/** The sentence for an action in the countdown: „fährt herunter“ / „geht in den Ruhezustand“. */
export function powerVerb(action: Exclude<PowerAfter, 'none'>): string {
  return action === 'shutdown' ? 'fährt der Computer herunter' : 'geht der Computer in den Ruhezustand'
}

/** The sentence for a refusal. */
export function powerProblem(reason: string | undefined): string {
  switch (reason) {
    case 'hibernate-off':
      return 'Der Ruhezustand ist in Windows aus. Er lässt sich in der Eingabeaufforderung mit „powercfg /hibernate on“ einschalten.'
    case 'not-windows':
      return 'Das geht nur unter Windows.'
    default:
      return 'Windows hat den Befehl nicht ausgeführt.'
  }
}

/** True once the app has said this is Windows; `null` while it is being asked. */
export function usePowerAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(IN_DESKTOP_APP && APP_BRIDGE?.power ? null : false)
  useEffect(() => {
    const ask = APP_BRIDGE?.power
    if (!IN_DESKTOP_APP || !ask) return
    let live = true
    void ask('status')
      .then((answer) => live && setAvailable(Boolean(answer?.available)))
      .catch(() => live && setAvailable(false))
    return () => {
      live = false
    }
  }, [])
  return available
}

/** Asks Windows; never throws. */
export async function runPower(action: Exclude<PowerAfter, 'none'>): Promise<{ ok: boolean; message: string }> {
  const ask = APP_BRIDGE?.power
  if (!ask) return { ok: false, message: powerProblem('not-windows') }
  try {
    const answer = await ask(action)
    return answer?.ok ? { ok: true, message: '' } : { ok: false, message: powerProblem(answer?.reason) }
  } catch {
    return { ok: false, message: powerProblem(undefined) }
  }
}
