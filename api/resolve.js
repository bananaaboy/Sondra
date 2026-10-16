/**
 * "What is behind this address, and what can I have?"
 *
 * The one endpoint that is not local. It is small on purpose: it looks up what
 * a URL offers, signs the addresses it found, and answers. It never holds a
 * file, never stores a URL, and never sees what the browser does next.
 */

import {
  allowedTarget,
  hasProvider,
  resolveViaProvider,
  resolveYoutube,
  sign,
  youtubeId,
} from './_shared.js'
import {
  DEFAULT_USER_AGENT,
  extractDirectMedia,
  isAniworldUrl,
  isBilibiliUrl,
  isHosterUrl,
  isPodcastOrRssUrl,
  isSpotifyUrl,
  parsePodcastFeed,
} from './extractors.js'

/*
 * The four helpers below are exported so they can be tested directly. A
 * serverless module's contract is its default export; the named ones cost
 * nothing at runtime and are the difference between testing this code and
 * testing a copy of it.
 */

/**
 * What counts as "there is already a file here".
 *
 * Not just `audio/`, `video/` and `image/`: plenty of perfectly ordinary media
 * arrives under `application/` — Wikimedia serves .ogg as `application/ogg`,
 * MPEG-DASH and HLS playlists have their own types, and Matroska is
 * `application/x-matroska`. Rejecting those told the visitor "that is a web
 * page" about a file that was plainly a sound recording.
 */
const MEDIA = /^(?:audio|video|image)\//i
const MEDIA_APPLICATION =
  /^application\/(?:ogg|mp4|x-matroska|x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|octet-stream)$/i
/** Extensions that make `application/octet-stream` believable. */
const MEDIA_EXTENSION =
  /\.(?:mp3|wav|flac|ogg|oga|opus|m4a|aac|aiff?|wma|mp4|m4v|webm|mkv|mov|avi|ts|flv|mpe?g|3gp|jpe?g|png|gif|webp|avif|bmp|tiff?|heic|m3u8|mpd)$/i

export function looksLikeMedia(type, url, disposition) {
  if (MEDIA.test(type)) return true
  if (!MEDIA_APPLICATION.test(type)) return false
  // octet-stream says nothing at all, so a name has to carry it — and on a
  // share link the name is not in the path.
  if (!type.toLowerCase().startsWith('application/octet-stream')) return true
  const named = filenameFrom(disposition)
  return MEDIA_EXTENSION.test(url.pathname) || (named ? MEDIA_EXTENSION.test(named) : false)
}

/**
 * The filename a server states in `Content-Disposition`.
 *
 * This is the header that rescues a share link. A cloud's public address is a
 * token — `/s/Ab3xK9mQ7pL2/download`, `?code=XZ…` — with no file name and no
 * extension anywhere in it, so everything that reads the path comes back empty
 * and the file gets mistaken for a web page. The server knows the real name
 * and says so here.
 *
 * Both spellings are read: plain `filename="…"` and RFC 5987's
 * `filename*=UTF-8''…`, which is the one that carries umlauts and is therefore
 * the one that matters for German file names.
 */
export function filenameFrom(disposition) {
  if (!disposition) return null
  const extended = disposition.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // A malformed encoding is not worth failing the whole download over.
    }
  }
  const plain = disposition.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i)
  const raw = plain ? (plain[1] ?? plain[2] ?? '').trim() : ''
  return raw || null
}

/** A name for a file: what the server called it, else what the URL suggests. */
export function nameFrom(url, disposition) {
  const stated = filenameFrom(disposition)
  // Strip any path a server may have put in the header; the name is all we want.
  if (stated) return stated.split(/[\\/]/).pop() || 'download'
  let last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  try {
    last = decodeURIComponent(last)
  } catch {}
  return last && last.includes('.') ? last : 'download'
}

/**
 * How big the file is, according to whichever header actually knows.
 *
 * After a ranged probe `Content-Length` is 1 — the single byte that was asked
 * for — and the real size sits at the end of `Content-Range` as
 * `bytes 0-0/16044`. Reading the wrong one reported every share link as a
 * one-byte file.
 */
export function sizeFrom(headers) {
  const total = (headers.get('content-range') ?? '').match(/\/(\d+)\s*$/)
  const length = total ? Number(total[1]) : Number(headers.get('content-length') ?? '0')
  return Number.isFinite(length) && length > 0 ? length : null
}

/**
 * An HLS playlist: by its type, or by its `.m3u8` name when the server types
 * it as plain text — some do. A `.m3u` music playlist (`audio/x-mpegurl`) is
 * a list of tracks, not one stream, and is left out on purpose.
 */
export function isHlsAnswer(type, url) {
  if (/^application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(type)) return true
  return /\.m3u8$/i.test(url.pathname) && !/html/i.test(type)
}

/**
 * Ask what is at an address without pulling the file down.
 *
 * `HEAD` first, because it is the polite question. Plenty of storage backends
 * answer it badly though — 405, or a 200 with no `content-type` at all — and a
 * file that exists then looked like a web page. So a `HEAD` that comes back
 * useless is retried as a `GET` for the first byte, which every server that
 * can serve the file at all will answer correctly.
 */
export async function probe(target) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: '*/*',
  }
  try {
    const head = await fetch(target, { method: 'HEAD', redirect: 'follow', headers })
    if (head.ok && head.headers.get('content-type')) return head
  } catch {
    // Fall through to the ranged GET below.
  }
  const ranged = await fetch(target, {
    method: 'GET',
    redirect: 'follow',
    headers: { ...headers, Range: 'bytes=0-0' },
  })
  // The body is one byte and unused; releasing it keeps the socket from being
  // held open for the rest of the invocation.
  try {
    await ranged.arrayBuffer()
  } catch {
    // Nothing to release.
  }
  return ranged
}

/**
 * The address that actually answered a redirecting probe.
 *
 * File hosts commonly put an opaque sharing address in front of the real
 * object. `fetch` follows that chain, but the response headers describe the
 * last address, not the share address that started it. In particular an
 * octet-stream without a Content-Disposition name can only be identified by
 * the extension on that final address.
 */
export function finalUrlFrom(probed, fallback) {
  try {
    return new URL(probed.url || fallback.toString())
  } catch {
    return fallback
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).json({ error: 'method', message: 'Nur POST.' })
    return
  }

  let body = {}
  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body ?? {})
  } catch {
    response.status(400).json({ error: 'json', message: 'Ungültiges JSON im Anfragekörper.' })
    return
  }
  const raw = String(body.url ?? '').trim()
  if (!raw) {
    response.status(400).json({ error: 'empty', message: 'Es wurde keine Adresse übergeben.' })
    return
  }

  const target = allowedTarget(raw)
  if (!target) {
    response.status(400).json({
      error: 'url',
      message: 'Das ist keine gültige öffentliche https-Adresse.',
    })
    return
  }

  // Nothing is cached: two people asking for the same video should each get
  // their own signed, expiring addresses.
  response.setHeader('Cache-Control', 'no-store')

  /**
   * The provider first, when the deployment has one.
   *
   * It reaches further than anything here can: full resolution on YouTube, and
   * the portals this file has no extractor for. Only when it is absent, or it
   * comes back empty, do the two built-in routes below get a turn — so a
   * deployment without one still works, just within narrower limits.
   */
  if (hasProvider()) {
    const viaProvider = await resolveViaProvider(target.toString())
    if (viaProvider && !viaProvider.error) {
      response.status(200).json({ ...viaProvider, source: 'provider' })
      return
    }
  }

  const id = youtubeId(raw)
  if (id) {
    try {
      const result = await resolveYoutube(id)
      if (result.streams.length === 0) {
        response.status(422).json({
          error: 'youtube.sabr',
          message:
            'Für dieses Video gibt YouTube einem Server keine einzige herunterladbare Adresse: ' +
            'alle Spuren laufen über SABR und haben gar keine. Hier hilft ein Anbieter ' +
            '(SONDRA_PROVIDER_URL) oder der Weg über das eigene Gerät.',
        })
        return
      }
      response.status(200).json({ ...result, source: 'youtube' })
    } catch (failure) {
      const code = failure?.code ?? 'youtube'
      response.status(502).json({
        error: code,
        message:
          code === 'youtube.signin'
            ? 'YouTube verlangt für dieses Video eine Anmeldung und lässt einen Server nicht durch.'
            : String(failure?.message || 'YouTube hat die Anfrage abgelehnt.'),
      })
    }
    return
  }

  /**
   * AniWorld, SerienStream (s.to) & Direkt-Hoster (VOE, Filemoon, Vidmoly, etc.)
   */
  const targetStr = target.toString()
  if (isAniworldUrl(targetStr) || isHosterUrl(targetStr) || isBilibiliUrl(targetStr) || isSpotifyUrl(targetStr)) {
    try {
      const media = await extractDirectMedia(targetStr, {
        localAddress: request.body?.bindAddress || process.env.SONDRA_BIND_ADDRESS || undefined,
        language: request.body?.language,
      })
      if (media && media.isPlaylist) {
        response.status(200).json({
          status: 'playlist',
          kind: 'playlist',
          title: media.title,
          author: media.seriesTitle,
          items: media.items,
        })
        return
      }
      if (media && media.isSpotifyTrack) {
        const streams = []
        if (media.previewUrl) {
          streams.push({
            id: 'preview',
            label: 'Spotify Preview (30s MP3)',
            hasVideo: false,
            hasAudio: true,
            width: null,
            height: null,
            ext: 'mp3',
            mime: 'audio/mpeg',
            bytes: null,
            token: sign(media.previewUrl, { ref: 'https://open.spotify.com/' }),
          })
        }
        response.status(200).json({
          status: 'stream',
          kind: 'stream',
          title: media.title,
          author: media.artist || 'Spotify',
          thumb: media.thumbnail,
          duration: media.duration,
          searchQuery: media.searchQuery,
          streams,
        })
        return
      }
      if (media && (media.url || (media.streams && media.streams.length > 0))) {
        const streams = []
        if (Array.isArray(media.streams) && media.streams.length > 0) {
          for (const s of media.streams) {
            const safeUrl = s.url.startsWith('//') ? `https:${s.url}` : s.url
            streams.push({
              id: s.id,
              label: s.label || `${s.provider || 'Video'} (${s.language || 'Stream'})`,
              hasVideo: true,
              hasAudio: true,
              width: null,
              height: 1080,
              ext: s.ext || (s.isHls ? 'mp4' : 'mp4'),
              mime: s.isHls ? 'application/x-mpegurl' : 'video/mp4',
              bytes: null,
              isHls: Boolean(s.isHls),
              token: sign(safeUrl, { ref: s.referer, isHls: Boolean(s.isHls) }),
            })
          }
        } else if (media.url) {
          const safeUrl = media.url.startsWith('//') ? `https:${media.url}` : media.url
          streams.push({
            id: 'stream-0',
            label: `${media.hoster || 'Video'} · Stream (1080p)`,
            hasVideo: true,
            hasAudio: true,
            width: null,
            height: 1080,
            ext: media.isHls ? 'mp4' : media.mp4 ? 'mp4' : 'mp4',
            mime: media.isHls ? 'application/x-mpegurl' : 'video/mp4',
            bytes: null,
            isHls: Boolean(media.isHls),
            token: sign(safeUrl, { ref: media.referer, isHls: Boolean(media.isHls) }),
          })
        }

        response.status(200).json({
          source: isAniworldUrl(targetStr) ? 'aniworld' : 'direct',
          kind: 'direct',
          title: media.title || 'Video',
          author: media.seriesTitle || target.hostname,
          durationSeconds: null,
          thumbnail: media.thumbnail || null,
          availableLanguages: media.availableLanguages,
          currentLanguage: media.language,
          streams,
        })
        return
      }
    } catch {
      // If error occurs, fall through to fallback error response
    }

    response.status(422).json({
      error: 'no-extractor',
      message:
        'Für dieses Video konnte kein aktiver Stream aufgelöst werden (die Quelle ist möglicherweise nicht mehr verfügbar oder geschützt). ' +
        'Nutzen Sie die Sondra Windows-App oder die lokale yt-dlp-Brücke auf Ihrem PC, um das Video dennoch zu laden.',
    })
    return
  }

  /**
   * Podcast / RSS Feed
   */
  if (isPodcastOrRssUrl(targetStr)) {
    try {
      const feedRes = await fetch(targetStr, {
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: 'application/rss+xml, application/xml, text/xml, text/plain, */*',
        },
      })
      if (feedRes.ok) {
        const text = await feedRes.text()
        const feed = parsePodcastFeed(text, targetStr)
        if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
          response.status(200).json({
            status: 'playlist',
            kind: 'playlist',
            title: feed.title,
            author: feed.seriesTitle,
            items: feed.items,
          })
          return
        }
      }
    } catch {
      // Fall through to probe below
    }
  }

  /**
   * Anything else: is this already a media file?
   *
   * The browser cannot fetch it itself — a foreign server almost never sends
   * the CORS header that would allow it, which is the entire reason this
   * endpoint exists. So the question "is there a file here" is asked from the
   * server, with a HEAD, and if the answer is yes the address is signed and
   * handed back. There is no page scraping here and there will not be: that is
   * what yt-dlp is for, and yt-dlp belongs on the visitor's own machine.
   */
  try {
    const probed = await probe(target)
    // Keep the resolved URL, rather than sending the browser through the
    // share-page redirects again. Besides preserving a direct download, this
    // lets the media check and the file name use the extension at the end of
    // the redirect chain.
    const mediaTarget = allowedTarget(finalUrlFrom(probed, target).toString())
    const type = probed.headers.get('content-type') ?? ''
    const disposition = probed.headers.get('content-disposition') ?? ''
    if (!mediaTarget || !probed.ok || !(looksLikeMedia(type, mediaTarget, disposition) || isHlsAnswer(type, mediaTarget))) {
      if (type.includes('xml') || type.includes('rss') || type.includes('atom') || target.pathname.endsWith('.xml') || target.pathname.endsWith('.rss')) {
        try {
          const feedRes = await fetch(target.toString(), {
            headers: {
              'User-Agent': DEFAULT_USER_AGENT,
              accept: 'application/rss+xml, application/xml, text/xml, */*',
            },
          })
          if (feedRes.ok) {
            const text = await feedRes.text()
            const feed = parsePodcastFeed(text, target.toString())
            if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
              response.status(200).json({
                status: 'playlist',
                kind: 'playlist',
                title: feed.title,
                author: feed.seriesTitle,
                items: feed.items,
              })
              return
            }
          }
        } catch {}
      }

      response.status(422).json({
        error: 'no-extractor',
        message:
          'Unter dieser Adresse liegt keine Mediendatei, sondern eine Webseite. Ohne Anbieter kann ' +
          'der eingebaute Dienst nur YouTube und direkte Datei-Adressen; für alles andere braucht ' +
          'es einen Anbieter (SONDRA_PROVIDER_URL) oder yt-dlp auf dem eigenen Gerät. Bei einem ' +
          'Freigabe-Link einer Cloud hilft oft die Adresse, die direkt die Datei liefert — meist ' +
          'dieselbe mit „/download“ am Ende oder aus dem Herunterladen-Knopf der Cloud kopiert.',
      })
      return
    }
    const length = sizeFrom(probed.headers)
    const name = nameFrom(mediaTarget, disposition)
    // An HLS playlist is a stream, not a file: the page fetches its segments
    // through `stream.js` and puts them together as an MP4. Announced as the
    // playlist it was, its text was what got saved.
    if (isHlsAnswer(type, mediaTarget)) {
      const stem = name.replace(/\.m3u8$/i, '')
      response.status(200).json({
        source: 'direct',
        kind: 'direct',
        title: `${stem === 'download' || /^(?:master|index|playlist|chunklist|prog_index|manifest|hls|stream|video)(?:[_.-]\w*)?$/i.test(stem) ? mediaTarget.hostname : stem}.mp4`,
        author: target.hostname,
        durationSeconds: null,
        thumbnail: null,
        streams: [
          {
            id: 'direct-hls',
            label: 'Stream laden (wird zusammengefügt)',
            hasVideo: true,
            hasAudio: true,
            width: null,
            height: null,
            ext: 'mp4',
            mime: 'video/mp4',
            bytes: null,
            isHls: true,
            token: sign(mediaTarget.toString(), { isHls: true }),
          },
        ],
      })
      return
    }
    response.status(200).json({
      source: 'direct',
      kind: 'direct',
      title: name,
      author: target.hostname,
      durationSeconds: null,
      thumbnail: null,
      streams: [
        {
          id: 'direct',
          label: 'Datei laden',
          hasVideo: type.startsWith('video/'),
          hasAudio: /^(?:audio|video)\/|^application\/ogg/i.test(type),
          width: null,
          height: null,
          ext: name.includes('.') ? (name.split('.').pop() ?? 'bin') : 'bin',
          mime: type.split(';')[0],
          bytes: length,
          token: sign(mediaTarget.toString()),
        },
      ],
    })
    return
  } catch (failure) {
    response.status(502).json({
      error: 'unreachable',
      message: `Die Adresse war vom Dienst aus nicht erreichbar: ${String(failure?.message ?? failure)}`,
    })
  }
}
