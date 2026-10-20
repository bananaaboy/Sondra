/**
 * The Merkliste in Anytype: one page, „Sondra · Merkliste", in a space the
 * user picks, read and written through Anytype's local API on this computer.
 *
 * Only the app can do this. Anytype's API answers no web page — it sends no
 * CORS headers (anytype-heart, core/api/server), so a reply could never reach
 * sondra.lizge.ch — and the app's main process asks it directly instead. The
 * key Anytype hands out stays here, encrypted with the system's own store
 * (Electron's safeStorage); the page learns whether there is one, never what
 * it is.
 *
 * Kept free of Electron itself so `scripts/verify-anytype.mjs` can run it
 * under Node against a stand-in for Anytype.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Where Anytype's desktop app listens (0.46.7 and later). */
export const ANYTYPE_API = 'http://127.0.0.1:31009'
/** The API version asked for; the reference of 8 November 2025. */
export const ANYTYPE_VERSION = '2025-11-08'
/** The page the list lives on. */
export const PAGE_NAME = 'Sondra · Merkliste'

/** A failure the page can name: Anytype closed, key withdrawn, a wrong code … */
class AnytypeError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/**
 * The link to Anytype, with what it keeps between runs in `dataDir`: the key
 * (encrypted) and the space and page it writes to.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(text: string) => Buffer} options.encrypt
 * @param {(data: Buffer) => string} options.decrypt
 * @param {() => boolean} options.canEncrypt  without it the key lives only until the app closes
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.api]
 */
export function createAnytype({ dataDir, encrypt, decrypt, canEncrypt, log = () => {}, api = ANYTYPE_API }) {
  const keyFile = path.join(dataDir, 'anytype-schluessel.bin')
  const configFile = path.join(dataDir, 'anytype.json')

  let key = null
  /** @type {{ spaceId?: string, spaceName?: string, objectId?: string }} */
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8')) ?? {}
  } catch {
    // Not connected yet.
  }
  try {
    if (canEncrypt() && fs.existsSync(keyFile)) key = decrypt(fs.readFileSync(keyFile))
  } catch (error) {
    log(`Anytype: Schlüssel nicht lesbar (${error?.message ?? error}), neu verbinden`)
  }

  const saveConfig = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(config))
  }
  const saveKey = () => {
    if (!canEncrypt()) return
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(keyFile, encrypt(key))
  }
  const dropKey = () => {
    key = null
    fs.rmSync(keyFile, { force: true })
  }

  async function call(method, route, body, { auth = true, timeout = 10_000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response
    try {
      response = await fetch(api + route, {
        method,
        headers: {
          'Anytype-Version': ANYTYPE_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth && key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch {
      throw new AnytypeError('unreachable')
    } finally {
      clearTimeout(timer)
    }
    if (response.ok) return response.status === 204 ? null : response.json()
    const detail = await response.text().catch(() => '')
    if (auth && (response.status === 401 || response.status === 403)) {
      // The key was withdrawn in Anytype's settings; a new code is needed.
      dropKey()
      throw new AnytypeError('unauthorized')
    }
    if (response.status === 404) throw new AnytypeError('missing')
    if (response.status === 429) throw new AnytypeError('busy')
    throw new AnytypeError(response.status === 400 ? 'rejected' : 'failed', `${response.status} ${detail.slice(0, 200)}`)
  }

  const needSpace = () => {
    if (!key) throw new AnytypeError('unauthorized')
    if (!config.spaceId) throw new AnytypeError('no-space')
    return encodeURIComponent(config.spaceId)
  }

  /** The page's id: the remembered one, or the one found by its name. */
  async function findPage() {
    const space = needSpace()
    if (config.objectId) return config.objectId
    const found = await call('POST', `/v1/spaces/${space}/search`, { query: PAGE_NAME, types: ['page'] })
    const page = (found?.data ?? []).find((object) => object?.name === PAGE_NAME && !object.archived)
    if (!page) return null
    config.objectId = page.id
    saveConfig()
    return page.id
  }

  const actions = {
    async status() {
      let reachable = true
      try {
        await call('GET', '/docs/openapi.json', undefined, { auth: false, timeout: 2000 })
      } catch (error) {
        reachable = error.code !== 'unreachable'
      }
      return {
        reachable,
        paired: Boolean(key),
        lasting: canEncrypt(),
        space: key && config.spaceId ? { id: config.spaceId, name: config.spaceName ?? '' } : null,
      }
    },

    /** Anytype shows a four-digit code for this; `pair` takes it. */
    async challenge() {
      const answer = await call('POST', '/v1/auth/challenges', { app_name: 'Sondra' }, { auth: false })
      if (!answer?.challenge_id) throw new AnytypeError('failed', 'keine challenge_id')
      return { challengeId: answer.challenge_id }
    },

    async pair(challengeId, code) {
      if (typeof challengeId !== 'string' || !/^\d{4}$/.test(String(code))) throw new AnytypeError('rejected')
      let answer
      try {
        answer = await call('POST', '/v1/auth/api_keys', { challenge_id: challengeId, code: String(code) }, { auth: false })
      } catch (error) {
        if (error.code === 'rejected' || error.code === 'missing') throw new AnytypeError('wrong-code')
        throw error
      }
      if (!answer?.api_key) throw new AnytypeError('failed', 'kein api_key')
      key = answer.api_key
      saveKey()
      log('Anytype: verbunden')
      return {}
    },

    async spaces() {
      if (!key) throw new AnytypeError('unauthorized')
      const answer = await call('GET', '/v1/spaces?limit=100')
      return {
        spaces: (answer?.data ?? [])
          .filter((space) => typeof space?.id === 'string')
          .map((space) => ({ id: space.id, name: String(space.name ?? '') })),
      }
    },

    async useSpace(id, name) {
      if (typeof id !== 'string' || !id) throw new AnytypeError('rejected')
      config = { spaceId: id, spaceName: typeof name === 'string' ? name : '' }
      saveConfig()
      return {}
    },

    /** The page's text, or null while there is no page yet. */
    async read() {
      const space = needSpace()
      let id = await findPage()
      if (!id) return { markdown: null }
      try {
        const answer = await call('GET', `/v1/spaces/${space}/objects/${encodeURIComponent(id)}?format=md`)
        if (answer?.object?.archived) throw new AnytypeError('missing')
        return { markdown: String(answer?.object?.markdown ?? '') }
      } catch (error) {
        if (error.code !== 'missing') throw error
        // Deleted in Anytype: look again by name, else there is none.
        delete config.objectId
        saveConfig()
        id = await findPage()
        if (!id) return { markdown: null }
        const answer = await call('GET', `/v1/spaces/${space}/objects/${encodeURIComponent(id)}?format=md`)
        return { markdown: String(answer?.object?.markdown ?? '') }
      }
    },

    async write(markdown) {
      if (typeof markdown !== 'string') throw new AnytypeError('rejected')
      const space = needSpace()
      const id = await findPage()
      if (id) {
        try {
          await call('PATCH', `/v1/spaces/${space}/objects/${encodeURIComponent(id)}`, { markdown })
          return {}
        } catch (error) {
          if (error.code !== 'missing') throw error
          delete config.objectId
        }
      }
      const answer = await call('POST', `/v1/spaces/${space}/objects`, { name: PAGE_NAME, type_key: 'page', body: markdown })
      if (!answer?.object?.id) throw new AnytypeError('failed', 'keine Objekt-ID')
      config.objectId = answer.object.id
      saveConfig()
      log(`Anytype: Seite „${PAGE_NAME}“ angelegt`)
      return {}
    },

    async forget() {
      dropKey()
      config = {}
      fs.rmSync(configFile, { force: true })
      log('Anytype: getrennt')
      return {}
    },
  }

  return {
    /**
     * One request from the page. Always answers — `{ ok: true, … }` or
     * `{ ok: false, error }` — since a thrown error reaches the page only as
     * a sentence about IPC.
     */
    async handle(action, args = []) {
      const run = Object.hasOwn(actions, action) ? actions[action] : null
      if (!run) return { ok: false, error: 'rejected' }
      try {
        return { ok: true, ...(await run(...args)) }
      } catch (error) {
        const code = error instanceof AnytypeError ? error.code : 'failed'
        if (code === 'failed') log(`Anytype: ${action} gescheitert ${error?.detail || error?.message || error}`)
        return { ok: false, error: code }
      }
    },
  }
}
