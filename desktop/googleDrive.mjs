/**
 * Google Drive from the app: the sign-in, and the key that keeps it.
 *
 * Google lets no embedded browser sign in („disallowed_useragent“), so the
 * app does what Google asks of installed programs: it opens the sign-in in
 * the system's own browser and takes the answer on a port of this computer
 * for one request (loopback with PKCE, RFC 8252). What Google hands back to
 * keep — the refresh token — stays here, encrypted with the system's own
 * store (Electron's safeStorage). The page asks for an access token when it
 * needs one, valid for an hour, and sends the files to Drive itself; it
 * never sees the refresh token.
 *
 * Only `drive.file`: Sondra sees the files it put in Drive and nothing else
 * of it.
 *
 * Kept free of Electron itself so `scripts/verify-drive.mts` can run it
 * under Node against a stand-in for Google.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

export const GOOGLE_ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
}

/** How long the browser has for the sign-in before the port closes again. */
const SIGN_IN_TIMEOUT = 5 * 60_000

class DriveError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

const base64url = (buffer) => buffer.toString('base64url')

/** The page the browser shows after the sign-in; it has nothing more to do. */
function answerPage(ok) {
  const text = ok
    ? 'Sondra ist mit Google Drive verbunden. Sie können dieses Fenster schliessen und zu Sondra zurückkehren.'
    : 'Die Anmeldung bei Google hat nicht geklappt. Schliessen Sie dieses Fenster und versuchen Sie es in Sondra noch einmal.'
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sondra · Google Drive</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8faf8;color:#0b4a22}p{max-width:34em;margin:24px}@media(prefers-color-scheme:dark){body{background:#0a110d;color:#a6ecb9}}</style><p>${text}</p></html>`
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(text: string) => Buffer} options.encrypt
 * @param {(data: Buffer) => string} options.decrypt
 * @param {() => boolean} options.canEncrypt  without it the sign-in lives only until the app closes
 * @param {(url: string) => unknown} options.openExternal
 * @param {string} options.clientId
 * @param {string} options.clientSecret  Google's „Desktop app“ client; not a secret in an installed program, as Google says
 * @param {(message: string) => void} [options.log]
 * @param {() => void} [options.focus]  brings the window back after the sign-in
 * @param {typeof GOOGLE_ENDPOINTS} [options.endpoints]
 * @param {typeof fetch} [options.fetch]
 */
export function createGoogleDrive({
  dataDir,
  encrypt,
  decrypt,
  canEncrypt,
  openExternal,
  clientId,
  clientSecret,
  log = () => {},
  focus = () => {},
  endpoints = GOOGLE_ENDPOINTS,
  fetch: request = fetch,
}) {
  const keyFile = path.join(dataDir, 'google-drive-schluessel.bin')
  const configured = Boolean(clientId && clientSecret)

  /** The refresh token, and the access token made from it with its end. */
  let refresh = null
  let access = null
  /** The sign-in waiting for the browser, if one is. */
  let pending = null

  try {
    if (canEncrypt() && fs.existsSync(keyFile)) refresh = decrypt(fs.readFileSync(keyFile))
  } catch (error) {
    log(`Google Drive: Schlüssel nicht lesbar (${error?.message ?? error}), neu anmelden`)
  }

  const saveKey = () => {
    if (!canEncrypt() || !refresh) return
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(keyFile, encrypt(refresh))
  }
  const dropKey = () => {
    refresh = null
    access = null
    fs.rmSync(keyFile, { force: true })
  }

  async function tokenRequest(fields) {
    let response
    try {
      response = await request(endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }).toString(),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new DriveError('offline', String(error?.message ?? error))
    }
    const text = await response.text()
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON; the status says enough.
    }
    if (!response.ok) {
      // A withdrawn or expired grant: the next step is a new sign-in.
      if (body.error === 'invalid_grant') throw new DriveError('revoked', body.error_description ?? '')
      throw new DriveError('failed', `${response.status} ${body.error ?? ''} ${body.error_description ?? text.slice(0, 160)}`.trim())
    }
    return body
  }

  function grantedDrive(scope) {
    return typeof scope !== 'string' || scope.split(/\s+/).includes(DRIVE_SCOPE)
  }

  /**
   * Opens a port on this computer for the one request the browser sends
   * back after the sign-in. Resolves once it listens, with the address to
   * give Google and the answer still to come.
   */
  function listen(state) {
    return new Promise((ready, failed) => {
      let settled = false
      let finish = null
      const answer = new Promise((resolve, reject) => {
        finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          server.close()
          if (error) reject(error)
          else resolve(value)
        }
      })
      // Nobody may be waiting yet when it fails; the caller sees it on await.
      answer.catch(() => {})
      const server = http.createServer((incoming, outgoing) => {
        const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
        // The browser also asks for /favicon.ico; only the answer counts.
        if (!url.searchParams.has('state')) {
          outgoing.statusCode = 404
          outgoing.end()
          return
        }
        const sameState = url.searchParams.get('state') === state
        const error = url.searchParams.get('error')
        outgoing.setHeader('content-type', 'text/html; charset=utf-8')
        outgoing.end(answerPage(sameState && !error && url.searchParams.has('code')))
        if (!sameState) finish(new DriveError('failed', 'state'))
        else if (error) finish(new DriveError(error === 'access_denied' ? 'denied' : 'failed', error))
        else finish(null, url.searchParams.get('code'))
      })
      const timer = setTimeout(() => finish(new DriveError('timeout')), SIGN_IN_TIMEOUT)
      server.on('error', (error) => {
        const failure = new DriveError('failed', String(error?.message ?? error))
        if (!server.listening) {
          clearTimeout(timer)
          settled = true
          failed(failure)
        } else finish(failure)
      })
      server.listen(0, '127.0.0.1', () => {
        ready({
          redirect: `http://127.0.0.1:${server.address().port}/`,
          answer,
          cancel: () => finish(new DriveError('cancelled')),
        })
      })
    })
  }

  async function accessToken(force = false) {
    if (!refresh) throw new DriveError('unauthorized')
    if (!force && access && access.expiresAt - 60_000 > Date.now()) return access
    try {
      const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh })
      access = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 }
      return access
    } catch (error) {
      if (error.code === 'revoked') {
        dropKey()
        log('Google Drive: Zugang bei Google zurückgezogen, neu anmelden')
        throw new DriveError('unauthorized')
      }
      throw error
    }
  }

  const actions = {
    async status() {
      return { configured, connected: Boolean(refresh), lasting: canEncrypt(), waiting: Boolean(pending) }
    },

    async connect() {
      if (!configured) throw new DriveError('not-configured')
      pending?.cancel()
      const verifier = base64url(crypto.randomBytes(48))
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
      const state = base64url(crypto.randomBytes(16))
      const own = await listen(state)
      pending = own
      const { redirect, answer } = own
      const url = new URL(endpoints.auth)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: DRIVE_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        // Without it a second sign-in brings no refresh token.
        prompt: 'consent',
      }).toString()
      log('Google Drive: Anmeldung im Browser geöffnet')
      try {
        await openExternal(url.toString())
        const code = await answer
        const body = await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        })
        if (!grantedDrive(body.scope)) throw new DriveError('scope')
        if (!body.refresh_token) throw new DriveError('failed', 'kein refresh_token')
        refresh = body.refresh_token
        access = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 }
        saveKey()
        log('Google Drive: verbunden')
        focus()
        return { lasting: canEncrypt() }
      } finally {
        // The port closes whatever happened (a no-op once answered); a
        // second sign-in may have taken the place by now.
        own.cancel()
        if (pending === own) pending = null
      }
    },

    async cancel() {
      pending?.cancel()
      return {}
    },

    /** An access token for the page, new when the last one is about to end or was refused. */
    async token(force = false) {
      const { token, expiresAt } = await accessToken(Boolean(force))
      return { token, expiresAt }
    },

    async disconnect() {
      const token = refresh
      dropKey()
      if (token) {
        // Withdrawn at Google as well, so the grant does not linger in the
        // account; a failure here leaves only a grant nobody holds.
        try {
          await request(endpoints.revoke, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
            signal: AbortSignal.timeout(10_000),
          })
        } catch {
          // Offline: the key is gone here either way.
        }
      }
      log('Google Drive: getrennt')
      return {}
    },
  }

  return {
    /** One request from the page; always answers `{ ok: true, … }` or `{ ok: false, error }`. */
    async handle(action, args = []) {
      const run = Object.hasOwn(actions, action) ? actions[action] : null
      if (!run) return { ok: false, error: 'rejected' }
      try {
        return { ok: true, ...(await run(...args)) }
      } catch (error) {
        const code = error instanceof DriveError ? error.code : 'failed'
        const detail = String((error instanceof DriveError ? error.detail : error?.message) || '').slice(0, 240)
        if (code !== 'cancelled') log(`Google Drive: ${action} → ${code}${detail ? ` (${detail})` : ''}`)
        return { ok: false, error: code, ...(detail ? { detail } : {}) }
      }
    },
  }
}
