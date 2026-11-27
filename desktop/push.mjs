/**
 * Notices on the phone: ntfy, Telegram or Pushover, whichever the person
 * enters. Sondra says when a download is done, a new episode is out or a
 * calendar entry is due; this sends it from the computer to the phone.
 *
 * Only the app can do this, and the service is the person's own choice:
 * nothing is built in — the ntfy server field starts empty — and the secrets
 * (a Telegram bot's token, Pushover's keys, an ntfy access token) stay here,
 * encrypted with the system's own store (Electron's safeStorage). The page
 * configures, tests and sends; it learns whether a secret is there, never
 * what it is. Nothing is logged with an address in it: Telegram carries its
 * token in the path.
 *
 * Kept free of Electron itself so `scripts/verify-push.mts` can run it under
 * Node against stand-ins for the three services.
 */

import fs from 'node:fs'
import path from 'node:path'

import { send } from './net.mjs'

export const SERVICES = ['ntfy', 'telegram', 'pushover']

/** Where Telegram and Pushover live; the check replaces them. ntfy has no default: the person names the server. */
export const DEFAULT_ENDPOINTS = {
  telegram: 'https://api.telegram.org',
  pushover: 'https://api.pushover.net',
}

/** A failure the page can name: wrong token, unknown chat, no network … */
export class PushError extends Error {
  constructor(code, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** A server address as typed: http(s) only, no login in it, no trailing slash. */
export function checkServer(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new PushError('no-server')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new PushError('bad-server')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PushError('bad-server')
  if (url.username || url.password) throw new PushError('credentials-in-address')
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, max)

function reasonOf(failure) {
  const code = String(failure?.code ?? failure?.errors?.[0]?.code ?? failure?.cause?.code ?? '')
  if (/CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|DEPTH_ZERO|ERR_TLS/i.test(code)) return 'certificate'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unknown-host'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT') return 'timeout'
  return 'unreachable'
}

/** What a service says when it refuses, in its own words — a few words, never more than a line. */
function wordsOf(text) {
  try {
    const parsed = JSON.parse(text)
    const said = parsed?.description ?? parsed?.error ?? (Array.isArray(parsed?.errors) ? parsed.errors.join(', ') : parsed?.message)
    if (typeof said === 'string') return clean(said, 120)
  } catch {
    // Not JSON.
  }
  return ''
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(text: string) => Buffer} options.encrypt
 * @param {(data: Buffer) => string} options.decrypt
 * @param {() => boolean} options.canEncrypt  without it the secrets live only until the app closes
 * @param {(message: string) => void} [options.log]
 * @param {{ telegram?: string, pushover?: string }} [options.endpoints]  replaced by the check
 */
export function createPush({ dataDir, encrypt, decrypt, canEncrypt, log = () => {}, endpoints = {} }) {
  const configFile = path.join(dataDir, 'push.json')
  const secretFile = path.join(dataDir, 'push-geheimnisse.bin')
  const where = { ...DEFAULT_ENDPOINTS, ...endpoints }

  /** @type {{ service?: string, ntfyServer?: string, ntfyTopic?: string, telegramChat?: string }} */
  let config = {}
  /** @type {{ ntfyToken?: string, telegramToken?: string, pushoverToken?: string, pushoverUser?: string }} */
  let secrets = {}
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8')) ?? {}
  } catch {
    // Not set up yet.
  }
  try {
    if (canEncrypt() && fs.existsSync(secretFile)) secrets = JSON.parse(decrypt(fs.readFileSync(secretFile))) ?? {}
  } catch {
    log('Handy-Meldungen: Schlüssel nicht lesbar, bitte neu eintragen')
  }

  const saveConfig = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(configFile, JSON.stringify(config))
  }
  const saveSecrets = () => {
    fs.rmSync(secretFile, { force: true })
    if (!canEncrypt() || Object.values(secrets).every((value) => !value)) return
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(secretFile, encrypt(JSON.stringify(secrets)))
  }

  /** Whether the chosen service has everything it needs. */
  const ready = () => {
    switch (config.service) {
      case 'ntfy':
        return Boolean(config.ntfyServer && config.ntfyTopic)
      case 'telegram':
        return Boolean(secrets.telegramToken && config.telegramChat)
      case 'pushover':
        return Boolean(secrets.pushoverToken && secrets.pushoverUser)
      default:
        return false
    }
  }

  const status = () => ({
    configured: ready(),
    service: config.service ?? null,
    ntfyServer: config.ntfyServer ?? '',
    ntfyTopic: config.ntfyTopic ?? '',
    telegramChat: config.telegramChat ?? '',
    hasNtfyToken: Boolean(secrets.ntfyToken),
    hasTelegramToken: Boolean(secrets.telegramToken),
    hasPushoverToken: Boolean(secrets.pushoverToken),
    hasPushoverUser: Boolean(secrets.pushoverUser),
    // False when the system has no store to keep secrets in: they go with the app's window.
    remembered: canEncrypt() || Object.values(secrets).every((value) => !value),
  })

  /** One message to the chosen service. Throws a `PushError`; the message and the secrets never reach a log. */
  async function deliver(title, body) {
    if (!ready()) throw new PushError('not-configured')
    const heading = clean(title, 120) || 'Sondra'
    const text = clean(body, 1000)
    let request
    switch (config.service) {
      case 'ntfy':
        request = {
          url: config.ntfyServer,
          headers: { 'Content-Type': 'application/json', ...(secrets.ntfyToken ? { Authorization: `Bearer ${secrets.ntfyToken}` } : {}) },
          // The JSON form, not headers: a title with an umlaut cannot travel in one.
          body: JSON.stringify({ topic: config.ntfyTopic, title: heading, message: text }),
        }
        break
      case 'telegram':
        request = {
          url: `${where.telegram}/bot${encodeURIComponent(secrets.telegramToken)}/sendMessage`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: config.telegramChat, text: `${heading}\n${text}` }),
        }
        break
      default:
        request = {
          url: `${where.pushover}/1/messages.json`,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: secrets.pushoverToken, user: secrets.pushoverUser, title: heading, message: text }),
        }
    }
    let response
    try {
      response = await send('POST', request.url, { headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body)) }, body: request.body, readBody: 2048 })
    } catch (failure) {
      // `failure` can carry the address (the token, for Telegram); only its reason goes on.
      throw new PushError(reasonOf(failure))
    }
    if (response.status >= 200 && response.status < 300) return
    const said = wordsOf(response.text)
    if (response.status === 401 || response.status === 403) throw new PushError('unauthorized', said)
    if (response.status === 429) throw new PushError('busy', said)
    // Telegram answers an unknown chat with 400 „chat not found“, a wrong token with 401/404; Pushover a wrong key with 400.
    if (config.service === 'telegram' && /chat not found/i.test(said)) throw new PushError('chat-not-found', said)
    if (config.service === 'telegram' && response.status === 404) throw new PushError('unauthorized', said)
    if (config.service === 'pushover' && response.status === 400) throw new PushError('unauthorized', said)
    if (response.status === 404) throw new PushError('missing', said)
    throw new PushError('failed', `HTTP ${response.status}${said ? ` ${said}` : ''}`)
  }

  /** The page's actions over IPC: status, configure, test, send, forget. */
  async function handle(action, args = []) {
    switch (action) {
      case 'status':
        return status()
      case 'configure': {
        const input = args[0] ?? {}
        const service = SERVICES.includes(input.service) ? input.service : null
        if (!service) return { ok: false, code: 'no-service', ...status() }
        const next = { ...config, service }
        try {
          if (service === 'ntfy') {
            next.ntfyServer = checkServer(input.ntfyServer)
            next.ntfyTopic = clean(input.ntfyTopic, 100).replace(/[\s/]+/g, '-')
            if (!next.ntfyTopic) throw new PushError('no-topic')
          } else if (service === 'telegram') {
            next.telegramChat = clean(input.telegramChat, 60)
            if (!next.telegramChat) throw new PushError('no-chat')
          }
        } catch (failure) {
          // Over IPC an error loses its class; the page gets the code as an answer.
          if (failure instanceof PushError) return { ok: false, code: failure.code, ...status() }
          throw failure
        }
        config = next
        // undefined keeps a secret, '' removes it, anything else replaces it.
        const take = (key, value) => {
          if (typeof value === 'string') secrets[key] = value.trim()
        }
        take('ntfyToken', input.ntfyToken)
        take('telegramToken', input.telegramToken)
        take('pushoverToken', input.pushoverToken)
        take('pushoverUser', input.pushoverUser)
        saveConfig()
        saveSecrets()
        if (!ready()) return { ok: false, code: service === 'telegram' ? 'no-token' : service === 'pushover' ? 'no-keys' : 'failed', ...status() }
        return { ok: true, ...status() }
      }
      case 'test':
      case 'send': {
        const input = args[0] ?? {}
        try {
          await deliver(action === 'test' ? 'Sondra' : input.title, action === 'test' ? 'So sieht eine Meldung von Sondra auf Ihrem Handy aus.' : input.body)
          return { ok: true }
        } catch (failure) {
          if (failure instanceof PushError) {
            log(`Handy-Meldungen: ${config.service ?? '?'} ${failure.code}`)
            return { ok: false, code: failure.code, detail: failure.detail }
          }
          throw failure
        }
      }
      case 'forget':
        config = {}
        secrets = {}
        fs.rmSync(configFile, { force: true })
        fs.rmSync(secretFile, { force: true })
        return status()
      default:
        throw new Error(`unbekannte Aktion: ${action}`)
    }
  }

  return { handle, status, ready, deliver }
}
