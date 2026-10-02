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

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const HOST = '127.0.0.1'

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
  const candidate = path.resolve(root, '.' + path.posix.normalize(decoded))
  const inside = candidate === root || candidate.startsWith(root + path.sep)
  if (!inside) return null
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  return path.extname(decoded) ? null : path.join(root, 'index.html')
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

export async function startServer({ root, port, onError }) {
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`Die Oberfläche fehlt: ${path.join(root, 'index.html')} gibt es nicht.`)
  }

  // Before the API modules load: they read the secret once, at import time.
  // Loaded dynamically for the same reason — a static import would evaluate
  // before this line, and the bundle is CommonJS, which has no top-level await.
  process.env.SONDRA_SECRET ||= crypto.randomBytes(32).toString('base64url')
  const { default: resolveFn } = await import('../api/resolve.js')
  const { default: streamFn } = await import('../api/stream.js')

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
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
