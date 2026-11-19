/**
 * The store-only ZIP the website writes (`createZip`, `zipName`, `uniqueEntryNames` in `src/lib/zip.ts`): the bytes
 * of archives with fixed dates, the names a typed name becomes, and how equal names are told apart. The native
 * `sondra-media::zip` must write the same bytes and make the same names.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { createZip, uniqueEntryNames, zipName } from '../src/lib/zip'

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const bytesOf = (text: string) => new TextEncoder().encode(text)

/** A date given by its parts, so no time zone gets a say. */
type Parts = [number, number, number, number, number, number]
const dateOf = ([y, mo, d, h, mi, s]: Parts) => new Date(y, mo - 1, d, h, mi, s)

const archives: { entries: { name: string; data: string; date: Parts }[]; zip: string }[] = []
const sets: { name: string; data: Uint8Array; date: Parts }[][] = [
  [],
  [{ name: 'eins.wav', data: bytesOf('hello'), date: [2026, 11, 19, 10, 30, 42] }],
  [
    { name: 'Stems/Gesang.wav', data: new Uint8Array(1000).map((_, i) => (i * 7) % 256), date: [2026, 1, 2, 3, 4, 6] },
    { name: 'Stems/Gesang.wav', data: bytesOf(''), date: [1999, 12, 31, 23, 59, 58] },
    { name: '../böse:name?.mp3', data: bytesOf('ä ö ü'), date: [2030, 6, 15, 12, 0, 0] },
    { name: '', data: bytesOf('x'), date: [2026, 11, 19, 0, 0, 1] },
    { name: 'a/b\\c/.../d', data: new Uint8Array(70000).map((_, i) => (i * 31 + 5) % 256), date: [2026, 2, 28, 14, 15, 16] },
    { name: 'ohne-endung', data: bytesOf('1'), date: [2026, 11, 19, 10, 30, 42] },
    { name: 'ohne-endung', data: bytesOf('2'), date: [2026, 11, 19, 10, 30, 42] },
  ],
]
for (const set of sets) {
  const zip = createZip(set.map((e) => ({ name: e.name, data: e.data, date: dateOf(e.date) })))
  archives.push({ entries: set.map((e) => ({ name: e.name, data: b64(e.data), date: e.date })), zip: b64(zip) })
}

const typed: [string, string][] = [
  ['Mein Mix', 'x'],
  ['  Mix: Live?  ', 'x'],
  ['A/B', 'x'],
  ['Musik.zip', 'x'],
  ['MUSIK.ZIP', 'x'],
  ['', 'Vorschlag'],
  ['', ''],
  ['con', 'x'],
  ['LPT1', 'x'],
  ['..hinten.', 'x'],
  ['viel   Platz', 'x'],
  ['a'.repeat(200), 'x'],
  ['\u0001kaputt\u001f', 'x'],
]
const names = typed.map(([t, s]) => ({ typed: t, suggestion: s, ...zipName(t, s) }))

const unique = [
  [{ name: 'a.wav' }, { name: 'A.wav' }, { name: 'a.wav' }, { name: 'b' }, { name: 'b' }, { name: '.hidden' }, { name: '.hidden' }],
  [{ name: 'x (2).mp3' }, { name: 'x.mp3' }, { name: 'x.mp3' }, { name: 'x.mp3' }],
].map((list) => ({ in: list.map((e) => e.name), out: uniqueEntryNames(list.map((e) => ({ name: e.name, data: new Uint8Array() }))).map((e) => e.name) }))

mkdirSync('native/sondra-media/tests/golden', { recursive: true })
writeFileSync('native/sondra-media/tests/golden/zip.json', JSON.stringify({ archives, names, unique }, null, 1) + '\n')
console.log(`zip golden: ${archives.length} archives, ${names.length} names, ${unique.length} lists`)
