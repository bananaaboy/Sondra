/**
 * Writes the table the native Merkliste (`native/sondra-merk`) is tested against: entries read from
 * every odd shape the web app has to put up with, how far they are seen, how they change when something
 * is ticked off, and how two copies merge — each with the web app's own answer. The Rust side must give
 * the same, so a rule changed in `merkliste.ts` that is not carried over fails the check instead of
 * somebody's list in Drive.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { deserializeSondraSqlite, serializeSondraSqlite } from '../src/lib/sqlite'

import { deriveLinkTitle, parseLinkEpisodeInfo } from '../src/lib/download'
import {
  adoptRemovals,
  caughtUp,
  createMerkItem,
  itemProgress,
  markRange,
  mergeMerkliste,
  mergeShared,
  partName,
  partOfEpisode,
  partProgress,
  partsOf,
  seasonName,
  seasonProgress,
  seasonsOf,
  settle,
  sharedKey,
  splitSeason,
  storedParts,
  takeShared,
  toggleWatched,
  travelling,
  watchedUpTo,
  withParts,
  type SavedLinkItem,
} from '../src/lib/merkliste'

const outDir = 'native/sondra-merk/tests/golden'
mkdirSync(outDir, { recursive: true })

const T = 1_700_000_000_000
const entry = (raw: Record<string, unknown>) => ({ id: 'x', updatedAt: T, ...raw })

/* The addresses ------------------------------------------------------------------------------- */

const urls = [
  '',
  '   ',
  'https://aniworld.to/anime/stream/frieren/staffel-2/episode-5',
  'https://aniworld.to/anime/stream/one-piece/filme/film-3',
  'https://aniworld.to/anime/stream/die-reise-nach-%C3%BCbermorgen/staffel-1',
  'aniworld.to/anime/stream/frieren',
  'https://www.s.to/serie/stream/dark/staffel-3/episode-12?x=1#y',
  'https://serienstream.sx/serie/stream/the_boys/staffel-0/episode-2',
  'https://9anime.to/watch/naruto-episode-14',
  'https://mvflix.net/player/tv/1399/3/7',
  'https://example.com/tv/55/2/9',
  'https://www.youtube.com/playlist?list=PL123&index=4',
  'https://www.youtube.com/watch?v=abc123',
  'https://example.com/video?season=2&episode=6',
  'https://example.com/show?staffel=0&folge=3',
  'https://example.com/show?season=abc',
  'https://example.com/show/s02e07/',
  'https://example.com/show/s2e7-title',
  'https://example.com/shows/staffel-4/folge-9',
  'https://example.com/shows/season_2',
  'https://example.com/shows/ep12',
  'https://example.com/media/Mein_Film-2020.mp4',
  'https://example.com/media/a',
  'https://example.com/%E0%A4%A',
  'https://example.com',
  'ftp://nope.example/file',
  'not a url at all :: ??',
  'https://example.com/embed/video/watch/stream',
  'https://example.com/a/b/c.tar.gz',
]

/* The entries read ---------------------------------------------------------------------------- */

const season = (raw: Record<string, unknown>) => ({ number: 1, episodes: 12, watched: [], ...raw })

const raws: Record<string, unknown>[] = [
  // (An entry without an id gets a random one — checked in the Rust tests, not here: a table that changes
  // on every run could not be checked in.)
  { id: 'z0', title: 'Nur Titel' },
  { id: 'a' },
  { id: 'b', title: 'Frieren', url: urls[2], season: 2, episode: 5 },
  { id: 'c', url: urls[2] },
  { id: 'c2', url: urls[3] },
  { id: 'c3', url: urls[4] },
  { id: 'c4', url: urls[7] },
  { id: 'c5', url: urls[11] },
  { id: 'd', title: '', url: '' },
  { id: 'e', status: 'paused' },
  { id: 'f', status: 'nonsense' },
  { id: 'g', status: 'dropped', language: 'de', mode: 'audio', audioFormat: 'flac', videoPref: 'p720', audioPref: 'low', autoTranscribe: true },
  { id: 'h', mode: 'other', autoTranscribe: 'yes' },
  { id: 'i', episode: null },
  { id: 'j', episode: 7, season: 3 },
  { id: 'k', season: 'x', episode: 'y', url: urls[16] },
  { id: 'l', lastOpenedAt: T - 5, rating: 2.5 },
  { id: 'l2', rating: -1 },
  { id: 'l3', rating: 7 },
  { id: 'l4', rating: 0.4 },
  { id: 'm', episodeDuration: 23.6, filmDuration: 0, opening: 9 },
  { id: 'm2', opening: 10, episodeDuration: -3, filmDuration: 95.4 },
  { id: 'm3', opening: 600.4 },
  { id: 'm4', opening: 600 },
  { id: 'n', durations: { '1:1': 48, '2:3': 12 }, notes: 'Kurz', cover: 'https://x/y.jpg', coverFrame: { x: 20, y: 80, zoom: 2 } },
  { id: 'n2', cover: 'https://x/y.jpg', coverFrame: { x: 50, y: 50, zoom: 1 } },
  { id: 'n3', cover: 'https://x/y.jpg', coverFrame: { x: -5, y: 140, zoom: 9 } },
  { id: 'n4', coverFrame: { x: 20, y: 80, zoom: 2 } },
  { id: 'n5', tileFormat: 'manga' },
  { id: 'n6', tileFormat: 'poster' },
  { id: 'o', tags: ['Anime', '#Liebling', '  ##Comedy ', 'Anime', '', '   ', 3] },
  { id: 'o2', tags: [] },
  { id: 'p', history: [{ id: 'wh-1', season: 1, episode: 2, at: T }, { id: 'wh-3', at: T, season: 1, episode: 3 }, { id: 'bad', season: 'x', episode: 1 }, { id: 'w2', season: -2, episode: 0.2, at: 5 }] },
  { id: 'q', onlineAvailable: { maxSeason: 0, maxEpisode: 0, checkedAt: T, hasNew: true } },
  { id: 'q2', onlineAvailable: { maxSeason: 3.7, maxEpisode: '12', checkedAt: T } },
  { id: 'q3', onlineAvailable: 'x' },
  { id: 'r', goal: { season: 3, episode: 12, by: '2026-12-01', setAt: T, count: 7.5 } },
  { id: 'r2', goal: { season: -1, episode: 1 } },
  { id: 'r3', goal: { season: 2, episode: 0 } },
  { id: 'r4', goal: { season: 2.9, episode: 4.2, by: '1.12.2026', setAt: T, count: -2 } },
  {
    id: 's',
    intros: [
      { print: 'AAAA', seconds: 89.04, learnedAt: 5 },
      { print: '', seconds: 10, learnedAt: 1 },
      { print: 'BB', seconds: 0, learnedAt: 1 },
      { print: 'CC', seconds: 12.34, learnedAt: '7' },
      { print: 'DD', seconds: 20 },
      { print: 'EE', seconds: 21, learnedAt: 9 },
      { print: 'FF', seconds: 22, learnedAt: 10 },
      { print: 'GG', seconds: 23, learnedAt: 11 },
    ],
  },
  { id: 's2', intros: [{ print: 'x'.repeat(1601), seconds: 5 }] },
  { id: 's3', intros: [] },
  // Seasons.
  { id: 't', seasons: [] },
  { id: 't2', season: 1, episode: 4, seasons: [season({ watched: [1, 2, 3] })] },
  { id: 't3', seasons: [season({ number: 2, episodes: 0, watched: [3, 1, 2, 2, 'x', 1.5, -4, 0] }), season({ number: 0, episodes: 3.9 }), season({ number: -2, episodes: null })] },
  { id: 't4', season: 1, episode: 20, seasons: [season({ episodes: 12, watched: [1, 2, 3, 13, 14] })] },
  { id: 't5', season: 1, episode: 13, seasons: [season({ episodes: 12, watched: Array.from({ length: 12 }, (_, i) => i + 1) }), season({ number: 2, episodes: 12, watched: [1, 2] })] },
  { id: 't6', status: 'done', season: 1, episode: 99, seasons: [season({ episodes: 12, watched: Array.from({ length: 12 }, (_, i) => i + 1) })] },
  { id: 't7', seasons: [season({ title: 'Der Anfang', cover: 'https://s/c.jpg', coverFrame: { x: 10, y: 10, zoom: 1.5 } }), season({ number: 2, cover: '', coverFrame: { x: 10, y: 10, zoom: 1.5 } })] },
  { id: 't8', seasons: [null, 7, { number: 'x' }, season({})] },
  {
    id: 'u',
    seasons: [
      season({
        episodes: 99,
        watched: [1, 2, 13, 14, 25],
        parts: [
          { episodes: 12, title: 'Teil A' },
          { episodes: 12, cover: 'https://p/1.jpg', coverFrame: { x: 1, y: 2, zoom: 3 } },
          { episodes: null },
        ],
      }),
    ],
  },
  { id: 'u2', seasons: [season({ parts: [{ episodes: 12 }, { episodes: null }, { episodes: 5 }] })] },
  { id: 'u3', seasons: [season({ episodes: 12, watched: [1, 2], parts: [{ episodes: 6, cover: 'https://only/part.jpg' }] })] },
  { id: 'u4', seasons: [season({ episodes: 12, cover: 'https://own/season.jpg', parts: [{ episodes: 6, cover: 'https://only/part.jpg' }] })] },
  { id: 'u5', seasons: [season({ parts: [null, 'x', { episodes: 4 }, { episodes: 4 }] })] },
  { id: 'v', unknownField: 'dropped', title: 'Ünïcode — Ärger' },
  // Not here: text fields holding something that is no text. The web app keeps such a value as it is;
  // the native one makes it text — a stored list never has them.
]

const readCases = raws.map((raw) => {
  const input = { updatedAt: T, ...raw }
  return { raw: input, item: createMerkItem(input as Partial<SavedLinkItem>) }
})

/* Progress ------------------------------------------------------------------------------------ */

const progressCases = readCases.map(({ item }) => {
  const seasons = seasonsOf(item)
  return {
    id: item.id,
    seasonsOf: seasons,
    itemProgress: itemProgress(item),
    seasons: seasons.map((s) => ({
      number: s.number,
      name: seasonName(s),
      progress: seasonProgress(s),
      parts: partsOf(s).map((p) => ({ part: p, name: partName(s, p), progress: partProgress(s, p) })),
      stored: storedParts(s),
      split: splitSeason(s),
      ofEpisode: [null, 1, 7, 13, 30].map((e) => ({ e, index: partOfEpisode(s, e).index })),
    })),
    caughtUp: caughtUp(seasons),
    toggled: [1, 5, 13].map((e) => ({ e, seasons: toggleWatched(item, item.season, e) })),
    upTo: [1, 4, 13, 40].map((e) => ({ e, seasons: watchedUpTo(item, item.season, e) })),
    range: markRange(item, item.season, 3, 8, true),
    unrange: markRange(item, item.season, 3, 8, false),
    settled: seasons.length > 0 ? [item.season, 0, 2, 99].map((from) => ({ from, settled: settle(item, seasons, from) })) : [],
    withParts: seasons.length > 0 ? withParts(seasons[0], [{ episodes: 5 }, { episodes: null }, { episodes: 3 }]) : null,
    withOne: seasons.length > 0 ? withParts(seasons[0], [{ episodes: 9, cover: 'https://one/part.jpg' }]) : null,
  }
})

/* Merging ------------------------------------------------------------------------------------- */

const mk = (raw: Record<string, unknown>) => createMerkItem({ updatedAt: T, ...raw } as Partial<SavedLinkItem>)
const picture = 'data:image/webp;base64,AAAA'

const local = [
  mk({ id: 'a', title: 'Frieren', updatedAt: T + 10, season: 1, episode: 3 }),
  mk({ id: 'b', title: 'Dark', updatedAt: T, cover: picture, coverFrame: { x: 10, y: 10, zoom: 2 } }),
  mk({ id: 'c', title: 'Same One', updatedAt: T }),
  mk({ id: 'd', title: 'Only Here', updatedAt: T, seasons: [{ number: 1, episodes: 12, watched: [1], cover: picture, coverFrame: { x: 1, y: 1, zoom: 1.5 }, parts: [{ episodes: 6, cover: picture }, { episodes: 6 }] }] }),
  mk({ id: 'e', title: 'Removed Remote', updatedAt: T }),
  mk({ id: 'f', title: 'Back Again', updatedAt: T + 50 }),
]
const remote = [
  mk({ id: 'a2', title: ' frieren ', updatedAt: T + 20, season: 1, episode: 9 }),
  mk({ id: 'b', title: 'Dark', updatedAt: T - 5, cover: 'sondra:lokal', status: 'done' }),
  mk({ id: 'c', title: 'Same One', updatedAt: T }),
  mk({ id: 'd', title: 'Only Here', updatedAt: T + 1, seasons: [{ number: 1, episodes: 12, watched: [1, 2], cover: 'sondra:lokal', parts: [{ episodes: 6, cover: 'sondra:lokal' }, { episodes: 6, cover: 'sondra:lokal' }] }] }),
  mk({ id: 'e', title: 'Removed Remote', updatedAt: T }),
  mk({ id: 'f', title: 'Back Again', updatedAt: T + 5 }),
  mk({ id: 'g', title: 'New There', updatedAt: T + 3, cover: 'sondra:lokal' }),
  mk({ id: 'h', title: 'Gone Here', updatedAt: T }),
]

const removedCases: { local: Record<string, number>; remote: Record<string, number> }[] = [
  { local: {}, remote: {} },
  { local: { h: T + 100 }, remote: { e: T + 1 } },
  { local: { f: T + 20 }, remote: { f: T + 10, g: T + 3 } },
  { local: { f: T + 60 }, remote: { f: T + 70 } },
  { local: { zzz: 5 }, remote: { zzz: 9, h: T } },
]

const mergeCases = removedCases.map(({ local: lr, remote: rr }) => {
  adoptRemovals(lr)
  const shared = mergeShared(local, { items: remote, removed: rr })
  return {
    localRemoved: lr,
    remoteRemoved: rr,
    shared,
    key: JSON.parse(sharedKey(shared.items, shared.removed)),
  }
})

adoptRemovals({})
const merged = mergeMerkliste(local, remote)
const importCases = [
  { current: local, incoming: remote, result: merged },
  { current: [], incoming: remote, result: mergeMerkliste([], remote) },
  { current: local, incoming: [], result: mergeMerkliste(local, []) },
  { current: local, incoming: local, result: mergeMerkliste(local, local) },
]

// The SQLite file the web app writes for a list, and what its own reader makes of it: the native reader
// is held to the second, and the native writer is held to being read by the first (`scripts/verify-native-sqlite.mts`).
const fileItems = mergeCases[1].shared.items
const fileRemoved = mergeCases[1].shared.removed
const fileState = {
  ansicht: { value: 'liste', updatedAt: T },
  sortierung: { value: { by: 'titel', up: true }, updatedAt: T + 1 },
}
const sqliteBytes = serializeSondraSqlite({
  items: fileItems.map(travelling) as unknown as Record<string, unknown>[],
  removed: fileRemoved,
  appState: fileState,
})
writeFileSync(`${outDir}/web.sqlite`, sqliteBytes)
const sqlite = deserializeSondraSqlite(sqliteBytes)

const out = {
  sqlite,
  urls: urls.map((url) => ({ url, info: parseLinkEpisodeInfo(url), title: deriveLinkTitle(url) })),
  read: readCases,
  progress: progressCases,
  import: importCases,
  travelling: local.concat(remote).map((item) => ({ item, travelling: travelling(item) })),
  mergeShared: mergeCases,
  takeShared: { current: local, remote, result: takeShared(local, { items: remote }) },
}
writeFileSync(`${outDir}/merk.json`, JSON.stringify(out, null, 1) + '\n')
console.log(`Merkliste: ${urls.length} Adressen, ${readCases.length} Einträge, ${mergeCases.length} Abgleiche`)
