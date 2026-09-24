/**
 * What counts as "there is a file at this address".
 *
 * The resolver's judgement is easy to break and hard to notice broken: it only
 * ever shows up as "Unter dieser Adresse liegt keine Mediendatei, sondern eine
 * Webseite" about a file that was plainly there. So the four helpers it rests
 * on are checked here against the shapes real storage actually takes, served
 * by a stand-in on localhost rather than described in prose.
 *
 * The case that prompted this is the last one: a Nextcloud share link
 * (`/s/<token>`) answers 307 and points at a *presigned* object-storage URL. A
 * presigned URL is signed for one HTTP method, so `HEAD` against a URL signed
 * for `GET` comes back 403 — and a probe that only ever asked `HEAD` therefore
 * concluded there was nothing there. The file's name lives only in
 * `Content-Disposition`, and after a ranged request its size lives only in
 * `Content-Range`. All three had to be handled before such a link worked.
 *
 * Run with:  npm run verify:resolve
 */

import http from 'node:http'

import { filenameFrom, finalUrlFrom, looksLikeMedia, nameFrom, probe, sizeFrom } from '../api/resolve.js'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  const shown = ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${shown}`)
}

/* -- a stand-in for the servers this has to survive ------------------------ */

const BODY = Buffer.alloc(94_234, 7)

const server = http.createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname
  const send = (status, headers, payload = '') => {
    response.writeHead(status, headers)
    response.end(payload)
  }

  // A share link whose HEAD is answered properly.
  if (path === '/s/token/download') {
    return send(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="Urlaub Aufnahme.wav"',
      'content-length': String(BODY.length),
    }, request.method === 'HEAD' ? '' : BODY)
  }

  // A backend that refuses HEAD outright, and names the file with umlauts.
  if (path === '/publink/show') {
    if (request.method === 'HEAD') return send(405, {})
    return send(206, {
      'content-type': 'application/octet-stream',
      'content-disposition': "attachment; filename*=UTF-8''Gespr%C3%A4ch%20M%C3%A4rz.wav",
      'content-range': `bytes 0-0/${BODY.length}`,
      'content-length': '1',
    }, BODY.subarray(0, 1))
  }

  // A HEAD that answers 200 and says nothing useful at all.
  if (path === '/dl/token') {
    if (request.method === 'HEAD') return send(200, {})
    return send(200, { 'content-type': 'audio/wav', 'content-length': String(BODY.length) }, BODY)
  }

  // The real one: presigned storage, signed for GET. HEAD is 403.
  if (path === '/presigned') {
    if (request.method === 'HEAD') {
      return send(403, { 'content-type': 'application/xml' }, '<Error>SignatureDoesNotMatch</Error>')
    }
    return send(206, {
      'content-type': 'image/jpeg',
      'content-disposition': `inline; filename="352.jfif"; filename*=UTF-8''352.jfif`,
      'content-range': `bytes 0-0/${BODY.length}`,
      'content-length': '1',
    }, BODY.subarray(0, 1))
  }

  // An opaque share URL whose final media URL is the only place the extension
  // appears. This is the shape used by short-link file hosts.
  if (path === '/e/token') {
    response.writeHead(302, { location: '/objects/recording.mp4' })
    return response.end()
  }
  if (path === '/objects/recording.mp4') {
    return send(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(BODY.length),
    }, request.method === 'HEAD' ? '' : BODY)
  }

  // And a page, which must keep being recognised as a page.
  if (path === '/seite') return send(200, { 'content-type': 'text/html; charset=utf-8' }, '<html></html>')

  send(404, {})
})

await new Promise((resolve) => server.listen(0, resolve))
const base = `http://localhost:${server.address().port}`

/* -- the name a server states --------------------------------------------- */

check('filename in Anführungszeichen', filenameFrom('attachment; filename="Urlaub Aufnahme.wav"'), 'Urlaub Aufnahme.wav')
check('filename ohne Anführungszeichen', filenameFrom('attachment; filename=lied.mp3'), 'lied.mp3')
check('RFC 5987 mit Umlaut', filenameFrom("attachment; filename*=UTF-8''Gespr%C3%A4ch%20M%C3%A4rz.wav"), 'Gespräch März.wav')
check('inline statt attachment', filenameFrom(`inline; filename="352.jfif"; filename*=UTF-8''352.jfif`), '352.jfif')
check('ohne Header', filenameFrom(''), null)
check('Header ohne Namen', filenameFrom('inline'), null)

/* -- is it a file ---------------------------------------------------------- */

const share = new URL('https://cloud.example.ch/s/e56714bb0a32')
check('octet-stream + Name im Header', looksLikeMedia('application/octet-stream', share, 'attachment; filename="a.wav"'), true)
check('octet-stream ohne jeden Hinweis', looksLikeMedia('application/octet-stream', share, ''), false)
check('octet-stream, Name ohne Medienendung', looksLikeMedia('application/octet-stream', share, 'attachment; filename="notizen.txt"'), false)
check('Bild bleibt Bild', looksLikeMedia('image/jpeg', share, ''), true)
check('Webseite bleibt Webseite', looksLikeMedia('text/html; charset=utf-8', share, 'attachment; filename="a.wav"'), false)

check('Name aus dem Header', nameFrom(share, 'attachment; filename="Urlaub Aufnahme.wav"'), 'Urlaub Aufnahme.wav')
check('Name aus dem Pfad, wenn kein Header', nameFrom(new URL('https://x.ch/lied.mp3'), ''), 'lied.mp3')
check('Rückfallwert, wenn beides fehlt', nameFrom(share, ''), 'download')
check('Pfad im Header wird gekürzt', nameFrom(share, 'attachment; filename="/etc/passwd"'), 'passwd')

/* -- the size, from whichever header knows it ------------------------------ */

check('Grösse aus content-length', sizeFrom(new Headers({ 'content-length': '94234' })), 94_234)
check('Grösse aus content-range', sizeFrom(new Headers({ 'content-range': 'bytes 0-0/94234', 'content-length': '1' })), 94_234)
check('unbekannte Gesamtgrösse', sizeFrom(new Headers({ 'content-range': 'bytes 0-0/*', 'content-length': '1' })), 1)
check('ohne jede Angabe', sizeFrom(new Headers({})), null)

/* -- the probe against each server shape ----------------------------------- */

for (const [path, label] of [
  ['/s/token/download', 'HEAD antwortet sauber'],
  ['/publink/show', 'HEAD 405, GET trägt'],
  ['/dl/token', 'HEAD 200 ohne content-type'],
  ['/presigned', 'vorsignierte Adresse: HEAD 403'],
]) {
  const answer = await probe(new URL(base + path))
  check(`Sondierung: ${label}`, answer.ok && Boolean(answer.headers.get('content-type')), true)
}

const presigned = await probe(new URL(`${base}/presigned`))
check('vorsigniert: gilt als Datei', looksLikeMedia(presigned.headers.get('content-type') ?? '', new URL(`${base}/presigned`), presigned.headers.get('content-disposition') ?? ''), true)
check('vorsigniert: Name', nameFrom(new URL(`${base}/presigned`), presigned.headers.get('content-disposition') ?? ''), '352.jfif')
check('vorsigniert: Grösse', sizeFrom(presigned.headers), 94_234)

const redirected = await probe(new URL(`${base}/e/token`))
const finalUrl = finalUrlFrom(redirected, new URL(`${base}/e/token`))
check('Weiterleitung: endgültige Adresse', finalUrl.pathname, '/objects/recording.mp4')
check(
  'Weiterleitung: Medienendung der endgültigen Adresse',
  looksLikeMedia(redirected.headers.get('content-type') ?? '', finalUrl, ''),
  true,
)
check('Weiterleitung: Name von endgültiger Adresse', nameFrom(finalUrl, ''), 'recording.mp4')

const page = await probe(new URL(`${base}/seite`))
check('Seite wird weiterhin erkannt', looksLikeMedia(page.headers.get('content-type') ?? '', new URL(`${base}/seite`), ''), false)

server.close()
console.log(failures === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failures} fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
