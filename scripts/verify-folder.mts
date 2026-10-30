/**
 * The folder page's logic (src/lib/folder.ts, src/lib/duplicates.ts), checked
 * on a folder made up here: what one level shows, searching below it, the
 * order of „Folge 2“ before „Folge 10“, selecting like a file manager, the
 * next episode to watch, and copies told apart from files that only share a
 * size.
 *
 *   npm run verify:folder
 */

import { subtitleNameFor, subtitlesBeside } from '../src/lib/subtitleFiles'
import { contentKey, copiesOf, findDuplicates, keepFirst, looksLikeCopy, WHOLE_LIMIT } from '../src/lib/duplicates'
import {
  BIN_NAME,
  binFiles,
  clickSelect,
  countBin,
  crumbs,
  eraseFromBin,
  folderEpisodes,
  folderSeries,
  hintOf,
  hintProperties,
  listBin,
  listing,
  matchFile,
  playQueue,
  restoreBinned,
  restoreFromBin,
  scanDrive,
  scanFileList,
  scanHandle,
  seasonPath,
  sortFiles,
  type FolderFile,
} from '../src/lib/folder'
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

{
  // Episodes filed in Drive: by the note on the file, by the season's folder, else by the name.
  const list = [
    createMerkItem({ id: 'fr', title: 'Frieren', season: 1, episode: 1, seasons: [{ number: 1, episodes: 28, watched: [1] }] }),
    createMerkItem({ id: 'k8', title: 'Kaiju Nr. 8', season: 1, episode: 1, seasons: [{ number: 1, episodes: 12, watched: [] }] }),
  ]
  check('Ordnerpfad einer Staffel', [seasonPath('Frieren', 2), seasonPath('AC/DC', 0)], [['Serien', 'Frieren', 'Staffel 2'], ['Serien', 'AC-DC', 'Filme']])
  check('Notiz hin und zurück', hintOf(hintProperties({ series: 'fr', season: 1, episode: 7 })), { series: 'fr', season: 1, episode: 7 })
  check('Unvollständige Notiz gilt nicht', [hintOf({ sondraSerie: 'fr', sondraStaffel: '1' }), hintOf({ sondraSerie: 'fr', sondraStaffel: 'x', sondraFolge: '2' })], [undefined, undefined])
  const scan = scanDrive({
    files: [
      { id: 'a', name: 'Episode 01.mkv', size: 10, modifiedTime: null, mimeType: 'video/x-matroska', path: 'Serien/Frieren/Staffel 1/Episode 01.mkv', parents: ['p1'], appProperties: hintProperties({ series: 'fr', season: 1, episode: 1 }) },
      { id: 'b', name: 'Folge 2.mkv', size: 10, modifiedTime: null, mimeType: 'video/x-matroska', path: 'Serien/Frieren/Staffel 1/Folge 2.mkv', parents: ['p1'] },
      { id: 'c', name: '03.mkv', size: 10, modifiedTime: null, mimeType: 'video/x-matroska', path: 'Serien/Kaiju Nr. 8/Staffel 1/03.mkv', parents: ['p2'] },
      { id: 'd', name: 'Frieren S01E04.mkv', size: 10, modifiedTime: null, mimeType: 'video/x-matroska', path: 'Heruntergeladen/Frieren S01E04.mkv', parents: ['p3'] },
      { id: 'e', name: 'Urlaub.mkv', size: 10, modifiedTime: null, mimeType: 'video/x-matroska', path: 'Serien/Unbekannt/Staffel 1/Urlaub.mkv', parents: ['p4'] },
    ],
    dirs: [''],
    truncated: false,
  })
  const found = scan.files.map((file) => {
    const match = matchFile(file, list)
    return match ? `${match.item.id} ${match.season}/${match.episode}` : null
  })
  check('Notiz, Staffel-Ordner, Name, nichts', found, ['fr 1/1', 'fr 1/2', 'k8 1/3', 'fr 1/4', null])
  check('Eltern-Ordner gemerkt (zum Verschieben)', scan.files[0].drive?.parent, 'p1')
  const fr = folderEpisodes(scan.files, list).get('fr')!.map((entry) => [entry.episode, entry.seen])
  check('Im Ordner gesehen markiert, über alle Wege', fr, [[1, true], [2, false], [4, false]])
}

// --- Subtitles beside a film -----------------------------------------------
{
  const all = [
    { name: 'Frieren S01E01.mkv', dir: 'Staffel 1' },
    { name: 'Frieren S01E01.srt', dir: 'Staffel 1' },
    { name: 'Frieren S01E01.de.srt', dir: 'Staffel 1' },
    { name: 'Frieren S01E01.vtt', dir: 'Staffel 2' },
    { name: 'Frieren S01E02.srt', dir: 'Staffel 1' },
    { name: 'Frieren S01E011.srt', dir: 'Staffel 1' },
    { name: 'Notizen.txt', dir: 'Staffel 1' },
  ]
  check('Untertitel neben dem Film: gleicher Name, auch mit Sprachkürzel, nur im selben Ordner', subtitlesBeside(all[0], all).map((entry) => entry.name), ['Frieren S01E01.srt', 'Frieren S01E01.de.srt'])
  check('Untertitel: eine andere Folge, ein anderer Ordner, eine Textdatei zählen nicht', subtitlesBeside({ name: 'Frieren S01E03.mkv', dir: 'Staffel 1' }, all).length, 0)
  check('Untertitel: „E01“ nimmt nicht „E011“ mit', subtitlesBeside({ name: 'Frieren S01E01.mkv', dir: 'Staffel 1' }, all).some((entry) => entry.name.includes('E011')), false)
  check('Untertitel: der gemachte heisst wie der Film, mit .srt', [subtitleNameFor('Frieren S01E01.mkv'), subtitleNameFor('Ein.Punkt.Im.Namen.mp4'), subtitleNameFor('ohne-endung')], ['Frieren S01E01.srt', 'Ein.Punkt.Im.Namen.srt', 'ohne-endung.srt'])
}

// --- Deleting into the bin of Sondra's own --------------------------------
// A folder in memory with just what the browser's folder API does: handles
// that list, make and remove entries — and, optionally, `move`.
{
  type Entry = { kind: 'file'; data: Uint8Array } | { kind: 'directory'; dir: MemoryDir }
  class MemoryDir {
    entries = new Map<string, Entry>()
    kind = 'directory' as const
    constructor(public name: string, private canMove: boolean) {}
    async *values() {
      for (const [name, entry] of this.entries) yield entry.kind === 'directory' ? entry.dir.asHandle(name) : this.fileHandle(name)
    }
    asHandle(name: string) {
      return Object.assign(this, { name })
    }
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      let entry = this.entries.get(name)
      if (!entry) {
        if (!options?.create) throw new DOMException('weg', 'NotFoundError')
        entry = { kind: 'directory', dir: new MemoryDir(name, this.canMove) }
        this.entries.set(name, entry)
      }
      if (entry.kind !== 'directory') throw new DOMException('Datei', 'TypeMismatchError')
      return entry.dir as never
    }
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!this.entries.has(name)) {
        if (!options?.create) throw new DOMException('weg', 'NotFoundError')
        this.entries.set(name, { kind: 'file', data: new Uint8Array(0) })
      }
      return this.fileHandle(name) as never
    }
    async removeEntry(name: string) {
      if (!this.entries.delete(name)) throw new DOMException('weg', 'NotFoundError')
    }
    fileHandle(name: string) {
      const dir = this
      const handle: Record<string, unknown> = {
        kind: 'file',
        name,
        async getFile() {
          const entry = dir.entries.get(name)
          if (!entry || entry.kind !== 'file') throw new DOMException('weg', 'NotFoundError')
          return new File([entry.data as BlobPart], name)
        },
        async createWritable() {
          const parts: Uint8Array[] = []
          return {
            async write(data: Blob | BufferSource) {
              parts.push(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer)))
            },
            async close() {
              const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
              let at = 0
              for (const part of parts) {
                all.set(part, at)
                at += part.length
              }
              dir.entries.set(name, { kind: 'file', data: all })
            },
            async abort() {},
          }
        },
      }
      if (this.canMove) {
        handle.move = async (to: MemoryDir, newName?: string) => {
          const entry = dir.entries.get(name)
          if (!entry) throw new DOMException('weg', 'NotFoundError')
          to.entries.set(newName ?? name, entry)
          dir.entries.delete(name)
        }
      }
      return handle
    }
  }
  const text = (dir: MemoryDir, name: string) => {
    const entry = dir.entries.get(name)
    return entry && entry.kind === 'file' ? new TextDecoder().decode(entry.data) : null
  }
  for (const canMove of [true, false]) {
    const way = canMove ? 'mit Verschieben' : 'ohne Verschieben (kopiert)'
    const root = new MemoryDir('Anime', canMove)
    const season = await root.getDirectoryHandle('Staffel 1', { create: true })
    for (const [dir, name, body] of [[root, 'Cover.jpg', 'bild'], [season, 'Folge 1.mkv', 'eins'], [season, 'Folge 2.mkv', 'zwei']] as const) {
      const handle = await dir.getFileHandle(name, { create: true })
      const out = await handle.createWritable!()
      await out.write(new TextEncoder().encode(body))
      await out.close()
    }
    const listed = await scanHandle(root as never)
    check(`Papierkorb ${way}: Ordner wird eingelesen`, listed.files.map((file) => file.path).sort(), ['Cover.jpg', 'Staffel 1/Folge 1.mkv', 'Staffel 1/Folge 2.mkv'])
    const wanted = listed.files.filter((file) => file.name !== 'Cover.jpg')
    const result = await binFiles(root as never, wanted)
    check(`Papierkorb ${way}: beide wandern in den Papierkorb`, result.binned.map((item) => item.binName).sort(), ['Folge 1.mkv', 'Folge 2.mkv'])
    check(`Papierkorb ${way}: aus dem Ordner sind sie weg`, [text(season as never, 'Folge 1.mkv'), text(season as never, 'Folge 2.mkv')], [null, null])
    const afterBin = await scanHandle(root as never)
    check(`Papierkorb ${way}: der Papierkorb selbst steht nicht in der Liste`, afterBin.files.map((file) => file.path), ['Cover.jpg'])
    check(`Papierkorb ${way}: der Ordner heisst ${BIN_NAME}`, root.entries.has(BIN_NAME), true)
    // The same name again: it is numbered, not overwritten.
    const again = await (await season.getFileHandle('Folge 1.mkv', { create: true })).createWritable!()
    await again.write(new TextEncoder().encode('neu'))
    await again.close()
    const second = await scanHandle(root as never)
    const twice = await binFiles(root as never, second.files.filter((file) => file.name === 'Folge 1.mkv'))
    check(`Papierkorb ${way}: gleicher Name zweimal: nummeriert`, twice.binned[0]?.binName, 'Folge 1 (2).mkv')
    const bin = (await root.getDirectoryHandle(BIN_NAME)) as unknown as MemoryDir
    check(`Papierkorb ${way}: beide Fassungen liegen dort`, [text(bin, 'Folge 1.mkv'), text(bin, 'Folge 1 (2).mkv')], ['eins', 'neu'])
    // Back, and a name taken in the meantime is not overwritten.
    const taken = await (await season.getFileHandle('Folge 2.mkv', { create: true })).createWritable!()
    await taken.write(new TextEncoder().encode('inzwischen'))
    await taken.close()
    const back = await restoreBinned(root as never, [...result.binned, ...twice.binned])
    check(`Papierkorb ${way}: alle drei kommen zurück`, back.restored.length, 3)
    check(`Papierkorb ${way}: die inzwischen belegte Datei bleibt, die zurückgelegte bekommt eine Nummer`, [text(season as never, 'Folge 2.mkv'), text(season as never, 'Folge 2 (2).mkv')], ['inzwischen', 'zwei'])
    check(`Papierkorb ${way}: danach ist der Papierkorb leer`, bin.entries.size, 0)
  }
  // The bin looked into later, by a page that knows nothing of what went in:
  // the notes in the bin say where each lay and when.
  for (const canMove of [true, false]) {
    const way = canMove ? 'mit Verschieben' : 'ohne Verschieben (kopiert)'
    const root = new MemoryDir('Anime', canMove)
    const season = await root.getDirectoryHandle('Staffel 1', { create: true })
    for (const [dir, name, body] of [[root, 'Cover.jpg', 'bild'], [season, 'Folge 1.mkv', 'eins'], [season, 'Folge 2.mkv', 'zwei']] as const) {
      const out = await (await dir.getFileHandle(name, { create: true })).createWritable!()
      await out.write(new TextEncoder().encode(body))
      await out.close()
    }
    check(`Ansehen ${way}: ohne Papierkorb nichts darin`, [await countBin(root as never), (await listBin(root as never)).length], [0, 0])
    const listed = await scanHandle(root as never)
    await binFiles(root as never, listed.files.filter((file) => file.name.startsWith('Folge')))
    check(`Ansehen ${way}: zwei Dateien im Papierkorb`, await countBin(root as never), 2)
    const bin = (await root.getDirectoryHandle(BIN_NAME)) as unknown as MemoryDir
    check(`Ansehen ${way}: die Notizen zählen nicht als Datei und stehen nicht in der Liste`, bin.entries.has('.sondra-papierkorb.json'), true)
    const afterBin = await scanHandle(root as never)
    check(`Ansehen ${way}: die Notizen stören den Ordner nicht`, afterBin.files.map((file) => file.path), ['Cover.jpg'])
    const items = await listBin(root as never)
    check(`Ansehen ${way}: Namen und woher sie kamen`, items.map((item) => [item.name, item.from]).sort(), [['Folge 1.mkv', 'Staffel 1/Folge 1.mkv'], ['Folge 2.mkv', 'Staffel 1/Folge 2.mkv']])
    check(`Ansehen ${way}: wann sie hineinkamen`, items.every((item) => typeof item.at === 'number' && item.at > 0), true)
    // The folder they lay in is gone meanwhile: it is made again.
    root.entries.delete('Staffel 1')
    const one = await restoreFromBin(root as never, items.filter((item) => item.name === 'Folge 1.mkv'))
    const again = (await root.getDirectoryHandle('Staffel 1')) as unknown as MemoryDir
    check(`Zurücklegen ${way}: eine Datei, in einem neu angelegten Ordner`, [one.done.length, text(again, 'Folge 1.mkv')], [1, 'eins'])
    const rest = await listBin(root as never)
    check(`Zurücklegen ${way}: die andere liegt noch im Papierkorb`, [rest.map((item) => item.name), rest[0]?.from], [['Folge 2.mkv'], 'Staffel 1/Folge 2.mkv'])
    // Without a note, a file goes back to the top.
    const loose = await (await bin.getFileHandle('Dazu.txt', { create: true })).createWritable!()
    await loose.write(new TextEncoder().encode('lose'))
    await loose.close()
    const withLoose = await listBin(root as never)
    check(`Ansehen ${way}: eine von Hand hineingelegte Datei ist ohne Herkunft da`, withLoose.find((item) => item.name === 'Dazu.txt')?.from, undefined)
    const top = await restoreFromBin(root as never, withLoose.filter((item) => item.name === 'Dazu.txt'))
    check(`Zurücklegen ${way}: ohne Herkunft ganz nach oben`, [top.done.length, text(root, 'Dazu.txt')], [1, 'lose'])
    // For good.
    const gone = await eraseFromBin(root as never, await listBin(root as never))
    check(`Endgültig ${way}: gelöscht, und der Papierkorb ist leer samt Notizen`, [gone.done.length, gone.failed.length, bin.entries.size], [1, 0, 0])
    check(`Endgültig ${way}: was zurückgelegt war, bleibt`, text(again, 'Folge 1.mkv'), 'eins')
  }
  // A note that points out of the folder is not followed.
  {
    const root = new MemoryDir('Sicher', true)
    const bin = await root.getDirectoryHandle(BIN_NAME, { create: true })
    const file = await (await bin.getFileHandle('x.txt', { create: true })).createWritable!()
    await file.write(new TextEncoder().encode('x'))
    await file.close()
    const notes = await (await bin.getFileHandle('.sondra-papierkorb.json', { create: true })).createWritable!()
    await notes.write(new TextEncoder().encode(JSON.stringify({ 'x.txt': { path: '../../etc/x.txt', at: 1 } })))
    await notes.close()
    const [item] = await listBin(root as never)
    const result = await restoreFromBin(root as never, [item])
    const etc = (await root.getDirectoryHandle('etc')) as unknown as MemoryDir
    check('Notiz mit „..“: die Teile werden übergangen, die Datei bleibt im Ordner', [result.done.length, text(etc, 'x.txt'), [...root.entries.keys()].sort()], [1, 'x', [BIN_NAME, 'etc']])
  }
  // Too big to copy where the browser cannot move: said, and left where it is.
  const root = new MemoryDir('Gross', false)
  const handle = await root.getFileHandle('Film.mkv', { create: true })
  const big = { path: 'Film.mkv', name: 'Film.mkv', dir: '', size: 300 * 1024 * 1024, modified: 0, kind: 'video' as const, parent: root as never }
  void handle
  const refused = await binFiles(root as never, [big])
  check('Zu gross zum Kopieren: gesagt, nichts verändert', [refused.binned.length, refused.failed[0]?.reason.includes('Zu gross'), root.entries.has('Film.mkv')], [0, true, true])
}

console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
