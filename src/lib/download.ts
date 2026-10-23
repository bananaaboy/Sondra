/**
 * Client-side media fetching.
 *
 * Everything here runs in the visitor's browser, which has a consequence worth
 * being blunt about: the browser enforces the same-origin policy on our behalf.
 * A page served from Sondra's origin may only read a remote file if that remote
 * server sends `Access-Control-Allow-Origin`. Server-side downloaders sidestep
 * this by fetching on a backend — which is exactly the thing this app refuses to
 * do, because it would mean the user's URLs and IP address pass through someone
 * else's machine.
 *
 * So: direct links and CORS-enabled HLS streams work, and everything else gets
 * an honest error rather than a silent failure.
 */

import { ANDROID_BRIDGE } from './android'
import { sanitizeFilename } from './format'
import { explain, fetchLocalAware } from './service'

export interface TransferProgress {
  receivedBytes: number
  totalBytes: number | null
  /** 0–1 where the length is known, otherwise null. */
  fraction: number | null
  /** Bytes per second over the last window. */
  bytesPerSecond: number
}

type ProgressHandler = (progress: TransferProgress) => void

/** Wraps a fetch failure in language that says what the user can do about it. */
export class TransferError extends Error {
  readonly kind: 'cors' | 'network' | 'http' | 'aborted' | 'empty'

  constructor(kind: TransferError['kind'], message: string) {
    super(message)
    this.name = 'TransferError'
    this.kind = kind
  }
}

function describeFetchFailure(error: unknown, url: string): TransferError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new TransferError('aborted', 'Übertragung abgebrochen.')
  }
  if (error instanceof TransferError) return error
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* keep the raw string */
  }
  // A TypeError from fetch is the browser refusing to expose the response —
  // in practice always a missing CORS header or an unreachable host.
  return new TransferError(
    'cors',
    `${host} erlaubt keinen direkten Zugriff aus dem Browser (fehlender CORS-Header) ` +
      'oder ist nicht erreichbar. Das lässt sich nicht umgehen, ohne die Anfrage über ' +
      'einen fremden Server zu leiten — und genau das tut diese App nicht.',
  )
}

/**
 * Smallest payload we are willing to call a media file.
 *
 * Big enough to reject a truncated answer, small enough that no real audio or
 * video file ever falls below it.
 */
const MIN_MEDIA_BYTES = 1024

/**
 * A transfer that ended with `200 OK` and nothing usable in it.
 *
 * This is not a theoretical case. When YouTube refuses the underlying stream,
 * cobalt's tunnel handler has already sent its headers, so it closes the body
 * without writing a single byte — the request looks like a success from here.
 * Without this check the empty body travels into the session and gets offered
 * for saving as a file of a few bytes.
 */
function emptyTransferError(byteLength: number, url: string): TransferError {
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* keep the raw string */
  }
  const what =
    byteLength === 0
      ? `${host} hat mit "in Ordnung" geantwortet und dann nichts geschickt (0 Bytes).`
      : `Von ${host} kamen nur ${byteLength} Bytes — das ist keine abspielbare Datei.`
  return new TransferError(
    'empty',
    `${what} Bei YouTube heisst das fast immer, dass YouTube den Abruf abgelehnt hat. ` +
      'Manchmal hilft eine andere Qualität oder ein zweiter Versuch in ein paar Minuten. ' +
      'Bleibt es dabei, ist der Dienst YouTube gegenüber veraltet: cobalt auf den neuesten ' +
      'Stand bringen, oder unter „Optionen“ den Weg über yt-dlp nehmen — yt-dlp wird fast ' +
      'täglich nachgeführt (vorher „yt-dlp -U“).',
  )
}

/** Pulls `{ error: { code } }` out of a refusal, if that is what it is. */
async function explainErrorBody(response: Response): Promise<string | null> {
  if (!response.headers.get('content-type')?.includes('json')) return null
  try {
    const body = (await response.json()) as { error?: { code?: string; detail?: string } }
    return body.error?.code ? explain(body.error.code, body.error.detail) : null
  } catch {
    return null
  }
}

/**
 * How often a transfer tells the page how far it is. A local service delivers
 * a chunk every few hundred microseconds; reporting each one re-rendered the
 * page thousands of times a second, and that — not the network — was what
 * made the window stutter while a download ran.
 */
const PROGRESS_EVERY_MS = 100

/** Largest declared length reserved up front (1.5 GB). */
const MAX_PREALLOCATE = 1_500_000_000

/** Reads a response body, reporting progress as the bytes arrive. */
async function readWithProgress(
  response: Response,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const header = response.headers.get('content-length')
  const totalBytes = header ? Number(header) : null
  const reader = response.body?.getReader()

  if (!reader) {
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  // With a declared length the bytes go straight to their place. Collecting
  // chunks and joining them at the end held the file twice and copied all of
  // it in one blocking step — right when the download looked finished.
  // A declared size is only trusted up to what a tab can hold; beyond it the
  // bytes are collected as before and the browser says when memory runs out.
  const placeable = totalBytes !== null && Number.isSafeInteger(totalBytes) && totalBytes > 0 && totalBytes <= MAX_PREALLOCATE
  let target = placeable ? new Uint8Array(totalBytes) : null
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let windowStart = performance.now()
  let windowBytes = 0
  let bytesPerSecond = 0
  let reportedAt = 0

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new TransferError('aborted', 'Übertragung abgebrochen.')
    }
    const { done, value } = await reader.read()
    if (done) break
    if (target && receivedBytes + value.byteLength <= target.byteLength) {
      target.set(value, receivedBytes)
    } else {
      // More than was declared: keep what is placed and collect the rest.
      if (target) {
        chunks.push(target.subarray(0, receivedBytes))
        target = null
      }
      chunks.push(value)
    }
    receivedBytes += value.byteLength
    windowBytes += value.byteLength

    const now = performance.now()
    if (now - windowStart > 400) {
      bytesPerSecond = (windowBytes * 1000) / (now - windowStart)
      windowStart = now
      windowBytes = 0
    }

    if (now - reportedAt >= PROGRESS_EVERY_MS) {
      reportedAt = now
      onProgress?.({
        receivedBytes,
        totalBytes,
        fraction: totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
        bytesPerSecond,
      })
    }
  }

  onProgress?.({
    receivedBytes,
    totalBytes,
    fraction: totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
    bytesPerSecond,
  })

  if (target) return receivedBytes === target.byteLength ? target : target.subarray(0, receivedBytes)
  const result = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Fetches a URL into memory with progress reporting. */
export async function fetchMedia(
  url: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string | null; filename: string }> {
  let response: Response
  try {
    response = await fetchLocalAware(url, { signal, redirect: 'follow', credentials: 'omit' })
  } catch (error) {
    throw describeFetchFailure(error, url)
  }

  if (!response.ok) {
    // A service that refuses a tunnel usually says why, in the same error
    // shape it uses everywhere else. Reporting "502" instead of that sentence
    // throws away the one part of the answer the reader can act on.
    const explained = await explainErrorBody(response)
    throw new TransferError('http', explained ?? `Server antwortete mit ${response.status} ${response.statusText}.`)
  }

  const bytes = await readWithProgress(response, onProgress, signal)
  if (bytes.byteLength < MIN_MEDIA_BYTES) throw emptyTransferError(bytes.byteLength, url)
  return {
    bytes,
    contentType: response.headers.get('content-type'),
    filename: filenameFromResponse(response, url),
  }
}

function filenameFromResponse(response: Response, url: string): string {
  const disposition = response.headers.get('content-disposition')
  const match = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)
  if (match) return sanitizeFilename(decodeURIComponent(match[1]))
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter(Boolean).pop()
    if (last) return sanitizeFilename(decodeURIComponent(last))
  } catch {
    /* fall through */
  }
  return 'download'
}

/* -------------------------------------------------------------------------- */
/* HLS                                                                         */
/* -------------------------------------------------------------------------- */

export interface HlsVariant {
  url: string
  bandwidth: number
  resolution: string | null
  codecs: string | null
  /** The `AUDIO` group whose rendition carries this variant's sound, if apart. */
  audioGroup: string | null
}

/** A sound track a master playlist keeps apart from the picture. */
export interface HlsRendition {
  url: string
  groupId: string
  isDefault: boolean
  language: string | null
  name: string | null
}

/** Bytes `start` through `end` (inclusive) of a segment's address. */
export interface HlsRange {
  start: number
  end: number
}

export interface HlsPlaylist {
  kind: 'master' | 'media'
  variants: HlsVariant[]
  segments: string[]
  /**
   * Per segment, the part of its address it is (`#EXT-X-BYTERANGE`), or null
   * for the whole. Packagers that write one file per quality list the same
   * address for every segment; fetched whole each time, the file came out
   * as many copies of itself.
   */
  ranges: (HlsRange | null)[]
  /** Separate audio renditions (`#EXT-X-MEDIA:TYPE=AUDIO` with a `URI`). */
  audio: HlsRendition[]
  /** Present when segments are AES-128 encrypted, which we do not decrypt. */
  encrypted: boolean
}

/** Parses an M3U8 playlist into either its variants or its segment list. */
export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const variants: HlsVariant[] = []
  const segments: string[] = []
  const audio: HlsRendition[] = []
  const ranges: (HlsRange | null)[] = []
  let encrypted = false
  let pendingVariant: Omit<HlsVariant, 'url'> | null = null
  let pendingRange: string | null = null
  // A range without an offset continues where the last one of the same
  // address ended.
  const endOf = new Map<string, number>()
  const rangeFor = (spec: string, address: string): HlsRange | null => {
    const [lengthText, offsetText] = spec.split('@')
    const length = Number(lengthText)
    if (!Number.isFinite(length) || length <= 0) return null
    const start = offsetText !== undefined && Number.isFinite(Number(offsetText)) ? Number(offsetText) : (endOf.get(address) ?? 0)
    endOf.set(address, start + length)
    return { start, end: start + length - 1 }
  }

  // A line that is not an address is skipped, not fatal: one bad line must not
  // turn into "Failed to construct 'URL'" for the whole download.
  const resolve = (reference: string): string | null => {
    try {
      return new URL(reference, baseUrl).href
    } catch {
      return null
    }
  }

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attributes = line.slice('#EXT-X-STREAM-INF:'.length)
      pendingVariant = {
        // `AVERAGE-BANDWIDTH` would match a looser pattern first.
        bandwidth: Number(attributes.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] ?? 0),
        resolution: attributes.match(/RESOLUTION=([\dx]+)/)?.[1] ?? null,
        codecs: attributes.match(/CODECS="([^"]+)"/)?.[1] ?? null,
        audioGroup: attributes.match(/AUDIO="([^"]+)"/)?.[1] ?? null,
      }
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line)) {
      const uri = line.match(/URI="([^"]+)"/)?.[1]
      const resolved = uri ? resolve(uri) : null
      if (resolved) {
        audio.push({
          url: resolved,
          groupId: line.match(/GROUP-ID="([^"]+)"/)?.[1] ?? '',
          isDefault: /DEFAULT=YES/.test(line),
          language: line.match(/LANGUAGE="([^"]+)"/)?.[1] ?? null,
          name: line.match(/NAME="([^"]+)"/)?.[1] ?? null,
        })
      }
      continue
    }

    if (line.startsWith('#EXT-X-KEY:') && !line.includes('METHOD=NONE')) {
      encrypted = true
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      // Initialisation segment for fragmented MP4 — it has to lead the stream.
      const uri = line.match(/URI="([^"]+)"/)?.[1]
      const resolved = uri ? resolve(uri) : null
      if (resolved) {
        const spec = line.match(/BYTERANGE="([^"]+)"/)?.[1]
        segments.push(resolved)
        ranges.push(spec ? rangeFor(spec, resolved) : null)
      }
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice('#EXT-X-BYTERANGE:'.length).trim()
      continue
    }

    if (line.startsWith('#')) continue

    const resolved = resolve(line)
    if (!resolved) continue
    if (pendingVariant) {
      variants.push({ ...pendingVariant, url: resolved })
      pendingVariant = null
    } else {
      segments.push(resolved)
      ranges.push(pendingRange ? rangeFor(pendingRange, resolved) : null)
      pendingRange = null
    }
  }

  return {
    kind: variants.length > 0 ? 'master' : 'media',
    variants: variants.sort((a, b) => b.bandwidth - a.bandwidth),
    segments,
    ranges,
    audio,
    encrypted,
  }
}

/**
 * The sound that belongs to a variant when it is not in the variant itself:
 * the default rendition of its `AUDIO` group, else the group's first.
 */
export function audioFor(playlist: HlsPlaylist, variant: HlsVariant): HlsRendition | null {
  if (!variant.audioGroup) return null
  const group = playlist.audio.filter((rendition) => rendition.groupId === variant.audioGroup)
  const chosen = group.find((rendition) => rendition.isDefault) ?? group[0] ?? null
  // Some masters name the variant's own address as the rendition; fetching it
  // twice would put the same picture in as "sound".
  return chosen && chosen.url !== variant.url ? chosen : null
}

export async function fetchPlaylist(url: string, signal?: AbortSignal): Promise<HlsPlaylist> {
  let response: Response
  try {
    response = await fetchLocalAware(url, { signal, credentials: 'omit' })
  } catch (error) {
    throw describeFetchFailure(error, url)
  }
  if (!response.ok) {
    throw new TransferError('http', `Playlist nicht abrufbar (${response.status}).`)
  }
  return parseM3u8(await response.text(), response.url || url)
}

/** True when the bytes start like an M3U8 playlist (BOM and blank lines aside). */
function looksLikePlaylist(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart()
  return head.startsWith('#EXTM3U')
}

/**
 * A tunnel announced as HLS, fetched whichever way it really is.
 *
 * cobalt means the flag literally: the tunnel is a playlist, the segments come
 * after. The yt-dlp bridge marks YouTube's HLS formats the same way but hands
 * over what yt-dlp has already assembled — the media itself. Read as a
 * playlist, megabytes of video became thousands of "segment addresses", and
 * the first one that did not parse ended the download with "Failed to
 * construct 'URL': Invalid URL". So the answer is looked at before it is
 * believed.
 */
export async function fetchHlsTunnel(
  url: string,
  onProgress?: (loaded: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetchLocalAware(url, { signal, credentials: 'omit' })
  } catch (error) {
    throw describeFetchFailure(error, url)
  }
  if (!response.ok) {
    const explained = await explainErrorBody(response)
    throw new TransferError('http', explained ?? `Server antwortete mit ${response.status} ${response.statusText}.`)
  }

  const bytes = await readWithProgress(response, (p) => onProgress?.(p.receivedBytes, p.totalBytes), signal)
  if (!looksLikePlaylist(bytes)) {
    if (bytes.byteLength < MIN_MEDIA_BYTES) throw emptyTransferError(bytes.byteLength, url)
    return bytes
  }

  let playlist = parseM3u8(new TextDecoder().decode(bytes), response.url || url)
  // A master playlist has no segments of its own, only the qualities it
  // offers. Taken as it was, it ended in "Die Playlist enthält keine
  // Segmente"; the best quality is what a tunnel means.
  if (playlist.kind === 'master' && playlist.variants.length > 0) {
    playlist = await fetchPlaylist(playlist.variants[0].url, signal)
  }
  // Segment counts say nothing about bytes, so progress counts up without a
  // ceiling rather than inventing one.
  return fetchHlsSegments(playlist, (_done, _total, received) => onProgress?.(received, null), signal)
}

/**
 * A whole HLS stream, put together: the media playlist's segments, or — from
 * a master playlist — the best quality and, where it keeps its sound in a
 * rendition of its own, that rendition as well. The two come back apart; one
 * stream copy in FFmpeg joins them.
 *
 * An answer that is not a playlist at all is the media already assembled (the
 * yt-dlp bridge does that) and comes back as the picture.
 */
export async function fetchHlsStream(
  url: string,
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ video: Uint8Array; audio: Uint8Array | null }> {
  let response: Response
  try {
    response = await fetchLocalAware(url, { signal, credentials: 'omit' })
  } catch (error) {
    throw describeFetchFailure(error, url)
  }
  if (!response.ok) {
    const explained = await explainErrorBody(response)
    throw new TransferError('http', explained ?? `Server antwortete mit ${response.status} ${response.statusText}.`)
  }
  const bytes = await readWithProgress(response, (p) => onProgress?.(p.receivedBytes), signal)
  if (!looksLikePlaylist(bytes)) {
    if (bytes.byteLength < MIN_MEDIA_BYTES) throw emptyTransferError(bytes.byteLength, url)
    return { video: bytes, audio: null }
  }

  const top = parseM3u8(new TextDecoder().decode(bytes), response.url || url)
  let media = top
  let audioPlaylist: HlsPlaylist | null = null
  if (top.kind === 'master') {
    const variant = top.variants[0]
    media = await fetchPlaylist(variant.url, signal)
    const rendition = audioFor(top, variant)
    if (rendition) audioPlaylist = await fetchPlaylist(rendition.url, signal)
  }

  // Both halves count into one figure, so the bar does not start over.
  let videoBytes = 0
  const video = await fetchHlsSegments(
    media,
    (_done, _total, received) => {
      videoBytes = received
      onProgress?.(received)
    },
    signal,
  )
  const audio = audioPlaylist
    ? await fetchHlsSegments(audioPlaylist, (_done, _total, received) => onProgress?.(videoBytes + received), signal)
    : null
  return { video, audio }
}

/**
 * Downloads every segment of a media playlist and concatenates them.
 *
 * Segments are fetched a few at a time: serially it is needlessly slow, and all
 * at once it opens hundreds of sockets and gets throttled.
 */
/** Further tries for a segment whose connection dropped or whose host hiccuped. */
const SEGMENT_RETRIES = 2

export async function fetchHlsSegments(
  playlist: HlsPlaylist,
  onProgress?: (done: number, total: number, bytes: number) => void,
  signal?: AbortSignal,
  concurrency = 4,
): Promise<Uint8Array> {
  if (playlist.encrypted) {
    throw new TransferError(
      'http',
      'Dieser Stream ist AES-verschlüsselt. Sondra lädt keine Schlüssel und umgeht keinen Kopierschutz.',
    )
  }

  const total = playlist.segments.length
  if (total === 0) throw new TransferError('http', 'Die Playlist enthält keine Segmente.')

  const workerCount = Math.min(concurrency, total)
  const parts = new Array<Uint8Array>(total)
  const inFlight = new Array<number>(workerCount).fill(0)
  let completed = 0
  let bytes = 0
  let cursor = 0

  const reportProgress = () => {
    if (!onProgress) return
    let live = bytes
    for (let i = 0; i < workerCount; i++) live += inFlight[i]
    onProgress(completed, total, live)
  }

  const worker = async (workerId: number) => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total) return
      if (signal?.aborted) throw new TransferError('aborted', 'Übertragung abgebrochen.')

      const range = playlist.ranges?.[index] ?? null
      // Hundreds of requests make one dropped connection likely; it costs
      // that segment a second try, not the whole download.
      let chunk: Uint8Array | null = null
      let response: Response | null = null
      for (let attempt = 0; ; attempt += 1) {
        inFlight[workerId] = 0
        try {
          response = await fetchLocalAware(playlist.segments[index], {
            signal,
            credentials: 'omit',
            ...(range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {}),
          })
          if (response.ok) {
            chunk = await readWithProgress(
              response,
              (p) => {
                inFlight[workerId] = p.receivedBytes
                reportProgress()
              },
              signal,
            )
            break
          }
          if (response.status < 500 || attempt >= SEGMENT_RETRIES) {
            throw new TransferError('http', `Segment ${index + 1} fehlte (${response.status}).`)
          }
        } catch (error) {
          inFlight[workerId] = 0
          if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
            throw new TransferError('aborted', 'Übertragung abgebrochen.')
          }
          if (error instanceof TransferError || attempt >= SEGMENT_RETRIES) {
            throw error instanceof TransferError ? error : describeFetchFailure(error, playlist.segments[index])
          }
        }
        await new Promise((done) => setTimeout(done, 400 * (attempt + 1)))
      }
      inFlight[workerId] = 0
      // A host that ignores Range sends the whole file; the segment is the
      // part of it that was asked for.
      if (range && response?.status === 200 && chunk.byteLength > range.end) {
        chunk = chunk.slice(range.start, range.end + 1)
      }
      parts[index] = chunk
      completed += 1
      bytes += chunk.byteLength
      reportProgress()
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)))

  if (bytes < MIN_MEDIA_BYTES) throw emptyTransferError(bytes, playlist.segments[0])

  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hands bytes to the browser's download machinery — in the Android app, to
 * the app, which writes them into Downloads/Sondra (a WebView cannot save a
 * `blob:` address).
 */
export function saveBytes(bytes: Uint8Array | Blob, filename: string, mime = 'application/octet-stream'): void {
  // A Blob copies what it is given anyway; copying first as well cost a
  // second full file for nothing. Only memory shared with a worker has to be
  // copied out, because a Blob will not take it.
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice()], { type: mime })
  if (ANDROID_BRIDGE) {
    // The app says where it went, or why not; nothing waits on it here.
    void ANDROID_BRIDGE.save(blob, sanitizeFilename(filename), blob.type || mime).catch(() => {})
    return
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = sanitizeFilename(filename)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Streams a URL straight to a file the user picks, so a two-gigabyte download
 * never has to fit in a tab's heap. Falls back to the in-memory path where the
 * File System Access API is missing (Firefox, Safari).
 */
export async function streamToDisk(
  url: string,
  suggestedName: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<'saved' | 'downloaded'> {
  const picker = globalThis.showSaveFilePicker
  if (typeof picker !== 'function') {
    const { bytes } = await fetchMedia(url, onProgress, signal)
    saveBytes(bytes, suggestedName)
    return 'downloaded'
  }

  const handle = await picker({ suggestedName: sanitizeFilename(suggestedName) })
  const writable = await handle.createWritable()

  try {
    let response: Response
    try {
      response = await fetchLocalAware(url, { signal, credentials: 'omit' })
    } catch (error) {
      throw describeFetchFailure(error, url)
    }
    if (!response.ok) throw new TransferError('http', `Server antwortete mit ${response.status}.`)

    const header = response.headers.get('content-length')
    const totalBytes = header ? Number(header) : null
    const reader = response.body?.getReader()
    if (!reader) throw new TransferError('network', 'Antwort ohne Datenstrom.')

    let receivedBytes = 0
    let windowStart = performance.now()
    let windowBytes = 0
    let bytesPerSecond = 0
    let reportedAt = 0

    for (;;) {
      if (signal?.aborted) {
        await reader.cancel()
        throw new TransferError('aborted', 'Übertragung abgebrochen.')
      }
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      receivedBytes += value.byteLength
      windowBytes += value.byteLength

      const now = performance.now()
      if (now - windowStart > 400) {
        bytesPerSecond = (windowBytes * 1000) / (now - windowStart)
        windowStart = now
        windowBytes = 0
      }
      if (now - reportedAt >= PROGRESS_EVERY_MS) {
        reportedAt = now
        onProgress?.({
          receivedBytes,
          totalBytes,
          fraction: totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
          bytesPerSecond,
        })
      }
    }

    // An empty body means the far end gave up after the headers. Closing the
    // writable here would leave a 0-byte file sitting where the user pointed.
    if (receivedBytes < MIN_MEDIA_BYTES) throw emptyTransferError(receivedBytes, url)

    await writable.close()
    return 'saved'
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

export const PORTAL_HOSTS =
  /(?:^|\.)(?:youtube\.com|youtu\.be|soundcloud\.com|vimeo\.com|tiktok\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|fb\.watch|reddit\.com|twitch\.tv|bilibili\.com|dailymotion\.com|streamable\.com|tumblr\.com|pinterest\.com|pin\.it|ardmediathek\.de|ard\.de|zdf\.de|arte\.tv|srf\.ch|spotify\.com|podcasts\.apple\.com|threads\.net|snapchat\.com|patreon\.com|vk\.com|rumble\.com|odysee\.com|archive\.org|kick\.com|substack\.com|peertube\.[a-z]+|orf\.at|3sat\.de|ok\.ru|rutube\.ru|mixcloud\.com|bandcamp\.com|loom\.com|bluesky\.app|bsky\.app|aniworld\.to|s\.to|serienstream\.to|voe\.sx|filemoon\.(?:sx|to|in|nl|wf)|vidmoly\.(?:to|me|net)|doodstream\.com|dood\.(?:to|so|ws|wf)|streamtape\.com|vidoza\.net)$/i

export const ANIWORLD_HOSTS = /^(?:[a-z0-9-]+\.)*(?:aniworld\.(?:to|la)|s\.to|serienstream\.(?:to|sx))$/i

export function isAniworldUrl(value: string): boolean {
  try {
    return ANIWORLD_HOSTS.test(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

export interface LinkEpisodeInfo {
  season: number
  episode: number | null
  isEpisodicUrl: boolean
  seriesSlug: string | null
}

/**
 * Extracts season (`0` = Filme/Specials, `1+` = Staffel) and episode (`null` = ganze Staffel / alle, `1+` = Folge)
 * from AniWorld, SerienStream, YouTube playlists, or generic episodic URLs.
 */
export function parseLinkEpisodeInfo(rawUrl: string): LinkEpisodeInfo {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { season: 1, episode: 1, isEpisodicUrl: false, seriesSlug: null }
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    const path = parsed.pathname

    if (ANIWORLD_HOSTS.test(parsed.hostname)) {
      const slugMatch = path.match(/\/(?:anime|serie)\/stream\/([^/?#]+)/i)
      const seriesSlug = slugMatch ? slugMatch[1] : null
      const isFilme = /\/filme(?:\/|$)/i.test(path)
      const staffelMatch = path.match(/\/staffel-(\d+)/i)
      const episodeMatch = path.match(/\/(?:episode|film)-(\d+)/i)
      const season = isFilme ? 0 : staffelMatch ? Math.max(1, Number(staffelMatch[1])) : 1
      const episode = episodeMatch ? Math.max(1, Number(episodeMatch[1])) : null
      return { season, episode, isEpisodicUrl: true, seriesSlug }
    }

    // YouTube playlist index or generic query params (?season=1&episode=2 or &index=3)
    const qSeason = parsed.searchParams.get('season') || parsed.searchParams.get('staffel')
    const qEpisode = parsed.searchParams.get('episode') || parsed.searchParams.get('folge') || parsed.searchParams.get('index')
    if (qSeason || qEpisode || parsed.searchParams.has('list')) {
      const season = qSeason && Number.isFinite(Number(qSeason)) ? Math.max(0, Number(qSeason)) : 1
      const episode = qEpisode && Number.isFinite(Number(qEpisode)) ? Math.max(1, Number(qEpisode)) : null
      return { season, episode, isEpisodicUrl: true, seriesSlug: null }
    }

    // Generic path patterns: /staffel-1/episode-2, /season-1/episode-2, /s01e02, /episode-5, /folge-5
    const sxeMatch = path.match(/\/s(\d{1,2})e(\d{1,3})(?:\/|$|-|\.)/i)
    if (sxeMatch) {
      return {
        season: Math.max(0, Number(sxeMatch[1])),
        episode: Math.max(1, Number(sxeMatch[2])),
        isEpisodicUrl: true,
        seriesSlug: null,
      }
    }

    const genericSeasonMatch = path.match(/\/(?:staffel|season)[-_]?(\d+)/i)
    const genericEpMatch = path.match(/\/(?:episode|folge|ep|film)[-_]?(\d+)/i)
    if (genericSeasonMatch || genericEpMatch) {
      return {
        season: genericSeasonMatch ? Math.max(0, Number(genericSeasonMatch[1])) : 1,
        episode: genericEpMatch ? Math.max(1, Number(genericEpMatch[1])) : null,
        isEpisodicUrl: true,
        seriesSlug: null,
      }
    }

    return { season: 1, episode: 1, isEpisodicUrl: false, seriesSlug: null }
  } catch {
    return { season: 1, episode: 1, isEpisodicUrl: false, seriesSlug: null }
  }
}

/**
 * Rewrites a URL when the user changes Staffel (`season`: `0` = Filme, `1+` = Staffel)
 * or Episode (`episode`: `null` = ganze Staffel/Liste, `1+` = Folge).
 */
export function buildUrlWithEpisode(rawUrl: string, season: number, episode: number | null): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return rawUrl
  try {
    const hasProtocol = /^https?:\/\//i.test(trimmed)
    const parsed = new URL(hasProtocol ? trimmed : `https://${trimmed}`)
    const cleanSeason = Math.max(0, Math.floor(Number.isFinite(season) ? season : 1))
    const cleanEpisode = episode !== null && Number.isFinite(episode) && episode >= 1 ? Math.floor(episode) : null

    if (ANIWORLD_HOSTS.test(parsed.hostname)) {
      const baseMatch = parsed.pathname.match(/^(\/(?:anime|serie)\/stream\/[^/?#]+)/i)
      if (baseMatch) {
        const basePath = baseMatch[1].replace(/\/$/, '')
        if (cleanSeason === 0) {
          parsed.pathname = cleanEpisode ? `${basePath}/filme/film-${cleanEpisode}` : `${basePath}/filme`
        } else {
          parsed.pathname = cleanEpisode
            ? `${basePath}/staffel-${cleanSeason}/episode-${cleanEpisode}`
            : `${basePath}/staffel-${cleanSeason}`
        }
        return parsed.toString()
      }
    }

    // Generic /s01e02 pattern in pathname
    if (/\/s\d{1,2}e\d{1,3}(?=\/|$|-|\.)/i.test(parsed.pathname)) {
      const sPad = String(Math.max(1, cleanSeason)).padStart(2, '0')
      const ePad = String(cleanEpisode ?? 1).padStart(2, '0')
      parsed.pathname = parsed.pathname.replace(/\/s\d{1,2}e\d{1,3}(?=\/|$|-|\.)/i, `/s${sPad}e${ePad}`)
      return parsed.toString()
    }

    // Generic /staffel-X or /season-X and /episode-Y or /folge-Y in pathname
    let pathUpdated = false
    let nextPath = parsed.pathname
    if (/\/(staffel|season)([-_]?)\d+/i.test(nextPath)) {
      nextPath = nextPath.replace(/\/(staffel|season)([-_]?)\d+/i, (_m, word, sep) => `/${word}${sep}${Math.max(1, cleanSeason)}`)
      pathUpdated = true
    }
    if (/\/(episode|folge|ep|film)([-_]?)\d+/i.test(nextPath)) {
      if (cleanEpisode !== null) {
        nextPath = nextPath.replace(/\/(episode|folge|ep|film)([-_]?)\d+/i, (_m, word, sep) => `/${word}${sep}${cleanEpisode}`)
      } else {
        nextPath = nextPath.replace(/\/(episode|folge|ep|film)[-_]?\d+\/?$/i, '')
      }
      pathUpdated = true
    } else if (pathUpdated && cleanEpisode !== null) {
      nextPath = `${nextPath.replace(/\/$/, '')}/episode-${cleanEpisode}`
    }
    if (pathUpdated) {
      parsed.pathname = nextPath
      return parsed.toString()
    }

    // YouTube playlist or URL with query parameters
    if (parsed.searchParams.has('list') || parsed.searchParams.has('index')) {
      if (cleanEpisode !== null) {
        parsed.searchParams.set('index', String(cleanEpisode))
      } else {
        parsed.searchParams.delete('index')
      }
      return parsed.toString()
    }

    if (parsed.searchParams.has('season') || parsed.searchParams.has('staffel') || parsed.searchParams.has('episode') || parsed.searchParams.has('folge')) {
      if (parsed.searchParams.has('staffel')) parsed.searchParams.set('staffel', String(cleanSeason))
      else if (parsed.searchParams.has('season')) parsed.searchParams.set('season', String(cleanSeason))
      if (cleanEpisode !== null) {
        if (parsed.searchParams.has('folge')) parsed.searchParams.set('folge', String(cleanEpisode))
        else parsed.searchParams.set('episode', String(cleanEpisode))
      } else {
        parsed.searchParams.delete('episode')
        parsed.searchParams.delete('folge')
      }
      return parsed.toString()
    }

    return rawUrl
  } catch {
    return rawUrl
  }
}

/** Derives a human-readable default title from a URL for saved links. */
export function deriveLinkTitle(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return 'Gespeicherter Link'
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    const host = parsed.hostname.replace(/^www\./i, '')
    if (ANIWORLD_HOSTS.test(host)) {
      const slugMatch = parsed.pathname.match(/\/(?:anime|serie)\/stream\/([^/?#]+)/i)
      if (slugMatch) {
        return decodeURIComponent(slugMatch[1])
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
      }
    }
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .filter((s) => !/^(?:watch|stream|anime|serie|video|embed|v|staffel-\d+|episode-\d+|filme|film-\d+)$/i.test(s))
    const last = segments[segments.length - 1]
    if (last && last.length > 2) {
      const cleaned = decodeURIComponent(last)
        .replace(/\.[a-z0-9]{2,4}$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim()
      if (cleaned) return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
    }
    const vParam = parsed.searchParams.get('v')
    if (vParam) return `${host} (${vParam})`
    return host
  } catch {
    return trimmed.slice(0, 48)
  }
}

/** Returns a short portal/source badge label for a URL. */
export function sourceBadgeForUrl(rawUrl: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`).hostname
      .replace(/^www\./i, '')
      .toLowerCase()
    if (/aniworld/.test(host)) return 'AniWorld'
    if (/s\.to|serienstream/.test(host)) return 'SerienStream'
    if (/youtube\.com|youtu\.be/.test(host)) return 'YouTube'
    if (/twitch\.tv/.test(host)) return 'Twitch'
    if (/tiktok\.com/.test(host)) return 'TikTok'
    if (/instagram\.com/.test(host)) return 'Instagram'
    if (/soundcloud\.com/.test(host)) return 'SoundCloud'
    if (/spotify\.com/.test(host)) return 'Spotify'
    if (/ardmediathek|ard\.de|zdf\.de|arte\.tv|srf\.ch|orf\.at|3sat\.de/.test(host)) return 'Mediathek'
    if (/vimeo\.com/.test(host)) return 'Vimeo'
    return host
  } catch {
    return 'Link'
  }
}

export function isPortalUrl(value: string): boolean {
  try {
    return PORTAL_HOSTS.test(new URL(value.trim()).hostname)
  } catch {
    return false
  }
}

export function isSupportedUrl(value: string): boolean {
  try {
    const trimmed = value.trim()
    if (!/^https?:\/\//i.test(trimmed)) return false
    const parsed = new URL(trimmed)
    if (parsed.hostname !== 'localhost' && !parsed.hostname.includes('.')) return false
    if (isPortalUrl(trimmed)) return true
    if (
      /\.(mp4|m4v|webm|mkv|mov|avi|wmv|flv|mp3|wav|m4a|flac|ogg|opus|aac|m3u8|mpd|ts|m3u|rss|xml)$/i.test(
        parsed.pathname,
      )
    ) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Closing brackets a pasted address keeps only when it also opened them. */
function trimUnbalanced(address: string, open: string, close: string): string {
  let value = address
  while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1)
  return value
}

/**
 * Every address in a piece of text, the way people paste them.
 *
 * One per line, but just as often „a, b“, „a,b“, „a; b“, in quotes, in angle
 * brackets, at the end of a sentence with its full stop. Splitting on line
 * breaks alone left „https://…/a.mp4,“ with its comma as the first address
 * and „a,b“ as one, and the field's own hint says a comma separates them.
 * Commas inside an address stay; only a comma or semicolon before the next
 * `http` separates. Duplicates count once.
 */
export function extractAddresses(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
    for (const piece of match[0].split(/[,;|]+(?=https?:\/\/)/i)) {
      let candidate = piece.replace(/[,;.:!?»“”„‘’'"]+$/u, '')
      candidate = trimUnbalanced(trimUnbalanced(trimUnbalanced(candidate, '(', ')'), '[', ']'), '{', '}')
      candidate = candidate.replace(/[,;.:!?]+$/, '')
      try {
        const parsed = new URL(candidate)
        if (!parsed.hostname) continue
      } catch {
        continue
      }
      if (!found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * True when a text file is an HLS playlist rather than a list of links.
 *
 * Both start with `#EXTM3U`. A music playlist lists tracks to fetch; an HLS
 * playlist lists the hundreds of segments of one stream, and taken as links it
 * became hundreds of entries none of which is a file of its own.
 */
export function isHlsPlaylistText(text: string): boolean {
  return /^﻿?\s*#EXTM3U/.test(text) && /#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(text)
}
