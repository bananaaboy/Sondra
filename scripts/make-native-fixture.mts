/**
 * Writes the fixtures the Rust core is tested against, using the real
 * serializer of the web app — so the native side reads exactly what the
 * other devices write, not what it imagines they write.
 *
 *   npm run native:fixture
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { serializeSondraSqlite } from '../src/lib/sqlite'

const outDir = 'native/sondra-core/tests/fixtures'
mkdirSync(outDir, { recursive: true })

const base = {
  language: 'auto',
  mode: 'video',
  audioFormat: 'mp3',
  videoPref: 'untouched',
  audioPref: 'high',
  autoTranscribe: false,
}

const items = [
  {
    ...base,
    id: 'frieren',
    url: 'https://aniworld.to/anime/stream/frieren',
    title: 'Frieren',
    season: 1,
    episode: 11,
    updatedAt: 1_790_000_000_000,
    status: 'watching',
    rating: 4.5,
    tags: ['Fantasy'],
    onlineAvailable: { maxSeason: 1, maxEpisode: 14, checkedAt: 1_790_000_100_000 },
    seasons: [{ number: 1, episodes: 28, watched: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
    history: [
      { id: 'wh-1', season: 1, episode: 10, at: 1_789_999_000_000 },
      { id: 'wh-2', season: 1, episode: 9, at: 1_789_998_000_000 },
    ],
    // A field this version of the core does not know: it has to survive.
    futureField: { kept: true },
  },
  {
    ...base,
    id: 'naruto',
    url: 'https://aniworld.to/anime/stream/naruto',
    title: 'Naruto',
    season: 1,
    episode: null,
    updatedAt: 1_780_000_000_000,
    status: 'done',
    seasons: [{ number: 1, episodes: 3, watched: [1, 2, 3] }],
  },
  {
    ...base,
    id: 'rezero',
    url: 'https://aniworld.to/anime/stream/re-zero',
    title: 'Re:Zero',
    season: 2,
    episode: 3,
    updatedAt: 1_791_000_000_000,
    status: 'watching',
    onlineAvailable: { maxSeason: 3, maxEpisode: 2, checkedAt: 1_791_000_100_000 },
    seasons: [
      { number: 1, episodes: 25, watched: Array.from({ length: 25 }, (_, i) => i + 1) },
      { number: 2, episodes: 4, watched: [1, 2] },
      { number: 3, episodes: null, watched: [] },
    ],
  },
  {
    ...base,
    id: 'film',
    url: '',
    title: 'Ein Film ohne Adresse',
    season: 0,
    episode: null,
    updatedAt: 1_770_000_000_000,
  },
]

const removed = { gone: 1_792_000_000_000 }
const appState = { 'sondra:ordner': { value: { sort: 'name' }, updatedAt: 1_790_000_000_000 } }

writeFileSync(`${outDir}/merkliste.sqlite`, serializeSondraSqlite({ items, removed, appState }))
writeFileSync(
  `${outDir}/merkliste.json`,
  JSON.stringify({ kind: 'sondra-merkliste', version: 2, exportedAt: '2026-11-18T10:00:00.000Z', items, removed }, null, 2),
)
console.log(`fixtures written to ${outDir}`)
