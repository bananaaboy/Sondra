/**
 * The WebDAV target, checked without a NAS: a stand-in for a WebDAV server
 * (MKCOL, PUT, PROPFIND, Basic auth, the answers a real one gives for a
 * folder that is there, a disk that is full, an address that moved), the
 * app's side of the link (desktop/webdav.mjs) talking to it, and the app's
 * own server (desktop/server.mjs) sending a download on.
 *
 *   npm run verify:webdav
 *
 * What it holds to: the password never lies in the clear on disk and never
 * comes back out; a path from the page cannot climb out of its folder; a
 * request from another origin is turned away before it writes anything; and
 * a file reaches the server byte for byte, through folders made on the way.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { cleanSegment, createWebdav, joinUrl, pathParts } from '../desktop/webdav.mjs'
import { startServer } from '../desktop/server.mjs'
import { episodeFolder, seasonDirName } from '../src/lib/storageLayout'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/* -- The stand-in ------------------------------------------------------------ */

const USER = 'mia'
const PASSWORD = 'g3heim-äö'
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

interface Stand {
  url: string
  /** Folders (collection paths without the slashes at the ends) and files, as the server holds them. */
  folders: Set<string>
  files: Map<string, Buffer>
  requests: string[]
  /** The length and transfer coding each PUT arrived with. */
  puts: { length: string | undefined; coding: string | undefined; size: number }[]
  close: () => Promise<void>
}

/** A WebDAV server under /dav. `/dav/voll` answers 507, `/dav/umzug` redirects, `/dav/leer` has no WebDAV. */
async function standIn(): Promise<Stand> {
  const folders = new Set<string>(['/dav'])
  const files = new Map<string, Buffer>()
  const requests: string[] = []
  const puts: Stand['puts'] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).replace(/\/+$/, '')
      requests.push(`${request.method} ${pathname}`)
      const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, 'utf8').toString('base64')}`
      if (request.headers.authorization !== expected) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' }).end()
        return
      }
      if (pathname.startsWith('/dav/umzug')) {
        response.writeHead(301, { location: 'https://elsewhere.example/dav' }).end()
        return
      }
      if (pathname.startsWith('/dav/leer')) {
        response.writeHead(501).end()
        return
      }
      const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/'
      if (request.method === 'MKCOL') {
        if (folders.has(pathname) || files.has(pathname)) response.writeHead(405).end()
        else if (!folders.has(parent)) response.writeHead(409).end()
        else {
          folders.add(pathname)
          response.writeHead(201).end()
        }
      } else if (request.method === 'PUT') {
        if (pathname.startsWith('/dav/voll')) response.writeHead(507).end()
        else if (!folders.has(parent)) response.writeHead(409).end()
        else {
          const existed = files.has(pathname)
          files.set(pathname, Buffer.concat(chunks))
          puts.push({ length: request.headers['content-length'], coding: request.headers['transfer-encoding'], size: Buffer.concat(chunks).length })
          response.writeHead(existed ? 204 : 201).end()
        }
      } else if (request.method === 'PROPFIND') {
        if (folders.has(pathname)) response.writeHead(207, { 'content-type': 'application/xml' }).end('<d:multistatus xmlns:d="DAV:"/>')
        else response.writeHead(404).end()
      } else {
        response.writeHead(405).end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/dav`,
    folders,
    files,
    requests,
    puts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A "key store" that is not plaintext: the bytes are reversed and tagged, so a clear-text search finds nothing. */
const sealed = {
  encrypt: (text: string) => Buffer.from(`SEALED:${[...Buffer.from(text, 'utf8')].reverse().map((b) => b.toString(16)).join('.')}`),
  decrypt: (data: Buffer) => {
    const body = data.toString().replace(/^SEALED:/, '')
    return Buffer.from(body.split('.').reverse().map((h) => parseInt(h, 16))).toString('utf8')
  },
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-webdav-test-'))
const dataDir = path.join(scratch, 'daten')
const link = (canEncrypt = true, dir = dataDir) =>
  createWebdav({ dataDir: dir, encrypt: sealed.encrypt, decrypt: sealed.decrypt, canEncrypt: () => canEncrypt })

const dav = await standIn()
const bigBytes = crypto.randomBytes(3 * 1024 * 1024 + 17)

try {
  /* -- Names ----------------------------------------------------------------- */

  check('pathParts: nie ".." und kein Anfang', pathParts('/../Sondra\\..//Serien/./x'), ['Sondra', 'Serien', 'x'])
  check('cleanSegment: Windows-Zeichen und Endpunkt', cleanSegment('Folge 1: Anfang?.'), 'Folge 1- Anfang-')
  check('joinUrl: kodiert und mit Schrägstrich bei Ordnern', joinUrl('https://h/dav/', ['Frieren – Folge 1', 'ä b'], { collection: true }), 'https://h/dav/Frieren%20%E2%80%93%20Folge%201/%C3%A4%20b/')
  check('Schema Sondra: Staffel und Filme', [seasonDirName(1, 'sondra'), seasonDirName(0, 'sondra')], ['Staffel 1', 'Filme'])
  check('Schema Jellyfin: Season 01 und Specials', [seasonDirName(1, 'jellyfin'), seasonDirName(12, 'jellyfin'), seasonDirName(0, 'jellyfin')], ['Season 01', 'Season 12', 'Specials'])
  check('episodeFolder mit Serie', episodeFolder('Frieren', 2, 'jellyfin'), 'Frieren/Season 02')
  check('episodeFolder: Schrägstrich im Titel wird kein Ordner', episodeFolder('AC/DC Show', 1, 'sondra'), 'AC-DC Show/Staffel 1')
  check('episodeFolder ohne Serie liegt im Ziel', episodeFolder(undefined, 1, 'sondra'), '')
  check('episodeFolder ohne Staffel nur die Serie', episodeFolder('Frieren', undefined, 'sondra'), 'Frieren')

  /* -- Einrichten, Passwort -------------------------------------------------- */

  const dave = link()
  check('anfangs nicht eingerichtet', (await dave.handle('status')).configured, false)
  check('Adresse mit Passwort wird abgelehnt', (await dave.handle('configure', [{ url: `http://${USER}:${PASSWORD}@127.0.0.1/dav` }])).code, 'credentials-in-address')
  check('ftp:// wird abgelehnt', (await dave.handle('configure', [{ url: 'ftp://nas/dav' }])).code, 'bad-address')
  check('leere Adresse wird abgelehnt', (await dave.handle('configure', [{ url: ' ' }])).code, 'no-address')
  check('nach Ablehnung weiter nicht eingerichtet', dave.isConfigured(), false)

  const wrong = await dave.handle('configure', [{ url: dav.url + '/', username: USER, password: 'falsch', basePath: 'Sondra' }])
  check('Einrichten sagt ok', wrong.ok, true)
  check('Zielpfad bekommt einen Anfang', wrong.basePath, '/Sondra')
  check('Passwort kommt nicht zurück', 'password' in wrong, false)
  check('falsches Passwort: unauthorized', (await dave.handle('test')).code, 'unauthorized')

  const set = await dave.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD, basePath: '/Sondra' }])
  check('Passwort gemerkt, nicht gezeigt', [set.hasPassword, 'password' in set, set.remembered], [true, false, true])
  const onDisk = fs
    .readdirSync(dataDir)
    .map((name) => fs.readFileSync(path.join(dataDir, name)).toString('latin1'))
    .join('\n')
  check('Passwort liegt nirgends im Klartext auf der Platte', onDisk.includes(PASSWORD), false)
  check('… auch nicht ohne Umlaute', onDisk.includes('g3heim'), false)
  const keep = await dave.handle('configure', [{ url: dav.url, username: USER, basePath: '/Sondra' }])
  check('ohne neues Passwort bleibt das alte', keep.hasPassword, true)
  const again = link()
  check('ein neuer Start liest es wieder', [again.isConfigured(), again.status().hasPassword], [true, true])

  const volatile = link(false, path.join(scratch, 'ohne-schluessel'))
  await volatile.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD }])
  check('ohne Schlüsselspeicher: nur im Speicher, und es sagt es', [volatile.status().hasPassword, volatile.status().remembered], [true, false])
  check('… und danach nichts auf der Platte', fs.existsSync(path.join(scratch, 'ohne-schluessel', 'webdav-passwort.bin')), false)

  /* -- Verbindung testen ----------------------------------------------------- */

  const first = await dave.handle('test')
  check('Test: Zielpfad noch nicht da, Server antwortet', [first.ok, first.folder], [true, 'new'])
  // A port that was free a moment ago and has nobody on it now (fetch refuses a few low ports outright).
  const closedPort = await new Promise<number>((resolve) => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
  const nowhere = link(true, path.join(scratch, 'nirgends'))
  await nowhere.handle('configure', [{ url: `http://127.0.0.1:${closedPort}/dav`, username: USER, password: PASSWORD }])
  check('Test: Server nicht erreichbar', (await nowhere.handle('test')).code, 'refused')
  const noDav = link(true, path.join(scratch, 'ohne-dav'))
  await noDav.handle('configure', [{ url: `${dav.url}/leer`, username: USER, password: PASSWORD, basePath: '/' }])
  check('Test: ein Server ohne WebDAV', (await noDav.handle('test')).code, 'no-webdav')

  // A NAS with a certificate of its own, which nobody told this computer to trust, is refused with its reason.
  const certDir = path.join(scratch, 'zertifikat')
  fs.mkdirSync(certDir, { recursive: true })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  const secure = https.createServer({ key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) }, (_q, r) => r.writeHead(207).end())
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
  const selfSigned = link(true, path.join(scratch, 'selbst'))
  await selfSigned.handle('configure', [{ url: `https://127.0.0.1:${(secure.address() as AddressInfo).port}/dav`, username: USER, password: PASSWORD }])
  check('Test: Zertifikat, dem niemand traut', (await selfSigned.handle('test')).code, 'certificate')
  secure.close()

  /* -- Hochladen ------------------------------------------------------------- */

  const small = path.join(scratch, 'folge.mp4')
  fs.writeFileSync(small, bigBytes)
  const sent = await dave.putFile({ segments: ['Frieren', 'Staffel 1'], fileName: 'Frieren S01E01.mp4', filePath: small, mime: 'video/mp4' })
  check('Upload: Pfad auf dem Server', sent.relPath, 'Sondra/Frieren/Staffel 1/Frieren S01E01.mp4')
  check('Upload: Ordner der Reihe nach angelegt', ['/dav/Sondra', '/dav/Sondra/Frieren', '/dav/Sondra/Frieren/Staffel 1'].every((f) => dav.folders.has(f)), true)
  const stored = dav.files.get('/dav/Sondra/Frieren/Staffel 1/Frieren S01E01.mp4')
  check('Upload: Byte für Byte angekommen', stored ? hash(stored) : null, hash(bigBytes))
  check('Upload: mit Länge im Kopf, nicht in Stücken', [dav.puts[0]?.length, dav.puts[0]?.coding], [String(bigBytes.length), undefined])
  check('Test danach: Zielpfad ist da', (await dave.handle('test')).folder, 'there')

  const before = dav.requests.length
  await dave.putFile({ segments: ['Frieren', 'Staffel 1'], fileName: 'Frieren S01E02.mp4', filePath: small })
  check('zweite Folge im selben Ordner: vorhandene Ordner sind kein Fehler', dav.files.has('/dav/Sondra/Frieren/Staffel 1/Frieren S01E02.mp4'), true)
  check('… und es wurde nichts doppelt angelegt', dav.requests.slice(before).filter((r) => r.startsWith('PUT')).length, 1)

  await dave.putFile({ segments: ['..', '..', 'Ausbruch', 'a\\..\\b'], fileName: '../../boese.mp4', filePath: small })
  check('Pfad aus der Seite klettert nicht aus dem Ordner', [...dav.files.keys()].filter((f) => !f.startsWith('/dav/Sondra/')), [])
  check('… der Name verliert die Schrägstriche', dav.files.has('/dav/Sondra/Ausbruch/a/b/..-..-boese.mp4') || [...dav.files.keys()].some((f) => f.endsWith('boese.mp4')), true)

  await dave.putFile({ segments: ['Serie mit Umlaut ä'], fileName: 'Folge „1“ – ü.mp4', filePath: small })
  check('Umlaute und Sonderzeichen im Namen', dav.files.has('/dav/Sondra/Serie mit Umlaut ä/Folge „1“ – ü.mp4'), true)

  const full = link(true, path.join(scratch, 'voll'))
  await full.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD, basePath: '/voll' }])
  check('Platte voll: full', await full.putFile({ segments: [], fileName: 'x.mp4', filePath: small }).catch((e) => e.code), 'full')
  const moved = link(true, path.join(scratch, 'umzug'))
  await moved.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD, basePath: '/umzug' }])
  check('Weiterleitung wird gemeldet, nicht ausgeführt', await moved.putFile({ segments: [], fileName: 'x.mp4', filePath: small }).catch((e) => e.code), 'redirect')
  const unconfigured = link(true, path.join(scratch, 'leer'))
  check('ohne Einrichtung: not-configured', await unconfigured.putFile({ segments: [], fileName: 'x.mp4', filePath: small }).catch((e) => e.code), 'not-configured')

  const forgotten = await dave.handle('forget')
  check('Entfernen: weg, Passwort auch', [forgotten.configured, forgotten.hasPassword], [false, false])
  check('… Dateien auf der Platte gelöscht', fs.readdirSync(dataDir).filter((n) => n.startsWith('webdav')), [])

  /* -- Der Server der App ---------------------------------------------------- */

  // The source a download comes from.
  const sourceBytes = crypto.randomBytes(1024 * 1024 + 5)
  const source = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': sourceBytes.length }).end(sourceBytes))
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  const sourceUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}/film.mp4`

  const root = path.join(scratch, 'seite')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Sondra</title>')
  const appData = path.join(scratch, 'app-daten')
  const appDav = link(true, appData)
  await appDav.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD, basePath: '/Sondra' }])
  const logged: string[] = []
  const { server, url: site } = await startServer({ root, port: 0, dataDir: appData, webdav: appDav, onError: (m: string) => logged.push(m) })
  check('Server: Anfragen werden nicht nach fünf Minuten abgebrochen', (server as http.Server).requestTimeout, 0)
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(site + route.replace(/^\//, ''), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  const target = path.join(scratch, 'ziel')
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sondra-webdav-')))

  // Local only, as before — but with the answer the page reads.
  const local = await (await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, subFolder: 'Frieren/Staffel 1', filename: 'a.mp4' })).json()
  check('direct-save: Antwort heisst savedPath und bytesWritten', [local.ok, typeof local.savedPath, local.bytesWritten], [true, 'string', sourceBytes.length])
  check('direct-save: Datei im Unterordner', hash(fs.readFileSync(path.join(target, 'Frieren', 'Staffel 1', 'a.mp4'))), hash(sourceBytes))
  check('direct-save: "offeredUrl" bleibt, wo bisher', typeof local.offeredUrl, 'string')

  // Local and WebDAV.
  const both = await (await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, subFolder: 'Frieren/Season 01', filename: 'b.mp4', webdav: true })).json()
  check('Ordner + WebDAV: beides gespeichert', [fs.existsSync(path.join(target, 'Frieren', 'Season 01', 'b.mp4')), both.webdavPath], [true, 'Sondra/Frieren/Season 01/b.mp4'])
  check('Ordner + WebDAV: auf dem Server unverändert', hash(dav.files.get('/dav/Sondra/Frieren/Season 01/b.mp4') ?? Buffer.alloc(0)), hash(sourceBytes))

  // WebDAV only: nothing stays here.
  const only = await (await post('/api/direct-save', { directUrl: sourceUrl, subFolder: 'Frieren/Season 01', filename: 'c.mp4', webdav: true, keepLocal: false })).json()
  check('nur WebDAV: keine Kopie hier gemeldet', [only.ok, only.savedPath, only.offeredUrl, only.webdavPath], [true, null, null, 'Sondra/Frieren/Season 01/c.mp4'])
  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sondra-webdav-') && !tmpBefore.has(n))
  check('nur WebDAV: der Zwischenordner ist wieder weg', tmpAfter, [])

  // WebDAV and something else that wants the file (Drive): the temp copy stays for the page to fetch.
  const forDrive = await (await post('/api/direct-save', { directUrl: sourceUrl, subFolder: 'Frieren', filename: 'd.mp4', webdav: true, keepLocal: false, offer: true })).json()
  const fetched = Buffer.from(await (await fetch(site + String(forDrive.offeredUrl).replace(/^\//, ''))).arrayBuffer())
  check('mit Drive: die Seite holt die Datei vom Server ab', hash(fetched), hash(sourceBytes))

  // The page names no path: a folder with .. stays below the target.
  await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, subFolder: '../../Ausbruch', filename: '../x.mp4' })
  check('direct-save: ".." klettert nicht aus dem Zielordner', fs.existsSync(path.join(scratch, 'Ausbruch')) || fs.existsSync(path.join(os.tmpdir(), 'Ausbruch')), false)

  // Another origin gets nothing written.
  const evil = await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, filename: 'fremd.mp4' }, { Origin: 'https://boese.example' })
  check('fremde Herkunft: 403', evil.status, 403)
  const site2 = await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, filename: 'fremd2.mp4' }, { 'Sec-Fetch-Site': 'cross-site' })
  check('cross-site: 403', site2.status, 403)
  check('… und nichts geschrieben', [fs.existsSync(path.join(target, 'fremd.mp4')), fs.existsSync(path.join(target, 'fremd2.mp4'))], [false, false])
  const own = await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, filename: 'eigen.mp4' }, { Origin: new URL(site).origin, 'Sec-Fetch-Site': 'same-origin' })
  check('eigene Herkunft wird bedient', own.status, 200)

  // Sending to WebDAV with none set up.
  const bare = await startServer({ root, port: 0, dataDir: path.join(scratch, 'bare'), webdav: link(true, path.join(scratch, 'bare-w')) })
  const noSetup = await fetch(bare.url + 'api/direct-save', { method: 'POST', body: JSON.stringify({ directUrl: sourceUrl, filename: 'z.mp4', webdav: true, keepLocal: false }) })
  check('ohne Einrichtung: 409 und nichts gesendet', [noSetup.status, (await noSetup.json()).error], [409, 'webdav-not-configured'])
  bare.server.close()

  // The server says no: the answer carries the reason and, where there is one, the local copy.
  await appDav.handle('configure', [{ url: dav.url, username: USER, password: 'falsch' }])
  const refused = await post('/api/direct-save', { directUrl: sourceUrl, targetDir: target, filename: 'e.mp4', webdav: true })
  const refusedAnswer = await refused.json()
  check('WebDAV lehnt ab: 502 mit Grund und lokaler Kopie', [refused.status, refusedAnswer.code, typeof refusedAnswer.savedPath], [502, 'unauthorized', 'string'])
  check('… Passwort steht in keiner Meldung', JSON.stringify([refusedAnswer, logged]).includes(PASSWORD), false)
  await appDav.handle('configure', [{ url: dav.url, username: USER, password: PASSWORD }])

  // Bytes the page holds.
  const put = (query: string, body: Buffer, headers: Record<string, string> = {}) =>
    fetch(`${site}api/webdav-upload?${query}`, { method: 'PUT', headers: { 'content-type': 'video/mp4', ...headers }, body })
  const page = crypto.randomBytes(700_001)
  const up = await put(new URLSearchParams({ name: 'f.mp4', sub: 'Frieren/Staffel 1' }).toString(), page)
  const upAnswer = await up.json()
  check('webdav-upload: angekommen', [up.status, upAnswer.webdavPath], [200, 'Sondra/Frieren/Staffel 1/f.mp4'])
  check('webdav-upload: Byte für Byte', hash(dav.files.get('/dav/Sondra/Frieren/Staffel 1/f.mp4') ?? Buffer.alloc(0)), hash(page))
  const upEvil = await put(new URLSearchParams({ name: 'g.mp4' }).toString(), page, { Origin: 'https://boese.example' })
  check('webdav-upload: fremde Herkunft 403', upEvil.status, 403)
  const upGet = await fetch(`${site}api/webdav-upload?name=h.mp4`)
  check('webdav-upload: nur PUT', upGet.status, 405)
  check('webdav-upload: nichts von der fremden Anfrage auf dem Server', [...dav.files.keys()].some((f) => f.endsWith('/g.mp4')), false)

  server.close()
  source.close()
} finally {
  await dav.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nAlles in Ordnung.')
process.exit(0)
