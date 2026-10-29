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
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const HOST = '127.0.0.1'
const driveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 30_000 })

let cachedFfmpegBin = undefined
let cachedGpuEncoder = undefined

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

function detectGpuEncoder(bin) {
  if (!bin) return null
  if (cachedGpuEncoder !== undefined) return cachedGpuEncoder
  try {
    const encOut = spawnSync(bin, ['-hide_banner', '-encoders'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    })
    const text = String(encOut.stdout || '')
    const candidates = ['h264_nvenc', 'h264_amf', 'h264_qsv'].filter((enc) => text.includes(enc))
    for (const enc of candidates) {
      const probe = spawnSync(
        bin,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=black:s=128x128:d=0.04',
          '-frames:v',
          '1',
          '-c:v',
          enc,
          '-f',
          'null',
          '-',
        ],
        { stdio: 'ignore', timeout: 3500, windowsHide: true },
      )
      if (probe.status === 0) {
        cachedGpuEncoder = enc
        return enc
      }
    }
  } catch {}
  cachedGpuEncoder = null
  return null
}

function rewriteArgsForGpu(rawArgs, gpuEncoder) {
  if (!gpuEncoder) return null
  const idx = rawArgs.findIndex((a, i) => (a === '-c:v' || a === '-vcodec') && /^(?:libx264|h264)$/i.test(rawArgs[i + 1] || ''))
  if (idx === -1) return null
  const next = [...rawArgs]
  next[idx + 1] = gpuEncoder
  // Strip x264-specific -crf / -preset flags that some hardware encoders reject
  const cleaned = []
  for (let i = 0; i < next.length; i++) {
    if (next[i] === '-crf' || next[i] === '-preset') {
      i += 1
      continue
    }
    cleaned.push(next[i])
  }
  return cleaned
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
    const gpuEncoder = payload.useGpu !== false ? detectGpuEncoder(bin) : null
    const gpuArgs = gpuEncoder ? rewriteArgsForGpu(rawArgs, gpuEncoder) : null

    const executeSpawn = (argsToRun, targetLogs) =>
      new Promise((resolve, reject) => {
        const child = spawn(bin, ['-y', ...argsToRun], {
          cwd: workDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const onChunk = (chunk) => {
          const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean)
          targetLogs.push(...lines)
          if (targetLogs.length > 500) targetLogs.splice(0, targetLogs.length - 500)
        }
        child.stdout.on('data', onChunk)
        child.stderr.on('data', onChunk)
        child.on('error', reject)
        child.on('close', (code) => resolve(code ?? 1))
      })

    const logs = []
    let usedGpu = null
    let exitCode = 1

    if (gpuArgs) {
      exitCode = await executeSpawn(gpuArgs, logs)
      if (exitCode === 0) {
        usedGpu = gpuEncoder
      } else {
        logs.length = 0
        exitCode = await executeSpawn(rawArgs, logs)
      }
    } else {
      exitCode = await executeSpawn(rawArgs, logs)
    }

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
    return { ok: true, files, logs, gpuEncoder: usedGpu }
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

function serveOffered(token, request, response, onError) {
  const now = Date.now()
  for (const [k, v] of offered) {
    if (v.until < now) offered.delete(k)
  }
  const entry = offered.get(token)
  if (!entry || entry.until < now) {
    response.statusCode = 404
    response.end()
    return
  }
  entry.until = now + OFFER_FOR_MS
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
  response.setHeader('accept-ranges', 'bytes')
  response.setHeader('cache-control', 'no-store')

  const rangeHeader = request.headers.range
  if (rangeHeader && size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
    if (match) {
      let start = match[1] ? Number(match[1]) : 0
      let end = match[2] ? Number(match[2]) : size - 1
      if (!match[1] && match[2]) {
        const suffix = Number(match[2])
        start = Math.max(0, size - suffix)
        end = size - 1
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start >= size || start > end) {
        response.statusCode = 416
        response.setHeader('content-range', `bytes */${size}`)
        response.end()
        return
      }
      end = Math.min(end, size - 1)
      response.statusCode = 206
      response.setHeader('content-range', `bytes ${start}-${end}/${size}`)
      response.setHeader('content-length', String(end - start + 1))
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      const stream = fs.createReadStream(entry.file, { start, end })
      stream.on('error', (failure) => {
        onError?.(`Geöffnete Datei: ${entry.file}: ${failure.message}`)
        response.destroy()
      })
      request.on('close', () => stream.destroy())
      stream.pipe(response)
      return
    }
  }

  response.statusCode = 200
  response.setHeader('content-length', String(size))
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  const stream = fs.createReadStream(entry.file)
  stream.on('error', (failure) => {
    onError?.(`Geöffnete Datei: ${entry.file}: ${failure.message}`)
    response.destroy()
  })
  request.on('close', () => stream.destroy())
  stream.pipe(response)
}

function serveDriveMedia(fileId, url, request, response, onError) {
  const token = url.searchParams.get('token') || (request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    response.statusCode = 401
    response.end('Unauthorized')
    return
  }
  const mimeType = url.searchParams.get('type') || 'application/octet-stream'
  const knownSize = Number(url.searchParams.get('size')) || 0
  const range = request.headers.range || 'bytes=0-'
  const upstreamUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`)

  const upReq = https.request(
    upstreamUrl,
    {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      agent: driveHttpsAgent,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(request.headers.range ? { Range: range } : {}),
      },
      timeout: 30_000,
    },
    (upRes) => {
      response.statusCode = upRes.statusCode || 200
      response.setHeader('content-type', mimeType)
      response.setHeader('accept-ranges', 'bytes')
      response.setHeader('cache-control', 'private, no-store')
      if (upRes.headers['content-range']) {
        response.setHeader('content-range', upRes.headers['content-range'])
      }
      if (upRes.headers['content-length']) {
        response.setHeader('content-length', upRes.headers['content-length'])
      } else if (knownSize > 0 && response.statusCode === 200) {
        response.setHeader('content-length', String(knownSize))
      }
      if (request.method === 'HEAD') {
        upRes.resume()
        response.end()
        return
      }
      upRes.pipe(response)
    },
  )

  upReq.on('timeout', () => {
    upReq.destroy(new Error('Google Drive stream timeout'))
  })
  upReq.on('error', (err) => {
    onError?.(`Drive-Stream ${fileId}: ${err.message}`)
    if (!response.headersSent) {
      response.statusCode = 502
      response.end()
    } else {
      response.destroy()
    }
  })
  request.on('close', () => {
    upReq.destroy()
  })
  upReq.end()
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
          response.status(200).json({
            available: Boolean(bin),
            bin: bin ? path.basename(bin) : null,
            gpuEncoder: bin ? detectGpuEncoder(bin) : null,
          })
        } else if (url.pathname === '/api/ffmpeg/run' && request.method === 'POST') {
          const bin = findNativeFfmpeg(dataDir)
          if (!bin) {
            response.status(404).json({ ok: false, error: 'no-native-ffmpeg' })
          } else {
            const payload = request.body ? JSON.parse(request.body) : {}
            const result = await runNativeFfmpeg(bin, payload)
            response.status(result.ok ? 200 : 422).json(result)
          }
        } else if (url.pathname === '/api/direct-save' && request.method === 'POST') {
          const payload = request.body ? JSON.parse(request.body) : {}
          const rawName = String(payload.filename || 'download.mp4').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'download.mp4'
          const baseDir =
            payload.targetDir ||
            readSettings().downloadDir ||
            path.join(os.homedir(), 'Downloads', 'Sondra')
          const subFolder = payload.subFolder
            ? String(payload.subFolder)
                .split(/[\\/]/)
                .map((s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim())
                .filter(Boolean)
                .join(path.sep)
            : ''
          const finalDir = subFolder ? path.join(baseDir, subFolder) : baseDir
          fs.mkdirSync(finalDir, { recursive: true })
          const destPath = path.join(finalDir, rawName)

          const directUrl = payload.directUrl
            ? String(payload.directUrl)
            : payload.token
              ? `http://${HOST}:${server.address().port}/api/stream?t=${encodeURIComponent(String(payload.token))}`
              : null
          if (!directUrl) {
            response.status(400).json({ ok: false, error: 'missing-source' })
          } else {
            const upRes = await fetch(directUrl)
            if (!upRes.ok || !upRes.body) {
              response.status(502).json({ ok: false, error: `status-${upRes.status}` })
            } else {
              const fileOut = fs.createWriteStream(destPath)
              let written = 0
              try {
                for await (const chunk of upRes.body) {
                  written += chunk.byteLength
                  if (!fileOut.write(chunk)) {
                    await new Promise((r) => fileOut.once('drain', r))
                  }
                }
                await new Promise((r, rej) => fileOut.end((err) => (err ? rej(err) : r())))
                response.status(200).json({
                  ok: true,
                  path: destPath,
                  size: written,
                  offeredUrl: offerFile(destPath),
                })
              } catch (err) {
                fileOut.destroy()
                try {
                  fs.rmSync(destPath, { force: true })
                } catch {}
                throw err
              }
            }
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
      serveOffered(handed[1], request, response, onError)
      return
    }

    const driveMatch = url.pathname.match(/^\/drive-media\/([^/]+)$/)
    if (driveMatch) {
      serveDriveMedia(decodeURIComponent(driveMatch[1]), url, request, response, onError)
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

  // The port is part of the origin, and the origin is where the page keeps
  // everything: the session, the Merkliste, the key that makes this computer
  // the same device under „Geräte“. A new port is a new, empty Sondra — after
  // an update that looked like the device was forgotten.
  const portFile = dataDir ? path.join(dataDir, 'port.json') : null
  const readSpare = () => {
    try {
      const value = JSON.parse(fs.readFileSync(portFile, 'utf8')).spare
      return Number.isInteger(value) && value > 1024 && value < 65536 && value !== port ? value : null
    } catch {
      return null
    }
  }
  const unavailable = (failure) => failure.code === 'EADDRINUSE' || failure.code === 'EACCES'
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  let bound = false
  // An update starts the new app while the old one is still letting go of
  // the port: wait for it a few seconds rather than move away for good.
  for (let attempt = 0; attempt < 16 && !bound; attempt += 1) {
    try {
      await listen(port)
      bound = true
    } catch (failure) {
      if (!unavailable(failure)) throw failure
      // A reserved range (Hyper-V, WSL: EACCES) does not clear by waiting.
      if (failure.code === 'EACCES') break
      if (attempt === 0) onError?.(`Port ${port} belegt, warte kurz.`)
      await wait(250)
    }
  }
  if (!bound) {
    // The spare port from last time, so the page finds its storage again.
    const spare = portFile ? readSpare() : null
    if (spare) {
      try {
        await listen(spare)
        bound = true
        onError?.(`Port ${port} nicht verfügbar, nehme wie zuletzt ${spare}.`)
      } catch (failure) {
        if (!unavailable(failure)) throw failure
      }
    }
  }
  if (!bound) {
    onError?.(`Port ${port} nicht verfügbar, weiche aus.`)
    await listen(0)
    if (portFile) {
      try {
        fs.mkdirSync(dataDir, { recursive: true })
        fs.writeFileSync(portFile, JSON.stringify({ spare: server.address().port }))
      } catch {
        // Then the next start may choose another one.
      }
    }
  }

  return { server, url: `http://${HOST}:${server.address().port}/` }
}
