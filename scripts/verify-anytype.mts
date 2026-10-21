/**
 * The Merkliste in Anytype, checked without Anytype: a stand-in for its
 * local API (the routes and answers of the 2025-11-08 reference) on a free
 * port, the app's side of the link (desktop/anytype.mjs) talking to it, and
 * the page's side (src/lib/anytype.ts) writing, reading and merging.
 *
 *   npm run verify:anytype
 *
 * The stand-in is strict where Anytype is — the version header, the key —
 * and rewrites a page's Markdown on the way in the way an editor might
 * (lines of the code block joined and re-cut, spaces trimmed), so the data
 * block has to survive that.
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createAnytype, PAGE_NAME } from '../desktop/anytype.mjs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/* -- The stand-in ------------------------------------------------------------ */

const KEY = 'schluessel-123'
const CODE = '4711'
const objects = new Map<string, { id: string; name: string; markdown: string; archived: boolean }>()
let objectCount = 0
let validKey = KEY

/** What an editor might do to Markdown: code lines re-cut at 60, trailing spaces gone. */
function reflow(markdown: string): string {
  return markdown.replace(/```([a-z-]*)\n([\s\S]*?)```/g, (_all, lang: string, code: string) => {
    const joined = code.replace(/\s+/g, '')
    const lines = joined.match(/.{1,60}/g) ?? []
    return '```' + lang + '\n' + lines.join('\n') + '\n```'
  }).replace(/[ \t]+$/gm, '')
}

const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const answer = (status: number, json?: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(json === undefined ? '' : JSON.stringify(json))
    }
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/docs/openapi.json') return answer(200, { openapi: '3.1.0' })
    if (request.headers['anytype-version'] !== '2025-11-08') return answer(400, { message: 'version' })
    const json = body ? JSON.parse(body) : {}
    if (request.method === 'POST' && url.pathname === '/v1/auth/challenges') {
      return json.app_name === 'Sondra' ? answer(201, { challenge_id: 'challenge-1' }) : answer(400, {})
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/api_keys') {
      return json.challenge_id === 'challenge-1' && json.code === CODE ? answer(201, { api_key: KEY }) : answer(400, { message: 'invalid code' })
    }
    if (request.headers.authorization !== `Bearer ${validKey}`) return answer(401, { message: 'unauthorized' })
    if (request.method === 'GET' && url.pathname === '/v1/spaces') {
      return answer(200, { data: [{ id: 'space-a', name: 'Privat' }, { id: 'space-b', name: 'Familie' }], pagination: {} })
    }
    const search = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/search$/)
    if (request.method === 'POST' && search) {
      const data = [...objects.values()].filter((object) => object.name.includes(json.query ?? '')).map(({ markdown: _m, ...rest }) => rest)
      return answer(200, { data, pagination: {} })
    }
    const listObjects = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects$/)
    if (request.method === 'GET' && listObjects) {
      const data = [...objects.values()].map(({ markdown: _m, ...rest }) => rest)
      return answer(200, { data, pagination: {} })
    }
    const create = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects$/)
    if (request.method === 'POST' && create) {
      objectCount += 1
      const object = { id: `object-${objectCount}`, name: json.name, markdown: reflow(json.body ?? ''), archived: false }
      objects.set(object.id, object)
      return answer(201, { object })
    }
    const one = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects\/([^/]+)$/)
    if (one) {
      const object = objects.get(decodeURIComponent(one[2]))
      if (!object) return answer(404, { message: 'not found' })
      if (request.method === 'GET') return answer(200, { object })
      if (request.method === 'PATCH') {
        if (typeof json.markdown === 'string') object.markdown = reflow(json.markdown)
        return answer(200, { object })
      }
    }
    answer(404, { message: 'no route' })
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const api = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

/* -- The app's side ------------------------------------------------------------ */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-anytype-'))
const vault = {
  dataDir,
  encrypt: (text: string) => Buffer.from(`geheim:${text}`),
  decrypt: (data: Buffer) => data.toString().replace(/^geheim:/, ''),
  canEncrypt: () => true,
  api,
}
let link = createAnytype(vault)
const call = (action: string, ...args: unknown[]) => link.handle(action, args) as Promise<Record<string, unknown>>

check('Ohne Anytype: nicht erreichbar', (await createAnytype({ ...vault, api: 'http://127.0.0.1:9' }).handle('status')).reachable, false)
check('Erreichbar, noch nicht verbunden', await call('status'), { ok: true, reachable: true, paired: false, lasting: true, space: null, note: null })
check('Code anfordern', await call('challenge'), { ok: true, challengeId: 'challenge-1' })
check('Falscher Code', await call('pair', 'challenge-1', '0000'), { ok: false, error: 'wrong-code' })
check('Richtiger Code', await call('pair', 'challenge-1', CODE), { ok: true })
check('Schlüssel liegt verschlüsselt', fs.readFileSync(path.join(dataDir, 'anytype-schluessel.bin'), 'utf8'), `geheim:${KEY}`)
check('Spaces', (await call('spaces')).spaces, [{ id: 'space-a', name: 'Privat' }, { id: 'space-b', name: 'Familie' }])
check('Ohne Space kein Lesen', await call('read'), { ok: false, error: 'no-space' })
check('Noch keine Notizen', (await call('listNotes', 'space-a')).notes, [])
check('Space wählen', await call('useSpace', 'space-a', 'Privat'), { ok: true })
check('Noch keine Seite', await call('read'), { ok: true, markdown: null })
check('Unbekannte Aktion', await call('deleteEverything'), { ok: false, error: 'rejected' })

// A new run of the app keeps the key and the space.
link = createAnytype(vault)
check('Nach Neustart verbunden', (await call('status')).space, { id: 'space-a', name: 'Privat' })

/* -- The page's side ----------------------------------------------------------- */

// The page's code asks the app through window.sondraApp; here that is the link above.
const store = new Map<string, string>()
Object.assign(globalThis, {
  window: {
    sondraApp: { anytype: (action: string, ...args: unknown[]) => link.handle(action, args) },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
})
const lib = await import('../src/lib/anytype')
const merk = await import('../src/lib/merkliste')

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
merk.setMerkItems([
  merk.createMerkItem({ id: 'jojo', title: 'JoJo', season: 2, episode: 3, cover: 'data:image/webp;base64,AAAA', updatedAt: 100,
    seasons: [{ number: 1, episodes: 26, watched: range(1, 26) }, { number: 2, episodes: 39, watched: [1, 2] }] }),
  merk.createMerkItem({ id: 'dark', title: 'Dark', season: 1, episode: 1, status: 'later', cover: 'https://bild.example/dark.jpg', updatedAt: 100,
    seasons: [{ number: 1, episodes: 10, watched: [] }] }),
])

let round = await lib.syncMerkliste()
check('Erster Abgleich legt die Seite an', [round.ok, [...objects.values()].map((object) => object.name)], [true, [PAGE_NAME]])
const page = [...objects.values()][0]
check('Seite lesbar: Stand in Worten', page.markdown.includes('**JoJo** — Staffel 2, Folge 3 · 28 von 65 gesehen'), true)
const back = lib.merklisteFromMarkdown(page.markdown)
check('Datenblock übersteht das Umbrechen', back?.items.map((item) => [item.id, item.title, item.episode]), [['jojo', 'JoJo', 3], ['dark', 'Dark', 1]])
const strippedMd = page.markdown.replace('```sondra-merkliste', '```')
const backStripped = lib.merklisteFromMarkdown(strippedMd)
check('Datenblock ohne Sprachkennung lesbar (Anytype-Standard)', backStripped?.items.map((item) => [item.id, item.title]), [['jojo', 'JoJo'], ['dark', 'Dark']])
check('Bild aus Datei reist nicht mit', back?.items[0].cover, merk.LOCAL_PICTURE)
check('Bildadresse reist mit', back?.items[1].cover, 'https://bild.example/dark.jpg')

// ListNotes finds the newly created note and counts items
const foundNotes = (await call('listNotes', 'space-a')).notes as { id: string; name: string; itemCount: number }[]
check('Notizen im Space auflisten', foundNotes.map((n) => [n.name, n.itemCount]), [[PAGE_NAME, 2]])

// Create separate new note
const createdNote = (await call('createNote', 'space-a', 'Sondra · Merkliste (Gerät 2)')) as { id: string; name: string }
check('Neue separate Notiz erstellen', createdNote.name, 'Sondra · Merkliste (Gerät 2)')
check('Beide Notizen bleiben erhalten', [...objects.values()].map((o) => o.name).sort(), [PAGE_NAME, 'Sondra · Merkliste (Gerät 2)'].sort())

// Connect back to the first note
await call('useSpace', 'space-a', 'Privat', page.id, PAGE_NAME)

round = await lib.syncMerkliste()
check('Unverändert: nichts geschrieben, nichts empfangen', round.ok && round.received, 0)

// Another computer ticks off an episode and adds a series, then writes.
const other = lib.merklisteFromMarkdown(page.markdown)!
other.items[0] = { ...other.items[0], episode: 4, updatedAt: 200, seasons: [other.items[0].seasons![0], { ...other.items[0].seasons![1], watched: [1, 2, 3] }] }
other.items.push(merk.createMerkItem({ id: 'frieren', title: 'Frieren', season: 1, episode: 1, updatedAt: 150, seasons: [{ number: 1, episodes: 28, watched: [] }] }))
page.markdown = lib.merklisteToMarkdown(other.items, {})
round = await lib.syncMerkliste()
const mine = merk.merkItems()
check('Von dort: neuere Folge übernommen', mine.find((item) => item.id === 'jojo')?.episode, 4)
check('Von dort: neue Serie dazu', mine.map((item) => item.id).sort(), ['dark', 'frieren', 'jojo'])
check('Eigenes Bild bleibt', mine.find((item) => item.id === 'jojo')?.cover, 'data:image/webp;base64,AAAA')

// Multi-device test: simulate a second device connecting with EMPTY local items
merk.setMerkItems([])
round = await lib.syncMerkliste()
check('Zweites leeres Gerät lädt alle Daten statt zu löschen', merk.merkItems().length > 0, true)
check('Auf Anytype bleibt die Liste vollständig', (lib.merklisteFromMarkdown(page.markdown)?.items.length ?? 0) >= 3, true)

// Removed here: it must not come back from the page.
merk.noteRemoved('dark')
merk.setMerkItems((current) => current.filter((item) => item.id !== 'dark'))
await lib.syncMerkliste()
await lib.syncMerkliste()
check('Hier entfernt bleibt entfernt', merk.merkItems().some((item) => item.id === 'dark'), false)
check('Auf der Seite ebenfalls weg', lib.merklisteFromMarkdown(page.markdown)?.items.some((item) => item.id === 'dark'), false)

// An older list written elsewhere is overwritten by the newer one here.
page.markdown = lib.merklisteToMarkdown([{ ...other.items[0], episode: 2, updatedAt: 50 }], {})
await lib.syncMerkliste()
check('Älterer Stand von dort überschreibt nichts', merk.merkItems().find((item) => item.id === 'jojo')?.episode, 4)
check('Und wird auf der Seite ersetzt', lib.merklisteFromMarkdown(page.markdown)?.items.find((item) => item.id === 'jojo')?.episode, 4)

// The page deleted in Anytype: the next round makes a new one.
objects.clear()
round = await lib.syncMerkliste()
check('Gelöschte Seite wird neu angelegt', [round.ok, objects.size], [true, 1])

// The key withdrawn in Anytype: the round says so, and the key is gone.
validKey = 'anderer-schluessel'
round = await lib.syncMerkliste()
check('Zurückgezogener Schlüssel', round.ok ? 'ok' : round.error, 'unauthorized')
check('Danach nicht mehr verbunden', (await call('status')).paired, false)
check('Getrennt: Schlüsseldatei gelöscht', fs.existsSync(path.join(dataDir, 'anytype-schluessel.bin')), false)
// Statistics calculation check
const testItems = [
  merk.createMerkItem({
    id: 's1',
    title: 'Series 1',
    status: 'watching',
    rating: 5,
    seasons: [{ number: 1, episodes: 24, watched: Array.from({ length: 12 }, (_, i) => i + 1) }],
  }),
  merk.createMerkItem({
    id: 's2',
    title: 'Series 2',
    status: 'later',
    seasons: [{ number: 1, episodes: 10, watched: [] }],
  }),
  merk.createMerkItem({
    id: 's3',
    title: 'Series 3',
    status: 'done',
    rating: 4,
    seasons: [{ number: 1, episodes: 12, watched: Array.from({ length: 12 }, (_, i) => i + 1) }],
  }),
]
const stats = merk.calculateMerklisteStats(testItems)
check('Statistiken: Serien gesamt', stats.totalSeries, 3)
check('Statistiken: Am Schauen', stats.watchingCount, 1)
check('Statistiken: Später', stats.laterCount, 1)
check('Statistiken: Fertig', stats.doneCount, 1)
check('Statistiken: Gesehene Folgen', stats.seenTotal, 24)
check('Statistiken: Bekannte Gesamtfolgen', stats.knownTotalEpisodes, 46)
check('Statistiken: Fortschritt', stats.overallProgressPercent, 52)
check('Statistiken: Staffeln abgeschlossen', stats.completedSeasons, 1)
check('Statistiken: Durchschnittsbewertung', stats.avgRating, '4.5')
check('Statistiken: Formatierung Sehzeit 222 Folgen', merk.formatWatchMinutes(222 * 24).long, '3 Tage, 16 Std., 48 Min.')
check('Statistiken: Formatierung 0 Min.', merk.formatWatchMinutes(0).short, '0 Std.')
// Sorting checks
const sortedByRating = merk.sortMerkItems(testItems, 'rating')
check('Sortierung nach Bewertung: Erstes Element hat 5 Sterne', sortedByRating[0].rating, 5)
const sortedByTitle = merk.sortMerkItems(testItems, 'title')
check('Sortierung nach Titel: Series 1 zuerst', sortedByTitle[0].title, 'Series 1')
const sortedByProgress = merk.sortMerkItems(testItems, 'progress')
check('Sortierung nach Fortschritt: Fertige Serie zuerst', sortedByProgress[0].id, 's3')

// Shuffle / Random Pick check
const picked = merk.pickRandomCandidate(testItems)
check('Zufallsauswahl liefert einen Kandidaten', Boolean(picked), true)
const pickedExclude = merk.pickRandomCandidate(testItems, 's1')
check('Zufallsauswahl respektiert Ausschluss', pickedExclude?.id !== 's1' || testItems.length <= 1, true)

// Binge Plan check
const plan = merk.calculateBingePlan(12)
check('Binge-Plan verbleibende Folgen', plan.episodesRemaining, 12)
check('Binge-Plan Sehzeit', plan.watchTime.short, '4.8 Std.')
check('Binge-Plan Projektion 1/Tag vorhanden', typeof plan.finishAt1PerDay, 'string')

// Duration & Episode-specific exceptions check
const durationTestItem = merk.createMerkItem({
  id: 'dur1',
  title: 'Duration Test Series',
  episodeDuration: 45,
  filmDuration: 110,
  durations: {
    '1:1': 60, // S1E1 exception
    '0:1': 130, // Film 1 exception
  },
  seasons: [
    { number: 1, episodes: 10, watched: [1, 2] },
    { number: 0, episodes: 2, watched: [1] },
  ],
})

check('Dauer: S1E1 Ausnahme (60 Min.)', merk.durationOfEpisode(durationTestItem, 1, 1), 60)
check('Dauer: S1E2 Standard (45 Min.)', merk.durationOfEpisode(durationTestItem, 1, 2), 45)
check('Dauer: Film 1 Ausnahme (130 Min.)', merk.durationOfEpisode(durationTestItem, 0, 1), 130)
check('Dauer: Film 2 Standard (110 Min.)', merk.durationOfEpisode(durationTestItem, 0, 2), 110)

// Watched: S1E1 (60), S1E2 (45), Film 1 (130) -> 60 + 45 + 130 = 235 minutes
check('Gesehene Minuten mit Ausnahmen', merk.itemWatchedMinutes(durationTestItem), 235)

// Remaining unseen:
// Season 1: episodes 3..10 = 8 episodes * 45 = 360 min
// Season 0: film 2 = 110 min
// Total remaining = 360 + 110 = 470 min, remainingCount = 9
const rem = merk.itemRemainingMinutes(durationTestItem)
check('Verbleibende Minuten mit Ausnahmen', rem.minutes, 470)
check('Verbleibende Folgenanzahl', rem.remainingCount, 9)

const planWithExact = merk.calculateBingePlan(rem.remainingCount, 24, rem.minutes)
check('Binge-Plan mit exakter Dauer', planWithExact.watchTime.short, '7.8 Std.')



server.close()
fs.rmSync(dataDir, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nVerbinden, Schreiben, Lesen und Zusammenführen mit Anytype verhalten sich wie erwartet.')
