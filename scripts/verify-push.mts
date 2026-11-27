/**
 * Notices on the phone, checked without a phone: stand-ins for ntfy,
 * Telegram and Pushover, and the app's side (desktop/push.mjs) talking to
 * them.
 *
 *   npm run verify:push
 *
 * What it holds to: each service gets what its API wants (ntfy the JSON form,
 * so an umlaut in a title survives; Telegram its token in the path; Pushover
 * both keys); a secret never lies in the clear on disk, never comes back out
 * of `status`, and never appears in a log line or an answer — Telegram's
 * token is part of the address, so a failed request is the dangerous case.
 */

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { checkServer, createPush } from '../desktop/push.mjs'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

const TG_TOKEN = '123456:ABC-tokenGEHEIM'
const NTFY_TOKEN = 'tk_ntfygeheim'
const PO_TOKEN = 'azGDORePK8gMaC0QOYAMyEEuzJnyUi'
const PO_USER = 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}
const seen: Seen[] = []
/** What the stand-in answers next: [status, body]. */
let answer: [number, string] = [200, '{}']

const stand = http.createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
    response.writeHead(answer[0], { 'content-type': 'application/json' }).end(answer[1])
  })
})
await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`

const sealed = {
  encrypt: (text: string) => Buffer.from(`SEALED:${[...Buffer.from(text, 'utf8')].reverse().map((b) => b.toString(16)).join('.')}`),
  decrypt: (data: Buffer) => Buffer.from(data.toString().replace(/^SEALED:/, '').split('.').reverse().map((h) => parseInt(h, 16))).toString('utf8'),
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-push-test-'))
const lines: string[] = []
const link = (dir = path.join(scratch, 'a'), canEncrypt = true) =>
  createPush({ dataDir: dir, encrypt: sealed.encrypt, decrypt: sealed.decrypt, canEncrypt: () => canEncrypt, log: (m: string) => lines.push(m), endpoints: { telegram: base, pushover: base } })

try {
  check('checkServer: Schrägstrich am Ende weg', checkServer('https://ntfy.example.org/'), 'https://ntfy.example.org')
  check('checkServer: ein Passwort in der Adresse wird abgelehnt', (() => { try { checkServer('https://u:p@x.example'); return 'ok' } catch (e: any) { return e.code } })(), 'credentials-in-address')
  check('checkServer: ftp:// wird abgelehnt', (() => { try { checkServer('ftp://x.example'); return 'ok' } catch (e: any) { return e.code } })(), 'bad-server')

  const push = link()
  check('anfangs nicht eingerichtet', (await push.handle('status')).configured, false)
  check('ohne Dienst: no-service', (await push.handle('configure', [{}])).code, 'no-service')
  check('ntfy ohne Server: no-server', (await push.handle('configure', [{ service: 'ntfy', ntfyTopic: 'x' }])).code, 'no-server')
  check('ntfy ohne Thema: no-topic', (await push.handle('configure', [{ service: 'ntfy', ntfyServer: base }])).code, 'no-topic')
  check('Test ohne Einrichtung: not-configured', (await push.handle('test')).code, 'not-configured')

  /* -- ntfy -------------------------------------------------------------- */
  const set = await push.handle('configure', [{ service: 'ntfy', ntfyServer: `${base}/`, ntfyTopic: 'mein thema', ntfyToken: NTFY_TOKEN }])
  check('ntfy: eingerichtet, Thema ohne Leerzeichen', [set.ok, set.configured, set.ntfyTopic], [true, true, 'mein-thema'])
  check('ntfy: das Passwort kommt nicht zurück', [JSON.stringify(set).includes(NTFY_TOKEN), set.hasNtfyToken], [false, true])
  const sentNtfy = await push.handle('send', [{ title: 'Neue Folge: Frieren – Größe', body: 'Staffel 1, Folge 5 ist da.' }])
  const n = seen.at(-1)!
  check('ntfy: gesendet', sentNtfy, { ok: true })
  check('ntfy: POST an den Server, Thema und Umlaute im JSON', [n.method, n.url, JSON.parse(n.body)], ['POST', '/', { topic: 'mein-thema', title: 'Neue Folge: Frieren – Größe', message: 'Staffel 1, Folge 5 ist da.' }])
  check('ntfy: der Token geht als Bearer', n.headers.authorization, `Bearer ${NTFY_TOKEN}`)
  check('ntfy: die Länge steht im Kopf', n.headers['content-length'], String(Buffer.byteLength(n.body)))

  /* -- Telegram ---------------------------------------------------------- */
  await push.handle('configure', [{ service: 'telegram', telegramChat: '4711', telegramToken: TG_TOKEN }])
  await push.handle('send', [{ title: 'Download fertig', body: 'Frieren S01E01.mp4' }])
  const t = seen.at(-1)!
  check('Telegram: Token im Pfad, sendMessage', [t.method, t.url], ['POST', `/bot${encodeURIComponent(TG_TOKEN)}/sendMessage`])
  check('Telegram: Chat und Text', JSON.parse(t.body), { chat_id: '4711', text: 'Download fertig\nFrieren S01E01.mp4' })

  /* -- Pushover ---------------------------------------------------------- */
  await push.handle('configure', [{ service: 'pushover', pushoverToken: PO_TOKEN, pushoverUser: PO_USER }])
  await push.handle('send', [{ title: 'Erinnerung', body: 'Frieren um 18:00' }])
  const p = seen.at(-1)!
  check('Pushover: Adresse und beide Schlüssel', [p.url, JSON.parse(p.body)], ['/1/messages.json', { token: PO_TOKEN, user: PO_USER, title: 'Erinnerung', message: 'Frieren um 18:00' }])

  /* -- Geheimnisse ------------------------------------------------------- */
  const onDisk = fs.readdirSync(path.join(scratch, 'a')).map((n) => fs.readFileSync(path.join(scratch, 'a', n)).toString('latin1')).join('\n')
  check('kein Geheimnis im Klartext auf der Platte', [NTFY_TOKEN, TG_TOKEN, PO_TOKEN, PO_USER, 'GEHEIM'].filter((s) => onDisk.includes(s)), [])
  const again = link()
  check('ein neuer Start liest sie wieder', [again.ready(), again.status().hasPushoverToken, again.status().hasTelegramToken], [true, true, true])
  const volatile = link(path.join(scratch, 'b'), false)
  await volatile.handle('configure', [{ service: 'pushover', pushoverToken: PO_TOKEN, pushoverUser: PO_USER }])
  check('ohne Schlüsselspeicher: nur im Speicher, und es sagt es', [volatile.ready(), volatile.status().remembered, fs.existsSync(path.join(scratch, 'b', 'push-geheimnisse.bin'))], [true, false, false])

  /* -- Fehler ------------------------------------------------------------ */
  const before = lines.length
  await push.handle('configure', [{ service: 'telegram', telegramChat: '4711', telegramToken: TG_TOKEN }])
  answer = [401, '{"ok":false,"error_code":401,"description":"Unauthorized"}']
  const refused = await push.handle('send', [{ title: 'x', body: 'y' }])
  check('Telegram 401: unauthorized mit den Worten des Dienstes', [refused.ok, refused.code, refused.detail], [false, 'unauthorized', 'Unauthorized'])
  answer = [400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}']
  check('Telegram: unbekannter Chat', (await push.handle('send', [{ title: 'x', body: 'y' }])).code, 'chat-not-found')
  answer = [404, '{"ok":false,"description":"Not Found"}']
  check('Telegram 404 heisst falscher Token', (await push.handle('send', [{ title: 'x', body: 'y' }])).code, 'unauthorized')
  answer = [429, '{"ok":false}']
  check('429: busy', (await push.handle('send', [{ title: 'x', body: 'y' }])).code, 'busy')
  answer = [500, 'kaputt']
  const failed = await push.handle('send', [{ title: 'x', body: 'y' }])
  check('500: failed mit Status', [failed.code, failed.detail], ['failed', 'HTTP 500'])
  await push.handle('configure', [{ service: 'pushover' }])
  answer = [400, '{"token":"invalid","errors":["application token is invalid"],"status":0}']
  const po = await push.handle('send', [{ title: 'x', body: 'y' }])
  check('Pushover 400: unauthorized mit dem Satz des Dienstes', [po.code, po.detail], ['unauthorized', 'application token is invalid'])
  answer = [200, '{}']

  // The dangerous case: a connection that fails with the address in its message.
  await push.handle('configure', [{ service: 'telegram', telegramChat: '4711', telegramToken: TG_TOKEN }])
  const dead = createPush({ dataDir: path.join(scratch, 'c'), encrypt: sealed.encrypt, decrypt: sealed.decrypt, canEncrypt: () => true, log: (m: string) => lines.push(m), endpoints: { telegram: 'http://127.0.0.1:1' } })
  await dead.handle('configure', [{ service: 'telegram', telegramChat: '4711', telegramToken: TG_TOKEN }])
  const down = await dead.handle('send', [{ title: 'x', body: 'y' }])
  check('Dienst nicht erreichbar: ein Grund, kein Absturz', ['refused', 'unreachable'].includes(down.code), true)
  const spoken = JSON.stringify([lines.slice(before), refused, failed, po, down])
  check('kein Token in einem Protokoll oder einer Antwort', [TG_TOKEN, 'GEHEIM', PO_TOKEN, PO_USER, NTFY_TOKEN].filter((s) => spoken.includes(s) || spoken.includes(encodeURIComponent(s))), [])

  const forgotten = await push.handle('forget')
  check('Entfernen: weg, auch die Schlüssel', [forgotten.configured, forgotten.hasTelegramToken, fs.readdirSync(path.join(scratch, 'a'))], [false, false, []])
} finally {
  stand.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nAlles in Ordnung.')
process.exit(0)
