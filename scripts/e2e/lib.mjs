// Shared pieces of the browser tests: a Drive kept in this process (just
// enough of the v3 API for what Sondra calls), a Chromium to drive, and the
// small reporter every scenario uses. Each scenario runs in its own process,
// so the module state here is that scenario's own Drive.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright-core'

export const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:4199/'
export const OUT = (process.env.E2E_OUT ?? path.join(os.tmpdir(), 'sondra-e2e')) + path.sep
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
export const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
export function finish() {
  console.log(failed ? `${failed} gescheitert` : 'Alles grün.')
  process.exit(failed ? 1 : 0)
}

/** The preinstalled Chromium where there is one, Playwright's own otherwise. */
export function launch(args = []) {
  const preinstalled = process.env.E2E_CHROMIUM ?? '/opt/pw-browsers/chromium'
  return chromium.launch({
    ...(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {}),
    args: ['--no-sandbox', ...args],
  })
}

/** A page error that is the test's own doing: with service workers blocked, `register` resolves to nothing. */
export const harmless = (error) => /reading 'update'|c is not iterable/.test(String(error))

/* ---------------- Drive in memory ---------------- */
export const FOLDER = 'application/vnd.google-apps.folder'
export const files = new Map()
let counter = 0
const newId = () => `f${(counter += 1).toString().padStart(4, '0')}`
export const now = () => new Date().toISOString()
const sessions = new Map()

function meta(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.bytes ? String(file.bytes.length) : undefined,
    modifiedTime: file.modifiedTime,
    createdTime: file.createdTime,
    parents: file.parents,
    appProperties: file.appProperties,
  }
}
function matches(file, q) {
  if (file.trashed) return false
  const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)
  if (name && file.name !== name[1].replace(/\\'/g, "'")) return false
  const mimeIs = /mimeType = '([^']*)'/.exec(q)
  if (mimeIs && file.mimeType !== mimeIs[1]) return false
  const mimeNot = /mimeType != '([^']*)'/.exec(q)
  if (mimeNot && file.mimeType === mimeNot[1]) return false
  const parent = /'([^']*)' in parents/.exec(q)
  if (parent && !(file.parents ?? []).includes(parent[1])) return false
  const prop = /appProperties has \{ key='([^']*)' and value='([^']*)' \}/.exec(q)
  if (prop && file.appProperties?.[prop[1]] !== prop[2]) return false
  return true
}
export function create(metaIn, bytes) {
  const id = newId()
  const file = {
    id,
    name: metaIn.name,
    mimeType: metaIn.mimeType ?? 'application/octet-stream',
    parents: metaIn.parents ?? ['root'],
    appProperties: metaIn.appProperties,
    bytes: metaIn.mimeType === FOLDER ? null : bytes ?? Buffer.alloc(0),
    createdTime: now(),
    modifiedTime: now(),
  }
  files.set(id, file)
  return file
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' }
const json = (route, body, status = 200, headers = {}) =>
  route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

export async function drive(route) {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
  const path = url.pathname
  if (path.endsWith('/about')) return json(route, { user: { displayName: 'Test', emailAddress: 'test@example.com' } })
  // Resumable sessions
  if (path.startsWith('/session/')) {
    const session = sessions.get(path)
    const range = request.headers()['content-range'] ?? ''
    const body = request.postDataBuffer() ?? Buffer.alloc(0)
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)
    if (m) {
      session.parts.push(body)
      const total = Number(m[3])
      const have = session.parts.reduce((s, p) => s + p.length, 0)
      if (have >= total) {
        const file = session.existing ?? create(session.meta, Buffer.concat(session.parts))
        if (session.existing) file.bytes = Buffer.concat(session.parts)
        return json(route, meta(file))
      }
      return route.fulfill({ status: 308, headers: { ...cors, Range: `bytes=0-${have - 1}` } })
    }
    return route.fulfill({ status: 308, headers: cors })
  }
  const upload = path.startsWith('/upload/drive/v3/files')
  const idMatch = /\/files\/([^/]+)$/.exec(path)
  if (upload) {
    const type = url.searchParams.get('uploadType')
    if (type === 'multipart') {
      const contentType = request.headers()['content-type']
      const boundary = /boundary=(.+)$/.exec(contentType)[1]
      const raw = request.postDataBuffer()
      const text = raw.toString('latin1')
      const parts = text.split(`--${boundary}`)
      const metaPart = parts[1]
      const metaJson = JSON.parse(Buffer.from(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim(), 'latin1').toString('utf8'))
      const dataPart = parts[2]
      const start = text.indexOf(dataPart) + dataPart.indexOf('\r\n\r\n') + 4
      const end = text.lastIndexOf(`\r\n--${boundary}--`)
      return json(route, meta(create(metaJson, raw.subarray(start, end))))
    }
    if (type === 'media' && idMatch) {
      const file = files.get(idMatch[1])
      if (!file) return json(route, { error: { message: 'not found' } }, 404)
      file.bytes = request.postDataBuffer() ?? Buffer.alloc(0)
      file.modifiedTime = now()
      return json(route, meta(file))
    }
    if (type === 'resumable') {
      const key = `/session/${newId()}`
      sessions.set(key, { meta: JSON.parse(request.postData() || '{}'), parts: [], existing: idMatch ? files.get(idMatch[1]) : null })
      return route.fulfill({ status: 200, headers: { ...cors, Location: `https://www.googleapis.com${key}` }, body: '' })
    }
  }
  if (idMatch) {
    const file = files.get(idMatch[1])
    if (method === 'DELETE') {
      if (!file) return json(route, { error: { message: 'not found' } }, 404)
      files.delete(file.id)
      return route.fulfill({ status: 204, headers: cors })
    }
    if (!file) return json(route, { error: { message: 'not found' } }, 404)
    if (url.searchParams.get('alt') === 'media') {
      return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/octet-stream' }, body: file.bytes })
    }
    if (method === 'PATCH') {
      const body = JSON.parse(request.postData() || '{}')
      if (body.trashed) file.trashed = true
      return json(route, { ...meta(file), trashed: Boolean(file.trashed) })
    }
    return json(route, { ...meta(file), trashed: Boolean(file.trashed) })
  }
  if (path.endsWith('/files')) {
    if (method === 'POST') return json(route, meta(create(JSON.parse(request.postData() || '{}'))))
    const q = url.searchParams.get('q') ?? ''
    const found = [...files.values()].filter((file) => matches(file, q))
    return json(route, { files: found.map(meta) })
  }
  return json(route, { error: { message: `unhandled ${method} ${path}` } }, 400)
}


