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
    const body = (await response.json()) as { error?: { code?: string } }
    return body.error?.code ? explain(body.error.code) : null
  } catch {
    return null
  }
}

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

  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let windowStart = performance.now()
  let windowBytes = 0
  let bytesPerSecond = 0

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new TransferError('aborted', 'Übertragung abgebrochen.')
    }
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    receivedBytes += value.byteLength
    windowBytes += value.byteLength

    const now = performance.now()
    if (now - windowStart > 400) {
      bytesPerSecond = (windowBytes * 1000) / (now - windowStart)
      windowStart = now
      windowBytes = 0
    }

    onProgress?.({
      receivedBytes,
      totalBytes,
      fraction: totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
      bytesPerSecond,
    })
  }

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
}

export interface HlsPlaylist {
  kind: 'master' | 'media'
  variants: HlsVariant[]
  segments: string[]
  /** Present when segments are AES-128 encrypted, which we do not decrypt. */
  encrypted: boolean
}

/** Parses an M3U8 playlist into either its variants or its segment list. */
export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const variants: HlsVariant[] = []
  const segments: string[] = []
  let encrypted = false
  let pendingVariant: Omit<HlsVariant, 'url'> | null = null

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
        bandwidth: Number(attributes.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0),
        resolution: attributes.match(/RESOLUTION=([\dx]+)/)?.[1] ?? null,
        codecs: attributes.match(/CODECS="([^"]+)"/)?.[1] ?? null,
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
      if (resolved) segments.push(resolved)
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
    }
  }

  return {
    kind: variants.length > 0 ? 'master' : 'media',
    variants: variants.sort((a, b) => b.bandwidth - a.bandwidth),
    segments,
    encrypted,
  }
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

  const playlist = parseM3u8(new TextDecoder().decode(bytes), response.url || url)
  // Segment counts say nothing about bytes, so progress counts up without a
  // ceiling rather than inventing one.
  return fetchHlsSegments(playlist, (_done, _total, received) => onProgress?.(received, null), signal)
}

/**
 * Downloads every segment of a media playlist and concatenates them.
 *
 * Segments are fetched a few at a time: serially it is needlessly slow, and all
 * at once it opens hundreds of sockets and gets throttled.
 */
export async function fetchHlsSegments(
  playlist: HlsPlaylist,
  onProgress?: (done: number, total: number, bytes: number) => void,
  signal?: AbortSignal,
  concurrency = 6,
): Promise<Uint8Array> {
  if (playlist.encrypted) {
    throw new TransferError(
      'http',
      'Dieser Stream ist AES-verschlüsselt. Sondra lädt keine Schlüssel und umgeht keinen Kopierschutz.',
    )
  }

  const total = playlist.segments.length
  if (total === 0) throw new TransferError('http', 'Die Playlist enthält keine Segmente.')

  const parts = new Array<Uint8Array>(total)
  let completed = 0
  let bytes = 0
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total) return
      if (signal?.aborted) throw new TransferError('aborted', 'Übertragung abgebrochen.')

      let response: Response
      try {
        response = await fetchLocalAware(playlist.segments[index], { signal, credentials: 'omit' })
      } catch (error) {
        throw describeFetchFailure(error, playlist.segments[index])
      }
      if (!response.ok) {
        throw new TransferError('http', `Segment ${index + 1} fehlte (${response.status}).`)
      }
      const chunk = new Uint8Array(await response.arrayBuffer())
      parts[index] = chunk
      completed += 1
      bytes += chunk.byteLength
      onProgress?.(completed, total, bytes)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))

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

/** Hands bytes to the browser's download machinery. */
export function saveBytes(bytes: Uint8Array, filename: string, mime = 'application/octet-stream'): void {
  const view = bytes.slice()
  const blob = new Blob([view.buffer as ArrayBuffer], { type: mime })
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
      onProgress?.({
        receivedBytes,
        totalBytes,
        fraction: totalBytes ? Math.min(1, receivedBytes / totalBytes) : null,
        bytesPerSecond,
      })
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
