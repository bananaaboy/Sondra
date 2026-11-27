/**
 * „Danach herunterfahren“, checked without turning anything off: the module
 * (desktop/power.mjs) is given a stand-in for `spawn`, and what it would have
 * run is looked at.
 *
 *   npm run verify:power
 */

import { EventEmitter } from 'node:events'

import { createPower, POWER_COMMANDS } from '../desktop/power.mjs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

const ran: { cmd: string; args: string[] }[] = []
/** A `spawn` that records the call and exits with `code` (or fails to start). */
const fake = (code: number, startFails = false) =>
  ((cmd: string, args: string[]) => {
    ran.push({ cmd, args })
    if (startFails) throw new Error('ENOENT')
    const child = new EventEmitter()
    setImmediate(() => child.emit('exit', code))
    return child
  }) as never

const windows = createPower({ platform: 'win32', spawn: fake(0) })
check('Windows meldet sich als verfügbar', await windows.handle('status'), { available: true })
check('Herunterfahren: sofort, ohne Wartezeit von Windows', [await windows.handle('shutdown'), ran.at(-1)], [{ ok: true }, { cmd: 'shutdown.exe', args: ['/s', '/t', '0'] }])
check('Ruhezustand', [await windows.handle('hibernate'), ran.at(-1)], [{ ok: true }, { cmd: 'shutdown.exe', args: ['/h'] }])

const count = ran.length
check('ein unbekannter Name läuft nicht', await windows.handle('sleep'), { ok: false, reason: 'unknown-action' })
check('eine Befehlszeile aus der Seite läuft nicht', await windows.handle('shutdown.exe /s /t 0 & calc'), { ok: false, reason: 'unknown-action' })
check('„__proto__“ und „toString“ sind keine Aktion', [await windows.handle('__proto__'), await windows.handle('toString')], [
  { ok: false, reason: 'unknown-action' },
  { ok: false, reason: 'unknown-action' },
])
check('… und es wurde nichts gestartet', ran.length, count)
check('es gibt genau zwei Befehle', Object.keys(POWER_COMMANDS), ['shutdown', 'hibernate'])

const linux = createPower({ platform: 'linux', spawn: fake(0) })
const before = ran.length
check('anderswo: nicht verfügbar', await linux.handle('status'), { available: false })
check('anderswo: nichts läuft', [await linux.handle('shutdown'), ran.length], [{ ok: false, reason: 'not-windows' }, before])

const off = createPower({ platform: 'win32', spawn: fake(1) })
check('Ruhezustand in Windows aus: der Grund steht da', await off.handle('hibernate'), { ok: false, reason: 'hibernate-off' })
check('Herunterfahren abgelehnt: failed', await off.handle('shutdown'), { ok: false, reason: 'failed' })
const broken = createPower({ platform: 'win32', spawn: fake(0, true) })
check('Programm nicht startbar: failed, kein Absturz', await broken.handle('shutdown'), { ok: false, reason: 'failed' })

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nAlles in Ordnung.')
