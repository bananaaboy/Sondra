/**
 * What the web app's own `deviceIdentity.ts` makes — canonical JSON, ids, names, signed records and
 * messages made by real WebCrypto keys — as a table the native crate (`native/sondra-devices`) has to read
 * the same way: ids from keys, signatures that verify, forgeries that do not.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { freeName, safeFileName, splitPath } from '../src/lib/deviceTransfer'
import { iceServersFor, serverProblem } from '../src/lib/deviceServers'
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

const fileNames = ['Film.mp4', 'a<b>c:d"e/f\\g|h?i*j', '..', '  . leer .  ', 'x'.repeat(250), '', 'Ordner\u0001Name\u007f.txt', ' Folge 1.mkv ', 'CON', 'ü ö ß 日本.mp3', '.versteckt', 'ende.']
const paths: (string | undefined)[] = ['Anime/Staffel 1/Folge 1.mkv', 'Folge.mkv', '../../etc/passwd', '/etc/hosts', 'C:\\Windows\\x.txt', undefined, '', '//./..//', `${Array.from({ length: 20 }, (_, n) => `d${n}`).join('/')}/datei.txt`, 'a/b/..', 'a/./b', ' a / b ', 'nur/ordner/']
const taken = [['Film.mp4'], ['Film.mp4', 'Film (2).mp4', 'Film (3).mp4'], ['.versteckt', '.versteckt (2)'], ['ohne-endung', 'ohne-endung (2)'], ['a.tar.gz']]
const transfer = {
  safe: fileNames.map((name) => ({ name, safe: safeFileName(name) })),
  paths: paths.map((path) => ({ path: path ?? null, split: splitPath(path, 'Ersatz.txt') })),
  free: [
    ...taken.map((list, i) => ({ name: ['Film.mp4', 'Film.mp4', '.versteckt', 'ohne-endung', 'a.tar.gz'][i], taken: list, free: freeName(['Film.mp4', 'Film.mp4', '.versteckt', 'ohne-endung', 'a.tar.gz'][i], (c) => list.includes(c)) })),
    { name: 'frei.txt', taken: [], free: freeName('frei.txt', () => false) },
  ],
  controls: [
    { t: 'start', files: [{ name: 'a.mkv', size: 1234, mime: 'video/x-matroska', path: 'Anime/a.mkv' }, { name: 'b.txt', size: 0, mime: 'text/plain' }] },
    { t: 'ready' },
    { t: 'ready', done: [0, 2], from: { 1: 65536, 3: 4194304 } },
    { t: 'file', i: 1 },
    { t: 'file', i: 2, at: 65536 },
    { t: 'end', i: 1 },
    { t: 'done' },
    { t: 'ack', bytes: 4194304 },
    { t: 'saved', places: ['Downloads/Sondra/a.mkv', 'Ordner/b (2).txt'] },
    { t: 'cancel' },
    { t: 'error', message: 'Kein Platz „mehr“' },
  ].map((c) => ({ value: c, text: JSON.stringify(c) })),
}

writeFileSync(
  `${outDir}/devices.json`,
  `${JSON.stringify({ now, ids, records, believed, picked: picked.map((r) => ({ id: r.id, seen: r.seen })), devices: devices.map((d) => d.id), messages: opened, canon, names, transfer, laptopId: laptopRecord.id, phoneId: phoneRecord.id }, null, 1)}\n`,
)
console.log(`Geräte: ${believed.filter((b) => b.ok).length} Einträge geglaubt, ${believed.filter((b) => !b.ok).length} abgelehnt, ${opened.length} Nachrichten`)

{
  const addresses = ['', '   ', 'stun:beispiel.de:3478', 'STUN:Beispiel.de', 'stuns:[::1]:5349', 'stun:', 'stun::3478', 'stun:host name', 'stun:host?transport=udp', 'turn:beispiel.de:3478', 'turns:beispiel.de:5349?transport=tcp', 'http://beispiel.de', 'stun:' + 'a'.repeat(250), 'stun:äö.de', 'turn:host:3478/pfad', ' turn:host ']
  const problems = addresses.flatMap((address) => (['stun', 'turn'] as const).map((kind) => ({ address, kind, problem: serverProblem(address, kind) })))
  const settings = [
    { stun: '', turn: '', user: '', password: '' },
    { stun: 'stun:a.de:3478', turn: '', user: '', password: '' },
    { stun: 'stun:a.de:3478', turn: 'turn:b.de:3478', user: 'mia', password: 'geheim' },
    { stun: 'turn:falsch', turn: 'stun:falsch', user: 'x', password: 'y' },
    { stun: ' stun:a.de ', turn: ' turns:b.de:5349 ', user: 'mia', password: '' },
    { stun: '', turn: 'turn:b.de', user: '', password: 'ohne Nutzer' },
  ]
  const ice = settings.map((s) => ({ settings: s, servers: iceServersFor(s) }))
  writeFileSync(`${outDir}/servers.json`, `${JSON.stringify({ problems, ice }, null, 1)}\n`)
  console.log('Server: ' + problems.length + ' Adressen, ' + ice.length + ' Einstellungen')
}
