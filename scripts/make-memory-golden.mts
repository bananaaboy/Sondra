/**
 * Writes the table the native folder memory (`native/sondra-merk`, `folder_memory.rs`) is tested against:
 * a few scenarios run through the web app's own `folderMemory.ts` on a store in memory, each step with
 * what it answered and what the store held afterwards.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { folderKey, lastVisit, prefsFor, savePrefs, type Store } from '../src/lib/folderMemory'

const outDir = 'native/sondra-merk/tests/golden'
mkdirSync(outDir, { recursive: true })

type Step =
  | { op: 'set'; key: string; value: string }
  | { op: 'save'; key: string | null; prefs: Record<string, unknown> }
  | { op: 'prefs'; key: string; defaults: Record<string, unknown> }
  | { op: 'visit'; key: string; now: number }
  | { op: 'newSession' }
  | { op: 'key'; name: string; drive: boolean }

const defaults = { kind: 'all', sort: 'name', view: 'tiles', depth: 'here', bySeries: false, unseen: false }
const prefsA = { kind: 'video', sort: 'date', view: 'list', depth: 'all', bySeries: true, unseen: false }
const prefsB = { kind: 'audio', sort: 'size', view: 'tiles', depth: 'here', bySeries: false, unseen: true, foreign: 'dropped' }

const many: Step[] = []
for (let i = 0; i < 45; i++) many.push({ op: 'visit', key: `geraet:Ordner ${i}`, now: 1_700_000_000_000 + i })
for (let i = 0; i < 45; i++) many.push({ op: 'save', key: `geraet:Ordner ${i}`, prefs: { ...prefsA, sort: i % 2 ? 'name' : 'date' } })
many.push({ op: 'newSession' })
many.push({ op: 'visit', key: 'geraet:Ordner 0', now: 1_800_000_000_000 }, { op: 'visit', key: 'geraet:Ordner 44', now: 1_800_000_000_001 })
many.push({ op: 'prefs', key: 'geraet:Ordner 0', defaults }, { op: 'prefs', key: 'geraet:Ordner 44', defaults })

const scenarios: { name: string; steps: Step[] }[] = [
  {
    name: 'first folder gets the defaults',
    steps: [{ op: 'prefs', key: 'geraet:Anime', defaults }, { op: 'visit', key: 'geraet:Anime', now: 1_700_000_000_000 }, { op: 'visit', key: 'geraet:Anime', now: 1_700_000_005_000 }],
  },
  {
    name: 'one folder, then a new one starts from the last set',
    steps: [
      { op: 'save', key: 'geraet:Anime', prefs: prefsA },
      { op: 'prefs', key: 'geraet:Anime', defaults },
      { op: 'prefs', key: 'geraet:Musik', defaults },
      { op: 'save', key: 'drive:Sondra', prefs: prefsB },
      { op: 'prefs', key: 'geraet:Anime', defaults },
      { op: 'prefs', key: 'drive:Sondra', defaults },
      { op: 'prefs', key: 'geraet:Neu', defaults },
    ],
  },
  {
    name: 'saving without a folder only moves the last set',
    steps: [{ op: 'save', key: null, prefs: prefsB }, { op: 'prefs', key: 'geraet:X', defaults }],
  },
  {
    name: 'a folder keeps its place: saved again it goes last',
    steps: [
      { op: 'save', key: 'a', prefs: prefsA },
      { op: 'save', key: 'b', prefs: prefsB },
      { op: 'save', key: 'a', prefs: prefsB },
      { op: 'prefs', key: 'a', defaults },
    ],
  },
  {
    name: 'broken and foreign storage reads as empty',
    steps: [
      { op: 'set', key: 'sondra:ordner', value: '[1,2,3]' },
      { op: 'set', key: 'sondra:ordner:je', value: 'not json' },
      { op: 'set', key: 'sondra:ordner:besuch', value: '"text"' },
      { op: 'prefs', key: 'geraet:Anime', defaults },
      { op: 'visit', key: 'geraet:Anime', now: 5 },
      { op: 'save', key: 'geraet:Anime', prefs: prefsA },
      { op: 'prefs', key: 'geraet:Anime', defaults },
    ],
  },
  {
    name: 'a folder entry that is not an object, a visit that is not a number',
    steps: [
      { op: 'set', key: 'sondra:ordner:je', value: '{"geraet:A":5,"geraet:B":null,"geraet:C":{"kind":null,"view":"list"}}' },
      { op: 'set', key: 'sondra:ordner:besuch', value: '{"geraet:A":"yesterday","geraet:B":12.5}' },
      { op: 'prefs', key: 'geraet:A', defaults },
      { op: 'prefs', key: 'geraet:B', defaults },
      { op: 'prefs', key: 'geraet:C', defaults },
      { op: 'visit', key: 'geraet:A', now: 100 },
      { op: 'visit', key: 'geraet:B', now: 200 },
    ],
  },
  {
    name: 'a visit is the same all session, and new in the next',
    steps: [
      { op: 'visit', key: 'geraet:Film', now: 1000 },
      { op: 'visit', key: 'geraet:Film', now: 2000 },
      { op: 'visit', key: 'drive:Film', now: 3000 },
      { op: 'newSession' },
      { op: 'visit', key: 'geraet:Film', now: 4000 },
      { op: 'visit', key: 'geraet:Film', now: 5000 },
    ],
  },
  { name: 'forty folders and a few more', steps: many },
  {
    name: 'keys',
    steps: [{ op: 'key', name: 'Anime', drive: false }, { op: 'key', name: 'Sondra', drive: true }, { op: 'key', name: 'Ä: Ö', drive: false }],
  },
]

function run(steps: Step[]) {
  const data = new Map<string, string>()
  const store: Store = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  let session = new Map<string, number | null>()
  return steps.map((step) => {
    let result: unknown = null
    if (step.op === 'set') data.set(step.key, step.value)
    else if (step.op === 'save') savePrefs(step.key, step.prefs, store)
    else if (step.op === 'prefs') result = prefsFor(step.defaults, step.key, store)
    else if (step.op === 'visit') result = lastVisit(step.key, step.now, store, session)
    else if (step.op === 'newSession') session = new Map()
    else if (step.op === 'key') result = folderKey(step.name, step.drive ? 'drive' : undefined)
    return { step, result, store: Object.fromEntries([...data.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) }
  })
}

writeFileSync(`${outDir}/folder-memory.json`, JSON.stringify(scenarios.map((s) => ({ name: s.name, trace: run(s.steps) })), null, 1))
console.log(`folder-memory golden: ${scenarios.length} scenarios`)
