// The changelog every platform shows („Was ist neu“) and the release notes
// are read from: the version in package.json must have an entry, the newest
// first, each with a date and at least one line. The release workflow reads
// the same entry as the notes of the GitHub release.
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { versions } = JSON.parse(readFileSync(new URL('../src/changelog.json', import.meta.url), 'utf8'))

const problems = []
const seen = new Set()
for (const entry of versions) {
  if (seen.has(entry.version)) problems.push(`${entry.version} steht zweimal da.`)
  seen.add(entry.version)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date ?? '')) problems.push(`${entry.version}: Datum fehlt oder ist nicht JJJJ-MM-TT.`)
  if (!Array.isArray(entry.items) || !entry.items.length || entry.items.some((item) => typeof item !== 'string' || !item.trim())) {
    problems.push(`${entry.version}: keine Zeilen.`)
  }
}
const parts = (v) => v.split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
for (let i = 1; i < versions.length; i += 1) {
  if (!newer(versions[i - 1].version, versions[i].version)) problems.push(`${versions[i - 1].version} steht vor ${versions[i].version}: die neueste zuerst.`)
}
if (versions[0]?.version !== version) problems.push(`Version ${version} aus package.json hat keinen Eintrag oben in src/changelog.json.`)

if (problems.length) {
  for (const problem of problems) console.error(`changelog: ${problem}`)
  process.exit(1)
}

console.log(`changelog: ${versions.length} Versionen, ${version} oben.`)
