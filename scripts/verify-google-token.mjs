/**
 * `api/google-token.js` against a stand-in for Google's token endpoint: the
 * code exchange keeps the refresh token in the cookie and never in the
 * answer, a refresh works from the cookie alone, a withdrawn sign-in drops
 * the cookie, and nothing answers a request from another site.
 *
 *   npm run verify:google-token
 */

import handler, { googleClient } from '../api/google-token.js'

let failures = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** Google, as far as this function sees it. */
const google = { calls: [], refresh: 'rt-1', revoked: [] }
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  if (target.href.startsWith('https://oauth2.googleapis.com/revoke')) {
    google.revoked.push(target.searchParams.get('token'))
    return new Response('{}', { status: 200 })
  }
  const fields = Object.fromEntries(new URLSearchParams(String(init.body)))
  google.calls.push(fields)
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (fields.client_secret !== 'secret-new' && fields.client_secret !== 'secret-old') return json({ error: 'invalid_client' }, 401)
  if (fields.grant_type === 'authorization_code') {
    if (fields.code !== 'good-code') return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)
    return json({ access_token: 'at-1', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', refresh_token: google.refresh })
  }
  if (fields.grant_type === 'refresh_token') {
    if (fields.refresh_token !== google.refresh) return json({ error: 'invalid_grant' }, 400)
    return json({ access_token: 'at-2', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file' })
  }
  return json({ error: 'unsupported_grant_type' }, 400)
}

/** Vercel's request and response, as far as the handler uses them. */
async function call({ method = 'POST', body, cookie, origin = 'https://sondra.lizge.ch', host = 'sondra.lizge.ch' } = {}) {
  const headers = { host, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }
  const request = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  const out = { status: 0, headers: {}, body: null }
  const response = {
    setHeader: (name, value) => {
      out.headers[name.toLowerCase()] = value
    },
    status(code) {
      out.status = code
      return this
    },
    json(data) {
      out.body = data
    },
  }
  await handler(request, response)
  return out
}
const cookieValue = (header) => /sondra_drive=([^;]*)/.exec(header ?? '')?.[1] ?? null

// Without a secret: nothing lasts, nothing is exchanged.
delete process.env.GOOGLE_CLIENT_SECRET
process.env.GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com'
{
  const config = await call({ method: 'GET' })
  check(config.status === 200 && config.body.lasting === false && config.body.clientId === '', 'ohne Secret: GET sagt „nicht dauerhaft“', JSON.stringify(config.body))
  const code = await call({ body: { action: 'code', code: 'good-code', redirectUri: 'https://sondra.lizge.ch/google-drive.html' } })
  check(code.status === 404 && google.calls.length === 0, 'ohne Secret: kein Tausch, Google wird nicht gefragt', `${code.status}`)
  const out = await call({ body: { action: 'signout' }, cookie: 'sondra_drive=rt-stale' })
  check(out.status === 200 && cookieValue(out.headers['set-cookie']) === '' && google.revoked.includes('rt-stale'), 'ohne Secret: Abmelden löscht ein altes Cookie trotzdem')
}

process.env.GOOGLE_CLIENT_SECRET = 'secret-old'
check(googleClient().clientSecret === 'secret-old', 'das Secret kommt aus GOOGLE_CLIENT_SECRET')
{
  const config = await call({ method: 'GET' })
  check(config.body.lasting === true && config.body.clientId === 'web-client.apps.googleusercontent.com', 'mit Secret: GET nennt die Client-ID, nie das Secret', JSON.stringify(config.body))
  check(!JSON.stringify(config.body).includes('secret-old'), 'GET verrät das Secret nicht')

  const code = await call({ body: { action: 'code', code: 'good-code', redirectUri: 'https://sondra.lizge.ch/google-drive.html' } })
  const setCookie = code.headers['set-cookie'] ?? ''
  check(code.status === 200 && code.body.access_token === 'at-1', 'Code gegen Zugang getauscht', JSON.stringify(code.body))
  check(!('refresh_token' in code.body) && !JSON.stringify(code.body).includes('rt-1'), 'der Refresh-Token steht nicht in der Antwort')
  check(cookieValue(setCookie) === 'rt-1', 'der Refresh-Token liegt im Cookie', setCookie)
  check(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\/api\/google-token/.test(setCookie), 'Cookie: HttpOnly, Secure, SameSite=Strict, nur für diese Funktion', setCookie)
  check(google.calls.at(-1)?.redirect_uri === 'https://sondra.lizge.ch/google-drive.html' && google.calls.at(-1)?.client_secret === 'secret-old', 'Google bekommt Secret und Weiterleitung vom Server')
  check(code.headers['cache-control'] === 'no-store', 'Antworten werden nicht zwischengespeichert')

  const foreign = await call({ body: { action: 'code', code: 'good-code', redirectUri: 'https://boese.example/google-drive.html' } })
  check(foreign.status === 400, 'eine fremde Weiterleitung wird abgelehnt', `${foreign.status}`)
  const cross = await call({ body: { action: 'refresh' }, cookie: 'sondra_drive=rt-1', origin: 'https://boese.example' })
  check(cross.status === 403, 'eine Anfrage von einer anderen Seite wird abgelehnt', `${cross.status}`)
  const bad = await call({ body: { action: 'code', code: 'bad-code', redirectUri: 'https://sondra.lizge.ch/google-drive.html' } })
  check(bad.status === 502 && !bad.headers['set-cookie'], 'ein abgelehnter Code setzt kein Cookie', `${bad.status}`)

  const refresh = await call({ body: { action: 'refresh' }, cookie: 'other=1; sondra_drive=rt-1' })
  check(refresh.status === 200 && refresh.body.access_token === 'at-2', 'eine neue Stunde aus dem Cookie', JSON.stringify(refresh.body))
  const none = await call({ body: { action: 'refresh' } })
  check(none.status === 401, 'ohne Cookie: 401', `${none.status}`)
}

// Rotation: a new secret in the environment, the same cookie still works.
process.env.GOOGLE_CLIENT_SECRET = 'secret-new'
{
  const refresh = await call({ body: { action: 'refresh' }, cookie: 'sondra_drive=rt-1' })
  check(refresh.status === 200 && google.calls.at(-1)?.client_secret === 'secret-new', 'nach dem Rotieren: dasselbe Cookie, das neue Secret, keine neue Anmeldung')
  process.env.GOOGLE_CLIENT_SECRET = 'secret-gone'
  const wrong = await call({ body: { action: 'refresh' }, cookie: 'sondra_drive=rt-1' })
  check(wrong.status === 502 && !wrong.headers['set-cookie'], 'ein falsches Secret löscht kein Cookie (der Fehler liegt beim Server)', `${wrong.status}`)
  process.env.GOOGLE_CLIENT_SECRET = 'secret-new'
}

{
  google.refresh = 'rt-2'
  const withdrawn = await call({ body: { action: 'refresh' }, cookie: 'sondra_drive=rt-1' })
  check(withdrawn.status === 401 && cookieValue(withdrawn.headers['set-cookie']) === '', 'bei Google zurückgezogen: 401, Cookie gelöscht')
  const out = await call({ body: { action: 'signout' }, cookie: 'sondra_drive=rt-2' })
  check(out.status === 200 && google.revoked.includes('rt-2') && /Max-Age=0/.test(out.headers['set-cookie']), 'Abmelden zieht bei Google zurück und löscht das Cookie')
}

if (failures) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen`)
  process.exit(1)
}
console.log('\nGoogle-Anmeldung über den Server: alles in Ordnung')
