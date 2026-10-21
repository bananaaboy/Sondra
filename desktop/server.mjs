/**
 * The built site and the two API functions, served on this machine only.
 *
 * Shared by the desktop app (`electron.mjs`, which points its own window at
 * it) and by `npm run desktop` (`main.mjs`, which points the browser at it).
 * It is `scripts/dev-service.mjs` grown up for being handed to somebody else:
 *
 * - It listens on 127.0.0.1, not on every interface. A program somebody
 *   installed should not quietly become a proxy for the whole network.
 * - `SONDRA_SECRET` is drawn fresh at every start unless one is set. The
 *   deployment falls back to a constant, which is fine for a website nobody
 *   can see the environment of and pointless on a machine where the constant
 *   is in the program.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const HOST = '127.0.0.1'

let cachedFfmpegBin = undefined

function findNativeFfmpeg(dataDir) {
  if (cachedFfmpegBin !== undefined) return cachedFfmpegBin
  const candidates = [
    process.env.SONDRA_FFMPEG,
    dataDir ? path.join(dataDir, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : null,
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  ].filter(Boolean)

  for (const bin of candidates) {
    try {
      const check = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 4000, windowsHide: true })
      if (check.status === 0) {
        cachedFfmpegBin = bin
        return bin
      }
    } catch {
      // try next candidate
    }
  }
  cachedFfmpegBin = null
  return null
}

async function runNativeFfmpeg(bin, payload) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ff-'))
  try {
    const folders = Array.isArray(payload.folders) ? payload.folders : []
    for (const folder of folders) {
      const targetDir = path.resolve(workDir, '.' + path.posix.normalize('/' + String(folder)))
      if (targetDir.startsWith(workDir)) fs.mkdirSync(targetDir, { recursive: true })
    }
    const input = payload.input && typeof payload.input === 'object' ? payload.input : {}
    for (const [name, b64] of Object.entries(input)) {
      const safePath = path.resolve(workDir, '.' + path.posix.normalize('/' + String(name)))
      if (!safePath.startsWith(workDir)) continue
      fs.mkdirSync(path.dirname(safePath), { recursive: true })
      fs.writeFileSync(safePath, Buffer.from(String(b64), 'base64'))
    }
    const rawArgs = Array.isArray(payload.args) ? payload.args.map(String) : []
    const logs = []
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(bin, ['-y', ...rawArgs], {
        cwd: workDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const onChunk = (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean)
        logs.push(...lines)
        if (logs.length > 500) logs.splice(0, logs.length - 500)
      }
      child.stdout.on('data', onChunk)
      child.stderr.on('data', onChunk)
      child.on('error', reject)
      child.on('close', (code) => resolve(code ?? 1))
    })

    if (exitCode !== 0) {
      return { ok: false, code: exitCode, logs }
    }

    const outputNames = Array.isArray(payload.output) ? payload.output.map(String) : []
    const files = {}
    for (const outName of outputNames) {
      const safeOut = path.resolve(workDir, '.' + path.posix.normalize('/' + outName))
      if (safeOut.startsWith(workDir) && fs.existsSync(safeOut)) {
        files[outName] = fs.readFileSync(safeOut).toString('base64')
      }
    }
    return { ok: true, files, logs }
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {}
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** Just enough of Vercel's request and response shape for the two handlers. */
function adapt(request, response, url) {
  request.query = Object.fromEntries(url.searchParams)
  response.status = (code) => {
    response.statusCode = code
    return response
  }
  response.json = (data) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(data))
  }
}

/**
 * The file a path names under root, index.html for the page itself, or null.
 *
 * Only extensionless paths fall back to the page. The app routes by hash, so
 * `/` is the only page address there is; a missing script or stylesheet
 * answered with HTML would fail in the browser with a confusing MIME error
 * instead of a plain 404.
 */
function fileFor(root, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, '.' + path.posix.normalize(decoded))
  const inside = candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep)
  if (!inside) return null
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  return path.extname(decoded) ? null : path.join(resolvedRoot, 'index.html')
}

/**
 * Serve `root` on 127.0.0.1, preferring `port` and falling back to any free
 * one. Resolves to the base address once listening.
 */
/** Types for files opened from Windows, so the page sorts them like a pick. */
const MEDIA = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.mid': 'audio/midi', '.midi': 'audio/midi',
}

/**
 * Files Windows handed to the app („Öffnen mit“, a file dropped on the icon),
 * offered to the page under an unguessable address for a few minutes. The
 * page fetches them like any other response — no copy through IPC, and a
 * video of several gigabytes streams rather than crossing in one message.
 */
const offered = new Map()
const OFFER_FOR_MS = 10 * 60 * 1000

/** Makes one file on disk fetchable once, by the page on this server. */
export function offerFile(file) {
  const token = crypto.randomBytes(18).toString('base64url')
  offered.set(token, { file, until: Date.now() + OFFER_FOR_MS })
  return `/geoeffnet/${token}`
}

function serveOffered(token, response, onError) {
  const entry = offered.get(token)
  offered.delete(token)
  if (!entry || entry.until < Date.now()) {
    response.statusCode = 404
    response.end()
    return
  }
  let size
  try {
    size = fs.statSync(entry.file).size
  } catch (failure) {
    onError?.(`Geöffnete Datei nicht lesbar: ${entry.file}: ${failure.message}`)
    response.statusCode = 404
    response.end()
    return
  }
  response.setHeader('content-type', MEDIA[path.extname(entry.file).toLowerCase()] ?? 'application/octet-stream')
  response.setHeader('content-length', String(size))
  response.setHeader('cache-control', 'no-store')
  const stream = fs.createReadStream(entry.file)
  stream.on('error', (failure) => {
    onError?.(`Geöffnete Datei: ${entry.file}: ${failure.message}`)
    response.destroy()
  })
  stream.pipe(response)
}

export async function startServer({ root, port, dataDir, onError }) {
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`Die Oberfläche fehlt: ${path.join(root, 'index.html')} gibt es nicht.`)
  }

  const settingsFile = dataDir ? path.join(dataDir, 'herunterladen.json') : null
  const readSettings = () => {
    if (!settingsFile) return {}
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const writeSettings = (patch) => {
    if (!settingsFile || !dataDir) return
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...patch }, null, 2))
    } catch {}
  }

  const initialBind = readSettings().bindAddress
  if (initialBind && initialBind !== 'default') {
    process.env.SONDRA_BIND_ADDRESS = initialBind
  }

  // Before the API modules load: they read the secret once, at import time.
  // Loaded dynamically for the same reason — a static import would evaluate
  // before this line, and the bundle is CommonJS, which has no top-level await.
  process.env.SONDRA_SECRET ||= crypto.randomBytes(32).toString('base64url')
  const { default: resolveFn } = await import('../api/resolve.js')
  const { default: streamFn } = await import('../api/stream.js')

  const server = http.createServer(async (request, response) => {
    const safeUrl = (request.url ?? '/').replace(/^\/{2,}/, '/')
    const url = new URL(safeUrl, 'http://localhost')
    // The same two headers vercel.json sets: SharedArrayBuffer, and with it
    // the multi-threaded FFmpeg core, depends on them.
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')

    if (url.pathname.startsWith('/api/')) {
      adapt(request, response, url)
      if (request.method === 'POST') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        request.body = Buffer.concat(chunks).toString()
      }
      try {
        if (url.pathname === '/api/resolve') await resolveFn(request, response)
        else if (url.pathname === '/api/stream') await streamFn(request, response)
        else if (url.pathname === '/api/adapters') {
          let chosen = null
          if (request.method === 'POST') {
            try {
              const parsed = request.body ? JSON.parse(request.body) : {}
              chosen = parsed.bindAddress || 'default'
            } catch {}
          }
          try {
            const forwardRes = await fetch('http://127.0.0.1:9000/adapters', {
              method: request.method,
              headers: { 'content-type': 'application/json' },
              body: request.method === 'POST' ? request.body : undefined,
            })
            if (!forwardRes.ok) throw new Error(`downloader status ${forwardRes.status}`)
            const data = await forwardRes.json()
            if (chosen) {
              process.env.SONDRA_BIND_ADDRESS = chosen === 'default' ? '' : chosen
              writeSettings({ bindAddress: chosen })
            }
            response.status(forwardRes.status).json(data)
          } catch {
            const nets = (await import('node:os')).default.networkInterfaces()
            const list = []
            for (const [name, addrs] of Object.entries(nets)) {
              for (const a of addrs || []) {
                if (a.family === 'IPv4' && !a.internal) list.push({ id: a.address, name: `${name} (${a.address})`, address: a.address })
              }
            }
            if (request.method === 'POST') {
              const val = chosen || 'default'
              process.env.SONDRA_BIND_ADDRESS = val === 'default' ? '' : val
              writeSettings({ bindAddress: val })
              response.status(200).json({ ok: true, selected: val })
            } else {
              const saved = readSettings().bindAddress || 'default'
              response.status(200).json({
                adapters: [
                  { id: 'default', name: 'Automatisch (Windows-Standard)', address: null },
                  ...list,
                ],
                selected: saved,
              })
            }
          }
        } else if (url.pathname === '/api/ffmpeg/status') {
          const bin = findNativeFfmpeg(dataDir)
          response.status(200).json({ available: Boolean(bin), bin: bin ? path.basename(bin) : null })
        } else if (url.pathname === '/api/ffmpeg/run' && request.method === 'POST') {
          const bin = findNativeFfmpeg(dataDir)
          if (!bin) {
            response.status(404).json({ ok: false, error: 'no-native-ffmpeg' })
          } else {
            const payload = request.body ? JSON.parse(request.body) : {}
            const result = await runNativeFfmpeg(bin, payload)
            response.status(result.ok ? 200 : 422).json(result)
          }
        }
        else response.status(404).json({ error: 'route' })
      } catch (failure) {
        onError?.(`${url.pathname}: ${failure?.stack ?? failure}`)
        if (!response.headersSent) response.status(500).json({ error: 'crash', message: String(failure?.message ?? failure) })
        else response.end()
      }
      return
    }

    const handed = url.pathname.match(/^\/geoeffnet\/([\w-]+)$/)
    if (handed) {
      serveOffered(handed[1], response, onError)
      return
    }

    const file = fileFor(root, url.pathname)
    if (!file) {
      response.statusCode = 404
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.end('Nicht gefunden.')
      return
    }
    response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    // Hashed assets never change under the same name; the page itself might.
    if (file.includes(`${path.sep}assets${path.sep}`)) response.setHeader('cache-control', 'public, max-age=31536000, immutable')
    else response.setHeader('cache-control', 'no-cache')
    const stream = fs.createReadStream(file)
    // A file that vanished or is locked (a virus scanner, mid-read) ends this
    // one response, not the whole app.
    stream.on('error', (failure) => {
      onError?.(`Lesen fehlgeschlagen: ${file}: ${failure.message}`)
      if (!response.headersSent) response.statusCode = 500
      response.end()
    })
    stream.pipe(response)
  })

  const listen = (candidate) =>
    new Promise((resolve, reject) => {
      const onListenError = (failure) => {
        server.off('listening', onListening)
        reject(failure)
      }
      const onListening = () => {
        server.off('error', onListenError)
        resolve()
      }
      server.once('error', onListenError)
      server.once('listening', onListening)
      server.listen(candidate, HOST)
    })

  try {
    await listen(port)
  } catch (failure) {
    // Something else already has the usual port, or Windows has reserved it
    // (Hyper-V and WSL claim whole ranges, and binding inside one is EACCES).
    // Any free port works; it only costs the origin, and with it whatever the
    // page kept in storage.
    if (failure.code !== 'EADDRINUSE' && failure.code !== 'EACCES') throw failure
    onError?.(`Port ${port} nicht verfügbar (${failure.code}), weiche aus.`)
    await listen(0)
  }

  return { server, url: `http://${HOST}:${server.address().port}/` }
}
