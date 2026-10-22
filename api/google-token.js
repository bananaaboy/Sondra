/**
 * The website's lasting Google sign-in, with the client secret kept here.
 *
 * Google gives a website a refresh token only in exchange for a code plus the
 * client secret, and a secret that the page knows is a secret everyone knows:
 * whatever the page's code holds is in the JavaScript every visitor loads. So
 * the page hands the code it got back from Google to this function, which adds
 * the secret, keeps the refresh token in an httpOnly cookie the page cannot
 * read, and answers with nothing but the hour-long access token.
 *
 *   GET                       → { lasting, clientId }   whether there is a secret here
 *   POST { action: 'code', code, redirectUri }          → access token, cookie set
 *   POST { action: 'refresh' }                          → access token from the cookie
 *   POST { action: 'signout' }                          → refresh token withdrawn, cookie gone
 *
 * Without a secret in the environment the page signs in for an hour, as
 * before, and never calls anything but GET. Rotating the secret is changing
 * `GOOGLE_CLIENT_SECRET` in the deployment: refresh tokens belong to the
 * client, not to one secret, so nobody has to sign in again.
 *
 * The cookie alone is no use to anyone: Google refreshes a web client's token
 * only together with the secret, which never leaves this function.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const COOKIE = 'sondra_drive'
const COOKIE_PATH = '/api/google-token'
/** Google drops a refresh token unused for six months; the cookie need not outlive it. */
const COOKIE_DAYS = 180

const first = (...names) => names.map((name) => process.env[name]?.trim()).find(Boolean) ?? ''

/** The same names the build reads the client id from, so page and function agree. */
export function googleClient() {
  return {
    clientId: first('VITE_GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'VERCEL_GOOGLE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_ID'),
    clientSecret: first('GOOGLE_CLIENT_SECRET', 'VERCEL_GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_CLIENT_SECRET', 'VITE_GOOGLE_CLIENT_SECRET'),
  }
}

function readCookie(request) {
  const header = request.headers?.cookie ?? ''
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return ''
      }
    }
  }
  return ''
}

/** Always `Secure`: browsers keep such a cookie on plain-http localhost too (`dev:service`). */
function cookie(value, maxAge) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`
}

function hostOf(request) {
  return String(request.headers?.['x-forwarded-host'] ?? request.headers?.host ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
}

/** Only this site's own pages: a request from elsewhere has a different Origin. */
function sameSite(request) {
  const origin = request.headers?.origin
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === hostOf(request)
  } catch {
    return false
  }
}

/** The popup page on this very site, nowhere else. */
function ownRedirect(raw, request) {
  try {
    const url = new URL(raw)
    return url.host.toLowerCase() === hostOf(request) && url.pathname.endsWith('/google-drive.html') && !url.search && !url.hash
  } catch {
    return false
  }
}

async function google(fields) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  let body = {}
  try {
    body = await res.json()
  } catch {
    // Google answers JSON; anything else is a failure below.
  }
  return { ok: res.ok && typeof body.access_token === 'string', status: res.status, body }
}

export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store')
  const { clientId, clientSecret } = googleClient()
  const lasting = Boolean(clientId && clientSecret)

  if (request.method === 'GET') return response.status(200).json({ lasting, clientId: lasting ? clientId : '' })
  if (request.method !== 'POST') return response.status(405).json({ error: 'method' })
  if (!sameSite(request)) return response.status(403).json({ error: 'origin' })

  let body
  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body ?? {})
  } catch {
    return response.status(400).json({ error: 'body' })
  }

  // Signing out works with or without a secret here: a cookie from before
  // the secret was taken away goes too.
  if (body.action === 'signout') {
    const refreshToken = readCookie(request)
    if (refreshToken) {
      await fetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken })}`, { method: 'POST' }).catch(() => {})
    }
    response.setHeader('set-cookie', cookie('', 0))
    return response.status(200).json({ ok: true })
  }

  if (!lasting) return response.status(404).json({ error: 'not-configured' })

  if (body.action === 'code') {
    if (typeof body.code !== 'string' || !body.code || !ownRedirect(body.redirectUri, request)) {
      return response.status(400).json({ error: 'request' })
    }
    const answer = await google({
      client_id: clientId,
      client_secret: clientSecret,
      code: body.code,
      grant_type: 'authorization_code',
      redirect_uri: body.redirectUri,
    })
    if (!answer.ok) return response.status(502).json({ error: 'google', detail: answer.body.error_description || answer.body.error || `HTTP ${answer.status}` })
    // No refresh token when Google already gave one for this account and
    // nobody asked again: the cookie there may still hold the earlier one.
    if (typeof answer.body.refresh_token === 'string') {
      response.setHeader('set-cookie', cookie(answer.body.refresh_token, COOKIE_DAYS * 86_400))
    }
    return response.status(200).json({
      access_token: answer.body.access_token,
      expires_in: answer.body.expires_in,
      scope: answer.body.scope,
      lasting: typeof answer.body.refresh_token === 'string' || Boolean(readCookie(request)),
    })
  }

  if (body.action === 'refresh') {
    const refreshToken = readCookie(request)
    if (!refreshToken) return response.status(401).json({ error: 'expired' })
    const answer = await google({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    if (answer.ok) return response.status(200).json({ access_token: answer.body.access_token, expires_in: answer.body.expires_in, scope: answer.body.scope })
    // Withdrawn at Google, or expired: the cookie is worth nothing any more.
    if (answer.body.error === 'invalid_grant') {
      response.setHeader('set-cookie', cookie('', 0))
      return response.status(401).json({ error: 'expired' })
    }
    return response.status(502).json({ error: 'google', detail: answer.body.error_description || answer.body.error || `HTTP ${answer.status}` })
  }

  return response.status(400).json({ error: 'action' })
}
