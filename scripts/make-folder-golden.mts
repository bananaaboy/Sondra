/**
 * Writes the table the native folder logic (`native/sondra-merk`, `folder.rs`) is tested against: a made-up
 * folder of a hundred and fifty files, read, sorted, filtered, selected and set into series by the web
 * app's own code. The Rust side must give the same, file for file.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import {
  clickSelect,
  crumbs,
  findNewSeries,
  folderEpisodes,
  folderSeries,
  groupBySeries,
  hintOf,
  hintProperties,
  listing,
  matchFile,
  playQueue,
  seasonPath,
  seriesFolderName,
  seriesToMerkItem,
  sortFiles,
  unfiledEpisodes,
  type FolderFile,
  type KindFilter,
  type SortKey,
} from '../src/lib/folder'
import { episodeKindOf, leftLabel, positionLabel, standLabel } from '../src/lib/merkRows'
import { subtitleNameFor, subtitlesBeside } from '../src/lib/subtitleFiles'
import { contentKey, copiesOf, findDuplicates, keepFirst, looksLikeCopy } from '../src/lib/duplicates'
import { createMerkItem, type SavedLinkItem } from '../src/lib/merkliste'
import { kindFromMime } from '../src/state/store'

const outDir = 'native/sondra-merk/tests/golden'
mkdirSync(outDir, { recursive: true })

const T = 1_700_000_000_000
const mk = (raw: Record<string, unknown>) => createMerkItem({ updatedAt: T, ...raw } as Partial<SavedLinkItem>)
const items = [
  mk({ id: 'fr', title: 'Frieren', status: 'watching', season: 1, episode: 4, seasons: [{ number: 1, episodes: 28, watched: [1, 2, 3] }, { number: 2, episodes: null, watched: [] }] }),
  mk({ id: 'dk', title: 'Dark', status: 'watching', season: 2, episode: 1, seasons: [{ number: 1, episodes: 10, watched: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, { number: 2, episodes: 8, watched: [] }, { number: 0, episodes: 1, watched: [] }] }),
  mk({ id: 'mp', title: 'Mob Psycho 100', status: 'paused', seasons: [{ number: 1, episodes: 12, watched: [1] }] }),
  mk({ id: 'op', title: 'One Piece', status: 'later', seasons: [{ number: 1, episodes: null, watched: [] }] }),
  mk({ id: 'fin', title: 'Fertig Serie', status: 'done', seasons: [{ number: 1, episodes: 2, watched: [1, 2] }] }),
]

let nextModified = T
const file = (path: string, size: number, kind?: string, drive?: FolderFile['drive']): FolderFile => {
  const at = path.lastIndexOf('/')
  const name = path.slice(at + 1)
  nextModified += 60_000 * ((path.length * 7) % 13)
  return { path, name, dir: at >= 0 ? path.slice(0, at) : '', size, modified: nextModified, kind: (kind ?? kindFromMime('', name)) as FolderFile['kind'], ...(drive ? { drive } : {}) }
}

const files: FolderFile[] = []
for (let e = 1; e <= 12; e += 1) {
  const n = String(e).padStart(2, '0')
  files.push(file(`Anime/Frieren/Staffel 1/Frieren S01E${n}.mkv`, 400_000_000 + e * 1000))
  files.push(file(`Anime/Dark/Dark.S02E${n}.GERMAN.1080p.mkv`, 800_000_000 + e))
  files.push(file(`Anime/Mob Psycho 100/Mob Psycho 100 - ${n} (1080p).mkv`, 300_000_000))
}
files.push(file('Anime/Frieren/Staffel 1/Frieren S01E03 (1).mkv', 100)) // a copy, smaller
files.push(file('Anime/Frieren/Staffel 1/Frieren S01E05 Kopie.mkv', 900_000_000)) // a copy, larger
files.push(file('Anime/Frieren/Staffel 2/Frieren S02E01.mkv', 1))
files.push(file('Anime/Frieren/Staffel 2/Frieren S02E02.mkv', 2))
for (let e = 1; e <= 5; e += 1) files.push(file(`Neu/Neue Serie - ${String(e).padStart(2, '0')}.mkv`, 10 * e))
for (let e = 1; e <= 3; e += 1) files.push(file(`Neu/Andere Serie S01E0${e}.mp4`, 10 * e))
files.push(file('Neu/Ocean 11.mkv', 77))
files.push(file('Neu/Fertig Serie S01E01.mkv', 5))
files.push(file('Musik/2 Ton.mp3', 4_000_000))
files.push(file('Musik/10 Ton.mp3', 4_000_001))
files.push(file('Musik/1 Ton.mp3', 4_000_002))
files.push(file('Musik/Café.flac', 30_000_000))
files.push(file('Musik/cafe noir.flac', 31_000_000))
files.push(file('Musik/Zebra.wav', 9_000_000))
files.push(file('Musik/zebra live.WAV', 9_000_001))
for (let i = 0; i < 20; i += 1) files.push(file(`Fotos/2026/IMG_${String(i * 37 + 1).padStart(4, '0')}.jpg`, 3_000_000 + i))
files.push(file('Fotos/Urlaub Ärger.PNG', 2_000_000))
files.push(file('Dokumente/Buch.pdf', 1_000_000))
files.push(file('Dokumente/Untertitel Frieren S01E01.srt', 40_000))
files.push(file('Dokumente/archiv.zip', 5_000_000))
files.push(file('Dokumente/ohne Endung', 10))
files.push(file('Dokumente/mp4', 10))
files.push(file('Lies mich.txt', 100))
files.push(file('Film.mp4', 2_000_000_000))
// Drive: with a note, in a series folder without a note, and loose.
files.push(file('Serien/Frieren/Staffel 1/Episode 09.mkv', 50, undefined, { id: 'd1', mime: 'video/x-matroska', parent: 'p1', hint: { series: 'fr', season: 1, episode: 9 } }))
files.push(file('Serien/Frieren/Staffel 2/folge 04.mkv', 51, undefined, { id: 'd2', mime: 'video/x-matroska', parent: 'p2' }))
files.push(file('Serien/Frieren/Staffel 3/Nur 0007.mkv', 51, undefined, { id: 'd3', mime: 'video/x-matroska', parent: 'p2' }))
files.push(file('Serien/Dark/Filme/Der Film Teil 12345.mkv', 51, undefined, { id: 'd4', mime: 'video/x-matroska', parent: 'p3' }))
files.push(file('Serien/Unbekannt/Staffel 1/Sache 03.mkv', 51, undefined, { id: 'd5', mime: 'video/x-matroska', parent: 'p4' }))
files.push(file('Lose/Frieren - 14.mkv', 52, undefined, { id: 'd6', mime: 'video/x-matroska', parent: 'p5' }))
files.push(file('Lose/Dark S02E03.mkv', 52, undefined, { id: 'd7', mime: 'video/x-matroska', parent: 'p5' }))
files.push(file('Lose/Dark S02E01.mkv', 52, undefined, { id: 'd8', mime: 'video/x-matroska', parent: 'p5' }))
files.push(file('Lose/Frieren - 15.mkv', 52, undefined, { id: 'd9', mime: 'video/x-matroska', parent: 'p5' }))
files.push(file('Lose/Mob Psycho 100 - 05.mkv', 52, undefined, { id: 'd10', mime: 'video/x-matroska', parent: 'p5' }))
files.push(file('Lose/Foto.jpg', 52, undefined, { id: 'd11', mime: 'image/jpeg', parent: 'p5' }))

const dirs = [...new Set(['', ...files.map((f) => f.dir).flatMap((dir) => dir.split('/').filter(Boolean).map((_, i, parts) => parts.slice(0, i + 1).join('/')))])].sort()
const scan = { name: 'Test', files, dirs, truncated: false }

const paths = (list: FolderFile[]) => list.map((f) => f.path)
const sorts: SortKey[] = ['name', 'modified', 'size', 'kind']
const filters: KindFilter[] = ['alle', 'video', 'audio', 'image', 'andere']
const listings = []
for (const dir of ['', 'Anime', 'Anime/Frieren', 'Musik', 'Fotos', 'Gibt es nicht']) {
  for (const deep of [false, true]) {
    for (const query of ['', 'cafe', 'ÄRGER', 'frieren', '  S01  ', 'zzz']) {
      for (const [sort, descending, filter] of [['name', false, 'alle'], ['modified', true, 'video'], ['size', false, 'audio'], ['kind', true, 'andere'], ['name', true, 'image']] as [SortKey, boolean, KindFilter][]) {
        const l = listing(scan as never, { dir, deep, filter, query, sort, descending })
        listings.push({ dir, deep, query, sort, descending, filter, files: paths(l.files), dirs: l.dirs.map((d) => [d.path, d.name, d.count, d.size]), counts: l.counts })
      }
    }
  }
}
const sortedAll = sorts.flatMap((sort) => [false, true].map((descending) => ({ sort, descending, paths: paths(sortFiles(files, sort, descending)) })))

const order = paths(sortFiles(files.filter((f) => f.dir === 'Musik'), 'name', false))
const clicks: { toggle: boolean; range: boolean; path: string }[] = [
  { toggle: false, range: false, path: order[2] }, { toggle: true, range: false, path: order[4] }, { toggle: false, range: true, path: order[0] },
  { toggle: true, range: true, path: order[6] }, { toggle: true, range: false, path: order[2] }, { toggle: false, range: true, path: 'nicht da' }, { toggle: false, range: false, path: order[1] },
]
let selected = new Set<string>()
let anchor: string | null = null
const selecting = clicks.map((c) => {
  const r = clickSelect(selected, order, anchor, c.path, { toggle: c.toggle, range: c.range })
  selected = r.selected
  anchor = r.anchor
  return { ...c, selected: [...selected].sort(), anchor }
})

const matches = files.map((f) => {
  const m = matchFile(f, items)
  return { path: f.path, match: m && { item: m.item.id, season: m.season, episode: m.episode } }
})
const found = findNewSeries(files, items)
const foundIgnored = findNewSeries(files, items, new Set([found[0]?.key ?? 'x']))
const unfiled = unfiledEpisodes(files, items)
const episodesBySeries = [...folderEpisodes(files, items)].map(([id, list]) => ({ id, episodes: list.map((e) => [e.file.path, e.season, e.episode, e.seen]) }))
const series = folderSeries(files, items).map((s) => ({ item: s.item.id, episodes: s.episodes.map((e) => e.file.path), next: [s.next.file.path, s.next.season, s.next.episode], queue: s.queue.map((e) => e.file.path) }))
const frieren = (folderEpisodes(files, items).get('fr') ?? [])
const queues = [[1, 1], [1, 4], [1, 9], [2, 1], [9, 9]].map(([s, e]) => ({ s, e, queue: playQueue(frieren, s, e).map((x) => x.file.path) }))
const grouped = groupBySeries(files, items)

/* Doubles ------------------------------------------------------------------------------------- */

const copyNames = ['Film.mp4', 'Film (1).mp4', 'Film (12).mp4', 'Film - Kopie.mp4', 'Film Kopie.mp4', 'Film_copy.mkv', 'Film copy 2.mp4', 'Film - Copy (3).mp4', 'Film duplikat.mp4', 'Film-DUPLIKAT 4', 'Kopie.mp4', 'Copy of Film.mp4', 'Film (1).mp4.bak', 'Film(1)', 'Dateiohne', 'Film (a).mp4', ' Film (2) .mp4']
const dupFiles: FolderFile[] = [
  file('A/Film.mp4', 1000), file('B/Film (1).mp4', 1000), file('C/Film - Kopie.mp4', 1000),
  file('A/Lied.mp3', 500), file('B/Lied.mp3', 500), file('B/Anderes.mp3', 500),
  file('Z/Gross.mkv', 9_000_000), file('Y/Gross copy.mkv', 9_000_000), file('X/Gross.mkv', 9_000_000),
  file('A/Leer1.txt', 0), file('B/Leer2.txt', 0),
  file('A/Einzel.bin', 77),
  file('A/Unlesbar.bin', 10), file('B/Unlesbar.bin', 10),
  file('D/Gleich.png', 20), file('E/Gleich.png', 20),
]
dupFiles[1].modified = dupFiles[0].modified + 5
dupFiles[2].modified = dupFiles[0].modified - 5
dupFiles[7].modified = dupFiles[6].modified
dupFiles[8].modified = dupFiles[6].modified
dupFiles[15].modified = dupFiles[14].modified
dupFiles[15].path = 'E/Gleich.png'
const dupKey = async (f: FolderFile) => {
  if (f.name.includes('Unlesbar')) throw new Error('nicht lesbar')
  return `g:${f.size}:${f.name.replace(/ \(\d+\)| - Kopie| copy/i, '').replace(/\.[^.]+$/, '')}`
}
const dupReport = await findDuplicates(dupFiles, { key: dupKey })
const big = new Uint8Array(33 * 1024 * 1024)
for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + (i >> 8) * 7 + (i >> 16)) & 0xff
const small = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff)
const contentKeys = [
  { size: small.length, key: await contentKey(new Blob([small])) },
  { size: 32 * 1024 * 1024, key: await contentKey(new Blob([big.subarray(0, 32 * 1024 * 1024)])) },
  { size: big.length, key: await contentKey(new Blob([big])) },
]
const dupOut = {
  names: copyNames.map((n) => ({ n, copy: looksLikeCopy(n) })),
  files: dupFiles,
  report: { groups: dupReport.groups.map((g) => ({ size: g.size, files: g.files.map((f) => f.path), whole: g.whole })), read: dupReport.read, spare: dupReport.spare, copies: copiesOf(dupReport).map((f) => f.path) },
  keepFirst: paths(keepFirst(dupFiles.slice(0, 3))),
  contentKeys,
}

const subFiles = [
  ['Film.mkv', 'A'], ['Film.srt', 'A'], ['Film.de.srt', 'A'], ['Film.EN.srt', 'A'], ['Film.vtt', 'A'], ['Film.deu.vtt', 'A'], ['Film.german.srt', 'A'],
  ['Film.srt', 'B'], ['Film 2.srt', 'A'], ['film.SRT', 'A'], ['Film.ass', 'A'], ['Film.txt', 'A'], ['Film.a.srt', 'A'], ['Ünï.mp4', 'A'], ['ünï.srt', 'A'], ['ÜNÏ.de.srt', 'A'],
  ['Serie - 01.mkv', 'S'], ['Serie - 01.srt', 'S'], ['Serie - 01.fr.srt', 'S'], ['Serie - 010.srt', 'S'], ['Serie - 02.srt', 'S'], ['a.b.c.mp4', 'D'], ['a.b.srt', 'D'], ['a.b.c.srt', 'D'], ['a.b.c.de.srt', 'D'], ['.srt', 'A'], ['Film', 'A'],
].map(([name, dir]) => ({ name, dir }))
const subtitles = {
  files: subFiles,
  beside: subFiles.filter((f) => /\.(mkv|mp4)$/i.test(f.name)).map((film) => ({ film, srt: subtitlesBeside(film, subFiles).map((f) => `${f.dir}/${f.name}`) })),
  named: ['Film.mkv', 'Serie - 01.mp4', 'a.b.c.mp4', 'ohne Endung', 'Ünï.MKV', '.verborgen', 'x.', 'Film.de.mkv'].map((name) => ({ name, srt: subtitleNameFor(name) })),
}
const rowUrls = [
  '', 'https://aniworld.to/anime/stream/frieren/staffel-1/episode-4', 'https://www.youtube.com/watch?v=abc&list=PL123&index=4', 'https://www.youtube.com/playlist?list=PL123',
  'https://example.org/video.mp4', 'https://serien.example/serie/staffel-2/folge-3', 'https://example.org/show/season-1/s01e05', 'https://example.org/filme/1', '  ',
]
const rowRaw: Record<string, unknown>[] = []
for (const [u, url] of rowUrls.entries()) {
  for (const status of ['watching', 'later', 'done', 'paused', 'dropped']) {
    rowRaw.push({ id: `r${u}-${status}`, url, title: `Reihe ${u}`, status, season: 1, episode: 4, seasons: [{ number: 1, episodes: 12, watched: status === 'later' ? [] : [1, 2, 3] }, { number: 2, episodes: null, watched: [] }] })
    rowRaw.push({ id: `s${u}-${status}`, url, title: `Fertig ${u}`, status, season: 1, episode: null, seasons: [{ number: 1, episodes: 3, watched: [1, 2, 3] }] })
    rowRaw.push({ id: `f${u}-${status}`, url, title: `Film ${u}`, status, season: 0, episode: 2, filmDuration: 100, seasons: [{ number: 0, episodes: 4, watched: [1] }] })
    rowRaw.push({ id: `z${u}-${status}`, url, title: `Leer ${u}`, status, season: 3, episode: null, seasons: [{ number: 3, episodes: null, watched: [] }] })
    rowRaw.push({ id: `n${u}-${status}`, url, title: `Ohne ${u}`, status, season: 1, episode: 1 })
    rowRaw.push({ id: `d${u}-${status}`, url, title: `Dauer ${u}`, status, season: 1, episode: 2, episodeDuration: 45, durations: { '1:3': 60 }, seasons: [{ number: 1, episodes: 5, watched: [1] }] })
  }
}
const rowItems = rowRaw.map((raw) => mk(raw))
const rows = {
  items: rowItems,
  kinds: rowUrls.map((url) => ({ url, kind: episodeKindOf(url) ?? null })),
  positions: [[1, 4, 'series'], [1, null, 'series'], [0, 2, 'series'], [0, null, 'series'], [2, 7, 'list'], [2, null, 'list'], [3, 0, 'series']].map(([season, episode, kind]) => ({ season, episode, kind, label: positionLabel(season as number, episode as number | null, kind as 'series' | 'list') })),
  lines: rowItems.map((item) => ({ id: item.id, stand: standLabel(item), left: leftLabel(item) ?? null })),
}
const out = {
  rows,
  subtitles,
  dup: dupOut,
  items,
  files,
  dirs,
  kinds: [['video/mp4', 'x'], ['audio/flac', 'x'], ['image/png', 'x'], ['text/plain', 'x.bin'], ['application/pdf', 'x'], ['application/zip', 'x'], ['application/x-tar', 'x'], ['', 'film.MKV'], ['', 'mp4'], ['', 'ohne'], ['', 'a.b.c.srt'], ['application/octet-stream', 'x.7z'], ['', '']].map(([mime, name]) => ({ mime, name, kind: kindFromMime(mime, name) })),
  names: ['Frieren', 'A/B\\C', '  viel   Platz  ', '', '///', 'Ünï'].map((t) => ({ t, folder: seriesFolderName(t), path: seasonPath(t, 0), path2: seasonPath(t, 3) })),
  hints: [{ sondraSerie: 'fr', sondraStaffel: '2', sondraFolge: '5' }, { sondraSerie: 'fr', sondraStaffel: '0', sondraFolge: '1' }, { sondraSerie: '', sondraStaffel: '1', sondraFolge: '1' }, { sondraSerie: 'fr', sondraStaffel: '-1', sondraFolge: '1' }, { sondraSerie: 'fr', sondraStaffel: '1', sondraFolge: '0' }, { sondraSerie: 'fr', sondraStaffel: '1.5', sondraFolge: '1' }, { sondraSerie: 'fr', sondraStaffel: 'x', sondraFolge: '1' }, { sondraSerie: 'fr', sondraStaffel: '', sondraFolge: '3' }, {}].map((p) => ({ p, hint: hintOf(p) ?? null })),
  hintProps: hintProperties({ series: 'fr', season: 2, episode: 5 }),
  listings,
  sortedAll,
  crumbs: ['', 'Anime', 'Anime/Frieren/Staffel 1'].map((dir) => ({ dir, crumbs: crumbs('Test', dir) })),
  selecting: { order, steps: selecting },
  matches,
  found: found.map((s) => ({ ...s, item: seriesToMerkItem(s) })),
  foundIgnored: foundIgnored.map((s) => s.key),
  unfiled: unfiled.map((u) => ({ item: u.item.id, season: u.season, files: u.files.map((f) => [f.file.path, f.episode]) })),
  episodesBySeries,
  series,
  queues,
  grouped: {
    groups: grouped.groups.map((g) => ({ key: g.key, files: paths(g.files), here: g.here, seenHere: g.seenHere, seen: g.seen, total: g.total })),
    rest: paths(grouped.rest),
    ordered: paths(grouped.ordered),
    episodes: [...grouped.episodes].map(([p, e]) => [p, e.season, e.episode, e.seen]),
    keyOf: [...grouped.keyOf],
  },
}
writeFileSync(`${outDir}/folder.json`, JSON.stringify(out) + '\n')
console.log(`Ordner: ${files.length} Dateien, ${listings.length} Ansichten, ${found.length} neue Serien`)
