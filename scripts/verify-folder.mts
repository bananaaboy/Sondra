/**
 * The folder page's logic (src/lib/folder.ts, src/lib/duplicates.ts), checked
 * on a folder made up here: what one level shows, searching below it, the
 * order of „Folge 2“ before „Folge 10“, selecting like a file manager, the
 * next episode to watch, and copies told apart from files that only share a
 * size.
 *
 *   npm run verify:folder
 */

import { contentKey, copiesOf, findDuplicates, keepFirst, looksLikeCopy, WHOLE_LIMIT } from '../src/lib/duplicates'
import { clickSelect, crumbs, folderEpisodes, folderSeries, listing, playQueue, scanFileList, sortFiles, type FolderFile } from '../src/lib/folder'
import { createMerkItem } from '../src/lib/merkliste'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/** A file as the folder picker hands it over: with its path below the folder. */
function picked(path: string, content: string | Uint8Array, modified = 1_700_000_000_000, type = ''): File {
  const file = new File([content as BlobPart], path.split('/').pop()!, { type, lastModified: modified })
  Object.defineProperty(file, 'webkitRelativePath', { value: `Anime/${path}` })
  return file
}

const scan = scanFileList([
  picked('Frieren S01E01.mkv', 'eins', 1_700_000_000_000),
  picked('Frieren S01E02.mkv', 'zwei', 1_700_000_100_000),
  picked('Frieren S01E10.mkv', 'zehn!', 1_700_000_200_000),
  picked('Frieren S01E03.mkv', 'drei', 1_700_000_050_000),
  picked('Cover.jpg', 'bild'),
  picked('notizen.txt', 'text'),
  picked('.DS_Store', 'x'),
  picked('Nana/Nana - 01.mp4', 'nana 1'),
  picked('Nana/Nana - 02.mp4', 'nana 2'),
  picked('Nana/Extras/Interview.mp3', 'ton'),
  picked('Nana/Nana - 02 (1).mp4', 'nana 2'),
  picked('Thumbs.db', 'x'),
])

check('Ordnername aus dem Pfad', scan.name, 'Anime')
check('Versteckte und System-Dateien fehlen', scan.files.length, 10)
check('Alle Ordner, auch Zwischenstufen', scan.dirs, ['', 'Nana', 'Nana/Extras'])

{
  const top = listing(scan, { dir: '', deep: false, filter: 'alle', query: '', sort: 'name', descending: false })
  check('Oben: Unterordner mit Zahl', top.dirs.map((dir) => `${dir.name}:${dir.count}`), ['Nana:4'])
  check('Oben: Dateien natürlich sortiert (2 vor 10)', top.files.map((file) => file.name), [
    'Cover.jpg',
    'Frieren S01E01.mkv',
    'Frieren S01E02.mkv',
    'Frieren S01E03.mkv',
    'Frieren S01E10.mkv',
    'notizen.txt',
  ])
  check('Zähler je Art', top.counts, { alle: 6, video: 4, audio: 0, image: 1, andere: 1 })
  const videos = listing(scan, { dir: '', deep: false, filter: 'video', query: '', sort: 'modified', descending: true })
  check('Nur Video, neueste zuerst', videos.files.map((file) => file.name), ['Frieren S01E10.mkv', 'Frieren S01E02.mkv', 'Frieren S01E03.mkv', 'Frieren S01E01.mkv'])
  const deep = listing(scan, { dir: 'Nana', deep: true, filter: 'alle', query: '', sort: 'name', descending: false })
  check('Mit Unterordnern: keine Ordner-Kacheln, alles darunter', [deep.dirs.length, deep.files.length], [0, 4])
  const searched = listing(scan, { dir: '', deep: false, filter: 'alle', query: 'INTERVIEW', sort: 'name', descending: false })
  check('Suche geht in Unterordner, ohne Gross/klein', searched.files.map((file) => file.path), ['Nana/Extras/Interview.mp3'])
  const accent = scanFileList([picked('Café Musik.mp3', 'x')])
  check('Suche ohne Akzente', listing(accent, { dir: '', deep: false, filter: 'alle', query: 'cafe', sort: 'name', descending: false }).files.length, 1)
  check('Grösse sortiert, kleinste zuerst', sortFiles(scan.files, 'size', false)[0]?.name, 'Interview.mp3')
}

check('Pfad zum Zurückklicken', crumbs('Anime', 'Nana/Extras'), [
  { label: 'Anime', path: '' },
  { label: 'Nana', path: 'Nana' },
  { label: 'Extras', path: 'Nana/Extras' },
])

{
  const order = ['a', 'b', 'c', 'd', 'e']
  let state = clickSelect(new Set(), order, null, 'b', { toggle: false, range: false })
  check('Klick: nur diese', [...state.selected], ['b'])
  state = clickSelect(state.selected, order, state.anchor, 'd', { toggle: false, range: true })
  check('Umschalt: Bereich vom letzten Klick', [...state.selected], ['b', 'c', 'd'])
  state = clickSelect(state.selected, order, state.anchor, 'c', { toggle: true, range: false })
  check('Strg: eine heraus', [...state.selected].sort(), ['b', 'd'])
  state = clickSelect(state.selected, order, state.anchor, 'e', { toggle: true, range: true })
  check('Strg+Umschalt: Bereich dazu, Rest bleibt', [...state.selected].sort(), ['b', 'c', 'd', 'e'])
  state = clickSelect(state.selected, order, state.anchor, 'a', { toggle: false, range: false })
  check('Klick ohne Taste: wieder nur eine', [...state.selected], ['a'])
}

{
  const frieren = createMerkItem({ id: 'f', title: 'Frieren', status: 'watching', season: 1, episode: 3, seasons: [{ number: 1, episodes: 28, watched: [1, 2] }] })
  const nana = createMerkItem({ id: 'n', title: 'Nana', status: 'later', season: 1, episode: 1, seasons: [{ number: 1, episodes: 47, watched: [] }] })
  const done = createMerkItem({ id: 'd', title: 'Cover', status: 'done' })
  const series = folderSeries(scan.files, [frieren, nana, done])
  check('Serien mit Folgen im Ordner, „Am Schauen“ zuerst', series.map((entry) => entry.item.title), ['Frieren', 'Nana'])
  check('Frieren: als Nächstes Folge 3 (der Stand)', [series[0].next?.episode, series[0].queue.map((entry) => entry.episode)], [3, [3, 10]])
  check('Gesehene sind markiert', series[0].episodes.filter((entry) => entry.seen).map((entry) => entry.episode), [1, 2])
  check('Doppelte Folge (Kopie): eine davon', series[1].episodes.map((entry) => entry.episode), [1, 2])
  const caught = createMerkItem({ ...frieren, seasons: [{ number: 1, episodes: 28, watched: [1, 2, 3, 10] }] })
  check('Alles gesehen: keine Karte', folderSeries(scan.files, [caught]).length, 0)
  const all = folderEpisodes(scan.files, [frieren, nana, done])
  check('Für die Merkliste: alle Folgen je Serie, gesehene dabei', all.get('f')?.map((entry) => `${entry.episode}${entry.seen ? '✓' : ''}`), ['1✓', '2✓', '3', '10'])
  check('Abspielen ab Folge 1: sie, dann nur Ungesehene', playQueue(all.get('f')!, 1, 1).map((entry) => entry.episode), [1, 3, 10])
  check('Abspielen ab einer Folge, die nicht im Ordner ist: nichts', playQueue(all.get('f')!, 1, 7).length, 0)
  const ahead = createMerkItem({ ...frieren, season: 1, episode: 5, seasons: [{ number: 1, episodes: 28, watched: [1, 2, 3, 4] }] })
  check('Stand nicht im Ordner: die nächste nach der zuletzt gesehenen', folderSeries(scan.files, [ahead])[0]?.next?.episode, 10)
}

{
  check('Kopie am Namen erkannt', ['Film (1).mp4', 'Film - Kopie.mp4', 'Film copy 2.mp4', 'Film.mp4', 'Folge (2010).mkv'].map(looksLikeCopy), [true, true, true, false, true])
  const report = await findDuplicates(scan.files)
  check('Gleich grosse, aber verschiedene Dateien sind keine Doppelten', report.groups.length, 1)
  check('Behalten: die ohne „(1)“', report.groups[0]?.files.map((file) => file.name), ['Nana - 02.mp4', 'Nana - 02 (1).mp4'])
  check('Kopien zum Auswählen', copiesOf(report).map((file) => file.path), ['Nana/Nana - 02 (1).mp4'])
  check('Platz der Kopien', report.spare, 6)
  const same = (name: string, modified: number) => ({ ...scan.files[0], name, path: name, modified }) as FolderFile
  check('Sonst die älteste behalten', keepFirst([same('b.mkv', 20), same('a.mkv', 10)]).map((file) => file.name), ['a.mkv', 'b.mkv'])

  const big = new Uint8Array(WHOLE_LIMIT + 4096)
  big.fill(7)
  const twin = big.slice()
  const other = big.slice()
  other[other.length - 1] = 9
  const [a, b, c] = await Promise.all([contentKey(new Blob([big])), contentKey(new Blob([twin])), contentKey(new Blob([other]))])
  check('Grosse Datei: gleiche an 32 Stellen gleich', [a === b, a.startsWith('s:')], [true, true])
  check('Grosse Datei: Unterschied am Ende erkannt', a === c, false)
}

console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
