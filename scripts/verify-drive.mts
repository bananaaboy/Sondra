/**
 * Google Drive, checked without Google: a stand-in for Drive's REST API (the
 * routes, queries and upload kinds Sondra uses, as Drive answers them) for
 * the page's client (src/lib/driveClient.ts), and a stand-in for Google's
 * token endpoint with a pretend browser for the app's sign-in
 * (desktop/googleDrive.mjs).
 *
 *   npm run verify:drive
 *
 * The stand-in is strict where Drive is: every request needs a live token,
 * a resumable upload takes its pieces only in order of their Content-Range,
 * and a 308 says how far it got — or, as a browser may show it across
 * origins, says nothing.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createGoogleDrive, DRIVE_SCOPE } from '../desktop/googleDrive.mjs'
import { createDriveClient, DriveError, folderPath, quote, type DriveFolder } from '../src/lib/driveClient'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/* -- Drive, stand-in ---------------------------------------------------------- */

const FOLDER = 'application/vnd.google-apps.folder'
const API = 'https://drive.test/drive/v3'
const UPLOAD = 'https://drive.test/upload/drive/v3'

interface StoredFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  content: Uint8Array
  modifiedTime: string
  versions: number
}

const files = new Map<string, StoredFile>()
const sessions = new Map<string, { fileId: string | null; meta: { name?: string; parents?: string[]; mimeType?: string }; size: number; data: Uint8Array; received: number }>()
let idCounter = 0
let clock = Date.parse('2026-10-22T10:00:00Z')
const seen = { requests: 0, creates: 0, folderCreates: 0, multipart: 0, media: 0, resumable: 0, pieces: 0, statusQueries: 0, refused401: 0, tooMany: 0 }
const tokens = { valid: new Set(['tok-1']), issued: 1 }
/** Knobs for the next requests. */
const knobs = { hideRange: false, dropPiece: false, quotaFull: false, tooManyOnce: false }

const ROOT = 'root-id'
const now = () => new Date((clock += 1000)).toISOString()

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}
function failure(status: number, reason: string, message = reason) {
  return json({ error: { code: status, message, errors: [{ reason, message }] } }, status)
}

function meta(file: StoredFile) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    trashed: file.trashed,
    ...(file.mimeType === FOLDER ? {} : { size: String(file.content.byteLength) }),
  }
}

/** Drive's query language, as far as Sondra writes it: clauses joined by `and`. */
function matches(file: StoredFile, q: string): boolean {
  const clauses = q.split(/ and (?=(?:[^']*'[^']*')*[^']*$)/)
  return clauses.every((clause) => {
    const unquote = (raw: string) => raw.slice(1, -1).replace(/\\(.)/g, '$1')
    let m = /^name = ('(?:[^'\\]|\\.)*')$/.exec(clause)
    if (m) return file.name === unquote(m[1])
    m = /^mimeType (=|!=) ('(?:[^'\\]|\\.)*')$/.exec(clause)
    if (m) return m[1] === '=' ? file.mimeType === unquote(m[2]) : file.mimeType !== unquote(m[2])
    m = /^('(?:[^'\\]|\\.)*') in parents$/.exec(clause)
    if (m) {
      const parent = unquote(m[1])
      return file.parents.includes(parent === 'root' ? ROOT : parent)
    }
    if (clause === 'trashed = false') return !file.trashed
    throw new Error(`Abfrage nicht verstanden: ${clause}`)
  })
}

function create(fields: { name?: string; parents?: string[]; mimeType?: string }, content = new Uint8Array()): StoredFile {
  const file: StoredFile = {
    id: `id-${(idCounter += 1)}`,
    name: fields.name ?? 'Unbenannt',
    mimeType: fields.mimeType ?? 'application/octet-stream',
    parents: (fields.parents ?? ['root']).map((parent) => (parent === 'root' ? ROOT : parent)),
    trashed: false,
    content,
    modifiedTime: now(),
    versions: 1,
  }
  files.set(file.id, file)
  seen.creates += 1
  if (file.mimeType === FOLDER) seen.folderCreates += 1
  return file
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof Uint8Array) return body
  throw new Error(`Unerwarteter Körper: ${typeof body}`)
}

/** `multipart/related`: the metadata part, then the content. */
function splitMultipart(bytes: Uint8Array, boundary: string) {
  const text = Buffer.from(bytes).toString('latin1')
  const parts = text.split(`--${boundary}`).slice(1, -1)
  const [head, body] = parts.map((part) => {
    const at = part.indexOf('\r\n\r\n')
    return { headers: part.slice(0, at), body: part.slice(at + 4, -2) }
  })
  return { meta: JSON.parse(head.body), content: new Uint8Array(Buffer.from(body.body, 'latin1')), type: /Content-Type: (.*)/i.exec(body.headers)?.[1] }
}

const standIn: typeof fetch = async (input, init = {}) => {
  seen.requests += 1
  const url = new URL(String(input))
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers as HeadersInit)

  // An upload session's address needs no token, as at Drive.
  const session = /^\/session\/(.+)$/.exec(url.pathname)
  if (url.host === 'upload-session.test' && session) {
    const upload = sessions.get(session[1])
    if (!upload) return failure(404, 'notFound')
    const range = headers.get('Content-Range') ?? ''
    const status = /^bytes \*\/(\d+)$/.exec(range)
    const said = (received: number) =>
      new Response(null, { status: 308, headers: knobs.hideRange || received === 0 ? {} : { Range: `bytes=0-${received - 1}` } })
    if (status) {
      seen.statusQueries += 1
      return said(upload.received)
    }
    const piece = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    if (!piece) return failure(400, 'badContentRange')
    const [from, to, total] = piece.slice(1).map(Number)
    if (total !== upload.size || from > upload.received) return failure(400, 'badContentRange', `Lücke: ${from} nach ${upload.received}`)
    const bytes = await bodyBytes(init.body)
    if (bytes.byteLength !== to - from + 1) return failure(400, 'badContentLength')
    seen.pieces += 1
    if (knobs.dropPiece) {
      // Half of it arrives, then the connection drops.
      knobs.dropPiece = false
      const half = bytes.subarray(0, Math.floor(bytes.byteLength / 2))
      upload.data.set(half, from)
      upload.received = Math.max(upload.received, from + half.byteLength)
      throw new TypeError('fetch failed')
    }
    upload.data.set(bytes, from)
    upload.received = Math.max(upload.received, to + 1)
    if (upload.received < upload.size) return said(upload.received)
    sessions.delete(session[1])
    let file: StoredFile
    if (upload.fileId) {
      file = files.get(upload.fileId)!
      file.content = upload.data
      file.modifiedTime = now()
      file.versions += 1
    } else file = create(upload.meta, upload.data)
    return json(meta(file))
  }

  const auth = /^Bearer (.+)$/.exec(headers.get('Authorization') ?? '')?.[1]
  if (!auth || !tokens.valid.has(auth)) {
    seen.refused401 += 1
    return failure(401, 'authError', 'Invalid Credentials')
  }
  if (knobs.tooManyOnce) {
    knobs.tooManyOnce = false
    seen.tooMany += 1
    return failure(429, 'rateLimitExceeded')
  }

  const route = url.href.startsWith(UPLOAD) ? `upload${url.pathname.replace('/upload/drive/v3', '')}` : url.pathname.replace('/drive/v3', '')
  const id = /^(?:upload)?\/files\/([^/]+)$/.exec(route.replace(/^upload/, ''))?.[1]

  if (route === '/about') return json({ user: { displayName: 'Lea Muster', emailAddress: 'lea@example.org' } })

  if (route === '/files' && method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const found = [...files.values()].filter((file) => matches(file, q))
    if (url.searchParams.get('orderBy') === 'modifiedTime desc') found.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
    return json({ files: found.map(meta) })
  }
  if (route === '/files' && method === 'POST') {
    const fields = JSON.parse(new TextDecoder().decode(await bodyBytes(init.body)))
    return json(meta(create(fields)))
  }
  if (id && !route.startsWith('upload') && method === 'GET') {
    const file = files.get(decodeURIComponent(id))
    if (!file) return failure(404, 'notFound', `File not found: ${id}`)
    if (url.searchParams.get('alt') === 'media') return new Response(file.content as Uint8Array<ArrayBuffer>, { status: 200 })
    return json(meta(file))
  }

  if (route.startsWith('upload')) {
    if (knobs.quotaFull) return failure(403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota')
    const kind = url.searchParams.get('uploadType')
    if (kind === 'multipart' && method === 'POST') {
      seen.multipart += 1
      const boundary = /boundary=(.+)$/.exec(headers.get('Content-Type') ?? '')?.[1] ?? ''
      const { meta: fields, content } = splitMultipart(await bodyBytes(init.body), boundary)
      return json(meta(create(fields, content)))
    }
    if (kind === 'media' && method === 'PATCH' && id) {
      seen.media += 1
      const file = files.get(decodeURIComponent(id))
      if (!file) return failure(404, 'notFound')
      file.content = await bodyBytes(init.body)
      file.modifiedTime = now()
      file.versions += 1
      return json(meta(file))
    }
    if (kind === 'resumable') {
      seen.resumable += 1
      const size = Number(headers.get('X-Upload-Content-Length'))
      const fields = JSON.parse(new TextDecoder().decode(await bodyBytes(init.body)) || '{}')
      const sid = `s${(idCounter += 1)}`
      sessions.set(sid, { fileId: id ? decodeURIComponent(id) : null, meta: fields, size, data: new Uint8Array(size), received: 0 })
      return new Response(null, { status: 200, headers: { Location: `https://upload-session.test/session/${sid}` } })
    }
  }
  return failure(400, 'badRequest', `${method} ${route}`)
}

/* -- The page's client -------------------------------------------------------- */

const tokenAsks: boolean[] = []
let cachedFolders: Partial<Record<DriveFolder, string>> = {}
const makeClient = (chunk = 256 * 1024) =>
  createDriveClient({
    token: async (refused) => {
      tokenAsks.push(refused)
      if (refused) {
        tokens.issued += 1
        tokens.valid.add(`tok-${tokens.issued}`)
      }
      return `tok-${tokens.issued}`
    },
    fetch: standIn,
    endpoints: { api: API, upload: UPLOAD },
    chunk,
    folders: { read: () => cachedFolders, write: (ids) => (cachedFolders = ids) },
    wait: async () => {},
  })

const pathOf = (id: string): string => {
  const file = files.get(id)!
  const parent = file.parents[0]
  return parent === ROOT ? file.name : `${pathOf(parent)}/${file.name}`
}
const bytes = (size: number, seed = 1) => {
  const out = new Uint8Array(size)
  let value = seed
  for (let index = 0; index < size; index += 1) out[index] = (value = (value * 1103515245 + 12345) & 0xff)
  return out
}
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b))
const blob = (data: Uint8Array, type = 'application/octet-stream') => new Blob([data as Uint8Array<ArrayBuffer>], { type })

{
  const client = makeClient()

  // Folders: one tree, made once, even when asked for at the same time.
  const [audio, video, projects] = await Promise.all([client.folder('audio'), client.folder('video'), client.folder('projects')])
  check('Ordner Ton liegt unter Sondra/Dateien', pathOf(audio), 'Sondra/Dateien/Ton')
  check('Ordner Video liegt unter Sondra/Dateien', pathOf(video), 'Sondra/Dateien/Video')
  check('Ordner Projekte liegt unter Sondra', pathOf(projects), 'Sondra/Projekte')
  check('Gleichzeitig gefragt: jeder Ordner einmal (Sondra, Dateien, Ton, Video, Projekte)', seen.folderCreates, 5)
  check('Ordnerpfad, wie Drive ihn zeigt', folderPath('images'), 'Sondra/Dateien/Bilder')

  // A small file: one multipart request; then the same name replaced as a new version.
  const first = await client.put('audio', "Lea's \\Aufnahme.wav", blob(bytes(1000), 'audio/wav'), { mode: 'replace' })
  check('Kleine Datei: ein Multipart-Upload', [seen.multipart, first.skipped, first.replaced], [1, false, false])
  check('Name mit Apostroph und Backslash bleibt der Name', files.get(first.file.id)!.name, "Lea's \\Aufnahme.wav")
  check('Abfrage quotet Apostroph und Backslash', quote("a'b\\c"), "'a\\'b\\\\c'")
  const again = await client.put('audio', "Lea's \\Aufnahme.wav", blob(bytes(1200, 2), 'audio/wav'), { mode: 'replace' })
  check('Gleicher Name, „replace“: neue Version derselben Datei', [again.file.id === first.file.id, again.replaced, files.get(first.file.id)!.versions], [true, true, 2])
  check('Neue Version hat den neuen Inhalt', same(files.get(first.file.id)!.content, bytes(1200, 2)), true)

  // skip-same: same name and size is taken to be there already.
  const before = seen.requests
  const skipped = await client.put('audio', "Lea's \\Aufnahme.wav", blob(bytes(1200, 3)), { mode: 'skip-same' })
  check('„skip-same“ mit gleicher Grösse: nichts gesendet', [skipped.skipped, seen.media], [true, 1])
  check('„skip-same“ fragt nur nach (Ordner bekannt, eine Suche)', seen.requests - before, 1)
  const other = await client.put('audio', "Lea's \\Aufnahme.wav", blob(bytes(1300, 3)), { mode: 'skip-same' })
  check('„skip-same“ mit anderer Grösse: neue Version', [other.skipped, other.replaced, seen.media], [false, true, 2])

  // A large file: resumable, in pieces of 256 KiB, with progress up to the end.
  const big = bytes(6 * 1024 * 1024 + 4321, 7)
  const progress: number[] = []
  const large = await client.put('video', 'Film.mp4', blob(big, 'video/mp4'), { mode: 'skip-same', onProgress: (loaded) => progress.push(loaded) })
  check('Grosse Datei: ein resumable Upload', seen.resumable, 1)
  check('In 25 Stücken', seen.pieces, 25)
  check('Inhalt kommt ganz an', same(files.get(large.file.id)!.content, big), true)
  check('Fortschritt steigt und endet bei der Grösse', [progress.every((value, index) => index === 0 || value >= progress[index - 1]), progress.at(-1)], [true, big.byteLength])
  check('Liegt in Sondra/Dateien/Video', pathOf(large.file.id), 'Sondra/Dateien/Video/Film.mp4')

  // A dropped piece: asks where it stands and goes on from there.
  knobs.dropPiece = true
  const pieces = seen.pieces
  const resumed = await client.put('video', 'Film 2.mp4', blob(big, 'video/mp4'), { mode: 'skip-same' })
  check('Abgerissenes Stück: einmal nachgefragt', seen.statusQueries, 1)
  // The dropped piece, then on from its half: not from the start again.
  const chunk = 256 * 1024
  check('… und ab der gemeldeten Stelle weiter', seen.pieces - pieces, 1 + Math.ceil((big.byteLength - chunk / 2) / chunk))
  check('… Inhalt trotzdem ganz', same(files.get(resumed.file.id)!.content, big), true)

  // A browser that hides `Range` across origins: the piece counts as taken.
  knobs.hideRange = true
  const hidden = await client.put('video', 'Film 3.mp4', blob(big, 'video/mp4'), { mode: 'skip-same' })
  check('Ohne sichtbares Range: Stück gilt als angekommen', same(files.get(hidden.file.id)!.content, big), true)
  knobs.dropPiece = true
  const restarted = await client.put('video', 'Film 4.mp4', blob(big, 'video/mp4'), { mode: 'skip-same' })
  check('Ohne Range nach Abriss: von vorn, Inhalt ganz', same(files.get(restarted.file.id)!.content, big), true)
  knobs.hideRange = false

  // A large replace goes through a resumable PATCH on the same file.
  const bigger = bytes(6 * 1024 * 1024 + 99, 9)
  const replaced = await client.put('video', 'Film.mp4', blob(bigger, 'video/mp4'), { mode: 'replace' })
  check('Grosse Datei ersetzt: dieselbe Datei, neue Version', [replaced.file.id === large.file.id, files.get(large.file.id)!.versions], [true, 2])
  check('… mit dem neuen Inhalt', same(files.get(large.file.id)!.content, bigger), true)

  // An empty file is a file too.
  const empty = await client.put('other', 'leer.txt', blob(new Uint8Array(), 'text/plain'), { mode: 'skip-same' })
  check('Leere Datei angelegt', [files.get(empty.file.id)!.content.byteLength, pathOf(empty.file.id)], [0, 'Sondra/Dateien/Andere/leer.txt'])

  // Listed newest first, read back as sent.
  await client.put('projects', 'Erstes.sondra', blob(bytes(50, 1)), { mode: 'replace' })
  await client.put('projects', 'Zweites.sondra', blob(bytes(60, 2)), { mode: 'replace' })
  const listed = await client.list('projects')
  check('Projekte, neuestes zuerst', listed.map((file) => file.name), ['Zweites.sondra', 'Erstes.sondra'])
  check('Grösse als Zahl', listed[0].size, 60)
  check('Zurückgelesen wie gesendet', same(await client.read(listed[1].id), bytes(50, 1)), true)
  check('Konto', await client.account(), { name: 'Lea Muster', email: 'lea@example.org' })

  // A token Drive refuses: asked once more for a fresh one, the step goes on.
  tokens.valid.delete(`tok-${tokens.issued}`)
  tokenAsks.length = 0
  const afterRefusal = await client.list('projects')
  check('Abgelehntes Token: einmal neu gefragt', [tokenAsks, afterRefusal.length], [[false, true], 2])

  // Too many requests: tried again, not reported.
  knobs.tooManyOnce = true
  check('429: wiederholt statt gemeldet', [(await client.list('projects')).length, seen.tooMany], [2, 1])

  // A full Drive is named as such.
  knobs.quotaFull = true
  let code = ''
  try {
    await client.put('downloads', 'gross.mp4', blob(bytes(100)), { mode: 'skip-same' })
  } catch (error) {
    code = error instanceof DriveError ? error.code : String(error)
  }
  check('Voller Speicher heisst „quota“', code, 'quota')
  knobs.quotaFull = false
}

{
  // Folder ids from an earlier visit: used after one check, made anew when binned.
  const creates = seen.folderCreates
  const client = makeClient()
  const projects = await client.folder('projects')
  check('Gemerkte Ordner: kein neuer angelegt', [seen.folderCreates - creates, pathOf(projects)], [0, 'Sondra/Projekte'])
  files.get(cachedFolders.root!)!.trashed = true
  files.get(cachedFolders.merkliste ?? projects)!.trashed = true
  const fresh = makeClient()
  const merkliste = await fresh.folder('merkliste')
  check('Sondra im Papierkorb: neu angelegt, Merkliste darin', [pathOf(merkliste), files.get(files.get(merkliste)!.parents[0])!.trashed], ['Sondra/Merkliste', false])
}

/* -- The app's sign-in ---------------------------------------------------------- */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-drive-'))
const encrypt = (text: string) => Buffer.from(`enc:${text}`)
const decrypt = (data: Buffer) => data.toString().replace(/^enc:/, '')

const google = {
  challenge: '',
  redirect: '',
  refresh: new Set<string>(),
  revoked: [] as string[],
  refreshes: 0,
  scope: DRIVE_SCOPE,
  issueRefresh: true,
}
/** What the pretend browser does with the sign-in: answer, refuse, or close. */
let browser: 'consent' | 'deny' | 'wrong-state' | 'close' = 'consent'

const tokenEndpoint: typeof fetch = async (input, init = {}) => {
  const url = String(input)
  const form = new URLSearchParams(String(init.body ?? ''))
  if (url === 'https://oauth.test/revoke') {
    google.revoked.push(form.get('token') ?? '')
    google.refresh.delete(form.get('token') ?? '')
    return new Response('{}', { status: 200 })
  }
  if (form.get('client_id') !== 'client-1' || form.get('client_secret') !== 'secret-1') return json({ error: 'invalid_client' }, 401)
  if (form.get('grant_type') === 'authorization_code') {
    const verifier = form.get('code_verifier') ?? ''
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    if (form.get('code') !== 'code-1' || challenge !== google.challenge || form.get('redirect_uri') !== google.redirect) {
      return json({ error: 'invalid_grant', error_description: 'Bad code or verifier' }, 400)
    }
    const refresh = `ref-${google.refresh.size + 1}`
    google.refresh.add(refresh)
    return json({ access_token: 'acc-0', expires_in: 3599, scope: google.scope, ...(google.issueRefresh ? { refresh_token: refresh } : {}) })
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (!google.refresh.has(form.get('refresh_token') ?? '')) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
    google.refreshes += 1
    return json({ access_token: `acc-${google.refreshes}`, expires_in: 3599, scope: DRIVE_SCOPE })
  }
  return json({ error: 'unsupported_grant_type' }, 400)
}

const opened: string[] = []
function makeApp() {
  return createGoogleDrive({
    dataDir,
    encrypt,
    decrypt,
    canEncrypt: () => true,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    endpoints: { auth: 'https://accounts.test/o/oauth2/v2/auth', token: 'https://oauth.test/token', revoke: 'https://oauth.test/revoke' },
    fetch: tokenEndpoint,
    openExternal: (address: string) => {
      opened.push(address)
      const url = new URL(address)
      google.challenge = url.searchParams.get('code_challenge') ?? ''
      google.redirect = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      // The browser comes back a moment later, as after a real sign-in.
      if (browser !== 'close') {
        setTimeout(() => {
          const back = new URL(google.redirect)
          if (browser === 'deny') back.search = new URLSearchParams({ error: 'access_denied', state }).toString()
          else back.search = new URLSearchParams({ code: 'code-1', state: browser === 'wrong-state' ? 'falsch' : state, scope: google.scope }).toString()
          void fetch(back).then((response) => response.text())
        }, 20)
      }
    },
  })
}

{
  const app = makeApp()
  check('App: eingerichtet, noch nicht verbunden', await app.handle('status'), { ok: true, configured: true, connected: false, lasting: true, waiting: false })
  check('App: ohne Anmeldung kein Token', await app.handle('token'), { ok: false, error: 'unauthorized' })

  const connected = await app.handle('connect')
  check('App: Anmeldung über den Browser verbindet', connected, { ok: true, lasting: true })
  const asked = new URL(opened.at(-1)!)
  check('App: fragt nur nach drive.file', asked.searchParams.get('scope'), DRIVE_SCOPE)
  check('App: PKCE mit S256, offline', [asked.searchParams.get('code_challenge_method'), asked.searchParams.get('access_type')], ['S256', 'offline'])
  check('App: Rückweg auf 127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(google.redirect), true)
  check('App: Schlüssel verschlüsselt abgelegt', fs.readFileSync(path.join(dataDir, 'google-drive-schluessel.bin')).toString(), 'enc:ref-1')
  let reachable = true
  try {
    await fetch(google.redirect, { signal: AbortSignal.timeout(500) })
  } catch {
    reachable = false
  }
  check('App: Rückweg danach geschlossen', reachable, false)

  const token = await app.handle('token')
  check('App: Token aus der Anmeldung, ohne neue Runde', [token.ok, (token as { token?: string }).token, google.refreshes], [true, 'acc-0', 0])
  const forced = await app.handle('token', [true])
  check('App: abgelehntes Token → neues aus dem Refresh-Token', [(forced as { token?: string }).token, google.refreshes], ['acc-1', 1])

  // A restart: the key is read back, and a token comes from it.
  const restarted = makeApp()
  check('App: nach Neustart verbunden', (await restarted.handle('status')) as unknown, { ok: true, configured: true, connected: true, lasting: true, waiting: false })
  check('App: nach Neustart Token über Refresh', [((await restarted.handle('token')) as { token?: string }).token, google.refreshes], ['acc-2', 2])

  // Withdrawn at Google: the next token request says so, and the key goes.
  google.refresh.clear()
  const withdrawn = makeApp()
  check('App: zurückgezogen → „unauthorized“', await withdrawn.handle('token'), { ok: false, error: 'unauthorized' })
  check('App: … und der Schlüssel ist weg', fs.existsSync(path.join(dataDir, 'google-drive-schluessel.bin')), false)

  // Disconnect withdraws at Google too.
  const again = makeApp()
  await again.handle('connect')
  const held = [...google.refresh][0]
  check('App: Trennen', await again.handle('disconnect'), { ok: true })
  check('App: Trennen zieht bei Google zurück', [google.revoked.at(-1) === held, google.refresh.has(held)], [true, false])
  check('App: nach Trennen nicht verbunden', ((await again.handle('status')) as { connected?: boolean }).connected, false)

  // Refusals the user can make, and a stranger's answer.
  browser = 'deny'
  check('App: abgelehnt im Browser → „denied“', (await again.handle('connect')).error, 'denied')
  browser = 'wrong-state'
  check('App: fremder state → abgelehnt', (await again.handle('connect')).error, 'failed')
  browser = 'consent'
  google.scope = 'openid'
  check('App: Häkchen für Drive fehlte → „scope“', (await again.handle('connect')).error, 'scope')
  google.scope = DRIVE_SCOPE

  // Closed browser: cancelled from the page.
  browser = 'close'
  const waiting = again.handle('connect')
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('App: wartet auf den Browser', ((await again.handle('status')) as { waiting?: boolean }).waiting, true)
  await again.handle('cancel')
  check('App: Abbrechen beendet das Warten', (await waiting).error, 'cancelled')
  check('App: danach wartet nichts mehr', ((await again.handle('status')) as { waiting?: boolean }).waiting, false)
  browser = 'consent'

  // Without a client the app says Drive is not set up.
  const bare = createGoogleDrive({ dataDir, encrypt, decrypt, canEncrypt: () => true, clientId: '', clientSecret: '', openExternal: () => {} })
  check('App: ohne Client nicht eingerichtet', [((await bare.handle('status')) as { configured?: boolean }).configured, (await bare.handle('connect')).error], [false, 'not-configured'])
  check('App: unbekannte Aktion abgelehnt', await bare.handle('constructor'), { ok: false, error: 'rejected' })
}

fs.rmSync(dataDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
