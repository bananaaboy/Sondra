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
/** The default page name the list lives on. */
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
  /** @type {{ spaceId?: string, spaceName?: string, objectId?: string, objectName?: string }} */
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
    const targetName = config.objectName || PAGE_NAME

    let page = null
    try {
      const found = await call('POST', `/v1/spaces/${space}/search`, { query: targetName, types: ['page'], type: 'page' })
      page = (found?.data ?? []).find((object) => object?.name === targetName && !object.archived)
      if (!page && targetName.includes('·')) {
        const sub = await call('POST', `/v1/spaces/${space}/search`, { query: 'Sondra', types: ['page'], type: 'page' })
        page = (sub?.data ?? []).find((object) => object?.name === targetName && !object.archived)
      }
    } catch {}

    if (!page) {
      try {
        const list = await call('GET', `/v1/spaces/${space}/objects?limit=50`)
        page = (list?.data ?? []).find((object) => object?.name === targetName && !object.archived)
      } catch {}
    }

    if (!page) return null
    config.objectId = page.id
    config.objectName = page.name || targetName
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
        note: key && config.objectId ? { id: config.objectId, name: config.objectName || PAGE_NAME } : null,
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

    async listNotes(spaceId) {
      if (!key) throw new AnytypeError('unauthorized')
      const targetSpace = spaceId || config.spaceId
      if (!targetSpace) throw new AnytypeError('no-space')
      const space = encodeURIComponent(targetSpace)

      const candidates = new Map()
      try {
        const found = await call('POST', `/v1/spaces/${space}/search`, { query: 'Sondra', types: ['page'], type: 'page' })
        for (const obj of found?.data ?? []) {
          if (obj?.id && !obj.archived && typeof obj?.name === 'string' && obj.name.includes('Sondra')) {
            candidates.set(obj.id, obj)
          }
        }
      } catch {}

      try {
        const list = await call('GET', `/v1/spaces/${space}/objects?limit=50`)
        for (const obj of list?.data ?? []) {
          if (obj?.id && !obj.archived && typeof obj?.name === 'string' && obj.name.includes('Sondra')) {
            candidates.set(obj.id, obj)
          }
        }
      } catch {}

      const notes = []
      for (const [id, obj] of candidates.entries()) {
        let itemCount = 0
        try {
          const detail = await call('GET', `/v1/spaces/${space}/objects/${encodeURIComponent(id)}?format=md`)
          const md = detail?.object?.markdown || ''
          const match = md.match(/sondra-merkliste\n([\s\S]*?)```/)
          if (match) {
            try {
              const raw = match[1].replace(/[^A-Za-z0-9+/=]/g, '')
              const decoded = Buffer.from(raw, 'base64').toString('utf8')
              const parsed = JSON.parse(decoded)
              if (Array.isArray(parsed.items)) itemCount = parsed.items.length
            } catch {}
          }
        } catch {}
        notes.push({
          id,
          name: obj.name,
          itemCount,
        })
      }
      return { notes }
    },

    async useSpace(id, name, objectId, objectName) {
      if (typeof id !== 'string' || !id) throw new AnytypeError('rejected')
      config = {
        spaceId: id,
        spaceName: typeof name === 'string' ? name : '',
        objectId: typeof objectId === 'string' && objectId ? objectId : undefined,
        objectName: typeof objectName === 'string' && objectName ? objectName : undefined,
      }
      saveConfig()
      return {}
    },

    async createNote(spaceId, name, initialMarkdown = '') {
      if (!key) throw new AnytypeError('unauthorized')
      const targetSpace = spaceId || config.spaceId
      if (!targetSpace) throw new AnytypeError('no-space')
      const space = encodeURIComponent(targetSpace)
      const pageName = typeof name === 'string' && name.trim() ? name.trim() : PAGE_NAME

      const answer = await call('POST', `/v1/spaces/${space}/objects`, {
        name: pageName,
        type_key: 'page',
        body: initialMarkdown,
      })
      if (!answer?.object?.id) throw new AnytypeError('failed', 'keine Objekt-ID')
      config.spaceId = targetSpace
      config.objectId = answer.object.id
      config.objectName = pageName
      saveConfig()
      log(`Anytype: Seite „${pageName}“ angelegt`)
      return { id: answer.object.id, name: pageName }
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
      const targetName = config.objectName || PAGE_NAME
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
      const answer = await call('POST', `/v1/spaces/${space}/objects`, { name: targetName, type_key: 'page', body: markdown })
      if (!answer?.object?.id) throw new AnytypeError('failed', 'keine Objekt-ID')
      config.objectId = answer.object.id
      config.objectName = targetName
      saveConfig()
      log(`Anytype: Seite „${targetName}“ angelegt`)
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
