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

import { allowedTarget, verify, youtubeStreamUrl } from './_shared.js'

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

export default async function handler(request, response) {
  const token = String(request.query?.t ?? '')
  const claim = verify(token)
  if (!claim) {
    response.status(403).json({ error: 'token', message: 'Der Link ist abgelaufen. Bitte neu suchen.' })
    return
  }

  const headers = {}
  // A media host that gets no Range answers 200 with the whole file, which is
  // exactly what must not happen here.
  const range = request.headers.range
  if (range) headers.range = range

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

    let upstream = await fetch(target, { headers, redirect: 'follow' })
    // A cached YouTube address can go stale, or belong to an egress address
    // this instance no longer has. One fresh lookup settles which it was.
    if (upstream.status === 403 && claim.yt) {
      target = await targetFor(claim, true)
      if (target) upstream = await fetch(target, { headers, redirect: 'follow' })
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
    const { Readable } = await import('node:stream')
    Readable.fromWeb(upstream.body).pipe(response)
  } catch (failure) {
    response.status(502).json({
      error: 'upstream',
      message: `Der Dienst kam nicht an die Datei: ${String(failure?.message ?? failure)}`,
    })
  }
}
