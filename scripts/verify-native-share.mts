/**
 * The links and files the native sharing writes (`native/sondra-merk`, test
 * `leaves_links_and_files_for_the_web_app_to_read`) opened by the web app's own code. A link made in the
 * native client must open on the website with every title, mark and picture in place.
 *
 *   npm run verify:native-share      (after `cargo test -p sondra-merk`)
 */
import { existsSync, readFileSync } from 'node:fs'

import { decodeShare, readShareFile } from '../src/lib/merkShare'

const dir = process.argv[2] ?? 'native/target/tmp/merk-interop'
if (!existsSync(`${dir}/share.json`)) {
  console.error(`Keine Datei in ${dir}: erst „cargo test -p sondra-merk“ laufen lassen.`)
  process.exit(2)
}
const cases = JSON.parse(readFileSync(`${dir}/share.json`, 'utf8')) as { key: string; list: { name: string; items: Record<string, unknown>[] }; link: string; file: string }[]
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16))
const plain = (list: { name: string; items: { thumb?: Uint8Array }[] } | null) =>
  list && JSON.stringify({ name: list.name, items: list.items.map((i) => ({ ...i, thumb: i.thumb ? hex(i.thumb) : undefined })) })

let bad = 0
for (const c of cases) {
  const want = JSON.stringify({ name: c.list.name, items: c.list.items.map((i) => ({ ...i, thumb: i.thumb })) })
  const fromLink = plain(await decodeShare(c.link))
  const fromFile = plain(await readShareFile(fromHex(c.file)))
  // Keys in another order mean the same: compare as values.
  const same = (a: string | null) => a !== null && JSON.stringify(JSON.parse(a), Object.keys(JSON.parse(a)).sort()) !== '' && deepEqual(JSON.parse(a), JSON.parse(want))
  if (!same(fromLink)) {
    bad += 1
    console.error(`${c.key}: der Link liest sich anders`)
  }
  if (!same(fromFile)) {
    bad += 1
    console.error(`${c.key}: die Datei liest sich anders`)
  }
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}
if (bad > 0) process.exit(1)
console.log(`ok: ${cases.length} Listen als Link und als Datei — die Website öffnet, was das native Teilen schreibt`)
