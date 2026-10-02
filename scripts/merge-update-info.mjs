/**
 * One latest.yml for both Windows builds.
 *
 *   node scripts/merge-update-info.mjs <x64/latest.yml> <arm64/latest.yml> <out/latest.yml>
 *
 * The installed app's updater reads latest.yml and, among its `files`, takes
 * the one whose name contains its own architecture — and the first one when
 * none does. So the x64 setup stays first (its name has no "x64"; installs
 * before 1.0.13 are x64 and must keep finding it), and the arm64 setup is
 * added behind it. The top-level `path` and `sha512`, read by very old
 * updaters, stay the x64 ones.
 *
 * The files are the flat YAML electron-builder writes; this splices the
 * `files:` list rather than pulling in a YAML library for it.
 */

import fs from 'node:fs'

const [x64File, armFile, outFile] = process.argv.slice(2)
if (!x64File || !armFile || !outFile) {
  console.error('Aufruf: node scripts/merge-update-info.mjs <x64/latest.yml> <arm64/latest.yml> <ziel/latest.yml>')
  process.exit(2)
}

/** The lines of the `files:` list: from the line after `files:` to the next top-level key. */
function filesBlock(lines) {
  const start = lines.findIndex((line) => line.trimEnd() === 'files:')
  if (start < 0) throw new Error('Kein "files:" in latest.yml.')
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('-') || lines[end] === '')) end += 1
  return { start, end }
}

const version = (lines) => lines.find((line) => line.startsWith('version:'))?.split(':')[1].trim()

const x64 = fs.readFileSync(x64File, 'utf8').split(/\r?\n/)
const arm = fs.readFileSync(armFile, 'utf8').split(/\r?\n/)
if (version(x64) !== version(arm)) throw new Error(`Versionen passen nicht: ${version(x64)} und ${version(arm)}.`)

const armBlock = filesBlock(arm)
const armEntries = arm.slice(armBlock.start + 1, armBlock.end).filter((line) => line.trim())
if (!armEntries.some((line) => /url: .*arm64/.test(line))) throw new Error('Die Arm-Datei nennt kein arm64-Setup.')

const x64Block = filesBlock(x64)
const x64Entries = x64.slice(x64Block.start + 1, x64Block.end).filter((line) => line.trim())
if (x64Entries.some((line) => /url: .*arm64/.test(line))) throw new Error('Die x64-Datei nennt schon ein arm64-Setup.')

const merged = [...x64.slice(0, x64Block.end).filter((line, index) => index <= x64Block.start || line.trim()), ...armEntries, ...x64.slice(x64Block.end)]
fs.writeFileSync(outFile, merged.join('\n'))
console.log(`latest.yml für ${version(x64)}: ${x64Entries.filter((l) => l.includes('url:')).length + armEntries.filter((l) => l.includes('url:')).length} Setups (x64 zuerst, dann arm64).`)
