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
 * Two dialects. `/v1` is what every Anytype since 0.46.7 speaks. Since
 * 0.51.6 the pairing lets the user hand out only some spaces, and `/v1`
 * refuses such a key outright („…carries a space grant, which /v1 cannot
 * honor"); `/v2` takes it. The first such refusal switches this link to
 * `/v2` for good — a key that may see everything stays on `/v1`, where it
 * always worked.
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
/** `/v2` takes at most 512 ops per PATCH and 256 blocks per op; a run may run over by a list item's few lines. */
const V2_MAX_OPS = 500
const V2_MAX_BLOCKS = 200

/**
 * The page's markdown in runs `/v2` takes as one `insert_blocks` each. Every
 * line outside the code fence is counted as a block — more than Anytype
 * makes of them, never fewer — and a run is cut only where a new block
 * starts at the top, never inside the fence or under a list item.
 */
export function markdownRuns(markdown, max = V2_MAX_BLOCKS) {
  const runs = []
  let run = []
  let lines = 0
  let fenced = false
  let blank = true
  for (const line of markdown.split('\n')) {
    const fence = /^\s*```/.test(line)
    const counted = !fenced && line.trim() !== ''
    const opens = counted && (blank || fence || /^(?:[-*+] |\d+[.)] |#{1,6} |> )/.test(line))
    if (opens && lines >= max) {
      runs.push(run.join('\n'))
      run = []
      lines = 0
    }
    if (counted) lines += 1
    if (fence) fenced = !fenced
    blank = line.trim() === ''
    run.push(line)
  }
  const last = run.join('\n')
  if (last.trim()) runs.push(last)
  return runs
}

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
  /** @type {{ spaceId?: string, spaceName?: string, objectId?: string, objectName?: string, api?: 'v2' }} */
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
    } catch (failure) {
      throw new AnytypeError('unreachable', `${method} ${route.split('?')[0]}: ${failure?.name === 'AbortError' ? `keine Antwort nach ${timeout / 1000} s` : (failure?.message ?? failure)}`)
    } finally {
      clearTimeout(timer)
    }
    if (response.ok) return response.status === 204 ? null : response.json()
    const text = await response.text().catch(() => '')
    // Anytype answers errors as { message, … } (and /v2 adds a code); the
    // sentence is what helps.
    let message = text
    let reason = ''
    try {
      const parsed = JSON.parse(text)
      message = parsed?.message ?? text
      reason = typeof parsed?.code === 'string' ? parsed.code : ''
    } catch {
      // Not JSON; the text as it came.
    }
    const detail = `${method} ${route.split('?')[0]}: HTTP ${response.status} ${String(message).slice(0, 160)}`.trim()
    // A key bound to chosen spaces: /v1 cannot take it, /v2 can.
    if (response.status === 403 && reason === 'v1_not_available_for_scoped_keys') throw new AnytypeError('scoped-key', detail)
    if (auth && response.status === 401) {
      // The key was withdrawn in Anytype's settings; a new code is needed.
      dropKey()
      throw new AnytypeError('unauthorized', detail)
    }
    // A space the key was not given when it was paired (/v2 only).
    if (response.status === 403 && reason === 'space_not_granted') throw new AnytypeError('not-granted', detail)
    // Forbidden is about this space or object (a shared space with reading
    // rights only, a key paired for reading), not about the key: it stays.
    if (response.status === 403) throw new AnytypeError('forbidden', detail)
    // 410: deleted in Anytype, emptied from its bin.
    if (response.status === 404 || response.status === 410) throw new AnytypeError('missing', detail)
    if (response.status === 429) throw new AnytypeError('busy', detail)
    throw new AnytypeError(response.status === 400 ? 'rejected' : 'failed', detail)
  }

  /**
   * The few things Sondra asks of Anytype, in both dialects. Rows come back
   * as `{ id, name, archived }`; `/v2` leaves archived objects out of its
   * lists by itself.
   */
  const v2 = () => config.api === 'v2'
  const object = (space, id) => `/spaces/${space}/objects/${encodeURIComponent(id)}`
  const dialect = {
    async spaces() {
      const answer = v2() ? await call('GET', '/v2/spaces?ids=full&limit=100') : await call('GET', '/v1/spaces?limit=100')
      return answer?.data ?? []
    },
    async search(space, query) {
      const answer = v2()
        ? await call('POST', `/v2/spaces/${space}/search?ids=full&limit=50`, { query, type: 'page' })
        : await call('POST', `/v1/spaces/${space}/search`, { query, types: ['page'], type: 'page' })
      return answer?.data ?? []
    },
    async list(space) {
      const answer = await call('GET', `/${v2() ? 'v2' : 'v1'}/spaces/${space}/objects?limit=50`)
      return answer?.data ?? []
    },
    /** The page as markdown; a page in Anytype's bin counts as gone. */
    async read(space, id) {
      if (v2()) {
        const answer = await call('GET', `/v2${object(space, id)}?format=md`)
        return String(answer?.markdown ?? '')
      }
      const answer = await call('GET', `/v1${object(space, id)}?format=md`)
      if (answer?.object?.archived) throw new AnytypeError('missing')
      return String(answer?.object?.markdown ?? '')
    },
    /** A new page; its id. */
    async create(space, name, markdown) {
      const answer = v2()
        ? await call('POST', `/v2/spaces/${space}/objects`, { type: 'page', name, markdown })
        : await call('POST', `/v1/spaces/${space}/objects`, { name, type_key: 'page', body: markdown })
      const id = v2() ? answer?.id : answer?.object?.id
      if (!id) throw new AnytypeError('failed', 'keine Objekt-ID')
      return id
    },
    /**
     * The page's text replaced. `/v1` takes it whole; `/v2` has no such
     * call — its own way to start a page over is to delete every top block
     * and insert the new ones, as one batch where the limits allow.
     */
    async replace(space, id, markdown) {
      if (!v2()) {
        await call('PATCH', `/v1${object(space, id)}`, { markdown })
        return
      }
      const outline = (await call('GET', `/v2${object(space, id)}?outline=true`))?.outline ?? []
      const ops = [
        ...outline.filter((block) => block?.indent === 0 && block.id).map((block) => ({ op: 'delete_block', id: block.id, recursive: true })),
        ...markdownRuns(markdown).map((run) => ({ op: 'insert_blocks', markdown: run, position: 'last' })),
      ]
      for (let at = 0; at < ops.length; at += V2_MAX_OPS) {
        await call('PATCH', `/v2${object(space, id)}`, { ops: ops.slice(at, at + V2_MAX_OPS) })
      }
    },
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

    const named = (rows) => rows.find((row) => row?.name === targetName && !row.archived)
    let page = null
    try {
      page = named(await dialect.search(space, targetName))
      if (!page && targetName.includes('·')) page = named(await dialect.search(space, 'Sondra'))
    } catch (error) {
      if (error.code === 'scoped-key') throw error
    }

    if (!page) {
      try {
        page = named(await dialect.list(space))
      } catch (error) {
        if (error.code === 'scoped-key') throw error
      }
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
      // A new key may see more or less than the old one: which dialect it
      // needs is found out again.
      if (config.api) {
        delete config.api
        saveConfig()
      }
      log('Anytype: verbunden')
      return {}
    },

    async spaces() {
      if (!key) throw new AnytypeError('unauthorized')
      return {
        spaces: (await dialect.spaces())
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
      const take = (rows) => {
        for (const obj of rows) {
          if (obj?.id && !obj.archived && typeof obj?.name === 'string' && obj.name.includes('Sondra')) candidates.set(obj.id, obj)
        }
      }
      for (const look of [() => dialect.search(space, 'Sondra'), () => dialect.list(space)]) {
        try {
          take(await look())
        } catch (error) {
          if (error.code === 'scoped-key') throw error
        }
      }

      const notes = []
      for (const [id, obj] of candidates.entries()) {
        let itemCount = 0
        try {
          const md = await dialect.read(space, id)
          const match = md.match(/```(?:sondra-merkliste)?\s*([\s\S]*?)```/)
          if (match) {
            try {
              const raw = match[1].replace(/[^A-Za-z0-9+/=]/g, '')
              const decoded = Buffer.from(raw, 'base64').toString('utf8')
              const parsed = JSON.parse(decoded)
              if (parsed?.kind === 'sondra-merkliste' && Array.isArray(parsed.items)) itemCount = parsed.items.length
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
        api: config.api,
      }
      saveConfig()
      return {}
    },

    async createNote(spaceId, name, spaceName = '', initialMarkdown = '') {
      if (!key) throw new AnytypeError('unauthorized')
      const targetSpace = spaceId || config.spaceId
      if (!targetSpace) throw new AnytypeError('no-space')
      const space = encodeURIComponent(targetSpace)
      const pageName = typeof name === 'string' && name.trim() ? name.trim() : PAGE_NAME

      const id = await dialect.create(space, pageName, typeof initialMarkdown === 'string' ? initialMarkdown : '')
      config.spaceId = targetSpace
      if (typeof spaceName === 'string' && spaceName) config.spaceName = spaceName
      config.objectId = id
      config.objectName = pageName
      saveConfig()
      log(`Anytype: Seite „${pageName}“ angelegt`)
      return { id, name: pageName }
    },

    /** The page's text, or null while there is no page yet. */
    async read() {
      const space = needSpace()
      let id = await findPage()
      if (!id) return { markdown: null }
      try {
        return { markdown: await dialect.read(space, id) }
      } catch (error) {
        if (error.code !== 'missing') throw error
        // Deleted in Anytype: look again by name, else there is none — and
        // one found by name that is gone as well counts as none.
        delete config.objectId
        saveConfig()
        id = await findPage()
        if (!id) return { markdown: null }
        try {
          return { markdown: await dialect.read(space, id) }
        } catch (again) {
          if (again.code !== 'missing') throw again
          delete config.objectId
          delete config.objectName
          saveConfig()
          return { markdown: null }
        }
      }
    },

    async write(markdown) {
      if (typeof markdown !== 'string') throw new AnytypeError('rejected')
      const space = needSpace()
      const targetName = config.objectName || PAGE_NAME
      const id = await findPage()
      if (id) {
        try {
          await dialect.replace(space, id, markdown)
          return {}
        } catch (error) {
          if (error.code !== 'missing') throw error
          delete config.objectId
        }
      }
      config.objectId = await dialect.create(space, targetName, markdown)
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
        try {
          return { ok: true, ...(await run(...args)) }
        } catch (error) {
          if (error?.code !== 'scoped-key' || config.api === 'v2') throw error
          // Refused on /v1 for its space grant: the same step once more on
          // /v2, and /v2 from now on.
          config.api = 'v2'
          saveConfig()
          log('Anytype: Schlüssel mit Space-Freigabe, weiter über /v2')
          return { ok: true, ...(await run(...args)) }
        }
      } catch (error) {
        const code = error instanceof AnytypeError ? error.code : 'failed'
        const detail = String((error instanceof AnytypeError ? error.detail : error?.message) || '').slice(0, 240)
        // Every failure with its reason, so sondra.log says which step stopped.
        // A closed Anytype is no news on the status check.
        if (!(action === 'status' && code === 'unreachable')) log(`Anytype: ${action} → ${code}${detail ? ` (${detail})` : ''}`)
        return { ok: false, error: code, ...(detail ? { detail } : {}) }
      }
    },
  }
}
