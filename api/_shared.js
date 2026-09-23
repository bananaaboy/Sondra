/**
 * The pieces both endpoints need: signing, and the one place that knows how to
 * ask YouTube anything.
 *
 * Files whose name starts with an underscore are not routed as functions by
 * Vercel, so this is a plain module rather than an endpoint.
 */

import crypto from 'node:crypto'
import vm from 'node:vm'

/* -------------------------------------------------------------------------- */
/* Signing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why sign at all, when the proxy only ever talks to an allow-listed handful of
 * media hosts?
 *
 * Because without it the endpoint is a general-purpose downloader for anyone
 * who finds the URL, paid for by whoever deployed this. The signature binds a
 * target to a short expiry, so a link only works for the person who just asked
 * for it and only for a few minutes.
 *
 * `SONDRA_SECRET` should be set in the deployment's environment. Without one
 * this falls back to a constant, which is worth exactly what it costs: it still
 * stops a casual passer-by from handing the endpoint arbitrary URLs, and it
 * stops nobody who has read this file. The allow-list is the real fence.
 */
const SECRET = process.env.SONDRA_SECRET || 'sondra-unconfigured'

/** How long a signed target stays usable. Long enough for a slow download. */
const TTL_SECONDS = 60 * 60 * 4

const b64url = (value) => Buffer.from(value).toString('base64url')

export function sign(target, extra = {}) {
  const payload = b64url(JSON.stringify({ u: target, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS, ...extra }))
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

export function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [payload, mac] = token.split('.')
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  // Constant-time, so the endpoint cannot be used as an oracle to guess a MAC.
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (typeof data.exp !== 'number' || data.exp * 1000 < Date.now()) return null
    return data
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Where the proxy is allowed to go                                            */
/* -------------------------------------------------------------------------- */

/**
 * The proxy fetches media, not web pages.
 *
 * Everything it is allowed to reach has to be a public HTTPS host, and never a
 * private address: an endpoint that will fetch any URL for you is an SSRF hole
 * into whatever else runs on the same network. Hostnames that resolve to
 * loopback or RFC 1918 space are refused by name here; the platform's own
 * network has no private services to reach in any case.
 */
const PRIVATE_HOST =
  /^(?:localhost|\[?::1\]?|0\.0\.0\.0)$|^(?:127|10)\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\.|\.(?:local|internal|localdomain)$/i

export function allowedTarget(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (PRIVATE_HOST.test(url.hostname)) return null
  return url
}

/* -------------------------------------------------------------------------- */
/* YouTube                                                                     */
/* -------------------------------------------------------------------------- */

let innertube = null

/**
 * One Innertube session per warm instance.
 *
 * Creating it downloads and parses YouTube's player script, which is megabytes
 * and seconds. Doing that per request would put the cost on every single
 * resolve; doing it once per container puts it on the first one.
 */
async function youtube() {
  if (innertube) return innertube
  const { Innertube, Platform } = await import('youtubei.js')
  // Deciphering a signature means running a chunk of YouTube's own JavaScript.
  // youtubei.js deliberately refuses to pick an evaluator for you, because
  // where that code runs is a security decision. `node:vm` with an empty
  // context is the smallest sandbox that works: the script gets no require, no
  // process, no fetch, and ten seconds.
  Platform.load({
    ...Platform.shim,
    eval: (data) =>
      new vm.Script(`(function(){${data.output}})()`).runInNewContext(Object.create(null), {
        timeout: 10_000,
      }),
  })
  innertube = await Innertube.create({ retrieve_player: true })
  return innertube
}

const YOUTUBE_HOST = /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$/i

export function youtubeId(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!YOUTUBE_HOST.test(url.hostname)) return null
  if (url.hostname.endsWith('youtu.be')) return url.pathname.slice(1).split('/')[0] || null
  if (url.pathname.startsWith('/shorts/') || url.pathname.startsWith('/embed/')) {
    return url.pathname.split('/')[2] || null
  }
  return url.searchParams.get('v')
}

const sizeLabel = (format) => {
  if (format.has_video && format.has_audio) return `${format.quality_label ?? 'Video'} mit Ton`
  if (format.has_video) return `${format.quality_label ?? 'Video'} ohne Ton`
  return `Nur Ton${format.bitrate ? ` · ${Math.round(format.bitrate / 1000)} kbit/s` : ''}`
}

/**
 * What YouTube will actually hand over to a server.
 *
 * Far less than it looks like from a browser, and the reason is worth writing
 * down: the high-resolution streams are served over SABR, a negotiated
 * protocol with no plain URL to fetch. They come back from the API with no
 * address at all — not a signed one, not an encrypted one — so there is
 * nothing for a proxy to pass on, with or without a PoToken (measured: minting
 * a valid one changes none of it). What is left is the progressive stream,
 * picture and sound already in one file, which tops out at 360p and which some
 * videos do not offer either.
 *
 * So this returns whatever really carries a URL and says plainly what it is.
 * The full-quality path is yt-dlp on the visitor's own machine, and the panel
 * offers it right next to this.
 */
/**
 * Deciphered addresses, per warm instance.
 *
 * A googlevideo address is bound to the IP that asked for it (`ip` is in its
 * `sparams`). On a serverless platform the call that resolves and the calls
 * that stream are separate invocations, often on separate machines with
 * separate egress addresses — and YouTube answers such a mismatched request
 * with 403. So a token carries the video and the itag, and whichever instance
 * streams looks the address up itself. This map saves it doing that for every
 * 4-MB chunk; it lives exactly as long as the instance, and therefore as long
 * as the IP the addresses in it belong to.
 */
const deciphered = new Map()
const DECIPHERED_TTL_MS = 60 * 60 * 1000

async function decipheredUrl(yt, format) {
  try {
    return (await format.decipher(yt.session.player)) || null
  } catch {
    // SABR-only, or a signature this player script cannot solve. Either way
    // there is no address, so there is nothing to offer.
    return null
  }
}

/**
 * The address of one YouTube stream, valid for this instance's IP.
 *
 * `fresh` skips the cache — for when the cached address was just refused.
 */
export async function youtubeStreamUrl(id, itag, { fresh = false } = {}) {
  const key = `${id}:${itag}`
  const cached = deciphered.get(key)
  if (!fresh && cached && Date.now() - cached.at < DECIPHERED_TTL_MS) return cached.url

  const yt = await youtube()
  const info = await yt.getBasicInfo(id)
  const data = info.streaming_data
  const format = [...(data?.formats ?? []), ...(data?.adaptive_formats ?? [])].find(
    (candidate) => String(candidate.itag) === String(itag),
  )
  const url = format ? await decipheredUrl(yt, format) : null
  if (url) deciphered.set(key, { url, at: Date.now() })
  else deciphered.delete(key)
  return url
}

export async function resolveYoutube(id) {
  const yt = await youtube()
  const info = await yt.getBasicInfo(id)

  const status = info.playability_status?.status
  if (status && status !== 'OK') {
    const reason = info.playability_status?.reason || ''
    throw Object.assign(new Error(reason || 'Das Video ist nicht abspielbar.'), {
      code: status === 'LOGIN_REQUIRED' ? 'youtube.signin' : 'youtube.unplayable',
    })
  }

  const data = info.streaming_data
  const all = [...(data?.formats ?? []), ...(data?.adaptive_formats ?? [])]

  const streams = []
  for (const format of all) {
    const url = await decipheredUrl(yt, format)
    if (!url) continue
    // If the stream calls land on this same instance, they need not ask again.
    deciphered.set(`${id}:${format.itag}`, { url, at: Date.now() })
    streams.push({
      id: String(format.itag),
      label: sizeLabel(format),
      hasVideo: Boolean(format.has_video),
      hasAudio: Boolean(format.has_audio),
      width: format.width ?? null,
      height: format.height ?? null,
      ext: format.mime_type?.includes('webm') ? 'webm' : format.has_video ? 'mp4' : 'm4a',
      mime: format.mime_type?.split(';')[0] ?? 'application/octet-stream',
      bytes: format.content_length ? Number(format.content_length) : null,
      // `u` stays in for the direct path; `yt` and `itag` let the streaming
      // instance fetch an address bound to its own IP (see above).
      token: sign(url, { yt: id, itag: String(format.itag) }),
    })
  }

  // Best first: sound and picture together, then the taller one.
  streams.sort((a, b) => {
    const complete = Number(b.hasVideo && b.hasAudio) - Number(a.hasVideo && a.hasAudio)
    return complete || (b.height ?? 0) - (a.height ?? 0)
  })

  return {
    kind: 'youtube',
    title: info.basic_info?.title ?? 'Video',
    author: info.basic_info?.author ?? null,
    durationSeconds: info.basic_info?.duration ?? null,
    thumbnail: info.basic_info?.thumbnail?.[0]?.url ?? null,
    streams,
  }
}

/* -------------------------------------------------------------------------- */
/* A provider, when the deployment has one                                     */
/* -------------------------------------------------------------------------- */

/**
 * The way past what YouTube hands a bare server.
 *
 * Measured, and the measurement is why this exists: asked directly, YouTube
 * gives a server the progressive stream and nothing else — picture and sound
 * in one file, 360p, and for some videos not even that. Everything above it
 * runs over SABR and has no address to fetch. A provider is a service that has
 * already solved that (its own extractors, its own addresses, residential
 * egress), and it also speaks to the fifty other portals this file never will.
 *
 * It is deliberately *not* hard-coded. Baking in a stranger's instance would
 * send every address a visitor types to a third party they never chose, and it
 * would rot the day that instance goes down. So the deployment names one:
 *
 *   SONDRA_PROVIDER_URL   a cobalt-compatible endpoint
 *   SONDRA_PROVIDER_KEY   its Api-Key, if it wants one
 *
 * With one set it is tried first and answers most things at full resolution.
 * Without one, everything still works — just within the limits above, and the
 * panel says which of the two answered.
 */
const PROVIDER = (process.env.SONDRA_PROVIDER_URL || '').trim().replace(/\/$/, '')
const PROVIDER_KEY = (process.env.SONDRA_PROVIDER_KEY || '').trim()

export function hasProvider() {
  return PROVIDER.length > 0
}

const QUALITY_LABEL = {
  audio: 'Nur Ton',
  mute: 'Video ohne Ton',
  auto: 'Video mit Ton',
}

/** Turns one cobalt item into the shape the browser already understands. */
function providerStream(url, filename, mode) {
  const ext = (filename?.split('.').pop() || (mode === 'audio' ? 'mp3' : 'mp4')).toLowerCase()
  const video = mode !== 'audio'
  return {
    id: `provider-${mode}`,
    label: QUALITY_LABEL[mode] ?? 'Datei',
    hasVideo: video,
    hasAudio: mode !== 'mute',
    width: null,
    height: null,
    ext,
    mime: video ? `video/${ext === 'webm' ? 'webm' : 'mp4'}` : `audio/${ext === 'mp3' ? 'mpeg' : ext}`,
    bytes: null,
    token: sign(url),
  }
}

/**
 * Asks the provider once per download mode.
 *
 * Three small requests rather than one, because cobalt answers a single mode
 * per call and "the video" and "just the sound" are the two things people
 * actually want — offering only one of them would mean going somewhere else
 * for the other.
 */
export async function resolveViaProvider(target, signal) {
  if (!PROVIDER) return null

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (PROVIDER_KEY) headers.authorization = `Api-Key ${PROVIDER_KEY}`

  const streams = []
  let filename = null
  let failure = null

  for (const mode of ['auto', 'audio']) {
    let answer
    try {
      const response = await fetch(PROVIDER, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
          url: target,
          videoQuality: '1080',
          audioFormat: 'mp3',
          downloadMode: mode,
          filenameStyle: 'basic',
          disableMetadata: true,
        }),
      })
      answer = await response.json()
    } catch (cause) {
      failure = String(cause?.message ?? cause)
      continue
    }

    if (answer?.status === 'tunnel' || answer?.status === 'redirect') {
      filename = filename ?? answer.filename ?? null
      streams.push(providerStream(answer.url, answer.filename, mode))
    } else if (answer?.status === 'picker' && Array.isArray(answer.picker)) {
      // A gallery or a post with several attachments: every item is offered.
      for (const [index, item] of answer.picker.entries()) {
        if (!item?.url) continue
        const stream = providerStream(item.url, item.url.split('/').pop(), item.type === 'photo' ? 'mute' : mode)
        streams.push({ ...stream, id: `provider-${mode}-${index}`, label: `${stream.label} ${index + 1}` })
      }
    } else if (answer?.status === 'error') {
      failure = answer?.error?.code ?? 'error.api'
    }
  }

  if (streams.length === 0) {
    return failure ? { error: failure } : null
  }

  return {
    kind: 'provider',
    title: (filename ?? 'Download').replace(/\.[^.]+$/, ''),
    author: new URL(target).hostname,
    durationSeconds: null,
    thumbnail: null,
    streams,
  }
}
