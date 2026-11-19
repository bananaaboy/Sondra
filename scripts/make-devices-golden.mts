/**
 * What the web app's own `deviceIdentity.ts` makes — canonical JSON, ids, names, signed records and
 * messages made by real WebCrypto keys — as a table the native crate (`native/sondra-devices`) has to read
 * the same way: ids from keys, signatures that verify, forgeries that do not.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { canonical, checkRecord, cleanName, deviceIdOf, makeKeys, openMessage, pickDevices, sealMessage, signRecord, uniqueName } from '../src/lib/deviceIdentity'

const outDir = 'native/sondra-devices/tests/golden'
mkdirSync(outDir, { recursive: true })

const now = 1_800_000_000_000
const laptop = await makeKeys()
const phone = await makeKeys()
const intruder = await makeKeys()

const laptopRecord = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now - 5000, seen: now })
const laptopCaps = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now - 5000, seen: now + 1000, caps: ['text', 'play', 'folder', 'resume'] })
const laptopOlder = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now - 5000, seen: now - 9000 })
const phoneRecord = await signRecord(phone, { name: 'Handy ✓ „Mia“', kind: 'android', platform: 'Android-App', created: now - 2000, seen: now - 100, caps: ['play'] })
const intruderRecord = await signRecord(intruder, { name: 'Fremd', kind: 'browser', platform: 'Chrome auf Linux', created: now, seen: now })

// Forgeries: the name changed after signing, the key swapped for another's, an id claimed that is not the key's.
const renamed = { ...laptopRecord, name: 'Laptop 2' }
const swapped = { ...laptopRecord, key: phoneRecord.key }
const claimed = { ...intruderRecord, id: laptopRecord.id }
const capsAdded = { ...laptopRecord, caps: ['text'] }
const noSig = (({ sig: _s, ...rest }) => rest)(laptopRecord)
const wrongKind = { ...laptopRecord, kind: 'toaster' }
const tooManyCaps = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'x', created: now, seen: now, caps: Array.from({ length: 17 }, (_, i) => `cap${String.fromCharCode(97 + i)}`) })

const records = { laptopRecord, laptopCaps, laptopOlder, phoneRecord, intruderRecord }
const believed = await Promise.all(Object.entries({ ...records, renamed, swapped, claimed, capsAdded, noSig, wrongKind, tooManyCaps }).map(async ([name, raw]) => ({ name, raw, ok: (await checkRecord(raw)) !== null })))

const picked = await pickDevices([laptopRecord, laptopOlder, laptopCaps, phoneRecord, intruderRecord, renamed, swapped, claimed, 'junk', null])

// Messages from the laptop to the phone, and what the phone makes of them.
const devices = (await pickDevices([laptopCaps, phoneRecord]))
const seal = (over: Record<string, unknown> = {}) => sealMessage(laptop, { id: 'ABCDEFGHJKMN', from: laptopRecord.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T1', body: { files: [{ name: 'Folge 1.mkv', size: 123456 }], note: 'mit „Umlauten“ ß 日本' }, ...over })
const messages = [
  { name: 'gut', raw: await seal(), seenIds: [] as string[], now },
  { name: 'schon-gesehen', raw: await seal(), seenIds: ['ABCDEFGHJKMN'], now },
  { name: 'zu-alt', raw: await seal(), seenIds: [], now: now + 16 * 60_000 },
  { name: 'für-andere', raw: await seal({ to: laptopRecord.id }), seenIds: [], now },
  { name: 'unbekannter-absender', raw: await sealMessage(intruder, { id: 'ZZZZ', from: intruderRecord.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T2', body: {} }), seenIds: [], now },
  { name: 'gefälscht', raw: { ...(await seal()), body: { files: [] } }, seenIds: [], now },
  { name: 'fremd-signiert', raw: await sealMessage(intruder, { id: 'QQQQ', from: laptopRecord.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T3', body: {} }), seenIds: [], now },
  { name: 'unvollständig', raw: { v: 1, id: 'x' }, seenIds: [], now },
]
const opened = await Promise.all(messages.map(async (m) => {
  const result = await openMessage(m.raw, { self: phoneRecord.id, devices, now: m.now, seen: (id) => m.seenIds.includes(id) })
  return { ...m, result: result.ok ? 'ok' : result.problem }
}))

const canonicals = [
  { name: 'schlüssel-sortiert', value: { b: 1, a: 2, c: { z: 1, y: [3, 2, { b: 1, a: 0 }] } } },
  { name: 'texte', value: { text: 'a"b\\c\nd\te\u0001f\u007f ü ß 日本 🎵  ' } },
  { name: 'zahlen', value: { n: [0, 1, -1, 1.5, 1e21, 123456789012, 0.1, 1e-7, 5.0] } },
  { name: 'null-und-bool', value: { a: null, b: true, c: false, d: [] , e: {} } },
  { name: 'umlaut-schlüssel', value: { ä: 1, z: 2, a: 3, ö: 4, '日': 5, '🎵': 6, '￿': 7 } },
]
const canon = canonicals.map((c) => ({ ...c, text: canonical(c.value) }))

const names = [
  { wanted: 'Laptop', others: [] as string[] },
  { wanted: 'Laptop', others: ['Laptop'] },
  { wanted: 'Laptop', others: ['laptop', 'LAPTOP 2'] },
  { wanted: 'Laptop 7', others: ['Laptop 7'] },
  { wanted: '   viel   Platz  ', others: [] },
  { wanted: '', others: [] },
  { wanted: 'ä\u0001ö  x', others: ['äö x'] },
  { wanted: 'A'.repeat(60), others: ['A'.repeat(40)] },
  { wanted: 'Ärger', others: ['ärger'] },
].map((c) => ({ ...c, cleaned: cleanName(c.wanted), unique: uniqueName(c.wanted, c.others) }))

const ids = await Promise.all([laptop, phone, intruder].map(async (k) => ({ jwk: k.publicJwk, id: await deviceIdOf(k.publicJwk) })))

writeFileSync(
  `${outDir}/devices.json`,
  `${JSON.stringify({ now, ids, records, believed, picked: picked.map((r) => ({ id: r.id, seen: r.seen })), devices: devices.map((d) => d.id), messages: opened, canon, names, laptopId: laptopRecord.id, phoneId: phoneRecord.id }, null, 1)}\n`,
)
console.log(`Geräte: ${believed.filter((b) => b.ok).length} Einträge geglaubt, ${believed.filter((b) => !b.ok).length} abgelehnt, ${opened.length} Nachrichten`)
