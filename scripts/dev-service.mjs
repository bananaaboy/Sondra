/**
 * The built site plus the API functions, on one port.
 *
 * `vite preview` serves the static build but knows nothing about `api/`, and
 * the functions only exist once deployed — so there is no way to try the
 * downloader end to end locally without something like this. It is a
 * development aid, not part of the deployment: on Vercel the platform routes
 * `api/*.js` itself and this file is never loaded.
 *
 *   npm run build && npm run dev:service   →   http://localhost:4199
 */

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import googleTokenFn from '../api/google-token.js'
import resolveFn from '../api/resolve.js'
import streamFn from '../api/stream.js'

const PORT = Number(process.env.PORT ?? 4199)
const driveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 30_000 })

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** Just enough of Vercel's request and response shape for the handlers. */
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

http
  .createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    // The same two headers vercel.json sets, because SharedArrayBuffer — and
    // therefore multi-threaded FFmpeg — depends on them.
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
        else if (url.pathname === '/api/google-token') await googleTokenFn(request, response)
        else response.status(404).json({ error: 'route' })
      } catch (failure) {
        response.status(500).json({ error: 'crash', message: String(failure?.stack ?? failure) })
      }
      return
    }

    const driveMatch = url.pathname.match(/^\/drive-media\/([^/]+)$/)
    if (driveMatch) {
      const fileId = decodeURIComponent(driveMatch[1])
      const token = url.searchParams.get('token') || (request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      if (!token) {
        response.statusCode = 401
        response.end('Unauthorized')
        return
      }
      const mimeType = url.searchParams.get('type') || 'application/octet-stream'
      const knownSize = Number(url.searchParams.get('size')) || 0
      const upReq = https.request(
        new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`),
        {
          method: request.method === 'HEAD' ? 'HEAD' : 'GET',
          agent: driveHttpsAgent,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.headers.range ? { Range: request.headers.range } : {}),
          },
          timeout: 30_000,
        },
        (upRes) => {
          response.statusCode = upRes.statusCode || 200
          response.setHeader('content-type', mimeType)
          response.setHeader('accept-ranges', 'bytes')
          response.setHeader('cache-control', 'private, no-store')
          if (upRes.headers['content-range']) response.setHeader('content-range', upRes.headers['content-range'])
          if (upRes.headers['content-length']) response.setHeader('content-length', upRes.headers['content-length'])
          else if (knownSize > 0 && response.statusCode === 200) response.setHeader('content-length', String(knownSize))
          if (request.method === 'HEAD') {
            upRes.resume()
            response.end()
            return
          }
          upRes.pipe(response)
        },
      )
      upReq.on('error', () => {
        if (!response.headersSent) response.statusCode = 502
        response.end()
      })
      request.on('close', () => upReq.destroy())
      upReq.end()
      return
    }

    let file = path.join('dist', url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join('dist', 'index.html')
    response.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream')
    fs.createReadStream(file).pipe(response)
  })
  .listen(PORT, () => console.log(`Sondra mit Dienst auf http://localhost:${PORT}`))
