/**
 * One HTTP(S) request the way the app's services need it — shared by WebDAV
 * (desktop/webdav.mjs) and the phone notices (desktop/push.mjs).
 *
 * `node:http(s)` rather than `fetch`: a body is sent with its length stated up
 * front (a Nextcloud behind nginx or many a NAS store an empty file for a
 * chunked one), a redirect is never followed (a PUT that a server answers with
 * 301 would go on without its body), and the certificates trusted are Node's
 * own and the system's. Nothing here logs an address: a Telegram bot's token
 * is part of its address.
 */

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

/**
 * The certificate authorities a request trusts: Node's own list and, where
 * this Node can read it, the operating system's store (as `api/extractors.js`
 * does). A NAS often serves a certificate of its own that the person has told
 * Windows to trust; Node's bundled list alone would refuse it, and switching
 * the check off would let anyone on the network pass off a server of their own.
 * `undefined` keeps Node's default.
 */
let trustedCas
function trustedAuthorities() {
  if (trustedCas !== undefined) return trustedCas ?? undefined
  try {
    const system = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : []
    trustedCas = system.length > 0 ? [...tls.rootCertificates, ...system] : null
  } catch {
    trustedCas = null
  }
  return trustedCas ?? undefined
}

/**
 * One request, answered with its status, headers and — when `readBody` asks
 * for it — the start of the answer as text; the rest of the answer is dropped. `body` is a string, a readable stream (its length in
 * `Content-Length`, so the server sees what it is being sent) or nothing.
 * Never follows a redirect. `idle` is how long the connection may stay silent.
 */
export function send(method, url, { headers = {}, body, signal, idle = 20_000, readBody = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const secure = target.protocol === 'https:'
    const ca = secure ? trustedAuthorities() : undefined
    const request = (secure ? https : http).request(target, { method, headers, ...(ca ? { ca } : {}) }, (response) => {
      response.on('error', reject)
      // Up to `readBody` bytes of the answer are kept as text (a service's own words for what went wrong); the rest is dropped.
      const kept = []
      let size = 0
      response.on('data', (chunk) => {
        if (readBody > 0 && size < readBody) {
          kept.push(chunk)
          size += chunk.length
        }
      })
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: readBody > 0 ? Buffer.concat(kept).toString('utf8').slice(0, readBody) : '',
        }),
      )
    })
    // The error listener first: destroying a request that is already aborted emits at once.
    request.on('error', reject)
    const onAbort = () => request.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    request.on('close', () => signal?.removeEventListener('abort', onAbort))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (idle) request.setTimeout(idle, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    if (body && typeof body.pipe === 'function') {
      body.on('error', (failure) => request.destroy(failure))
      body.pipe(request)
    } else {
      request.end(body)
    }
  })
}

