/**
 * A WebDAV folder as a place to put downloads: a NAS, Nextcloud, anything
 * that speaks MKCOL and PUT. The address, the user name and the folder the
 * files go under are the user's own entry — nothing is built in, and the
 * field starts empty („kein Anbieter fest verdrahtet“).
 *
 * Only the app can do this. NAS and Nextcloud servers send no CORS headers,
 * so a web page could never reach them, and the password must not sit in the
 * page either: it is kept here, encrypted with the system's own store
 * (Electron's safeStorage), and the page learns whether there is one, never
 * what it is. The page configures, tests and forgets; the files are sent by
 * the app's own server (`/api/direct-save`, `/api/webdav-upload`), which
 * only ever sends a file it wrote itself or bytes the page hands over —
 * never a path the page names.
 *
 * Kept free of Electron itself so `scripts/verify-webdav.mts` can run it
 * under Node against a stand-in for a WebDAV server.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

/** What a user types into the folder field when they have not chosen one. */
export const DEFAULT_BASE_PATH = '/Sondra'

/** A failure the page can name: wrong password, unknown address, full disk … */
export class WebdavError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** One part of a path, without anything a file system or a server would read as more than a name. */
export function cleanSegment(raw) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .trim()
    .replace(/[. ]+$/, '')
}

/** The parts of a path as typed („/Sondra/Serien“, `a\b`), without empty ones and never `.` or `..`. */
export function pathParts(raw) {
  return String(raw ?? '')
    .split(/[\\/]+/)
    .map(cleanSegment)
    .filter((part) => part !== '' && part !== '.' && part !== '..')
}

/** `base` plus path parts, each encoded; a trailing slash only when asked for (collections). */
export function joinUrl(base, parts, { collection = false } = {}) {
  const clean = String(base ?? '').trim().replace(/\/+$/, '')
  const tail = parts.map((part) => encodeURIComponent(part)).join('/')
  const joined = tail ? `${clean}/${tail}` : clean
  return collection ? `${joined}/` : joined
}

/** The address as the user may enter it: http(s) only, no password in it. Returns the cleaned address or throws. */
export function checkAddress(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new WebdavError('no-address')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new WebdavError('bad-address')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebdavError('bad-address')
  // A password in the address would end up in every log line; it has its own field.
  if (url.username || url.password) throw new WebdavError('credentials-in-address')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

/** A network failure's reason, in a few words a person can act on. */
function reasonOf(failure) {
  // Node reports a refused connection as a plain error or, with several addresses tried, an AggregateError of them.
  const code = failure?.cause?.code ?? failure?.cause?.errors?.[0]?.code ?? failure?.code ?? ''
  const text = failure?.cause?.message ?? failure?.message ?? String(failure)
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(String(code)) || /certificate/i.test(text)) return 'certificate'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unknown-host'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout'
  return 'unreachable'
}

/**
 * The link to one WebDAV folder, with what it keeps between runs in
 * `dataDir`: address, user name and folder (plain), the password (encrypted).
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(text: string) => Buffer} options.encrypt
 * @param {(data: Buffer) => string} options.decrypt
 * @param {() => boolean} options.canEncrypt  without it the password lives only until the app closes
 * @param {(message: string) => void} [options.log]
 */
export function createWebdav({ dataDir, encrypt, decrypt, canEncrypt, log = () => {} }) {
  const configFile = path.join(dataDir, 'webdav.json')
  const secretFile = path.join(dataDir, 'webdav-passwort.bin')

  /** @type {{ url?: string, username?: string, basePath?: string }} */
  let config = {}
  let password = ''
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8')) ?? {}
  } catch {
    // Not set up yet.
  }
  try {
    if (canEncrypt() && fs.existsSync(secretFile)) password = decrypt(fs.readFileSync(secretFile))
  } catch (error) {
    log(`WebDAV: Passwort nicht lesbar (${error?.message ?? error}), bitte neu eintragen`)
  }

  const saveConfig = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(config))
  }
  const saveSecret = () => {
    fs.rmSync(secretFile, { force: true })
    if (!password || !canEncrypt()) return
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(secretFile, encrypt(password))
  }

  const isConfigured = () => Boolean(config.url)
  const basePathParts = () => pathParts(config.basePath ?? DEFAULT_BASE_PATH)

  const status = () => ({
    configured: isConfigured(),
    url: config.url ?? '',
    username: config.username ?? '',
    basePath: config.basePath ?? DEFAULT_BASE_PATH,
    hasPassword: password !== '',
    // False when the system has no store to keep the password in: it goes with the app's window.
    remembered: password === '' || canEncrypt(),
  })

  const authHeaders = () =>
    config.username || password
      ? { Authorization: `Basic ${Buffer.from(`${config.username ?? ''}:${password}`, 'utf8').toString('base64')}` }
      : {}

  /**
   * One request. Redirects are never followed: a PUT that a server answers
   * with 301 to https would go on without its body, and the answer is worth
   * more than a retry — „use https:// in the address“.
   */
  async function call(method, url, { headers = {}, body, duplex, signal, timeout = 20_000 } = {}) {
    const controller = new AbortController()
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(url, {
        method,
        headers: { ...authHeaders(), ...headers },
        body,
        duplex,
        redirect: 'manual',
        signal: controller.signal,
      })
      // Whatever the body holds is not needed; leaving it unread holds the socket.
      await response.arrayBuffer().catch(() => undefined)
      return response
    } catch (failure) {
      if (signal?.aborted) throw failure
      if (failure?.name === 'AbortError') throw new WebdavError('timeout', `${method}: keine Antwort nach ${timeout / 1000} s`)
      throw new WebdavError(reasonOf(failure), `${method}: ${failure?.cause?.message ?? failure?.message ?? failure}`)
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** A status the server answered, as the failure the page names. */
  function failureFor(response, what) {
    const detail = `${what}: HTTP ${response.status}`
    if (response.status === 401) return new WebdavError('unauthorized', detail)
    if (response.status === 403) return new WebdavError('forbidden', detail)
    if (response.status === 404) return new WebdavError('missing', detail)
    if (response.status === 507) return new WebdavError('full', detail)
    if (response.status === 413) return new WebdavError('too-large', detail)
    if (response.status >= 300 && response.status < 400) return new WebdavError('redirect', detail)
    return new WebdavError('failed', detail)
  }

  /** Makes every folder on the way, one MKCOL each; one that is there already is fine. */
  async function ensureFolders(parts, signal) {
    for (let i = 1; i <= parts.length; i += 1) {
      const response = await call('MKCOL', joinUrl(config.url, parts.slice(0, i), { collection: true }), { signal })
      // 201 made, 405 there already (RFC 4918 §9.3.1), 301 an Apache that wants the slash — all fine.
      if (response.status === 201 || response.status === 405) continue
      if (response.status === 301 || response.status === 308) continue
      throw failureFor(response, `MKCOL ${parts.slice(0, i).join('/')}`)
    }
  }

  /**
   * Whether the folder answers. PROPFIND with Depth 0 asks about the folder
   * alone: 207 is there, 404 is „not yet“ (it is made with the first file, so
   * the test asks the address itself then) — a server that has no WebDAV
   * says 405 or 501.
   */
  async function test() {
    if (!isConfigured()) throw new WebdavError('not-configured')
    const ask = (parts) =>
      call('PROPFIND', joinUrl(config.url, parts, { collection: true }), {
        headers: { Depth: '0', 'Content-Type': 'application/xml' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      })
    const parts = basePathParts()
    let response = await ask(parts)
    if (response.status === 207 || response.status === 200) return { ok: true, folder: 'there' }
    if (response.status === 404 && parts.length > 0) {
      response = await ask([])
      if (response.status === 207 || response.status === 200) return { ok: true, folder: 'new' }
    }
    if (response.status === 405 || response.status === 501) throw new WebdavError('no-webdav', `PROPFIND: HTTP ${response.status}`)
    throw failureFor(response, 'PROPFIND')
  }

  /**
   * One file into `segments` under the folder: `source` is a readable stream
   * of exactly `size` bytes. Never a path from outside: callers hand over a
   * stream they opened themselves.
   */
  async function put({ segments = [], fileName, source, size, mime = 'application/octet-stream', signal }) {
    if (!isConfigured()) throw new WebdavError('not-configured')
    const name = cleanSegment(fileName)
    if (!name) throw new WebdavError('bad-name')
    const folder = [...basePathParts(), ...segments.flatMap((s) => pathParts(s))]
    await ensureFolders(folder, signal)
    const target = joinUrl(config.url, [...folder, name])
    const response = await call('PUT', target, {
      headers: { 'Content-Type': mime, 'Content-Length': String(size) },
      body: Readable.toWeb(source),
      duplex: 'half',
      signal,
      timeout: 0,
    })
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) throw failureFor(response, 'PUT')
    return { relPath: [...folder, name].join('/'), size }
  }

  /** A file the caller has just written itself (the server's direct-save), read from its path. */
  async function putFile({ segments, fileName, filePath, mime, signal }) {
    const size = fs.statSync(filePath).size
    return put({ segments, fileName, source: fs.createReadStream(filePath), size, mime, signal })
  }

  /** The page's actions over IPC: configure, test, status, forget. */
  async function handle(action, args = []) {
    switch (action) {
      case 'status':
        return status()
      case 'configure': {
        const input = args[0] ?? {}
        let url
        try {
          url = checkAddress(input.url)
        } catch (failure) {
          // Over IPC an error loses its class; the page gets the code as an answer.
          if (failure instanceof WebdavError) return { ok: false, code: failure.code, ...status() }
          throw failure
        }
        const basePath = String(input.basePath ?? '').trim() || DEFAULT_BASE_PATH
        config = { url, username: String(input.username ?? '').trim(), basePath: `/${pathParts(basePath).join('/')}` }
        // undefined keeps the password, '' removes it, anything else replaces it.
        if (typeof input.password === 'string') password = input.password
        saveConfig()
        saveSecret()
        return { ok: true, ...status() }
      }
      case 'test':
        try {
          return { ok: true, ...(await test()) }
        } catch (failure) {
          if (failure instanceof WebdavError) return { ok: false, code: failure.code, detail: failure.detail }
          throw failure
        }
      case 'forget':
        config = {}
        password = ''
        fs.rmSync(configFile, { force: true })
        fs.rmSync(secretFile, { force: true })
        return status()
      default:
        throw new Error(`unbekannte Aktion: ${action}`)
    }
  }

  return { handle, status, isConfigured, test, put, putFile }
}
