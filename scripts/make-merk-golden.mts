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
import {
  dayLabel,
  dayText,
  decimal,
  finishAt,
  goalState,
  inLabel,
  lastPoint,
  lengthLabel,
  openingOf,
  paceFor,
  paceSetting,
  parseDay,
  pointLabel,
  recentPace,
  seasonEnd,
  standPoint,
  watchPlan,
  type PlanOptions,
  type PlanPoint,
} from '../src/lib/watchPlan'
import { recapYears, recordedSince, yearRecap } from '../src/lib/recap'
import { alreadySeen, guessEpisode, matchEpisode, matchHint, normalTitle, seenEpisode } from '../src/lib/episodeMatch'

// The person's own days: the clocks change in the nights of 29 March and 25 October, and the numbers
// must come out right across them. (The native side is tested in the same zone.)
process.env.TZ = 'Europe/Zurich'

import { deriveLinkTitle, parseLinkEpisodeInfo } from '../src/lib/download'
import {
  adoptRemovals,
  allHistory,
  allTags,
  calculateBingePlan,
  calculateMerklisteStats,
  caughtUp,
  createMerkItem,
  durationOfEpisode,
  formatWatchMinutes,
  readMerklisteFile,
  itemProgress,
  itemRemainingMinutes,
  itemWatchedMinutes,
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
  sortMerkItems,
  splitSeason,
  storedParts,
  takeShared,
  toggleWatched,
  travelling,
  watchedUpTo,
  withParts,
  type SavedLinkItem,
  onlineNews,
  takeOnlineNews,
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
    news: [[1, 5], [1, 13], [1, 40], [2, 3], [3, 1], [0, 4], [item.season, 99]].map(([maxSeason, maxEpisode]) => {
      const online = { maxSeason, maxEpisode, checkedAt: 1 }
      const taken = takeOnlineNews({ ...item, onlineAvailable: online })
      return { online, news: onlineNews(item, online), taken }
    }),
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

/* Statistics, sorting, the plan ---------------------------------------------------------------- */

const all = readCases.map((c) => c.item)
const titles = [
  'banana', 'Äpfel', 'apfel', 'Zebra', 'zebra', 'Ärger', 'Über', 'uber', 'ß-Test', 'Strasse', 'Straße', '10 Dinge', '2 Fast', '  Leer', '(Klammer)',
  'One Piece', 'one-piece', 'Os', 'Öl', 'Oz', 'éclair', 'eclair', 'Zoë', '100', '9', 'Naruto: Shippuden', 'naruto shippuden', 'Frieren', 'FRIEREN', '',
]
const titled = titles.map((title, i) => mk({ id: `ti${i}`, title: title || 'Leer?', updatedAt: T + i }))
const sorts = ['recent', 'title', 'rating', 'progress', 'remaining', 'episodes'] as const
const subsets: [string, SavedLinkItem[]][] = [
  ['alle', all],
  ['leer', []],
  ['fünf', all.slice(0, 5)],
  ['mit Staffeln', all.filter((i) => i.seasons && i.seasons.length > 0)],
  ['bewertet', all.filter((i) => typeof i.rating === 'number')],
  ['Titel', titled],
]
const statCases = subsets.map(([name, list]) => {
  const stats = calculateMerklisteStats(list)
  return {
    name,
    stats: { ...stats, recentItems: stats.recentItems.map((i) => i.id) },
    sorted: Object.fromEntries(sorts.map((by) => [by, sortMerkItems(list, by).map((i) => i.id)])),
    minutes: list.map((i) => ({ id: i.id, watched: itemWatchedMinutes(i), remaining: itemRemainingMinutes(i) })),
  }
})
const minuteCases = [-5, 0, 1, 7, 45, 59, 60, 61, 90, 119, 120, 600, 1439, 1440, 1441, 2880, 3000, 12345, 123456, 1_234_567, 5_000_000]
const durationCases = all.slice(0, 20).flatMap((item) => [[0, 1], [1, 1], [1, 2], [2, 3]].map(([s, e]) => ({ id: item.id, s, e, minutes: durationOfEpisode(item, s, e) })))
const plans = [[0, 24], [1, 24], [5, 24], [13, 45], [100, 24]].map(([n, m]) => ({ n, m, plan: (({ episodesRemaining, watchTime }) => ({ episodesRemaining, watchTime }))(calculateBingePlan(n, m)) }))
  .concat([{ n: 7, m: 24, plan: (({ episodesRemaining, watchTime }) => ({ episodesRemaining, watchTime }))(calculateBingePlan(7, 24, 333)) }])
const dateLabels = Array.from({ length: 60 }, (_, i) => {
  const d = new Date(2026, 0, 1 + i * 6)
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), label: d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short' }) }
})

/* The plan, pace, goals, the recap ------------------------------------------------------------ */

const withSeasons = all.filter((i) => seasonsOf(i).length > 0)
const optionSets: PlanOptions[] = [
  { from: 'stand', speed: 1, skipOpening: 0 },
  { from: 'start', speed: 1.5, skipOpening: 90 },
  { from: 'stand', speed: 2, skipOpening: 300 },
  { from: 'stand', speed: 7, skipOpening: 5000 },
  { from: 'stand', speed: 0, skipOpening: 0 },
]
const planCases = withSeasons.map((item) => {
  const targets: PlanPoint[] = [
    standPoint(item),
    ...(lastPoint(item) ? [lastPoint(item) as PlanPoint] : []),
    ...(seasonEnd(item) ? [seasonEnd(item) as PlanPoint] : []),
    { season: 2, episode: 5 },
    { season: 0, episode: 1 },
    { season: 1, episode: 1 },
    { season: 3, episode: 20 },
  ]
  return {
    id: item.id,
    stand: standPoint(item),
    last: lastPoint(item),
    end: seasonEnd(item),
    opening: [undefined, 120].map((f) => (f === undefined ? openingOf(item) : openingOf(item, f))),
    plans: targets.flatMap((target) => optionSets.map((options, o) => ({ target, o, plan: watchPlan(item, target, options) }))),
  }
})

const today = new Date(2026, 2, 27)
const paceCases = {
  today: dayText(today),
  finish: [[0, 2, 'day'], [1, 2, 'day'], [5, 2, 'day'], [5, 1, 'week'], [13, 0.3, 'week'], [100, 3, 'day'], [7, 0, 'day'], [30, 5, 'week']].map(([n, r, u]) => {
    const f = finishAt(n as number, r as number, u as 'day' | 'week', today)
    return { n, r, u, days: f.days, date: dayText(f.date) }
  }),
  for: [['2026-03-27', 10, 240], ['2026-03-26', 10, 240], ['2026-04-05', 13, 312], ['2026-03-30', 0, 0], ['2027-01-01', 100, 2400]].map(([by, n, m]) => {
    const p = paceFor(n as number, m as number, parseDay(by as string) as Date, today)
    return { by, n, m, pace: p }
  }),
  parse: ['2026-11-14', '2026-02-30', '2026-13-45', '2026-00-10', '2026-1-1', 'x', '', '2026-11-14T00', '2026-12-31'].map((t) => {
    const d = parseDay(t)
    return { t, day: d ? dayText(d) : null }
  }),
  setting: [0.01, 0.1, 0.3, 0.5, 1, 1.4, 1.5, 2.5, 10].map((p) => ({ p, s: paceSetting(p) })),
}
const nowMs = new Date(2026, 5, 20, 21, 0).getTime()
const paced = [
  mk({ id: 'pc1', history: [3, 6, 9, 12].map((d, i) => ({ id: `h${i}`, season: 1, episode: i + 1, at: nowMs - d * 86_400_000 })) }),
  mk({ id: 'pc2', history: [{ id: 'a', season: 1, episode: 1, at: nowMs - 1000 }] }),
  mk({ id: 'pc3', history: [{ id: 'a', season: 1, episode: 1, at: nowMs - 2000 }, { id: 'b', season: 1, episode: 2, at: nowMs - 1000 }] }),
  mk({ id: 'pc4', history: Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, season: 1, episode: i + 1, at: nowMs - i * 86_400_000 })) }),
  mk({ id: 'pc5', history: [{ id: 'a', season: 1, episode: 1, at: nowMs - 40 * 86_400_000 }, { id: 'b', season: 1, episode: 2, at: nowMs - 10 * 86_400_000 }, { id: 'c', season: 1, episode: 3, at: nowMs + 5000 }] }),
]
const recentCases = paced.map((item) => ({ id: item.id, now: nowMs, pace: recentPace(item, nowMs), history: item.history }))

const goalItem = mk({ id: 'gi', season: 1, episode: 4, seasons: [{ number: 1, episodes: 12, watched: [1, 2, 3] }, { number: 2, episodes: 12, watched: [] }] })
const goalCases = [
  { season: 1, episode: 12, by: '2026-04-10', setAt: new Date(2026, 2, 20).getTime(), count: 9 },
  { season: 2, episode: 6, by: '2026-03-25', setAt: new Date(2026, 2, 1).getTime(), count: 10 },
  { season: 2, episode: 6, setAt: new Date(2026, 2, 1).getTime() },
  { season: 1, episode: 2, by: '2026-04-10', setAt: new Date(2026, 2, 1).getTime(), count: 3 },
  { season: 2, episode: 12, by: '2026-03-27', setAt: new Date(2026, 2, 27).getTime(), count: 20 },
  { season: 2, episode: 12, by: '2026-10-31', setAt: new Date(2026, 2, 28, 23, 30).getTime(), count: 20 },
].map((goal) => ({ goal, state: goalState(goalItem, goal, { from: 'stand', speed: 1, skipOpening: 0 }, today) }))

const labelCases = {
  point: [[1, 1], [0, 2], [3, 12]].map(([s, e]) => ({ s, e, l: pointLabel({ season: s, episode: e }) })),
  decimal: [[0, 1], [1.5, 1], [2, 1], [1234.56, 1], [0.04, 1], [0.05, 1], [-1.25, 1], [1234567.891, 2], [12, 0], [0.5, 0], [1.005, 2]].map(([v, d]) => ({ v, d, t: decimal(v, d) })),
  length: [0, 1, 59, 60, 61, 119.5, 1439, 1440, 1441, 2880, 3000, 100000, -5].map((m) => ({ m, t: lengthLabel(m) })),
  day: Array.from({ length: 24 }, (_, i) => {
    const d = new Date(2026, 2, 27 + [0, 1, 2, 3, 9, 40, 100, 300, 400, -1][i % 10] + i)
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), t: dayLabel(d, today) }
  }),
  in: [0, 1, 2, 3, 13, 14, 20, 62, 63, 100, 400].map((n) => ({ n, t: inLabel(n) })),
}

const histo = (items: [string, number, number, number][]) => items.map(([id, s, e, at], i) => ({ id: `${id}${i}`, season: s, episode: e, at }))
const at = (y: number, m: number, d: number, h = 20) => new Date(y, m - 1, d, h).getTime()
const recapItems = [
  mk({ id: 'rc1', title: 'Frieren', status: 'done', history: histo([['a', 1, 1, at(2026, 1, 3)], ['a', 1, 2, at(2026, 1, 4)], ['a', 1, 3, at(2026, 1, 5)], ['a', 1, 3, at(2026, 1, 6)], ['a', 1, 4, at(2026, 3, 28, 23)], ['a', 1, 5, at(2026, 3, 29, 0)], ['a', 1, 6, at(2026, 3, 30)], ['a', 1, 7, at(2025, 12, 31)]]) }),
  mk({ id: 'rc2', title: 'äpfel', status: 'watching', history: histo([['b', 1, 1, at(2026, 10, 24)], ['b', 1, 2, at(2026, 10, 25, 1)], ['b', 1, 3, at(2026, 10, 26)], ['b', 1, 4, at(2026, 10, 26, 23)], ['b', 0, 1, at(2026, 2, 14)]]), filmDuration: 120 }),
  mk({ id: 'rc3', title: 'Apfel', status: 'done', history: histo([['c', 1, 1, at(2026, 6, 1)], ['c', 1, 2, at(2026, 6, 1)], ['c', 1, 3, at(2027, 2, 1)]]) }),
  mk({ id: 'rc4', title: 'apfel', status: 'watching', history: histo([['d', 1, 1, at(2026, 6, 2)], ['d', 1, 2, at(2026, 6, 2)], ['d', 1, 3, at(2026, 6, 3)]]) }),
  mk({ id: 'rc5', title: 'Zebra', status: 'dropped', history: histo([['e', 1, 1, at(2026, 7, 7)], ['e', 1, 2, at(2026, 7, 8)], ['e', 1, 3, at(2026, 7, 9)], ['e', 1, 4, at(2026, 7, 10)], ['e', 1, 5, at(2026, 7, 11)], ['e', 1, 6, at(2026, 7, 12)]]) }),
  mk({ id: 'rc6', title: 'Leer' }),
]
const recapCases = {
  items: recapItems.map((i) => ({ id: i.id, title: i.title, status: i.status, filmDuration: i.filmDuration, history: i.history })),
  years: recapYears(recapItems),
  since: recordedSince(recapItems),
  recaps: [2024, 2025, 2026, 2027].map((year) => ({ year, recap: yearRecap(recapItems, year) })),
  empty: { years: recapYears([]), since: recordedSince([]), recap: yearRecap([], 2026) },
}

const compareFull = titled.map((i) => i.title).concat(['apfel', 'Apfel', 'äpfel', 'Äpfel', 'apfel ', 'z', 'Z'])
const fullOrder = [...compareFull].sort((a, b) => a.localeCompare(b, 'de'))

/* Files read ------------------------------------------------------------------------------------ */

const mal = `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist><myinfo><user_name>x</user_name></myinfo>
<anime><series_title><![CDATA[Frieren: Beyond Journey&#039;s End]]></series_title><series_episodes>28</series_episodes><my_watched_episodes>12</my_watched_episodes><my_score>9</my_score><my_status>Watching</my_status></anime>
<anime><series_title>Dark &amp; Light</series_title><series_episodes>0</series_episodes><my_watched_episodes>5</my_watched_episodes><my_score>10</my_score><my_status><![CDATA[Completed]]></my_status></anime>
<anime><series_title>Fertig Serie</series_title><series_episodes>12</series_episodes><my_watched_episodes>12</my_watched_episodes><my_score>1</my_score><my_status>fertig</my_status></anime>
<anime><series_title>Mehr gesehen</series_title><series_episodes>12</series_episodes><my_watched_episodes>30</my_watched_episodes><my_score>0</my_score><my_status>On-Hold</my_status></anime>
<anime><series_title>Abgebrochen</series_title><my_watched_episodes>2</my_watched_episodes><my_score>7</my_score><my_status>Dropped</my_status></anime>
<anime><series_title>Plan</series_title><series_episodes>24</series_episodes><my_score>3</my_score><my_status>Plan to Watch</my_status></anime>
<anime><series_title>   </series_title></anime>
<anime><series_episodes>5</series_episodes></anime>
<ANIME><SERIES_TITLE>Großbuchstaben</SERIES_TITLE></ANIME>
</myanimelist>`
const aniEntry = (extra: Record<string, unknown>) => ({ status: 'CURRENT', progress: 3, score: 8, media: { title: { userPreferred: 'Frieren', romaji: 'Sousou no Frieren' }, episodes: 28, coverImage: { large: 'https://a/l.jpg', medium: 'https://a/m.jpg' } }, ...extra })
const aniEntries = [
  aniEntry({}),
  aniEntry({ status: 'completed', progress: 28, score: 0, scoreRaw: 90, media: { title: { english: 'Dark' }, episodes: 26, coverImage: { medium: 'https://a/m2.jpg' } } }),
  aniEntry({ status: 'PAUSED', progress: 0, score: 5, media: { title: { romaji: 'Nur Romaji' }, episodes: null } }),
  aniEntry({ status: 'DROPPED', progress: 7, score: 2.4, media: { title: 'Titel als Text' } }),
  aniEntry({ status: 'PLANNING', progress: 99, score: 100, media: { title: { native: '日本語' }, episodes: 12 } }),
  aniEntry({ status: null, progress: -4, score: 'x', media: {}, title: 'Titel am Eintrag' }),
  aniEntry({ media: { title: {} } }),
  { title: 'Ohne Media', progress: 1 },
  null,
  7,
]
const jsonItems = [{ id: 'j1', title: 'Aus JSON', updatedAt: T, status: 'done', seasons: [{ number: 1, episodes: 12, watched: [1, 2] }] }, null, 5, { id: 'j2', title: 'Zweite', updatedAt: T }]
const sqliteFile = new Uint8Array((await import('node:fs')).readFileSync(`${outDir}/web.sqlite`))
const fileInputs: [string, string | Uint8Array][] = [
  ['mal', mal],
  ['mal ohne Anime', '<myanimelist></myanimelist>'],
  ['mal mit <anime> aber leer', '<anime></anime>'],
  ['anilist array', JSON.stringify(aniEntries)],
  ['anilist entries', JSON.stringify({ entries: aniEntries })],
  ['anilist lists', JSON.stringify({ lists: [{ entries: aniEntries.slice(0, 3) }, { entries: aniEntries.slice(3) }, 7, null] })],
  ['anilist leer', JSON.stringify({ lists: [] })],
  ['export items', JSON.stringify({ kind: 'sondra-merkliste', version: 1, items: jsonItems })],
  ['array', JSON.stringify(jsonItems)],
  ['leeres Array', '[]'],
  ['leeres Objekt', '{}'],
  ['Objekt ohne items', JSON.stringify({ items: 5 })],
  ['Text', 'das ist keine Liste'],
  ['Zahl', '42'],
  ['sqlite', sqliteFile],
]
const stripVolatile = (item: SavedLinkItem) => {
  const { id: _id, updatedAt: _u, ...rest } = item
  return rest
}
const fileCases = fileInputs.map(([name, input]) => {
  try {
    const result = readMerklisteFile(input)
    return { name, input: typeof input === 'string' ? input : null, items: result.map(stripVolatile) }
  } catch (error) {
    return { name, input: typeof input === 'string' ? input : null, error: (error as Error).message }
  }
})
const tagItems = [mk({ id: 't1', tags: ['Anime', 'liebling', ' Zebra ', 'anime', 'Äpfel'] }), mk({ id: 't2', tags: ['Anime', 'Comedy', '#x'] }), mk({ id: 't3' })]
const historyItems = [
  mk({ id: 'h1', history: [{ id: 'a', season: 1, episode: 1, at: 5 }, { id: 'b', season: 1, episode: 2, at: 9 }] }),
  mk({ id: 'h2', history: [{ id: 'c', season: 2, episode: 1, at: 9 }, { id: 'd', season: 1, episode: 1, at: 1 }] }),
]
const filesOut = {
  cases: fileCases,
  tags: { items: tagItems.map((i) => ({ id: i.id, tags: i.tags })), result: allTags(tagItems) },
  history: { items: historyItems.map((i) => ({ id: i.id, history: i.history })), result: allHistory(historyItems).map((h) => [h.item.id, h.entry.id]) },
}

/* File names and the list --------------------------------------------------------------------- */

const names = [
  'Frieren S01E13.mkv', 'Frieren.1x13.1080p.mkv', '[Gruppe] Frieren - 13 (1080p).mkv', 'Frieren Staffel 1 Folge 13.mp4',
  'Frieren Season 2 Episode 4.mp4', 'Frieren Episode 7.mkv', 'Frieren Ep. 8.avi', 'Frieren Folge 9', 'Frieren - 14v2 [BD 1080p].mkv',
  '[SubGruppe][Frieren][05][1080p][HEVC].mkv', 'Frieren - 05 (BD 1080p x265).mkv', 'Frieren 13.mkv', 'Frieren_S02E100.mkv',
  'Mob Psycho 100 II - 03.mkv', 'Mob Psycho 100 - 03.mkv', 'Mob.Psycho.100.S03E01.WEB.mkv', 'Dark.S03E08.GERMAN.DL.1080p.mkv',
  'Der Film.mkv', 'Film 2020.mkv', 'Nur Titel', '12.mkv', 'S01E02.mkv', 'A - 1.mkv', ' - 5.mkv', 'Titel - 0.mkv', 'Titel S01E00.mkv',
  'One Piece - 1071 [1080p].mkv', 'One Piece 1x1071.mkv', 'Die Reise nach Übermorgen S02E03.mkv', 'Naruto: Shippuden - 12.mkv', 'Ünïcode Straße S1E1.mp4',
  'Frieren Staffel2 Ep3.mkv', 'Frieren Staffel 2 - Folge 3.mkv', 'Frieren Staffel 2 irgendwas Folge 3.mkv', 'Frieren x265 - 01.mkv',
  'Serie.2020.S01E05.mkv', 'Show 1x01-1x02.mkv', 'Show - 105.mkv', 'Show - 1234.mkv', 'Show - 12345.mkv', 'Anime Titel 99', 'Test (720p) - 03.mkv', 'Test (Kommentar) - 03.mkv',
]
const matchItems = [
  mk({ id: 'm1', title: 'Frieren', season: 1, episode: 3, seasons: [{ number: 1, episodes: 28, watched: [] }, { number: 2, episodes: 10, watched: [] }] }),
  mk({ id: 'm2', title: 'Mob Psycho 100', seasons: [{ number: 1, episodes: 12, watched: [] }] }),
  mk({ id: 'm3', title: 'Mob Psycho 100 II', seasons: [{ number: 1, episodes: 12, watched: [] }] }),
  mk({ id: 'm4', title: 'Dark', season: 3, episode: 1, seasons: [{ number: 1, episodes: 10, watched: [] }, { number: 2, episodes: 8, watched: [] }, { number: 3, episodes: 8, watched: [1, 2] }] }),
  mk({ id: 'm5', title: 'One Piece', seasons: [{ number: 1, episodes: null, watched: [] }] }),
  mk({ id: 'm6', title: 'Die Reise nach Übermorgen', seasons: [{ number: 1, episodes: 5, watched: [] }, { number: 2, episodes: null, watched: [] }] }),
  mk({ id: 'm7', title: 'Show', season: 2, episode: 1, seasons: [{ number: 1, episodes: 12, watched: [] }, { number: 2, episodes: null, watched: [] }, { number: 3, episodes: 12, watched: [] }] }),
  mk({ id: 'm8', title: 'A' }),
  mk({ id: 'm9', title: 'Naruto Shippuden' }),
  mk({ id: 'm10', title: 'Unicode Strasse' }),
]
const nameCases = names.map((name) => {
  const m = matchEpisode(name, matchItems)
  return { name, guess: guessEpisode(name), match: m && { item: m.item.id, season: m.season, episode: m.episode } }
})
const titleKeys = ['Frieren: Beyond', 'ÄÖÜ ß', 'a--b__c', '  ', 'Ｆｕｌｌ', 'Ⅻ', ''].map((t) => ({ t, n: normalTitle(t) }))
const seenCases = [
  { id: 'm1', s: 1, e: 3 }, { id: 'm1', s: 2, e: 1 }, { id: 'm1', s: 4, e: 2 }, { id: 'm4', s: 3, e: 3 }, { id: 'm5', s: 1, e: 5 },
].map(({ id, s, e }) => {
  const item = matchItems.find((i) => i.id === id) as SavedLinkItem
  const r = seenEpisode(item, s, e)
  return { id, s, e, already: alreadySeen({ item, season: s, episode: e }), seasons: r.seasons, season: r.season, episode: r.episode, status: r.status, history: (r.history ?? []).map((h) => ({ season: h.season, episode: h.episode })) }
})
const hintCases = [{ series: 'm1', season: 2, episode: 4 }, { series: 'weg', season: 1, episode: 1 }, undefined].map((hint) => {
  const m = matchHint(hint, matchItems)
  return { hint: hint ?? null, match: m && { item: m.item.id, season: m.season, episode: m.episode } }
})

const out = {
  matching: { items: matchItems, names: nameCases, titles: titleKeys, seen: seenCases, hints: hintCases },
  files: filesOut,
  plan: { cases: planCases, pace: paceCases, recent: recentCases, goals: goalCases, labels: labelCases, goalItem },
  recap: recapCases,
  fullOrder: { input: compareFull, sorted: fullOrder },
  stats: { cases: statCases, titled: titled.map((i) => i.title), minutes: minuteCases.map((m) => ({ m, t: formatWatchMinutes(m) })), durations: durationCases, plans, dates: dateLabels },
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
