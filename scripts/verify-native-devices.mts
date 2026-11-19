/**
 * The records and messages the native crate writes (`native/sondra-devices`, test
 * `leaves_records_and_messages_for_the_web_app_to_read`) opened by the web app's own code: a device that is
 * native must be believed by every browser of the account, and its forgeries must not be.
 *
 *   npm run verify:native-devices      (after `cargo test -p sondra-devices`)
 */
import { existsSync, readFileSync } from 'node:fs'

import { checkRecord, openMessage, pickDevices } from '../src/lib/deviceIdentity'

const dir = process.argv[2] ?? 'native/target/tmp/devices-interop'
if (!existsSync(`${dir}/devices.json`)) {
  console.error(`Keine Datei in ${dir}: erst „cargo test -p sondra-devices“ laufen lassen.`)
  process.exit(2)
}
const file = JSON.parse(readFileSync(`${dir}/devices.json`, 'utf8')) as {
  records: unknown[]
  forgedRecords: unknown[]
  messages: unknown[]
  forgedMessages: unknown[]
  phoneId: string
  at: number
}

let bad = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) bad += 1
}

for (const [i, record] of file.records.entries()) check(`Eintrag ${i + 1} wird geglaubt`, (await checkRecord(record)) !== null)
for (const [i, record] of file.forgedRecords.entries()) check(`gefälschter Eintrag ${i + 1} wird abgelehnt`, (await checkRecord(record)) === null)
const devices = await pickDevices(file.records)
check('beide Geräte stehen in der Liste', devices.length === 2)
for (const [i, message] of file.messages.entries()) {
  const opened = await openMessage(message, { self: file.phoneId, devices, now: file.at, seen: () => false })
  check(`Nachricht ${i + 1} wird geöffnet`, opened.ok)
}
for (const [i, message] of file.forgedMessages.entries()) {
  const opened = await openMessage(message, { self: file.phoneId, devices, now: file.at, seen: () => false })
  check(`gefälschte Nachricht ${i + 1} wird abgelehnt`, !opened.ok && opened.problem === 'forged')
}
if (bad > 0) {
  console.error(`${bad} Prüfung(en) fehlgeschlagen`)
  process.exit(1)
}
console.log('alles gelesen wie auf der Website')
