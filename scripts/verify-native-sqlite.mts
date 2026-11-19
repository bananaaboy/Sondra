/**
 * The file the native Merkliste writes (`native/sondra-merk`, test `leaves_a_file_for_the_web_app_to_read`)
 * read by the web app's own reader. A list written there must open here with every entry, season, part,
 * mark, removal and app value in place — a native client that wrote a file the website cannot read would
 * make the list in Drive worse, which it never may.
 *
 *   npm run verify:native-sqlite      (after `cargo test -p sondra-merk`)
 */
import { existsSync, readFileSync } from 'node:fs'

import { deserializeSondraSqlite } from '../src/lib/sqlite'

const dir = process.argv[2] ?? 'native/target/tmp/merk-interop'
if (!existsSync(`${dir}/native.sqlite`)) {
  console.error(`Keine Datei in ${dir}: erst „cargo test -p sondra-merk“ laufen lassen.`)
  process.exit(2)
}

const read = deserializeSondraSqlite(new Uint8Array(readFileSync(`${dir}/native.sqlite`)))
const expected = JSON.parse(readFileSync(`${dir}/native.json`, 'utf8'))

const failures: string[] = []
function compare(path: string, a: unknown, b: unknown) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a !== b) failures.push(`${path}: ${a} ≠ ${b}`)
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) failures.push(`${path}: Länge ${a.length} ≠ ${b.length}`)
    a.forEach((v, i) => compare(`${path}[${i}]`, v, b[i]))
    return
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort()
    const kb = Object.keys(b as object).sort()
    if (ka.join() !== kb.join()) failures.push(`${path}: Schlüssel ${ka.join(',')} ≠ ${kb.join(',')}`)
    for (const k of ka) compare(`${path}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    return
  }
  if (a !== b) failures.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
}

compare('items', read.items, expected.items)
compare('removed', read.removed, expected.removed)
compare('appState', read.appState, expected.appState)

if (failures.length > 0) {
  console.error(`Die native Datei liest sich hier anders (${failures.length}):`)
  for (const f of failures.slice(0, 30)) console.error('  ' + f)
  process.exit(1)
}
console.log(`ok: ${read.items.length} Einträge, ${Object.keys(read.removed).length} Entfernungen, ${Object.keys(read.appState ?? {}).length} Werte — die Website liest die native Datei`)
