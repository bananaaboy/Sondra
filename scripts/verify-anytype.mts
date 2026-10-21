/**
 * The Merkliste in Anytype, checked without Anytype: a stand-in for its
 * local API (the routes and answers of the 2025-11-08 reference) on a free
 * port, the app's side of the link (desktop/anytype.mjs) talking to it, and
 * the page's side (src/lib/anytype.ts) writing, reading and merging.
 *
 *   npm run verify:anytype
 *
 * The stand-in is strict where Anytype is — the version header, the key —
 * and rewrites a page's Markdown on the way in the way Anytype's export
 * hands it back (a code block loses its language, anytype-heart
 * core/converter/md) and an editor might (lines of the code block joined and
 * re-cut, spaces trimmed), so the data block has to survive that.
 *
 * It speaks `/v2` as well (anytype-heart 0.51.6): a key paired for chosen
 * spaces is refused on `/v1` the way Anytype refuses it, and `/v2` holds a
 * page as blocks with ids, takes no whole-page replace, and keeps to its
 * limits — 512 ops per PATCH, 256 blocks per op, strict bodies.
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
/** A key paired for space-a only: /v1 refuses it, /v2 takes it. */
const SCOPED_KEY = 'schluessel-space-a'
const GRANTED = ['space-a']
let issueScoped = false
const CODE = '4711'

/** A page's top blocks, as Anytype splits Markdown: the code block whole, every list item and heading its own. */
function blocksOf(markdown: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fenced = false
  const flush = () => {
    if (current.some((line) => line.trim())) blocks.push(current.join('\n'))
    current = []
  }
  for (const line of markdown.split('\n')) {
    const fence = line.trimStart().startsWith('```')
    if (fenced) {
      current.push(line)
      if (fence) {
        fenced = false
        flush()
      }
      continue
    }
    if (fence) {
      flush()
      current.push(line)
      fenced = true
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (/^(?:[-*+] |#{1,6} )/.test(line)) flush()
    current.push(line)
  }
  flush()
  return blocks
}

let blockCount = 0
/** A page as Anytype holds it: blocks with lasting ids; its Markdown is what an export makes of them. */
class Page {
  blocks: { id: string; text: string }[] = []
  constructor(
    public id: string,
    public name: string,
    markdown: string,
    public space: string,
    public archived = false,
  ) {
    this.markdown = markdown
  }
  static from(texts: string[]) {
    return texts.map((text) => ({ id: `blk-${(blockCount += 1)}`, text }))
  }
  get markdown() {
    return this.blocks.map((block) => block.text).join('\n\n')
  }
  set markdown(value: string) {
    this.blocks = Page.from(blocksOf(value))
  }
  get row() {
    return { id: this.id, name: this.name, archived: this.archived, space: this.space }
  }
  toJSON() {
    return { ...this.row, markdown: this.markdown }
  }
}
const objects = new Map<string, Page>()
/** What the /v2 side was sent: PATCH rounds, the largest batch and run, /v1 calls with the scoped key. */
const seen = { patches: 0, maxOps: 0, maxBlocks: 0, v1Scoped: 0 }
let objectCount = 0
let validKey = KEY
/** Pages deleted for good in Anytype: it answers 410 for them. */
const gone = new Set<string>()
/** A shared space with reading rights only: writing there is 403. */
const READ_ONLY = 'space-c'

/** What Anytype and an editor do to Markdown: no code language, code lines re-cut at 60, trailing spaces gone. */
function reflow(markdown: string): string {
  return markdown.replace(/```([a-z-]*)\n([\s\S]*?)```/g, (_all, _lang: string, code: string) => {
    const joined = code.replace(/\s+/g, '')
    const lines = joined.match(/.{1,60}/g) ?? []
    return '```\n' + lines.join('\n') + '\n```'
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
      return json.challenge_id === 'challenge-1' && json.code === CODE
        ? answer(201, { api_key: issueScoped ? SCOPED_KEY : KEY })
        : answer(400, { message: 'invalid code' })
    }
    if (request.headers.authorization !== `Bearer ${validKey}`) return answer(401, { message: 'unauthorized' })
    if (validKey === SCOPED_KEY && url.pathname.startsWith('/v1/')) {
      seen.v1Scoped += 1
      return answer(403, {
        status: 403,
        code: 'v1_not_available_for_scoped_keys',
        message: `key "Sondra" carries a space grant (spaces [${GRANTED.join(' ')}] with readwrite access), which /v1 cannot honor — call the same route on /v2, or issue an unscoped key for /v1`,
      })
    }
    if (url.pathname.startsWith('/v2/')) return v2(request.method ?? 'GET', url, json, answer)
    if (request.method === 'GET' && url.pathname === '/v1/spaces') {
      return answer(200, { data: [{ id: 'space-a', name: 'Privat' }, { id: 'space-b', name: 'Familie' }], pagination: {} })
    }
    const search = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/search$/)
    if (request.method === 'POST' && search) {
      const data = [...objects.values()]
        .filter((object) => object.space === search[1] && !gone.has(object.id) && object.name.includes(json.query ?? ''))
        .map((object) => object.row)
      return answer(200, { data, pagination: {} })
    }
    const listObjects = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects$/)
    if (request.method === 'GET' && listObjects) {
      const data = [...objects.values()].filter((object) => object.space === listObjects[1] && !gone.has(object.id)).map((object) => object.row)
      return answer(200, { data, pagination: {} })
    }
    const create = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects$/)
    if (request.method === 'POST' && create && create[1] === READ_ONLY) return answer(403, { message: 'forbidden' })
    if (request.method === 'POST' && create) {
      objectCount += 1
      const object = new Page(`object-${objectCount}`, json.name, reflow(json.body ?? ''), create[1])
      objects.set(object.id, object)
      return answer(201, { object })
    }
    const one = url.pathname.match(/^\/v1\/spaces\/([^/]+)\/objects\/([^/]+)$/)
    if (one) {
      const object = objects.get(decodeURIComponent(one[2]))
      if (!object) return answer(404, { message: 'not found' })
      if (gone.has(object.id)) return answer(410, { message: 'object deleted' })
      if (request.method === 'GET') return answer(200, { object })
      if (request.method === 'PATCH' && one[1] === READ_ONLY) return answer(403, { message: 'forbidden' })
      if (request.method === 'PATCH') {
        if (typeof json.markdown === 'string') object.markdown = reflow(json.markdown)
        return answer(200, { object })
      }
    }
    answer(404, { message: 'no route' })
  })
})

/** The /v2 routes Sondra uses, as strict as Anytype's. */
function v2(method: string, url: URL, json: Record<string, unknown>, answer: (status: number, json?: unknown) => void) {
  const refuse = (status: number, code: string, message: string) => answer(status, { status, code, message, issues: [] })
  const only = (allowed: string[]) => Object.keys(json).find((key) => !allowed.includes(key))
  if (method === 'GET' && url.pathname === '/v2/spaces') {
    const all = [{ id: 'space-a', name: 'Privat' }, { id: 'space-b', name: 'Familie' }]
    return answer(200, { data: all.filter((space) => GRANTED.includes(space.id)), total: 1, offset: 0, limit: 100, has_more: false, has_not_granted_spaces: true })
  }
  const inSpace = url.pathname.match(/^\/v2\/spaces\/([^/]+)\/(.*)$/)
  if (!inSpace) return refuse(404, 'not_found', 'no route')
  const [, space, rest] = inSpace
  if (!GRANTED.includes(space)) return refuse(403, 'space_not_granted', `space "${space}" is not granted to this key`)
  if (method === 'POST' && rest === 'search') {
    const stray = only(['query', 'type', 'filter', 'filters', 'sorts', 'fields'])
    if (stray) return refuse(400, 'validation_failed', `unknown key "${stray}"`)
    const data = [...objects.values()]
      .filter((object) => object.space === space && !gone.has(object.id) && !object.archived && object.name.includes(String(json.query ?? '')))
      .map((object) => ({ id: object.id, name: object.name, type: 'page' }))
    return answer(200, { data, total: data.length, offset: 0, limit: 50, has_more: false })
  }
  if (method === 'GET' && rest === 'objects') {
    const data = [...objects.values()].filter((object) => object.space === space && !gone.has(object.id) && !object.archived).map((object) => ({ id: object.id, name: object.name, type: 'page' }))
    return answer(200, { data, total: data.length, offset: 0, limit: 50, has_more: false })
  }
  if (method === 'POST' && rest === 'objects') {
    const stray = only(['type', 'name', 'properties', 'markdown'])
    if (stray) return refuse(400, 'validation_failed', `unknown key "${stray}" — the shortcut accepts type, name, properties, markdown`)
    if (json.type !== 'page') return refuse(400, 'validation_failed', 'unknown type')
    objectCount += 1
    const object = new Page(`object-${objectCount}`, String(json.name ?? ''), reflow(String(json.markdown ?? '')), space)
    objects.set(object.id, object)
    return answer(201, { id: object.id, type: 'page', etag: 'e1' })
  }
  const one = rest.match(/^objects\/([^/]+)$/)
  if (!one) return refuse(404, 'not_found', 'no route')
  const object = objects.get(decodeURIComponent(one[1]))
  if (!object || object.space !== space) return refuse(404, 'not_found', 'object not found')
  if (gone.has(object.id)) return refuse(410, 'gone', 'object deleted')
  if (method === 'GET' && url.searchParams.get('format') === 'md') {
    if (url.searchParams.get('outline')) return refuse(400, 'validation_failed', 'format=md and outline are mutually exclusive')
    return answer(200, { id: object.id, type: 'page', etag: 'e1', markdown: object.markdown })
  }
  if (method === 'GET' && url.searchParams.get('outline') === 'true') {
    return answer(200, { id: object.id, type: 'page', etag: 'e1', outline: object.blocks.map((block) => ({ indent: 0, id: block.id, type: 'text', text: block.text.slice(0, 80) })) })
  }
  if (method === 'PATCH') {
    const stray = only(['ops'])
    if (stray) return refuse(400, 'validation_failed', `unknown key "${stray}" — the PATCH body carries only ops`)
    const ops = json.ops as Record<string, unknown>[]
    if (!Array.isArray(ops) || ops.length === 0) return refuse(400, 'validation_failed', 'ops missing')
    if (ops.length > 512) return refuse(400, 'validation_failed', `${ops.length} ops exceed the 512-op limit`)
    // One batch is atomic: worked on a copy, kept only when every op went through.
    let blocks = [...object.blocks]
    for (const [index, op] of ops.entries()) {
      if (op.op === 'delete_block') {
        if (!blocks.some((block) => block.id === op.id)) return refuse(400, 'validation_failed', `ops[${index}]: unknown block "${String(op.id)}"`)
        blocks = blocks.filter((block) => block.id !== op.id)
      } else if (op.op === 'insert_blocks') {
        if (op.position !== undefined && op.position !== 'first' && op.position !== 'last') return refuse(400, 'validation_failed', 'invalid position')
        const run = blocksOf(reflow(String(op.markdown ?? '')))
        if (run.length > 256) return refuse(400, 'validation_failed', `ops[${index}]: ${run.length} blocks exceed the 256-block per-op limit`)
        seen.maxBlocks = Math.max(seen.maxBlocks, run.length)
        blocks = op.position === 'first' ? [...Page.from(run), ...blocks] : [...blocks, ...Page.from(run)]
      } else {
        return refuse(400, 'validation_failed', `ops[${index}]: op "${String(op.op)}" not used here`)
      }
    }
    object.blocks = blocks
    seen.patches += 1
    seen.maxOps = Math.max(seen.maxOps, ops.length)
    return answer(200, { id: object.id, etag: 'e2', diff_stats: {} })
  }
  return refuse(405, 'method_not_allowed', method)
}

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

// Removed, then read back in from a file: the file wins, also on the page,
// although the page still remembers the removal.
const titles = () => merk.merkItems().map((item) => item.title).sort()
merk.setMerkItems((current) => [...current, merk.createMerkItem({ id: 'mob', title: 'Mob', updatedAt: 300 }), merk.createMerkItem({ id: 'nana', title: 'Nana', updatedAt: 300 })])
await lib.syncMerkliste()
const file = merk.exportMerkliste()
for (const id of ['frieren', 'mob', 'nana']) {
  merk.noteRemoved(id)
  merk.setMerkItems((current) => current.filter((item) => item.id !== id))
}
await lib.syncMerkliste()
check('Drei entfernt, auch auf der Seite', lib.merklisteFromMarkdown(page.markdown)?.items.map((item) => item.title), ['JoJo'])
const imported = merk.importMerkliste(merk.readMerklisteFile(file))
check('Einlesen meldet', [imported.result.added, imported.result.same], [3, 1])
await lib.syncMerkliste()
await lib.syncMerkliste()
check('Eingelesenes bleibt nach dem Abgleich', titles(), ['Frieren', 'JoJo', 'Mob', 'Nana'])
check('Und steht auf der Seite', lib.merklisteFromMarkdown(page.markdown)?.items.map((item) => item.title).sort(), ['Frieren', 'JoJo', 'Mob', 'Nana'])
check('Verbrauchte Entfernungen reisen nicht weiter', Object.keys(lib.merklisteFromMarkdown(page.markdown)?.removed ?? {}).filter((id) => id !== 'dark'), [])

// Reading in taken back: what the file added goes, also from the page.
const extra = merk.exportMerkliste([merk.createMerkItem({ id: 'ghibli', title: 'Ghibli', updatedAt: 400 })])
const second = merk.importMerkliste(merk.readMerklisteFile(extra))
await lib.syncMerkliste()
merk.revertImport(second.before)
await lib.syncMerkliste()
await lib.syncMerkliste()
check('Einlesen rückgängig: bleibt weg', titles(), ['Frieren', 'JoJo', 'Mob', 'Nana'])
check('Einlesen rückgängig: auch auf der Seite', lib.merklisteFromMarkdown(page.markdown)?.items.some((item) => item.id === 'ghibli'), false)

// A removal undone after the round already took it to the page.
const nana = merk.merkItems().find((item) => item.id === 'nana') ?? merk.createMerkItem({ id: 'nana', title: 'Nana', updatedAt: 300 })
const nanaAt = merk.merkItems().indexOf(nana)
merk.noteRemoved('nana')
merk.setMerkItems((current) => current.filter((item) => item.id !== 'nana'))
await lib.syncMerkliste()
merk.restoreMerkItem(nana, nanaAt)
await lib.syncMerkliste()
await lib.syncMerkliste()
check('Rückgängig nach dem Abgleich hält', titles(), ['Frieren', 'JoJo', 'Mob', 'Nana'])

// A data block Sondra cannot read is not written over.
const intact = page.markdown
page.markdown = intact.replace(/```\n[\s\S]*?```/, '```\nkaputt\n```')
const bent = page.markdown
round = await lib.syncMerkliste()
check('Unlesbarer Datenblock: Abgleich hält an', round.ok ? 'ok' : round.error, 'unreadable')
check('Unlesbarer Datenblock: Seite unverändert', page.markdown, bent)
page.markdown = intact

// Connecting with „Aus Anytype laden“: the page's list replaces this one,
// and the replaced one can be taken back in.
const onPage = lib.merklisteFromMarkdown(page.markdown)!.items.map((item) => item.title).sort()
merk.setMerkItems([merk.createMerkItem({ id: 'nur-hier', title: 'Nur hier', updatedAt: 500 })])
const loaded = await lib.loadFromAnytype()
check('Laden: Liste aus Anytype ersetzt diese', titles(), onPage)
check('Laden: meldet, wie viele', loaded.ok && [loaded.loaded, loaded.empty, loaded.before.map((item) => item.title)], [onPage.length, false, ['Nur hier']])
check('Laden: danach nichts zu schreiben', lib.inStepWithAnytype(merk.merkItems()), true)
if (loaded.ok) merk.importMerkliste(loaded.before)
await lib.syncMerkliste()
check('Bisherige dazugenommen, auch auf der Seite', lib.merklisteFromMarkdown(page.markdown)?.items.some((item) => item.id === 'nur-hier'), true)

// A shared space with reading rights only: the round says so, the key stays.
await call('useSpace', READ_ONLY, 'Geteilt')
round = await lib.syncMerkliste()
check('Nur Leserechte: Abgleich sagt es', round.ok ? 'ok' : round.error, 'forbidden')
check('Nur Leserechte: Grund steht dabei', !round.ok && Boolean(round.detail?.includes('403')), true)
check('Nur Leserechte: Zugang bleibt', (await call('status')).paired, true)
await call('useSpace', 'space-a', 'Privat', page.id, PAGE_NAME)

// The page deleted for good (410): found missing, made anew.
gone.add(page.id)
round = await lib.syncMerkliste()
check('Endgültig gelöschte Seite (410) wird neu angelegt', [round.ok, [...objects.values()].filter((object) => !gone.has(object.id)).length >= 1], [true, true])

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

/* -- A key for chosen spaces (Anytype 0.51.6): /v2 --------------------------- */

// Paired anew; this time the user handed Sondra only „Privat“.
issueScoped = true
validKey = SCOPED_KEY
await call('challenge')
check('Neu verbunden, nur für einen Space', await call('pair', 'challenge-1', CODE), { ok: true })
const config = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'anytype.json'), 'utf8'))
check('Spaces: /v1 lehnt ab, /v2 nennt den freigegebenen', (await call('spaces')).spaces, [{ id: 'space-a', name: 'Privat' }])
check('Ab jetzt /v2', config().api, 'v2')
const v1Before = seen.v1Scoped
round = await lib.syncMerkliste()
check('Abgleich über /v2', round.ok, true)
check('Kein /v1 mehr nach dem Wechsel', seen.v1Scoped, v1Before)
const v2Page = [...objects.values()].find((object) => object.space === 'space-a' && !gone.has(object.id))!
check('Liste steht auf der Seite (/v2)', lib.merklisteFromMarkdown(v2Page.markdown)?.items.map((item) => item.title).sort(), titles())

// A long list: more blocks than one op, later more ops than one PATCH.
// Those already on the page stay: the merge keeps them.
const kept = titles().length
const many = Array.from({ length: 600 }, (_, i) => merk.createMerkItem({ id: `serie-${i}`, title: `Serie ${i}`, updatedAt: 1000 + i }))
merk.setMerkItems(many)
round = await lib.syncMerkliste()
check('600 Serien über /v2 geschrieben', [round.ok, lib.merklisteFromMarkdown(v2Page.markdown)?.items.length], [true, 600 + kept])
check('Je Op höchstens 256 Blöcke', seen.maxBlocks <= 256, true)
const patchesBefore = seen.patches
merk.setMerkItems((current) => current.map((item) => (item.id === 'serie-7' ? { ...item, episode: 9, updatedAt: 5000 } : item)))
round = await lib.syncMerkliste()
check('Zweites Schreiben: in Runden zu höchstens 512 Ops', [round.ok, seen.maxOps <= 512, seen.patches - patchesBefore > 1], [true, true, true])
const after = lib.merklisteFromMarkdown(v2Page.markdown)
check('Danach genau die neue Fassung', [after?.items.length, after?.items.find((item) => item.id === 'serie-7')?.episode, blocksOf(v2Page.markdown).filter((block) => block.startsWith('## Sondra-Daten')).length], [600 + kept, 9, 1])

// A space chosen before, which this key was not given.
await call('useSpace', 'space-b', 'Familie')
round = await lib.syncMerkliste()
check('Nicht freigegebener Space: Abgleich sagt es', round.ok ? 'ok' : round.error, 'not-granted')
await call('useSpace', 'space-a', 'Privat', v2Page.id, PAGE_NAME)

// New page and the list of pages, over /v2.
const thirdNote = (await call('createNote', 'space-a', 'Sondra · Merkliste (Gerät 3)', 'Privat')) as { ok: boolean; name: string }
check('Neue Notiz über /v2', [thirdNote.ok, thirdNote.name], [true, 'Sondra · Merkliste (Gerät 3)'])
const notesV2 = ((await call('listNotes', 'space-a')).notes as { name: string; itemCount: number }[]).find((note) => note.name === PAGE_NAME)
check('Notizen über /v2 mit Anzahl', notesV2?.itemCount, 600 + kept)
await call('useSpace', 'space-a', 'Privat', v2Page.id, PAGE_NAME)

// The next run of the app goes to /v2 straight away.
link = createAnytype(vault)
const v1AtRestart = seen.v1Scoped
check('Nach Neustart gleich über /v2', [(await lib.syncMerkliste()).ok, seen.v1Scoped - v1AtRestart], [true, 0])
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
