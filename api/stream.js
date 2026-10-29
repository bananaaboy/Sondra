/**
 * The pipe.
 *
 * Takes a token that `resolve` signed, fetches exactly that address and passes
 * the bytes straight back. It adds nothing, keeps nothing and logs nothing.
 *
 * Range headers are forwarded in both directions, and that is the whole trick
 * that makes this work on a serverless platform at all: a function has a time
 * limit measured in seconds, so a two-hundred-megabyte file would never finish
 * in one call. The browser asks for it a few megabytes at a time instead, each
 * chunk its own short-lived invocation, and reassembles them. Which also means
 * a cancelled download stops costing anything immediately.
 */

import { allowedTarget, sign, verify, youtubeStreamUrl } from './_shared.js'
import { boundedFetch } from './extractors.js'

/**
 * Where to fetch a claim from.
 *
 * A YouTube claim names the video and the itag rather than trusting the signed
 * address: that address is bound to the IP of whichever instance resolved it,
 * and this invocation may well run somewhere else (see `youtubeStreamUrl`).
 */
async function targetFor(claim, fresh = false) {
  if (claim.yt && claim.itag) {
    const url = await youtubeStreamUrl(claim.yt, claim.itag, { fresh })
    return url ? allowedTarget(url) : null
  }
  return allowedTarget(claim.u)
}

/** Playlists are text and small; anything past this is not one. */
const PLAYLIST_LIMIT = 8 * 1024 * 1024
const PLAYLIST_TYPE = /^application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i

/**
 * An HLS playlist with every address in it pointed back through this pipe.
 *
 * The browser may not fetch a segment from the media host itself — the same
 * CORS wall that is the reason this endpoint exists — so each segment, each
 * quality and each separate sound track gets its own signed token, with the
 * same referer as the playlist. Keys are left alone: an encrypted stream is
 * refused on the page, and its key is never fetched by anyone here.
 *
 * Exported for the checks in `scripts/verify-resolve.mjs`.
 */
export function rewritePlaylist(text, base, extra = {}) {
  const claim = (target, nested) => {
    let absolute
    try {
      absolute = new URL(target, base)
    } catch {
      return null
    }
    if (!allowedTarget(absolute.href)) return null
    return `/api/stream?t=${encodeURIComponent(sign(absolute.href, { ...extra, ...(nested ? { isHls: true } : {}) }))}`
  }
  let nextIsPlaylist = false
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-STREAM-INF/i.test(trimmed)) nextIsPlaylist = true
        if (/^#EXT-X-(?:SESSION-)?KEY/i.test(trimmed)) return line
        const nested = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)/i.test(trimmed)
        return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
          const proxied = claim(uri, nested)
          return proxied ? `URI="${proxied}"` : whole
        })
      }
      const nested = nextIsPlaylist || /\.m3u8?(?:$|\?)/i.test(trimmed)
      nextIsPlaylist = false
      return claim(trimmed, nested) ?? line
    })
    .join('\n')
}

export default async function handler(request, response) {
  const token = String(request.query?.t ?? request.query?.token ?? '')
  const claim = verify(token)
  if (!claim) {
    response.status(403).json({ error: 'token', message: 'Der Link ist abgelaufen. Bitte neu suchen.' })
    return
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  }
  // A media host that gets no Range answers 200 with the whole file, which is
  // exactly what must not happen here.
  const range = request.headers.range
  if (range) headers.range = range
  const referer = claim.ref || claim.referer
  if (referer) headers.Referer = referer
  if (claim.cookie) headers.Cookie = claim.cookie

  try {
    let target = await targetFor(claim)
    if (!target) {
      response.status(claim.yt ? 502 : 400).json(
        claim.yt
          ? { error: 'upstream', message: 'YouTube bietet diese Spur gerade nicht mehr an. Bitte neu suchen.' }
          : { error: 'url', message: 'Ziel nicht erlaubt.' },
      )
      return
    }

    const localAddress = process.env.SONDRA_BIND_ADDRESS || undefined
    let upstream = await boundedFetch(target, { headers, redirect: 'follow', localAddress })
    // A cached YouTube address can go stale, or belong to an egress address
    // this instance no longer has. One fresh lookup settles which it was.
    if (upstream.status === 403 && claim.yt) {
      target = await targetFor(claim, true)
      if (target) upstream = await boundedFetch(target, { headers, redirect: 'follow', localAddress })
    }

    // Passed through, a refusal from the media host looked exactly like this
    // endpoint's own "token expired" 403, and the panel said the link had run
    // out when YouTube had simply turned this machine away.
    if (upstream.status === 403) {
      response.status(502).json({
        error: 'refused',
        message: claim.yt
          ? 'YouTube hat die Übertragung an diesen Rechner abgelehnt. Über „Optionen" mit yt-dlp auf dem eigenen Gerät geht es meist trotzdem.'
          : 'Die Quelle hat die Übertragung abgelehnt (403).',
      })
      return
    }

    // An HLS playlist is answered whole and rewritten, never in ranges: its
    // addresses have to be signed for this pipe before the page can use them.
    const type = upstream.headers.get('content-type') ?? ''
    const maybePlaylist =
      Boolean(claim.isHls) ||
      PLAYLIST_TYPE.test(type) ||
      (/\.m3u8$/i.test(target.pathname) && (/mpegurl/i.test(type) || !/^(?:video|audio)\//i.test(type)))
    // `body` is not touched here: on the adapter path it is a stream of its
    // own, and asking for it would leave nothing for `arrayBuffer`.
    if (maybePlaylist && upstream.ok) {
      let buffer = Buffer.from(await upstream.arrayBuffer())
      const head = buffer.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart()
      if (head.startsWith('#EXTM3U')) {
        // A ranged request may have cut the playlist short; fetch it whole.
        if (upstream.status === 206) {
          const { range: _range, ...whole } = headers
          const full = await boundedFetch(target, { headers: whole, redirect: 'follow', localAddress })
          if (full.ok) buffer = Buffer.from(await full.arrayBuffer())
        }
        if (buffer.byteLength <= PLAYLIST_LIMIT) {
          const rewritten = rewritePlaylist(buffer.toString('utf8'), upstream.url || target.href, referer ? { ref: referer } : {})
          const body = Buffer.from(rewritten, 'utf8')
          response.status(200)
          response.setHeader('content-type', 'application/vnd.apple.mpegurl')
          response.setHeader('content-length', String(body.byteLength))
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
          response.end(body)
          return
        }
      }
      // Not a playlist after all: the bytes as they came.
      response.status(upstream.status)
      for (const header of ['content-type', 'content-range', 'accept-ranges', 'last-modified']) {
        const value = upstream.headers.get(header)
        if (value) response.setHeader(header, value)
      }
      response.setHeader('content-length', String(buffer.byteLength))
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      response.end(buffer)
      return
    }

    response.status(upstream.status)
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const value = upstream.headers.get(header)
      if (value) response.setHeader(header, value)
    }
    response.setHeader('Cache-Control', 'no-store')
    // The page is cross-origin isolated; a subresource from it needs to say it
    // is willing to be embedded there.
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')

    if (!upstream.body) {
      response.end()
      return
    }

    // Node's stream plumbing, not `await arrayBuffer()`: buffering the chunk in
    // memory first would double the memory and add latency for no gain.
    // `pipeline`, not `pipe`: a source that drops the connection mid-chunk
    // raised an error nobody listened for, and that ended the whole process —
    // in the app, the server inside it. Now only this answer is cut off, and
    // the page sees a short chunk it can ask for again.
    const { Readable } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    try {
      await pipeline(Readable.fromWeb(upstream.body), response)
    } catch {
      if (!response.writableEnded) response.destroy()
    }
  } catch (failure) {
    response.status(502).json({
      error: 'upstream',
      message: `Der Dienst kam nicht an die Datei: ${String(failure?.message ?? failure)}`,
    })
  }
}
