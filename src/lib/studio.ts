/**
 * The one part of Sondra that is not local.
 *
 * Everything else here happens in the tab: files are read with the File API,
 * decoded by the browser, and processed by FFmpeg compiled to WebAssembly.
 * Nothing is uploaded, ever. Fetching a video from an address is the one thing
 * a browser is not allowed to do — a foreign server does not send the CORS
 * header that would permit it, and YouTube in particular does not send
 * anything at all — so that single step goes through a small service that
 * belongs to this site.
 *
 * What the service sees: the address you paste, and the fact that bytes were
 * fetched. What it keeps: nothing. What it never receives: any file of yours.
 *
 * The panel says all of this in plain German before anything is sent, because
 * a tool that claims to be local and quietly makes a network call is worse
 * than one that never claimed it.
 *
 * ## Three routes, in order
 *
 * A configured provider first — it reaches full resolution and the portals
 * nothing here has an extractor for. Then YouTube asked directly, which on a
 * server yields only the progressive stream (picture and sound together, as a
 * rule 360p). Then any address that already points straight at a media file.
 * The answer names which one it was, because "360p" and "1080p" are not a
 * detail and neither is which company saw the address.
 *
 * ## Why in chunks
 *
 * The service runs as a serverless function with a time limit of a minute or
 * so. A long video would never finish inside one call, so it is fetched a few
 * megabytes at a time, each chunk a separate short request with its own Range
 * header, and reassembled here. That also makes progress exact and cancelling
 * instant.
 */

import { fetchHlsTunnel, fetchMedia } from './download'
import { loadFfmpeg, runFfmpeg } from './ffmpegClient'
import { sanitizeFilename, withExtension } from './format'
import {
  DEFAULT_SERVICE,
  localJobArgs,
  localJobExtension,
  resolveMedia,
  type LocalJob,
  type ServiceItem,
  type ServiceSettings,
} from './service'
import { serviceConnection } from './serviceState'

export interface StudioStream {
  id: string
  label: string
  hasVideo: boolean
  hasAudio: boolean
  width: number | null
  height: number | null
  ext: string
  mime: string
  /** Total size when the source declares it, otherwise null. */
  bytes: number | null
  /** Signed, short-lived permission for the proxy to fetch this one address. */
  token: string
  /**
   * An address the browser may fetch itself, when one answered directly.
   *
   * A connected service hands back a tunnel of its own with the CORS header
   * that allows it, so that one needs no proxy and no token. Exactly one of
   * the two is ever set.
   */
  directUrl?: string | null
  /**
   * Parts that still have to be put together here.
   *
   * A service that keeps picture and sound apart — which is everything above
   * 360p on YouTube — hands over the pieces and expects the client to combine
   * them. FFmpeg is already in this tab, so that happens here and the service
   * never sees the finished file.
   */
  job?: LocalJob | null
}

export interface StudioResult {
  /** Which of the three routes answered — the panel says so out loud. */
  source?: 'provider' | 'youtube' | 'direct' | 'service'
  kind: 'youtube' | 'direct' | 'provider'
  title: string
  author: string | null
  durationSeconds: number | null
  thumbnail: string | null
  streams: StudioStream[]
}

export class StudioError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StudioError'
    this.code = code
  }
}

/** Four megabytes: big enough that the per-request overhead disappears, small
 *  enough that a chunk always finishes well inside the function's time limit. */
const CHUNK = 4 * 1024 * 1024

/**
 * Puts a `local-processing` job together and hands back the finished bytes.
 *
 * Lifted out of the options section so the one address field can finish such a
 * job too. Before this it could not, and that was the whole of the complaint:
 * with a bridge connected, „Nachsehen" asked it, got parts back instead of a
 * file, quietly fell through to this site's own endpoint and answered 360p —
 * or nothing. The better answer was one button further down, and nothing on
 * screen said so.
 */
export async function finishLocalJob(
  job: LocalJob,
  options: {
    onProgress?: (progress: StreamProgress) => void
    onNote?: (note: string) => void
    signal?: AbortSignal
  } = {},
): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
  const { onProgress, onNote, signal } = options
  const inputs: Record<string, Uint8Array> = {}
  const names: string[] = []
  // The core comes down while the parts do, not after them: its 30 MB were
  // otherwise a wait of their own at the very end.
  void loadFfmpeg().catch(() => undefined)

  for (const [index, tunnel] of job.tunnels.entries()) {
    onNote?.(`Teil ${index + 1} von ${job.tunnels.length} wird geholt`)
    let bytes: Uint8Array
    if (job.isHls) {
      // Usually a playlist whose segments follow; from the yt-dlp bridge, the
      // assembled media itself. `fetchHlsTunnel` tells the two apart.
      bytes = await fetchHlsTunnel(tunnel, (loaded, total) => onProgress?.({ loaded, total }), signal)
    } else {
      bytes = (
        await fetchMedia(
          tunnel,
          (p) => onProgress?.({ loaded: p.receivedBytes, total: p.totalBytes }),
          signal,
        )
      ).bytes
    }
    const name = `part${index}`
    inputs[name] = bytes
    names.push(name)
  }

  onNote?.('Wird lokal zusammengefügt')
  await loadFfmpeg()

  const extension = localJobExtension(job)
  const outputName = `out.${extension}`
  const { files } = await runFfmpeg({
    input: inputs,
    output: [outputName],
    args: localJobArgs(job, names, outputName),
    signal,
    // The parts were fetched for this merge only.
    consumeInput: true,
  })
  const bytes = files[outputName]

  // FFmpeg writes a container header before it knows the streams are unusable,
  // so a failed merge leaves a file of a few bytes behind. Offering that for
  // saving is worse than saying plainly that nothing came through.
  if (!bytes || bytes.byteLength < 1024) {
    throw new StudioError(
      'merge',
      `Das Zusammenfügen ergab nur ${bytes?.byteLength ?? 0} Bytes — die Teile vom Dienst waren ` +
        'unbrauchbar. Meist hilft eine andere Qualität oder ein erneuter Versuch in ein paar Minuten.',
    )
  }

  return {
    bytes,
    name: sanitizeFilename(withExtension(job.filename, extension)),
    mime: job.mimeType,
  }
}

/** A service answer, in the shape the panel already knows how to show. */
function fromServiceItems(items: ServiceItem[], fallbackTitle: string): StudioResult {
  return {
    kind: 'provider',
    source: 'service',
    title: items.length === 1 ? items[0].filename || fallbackTitle : fallbackTitle,
    author: null,
    durationSeconds: null,
    thumbnail: null,
    streams: items.map((item, index) => ({
      id: `dienst-${index}`,
      label: item.filename || `Datei ${index + 1}`,
      hasVideo: item.kind === 'video' || item.kind === 'gif',
      hasAudio: item.kind === 'video' || item.kind === 'audio',
      width: null,
      height: null,
      ext: item.filename.includes('.')
        ? (item.filename.split('.').pop() ?? 'bin').toLowerCase()
        : 'bin',
      mime: 'application/octet-stream',
      bytes: null,
      token: '',
      directUrl: item.url,
    })),
  }
}

/**
 * One address in, whatever can be had out.
 *
 * The two halves of this panel used to be strangers: the field at the top
 * asked this site's own endpoint, and the visitor's own connected service was
 * only reachable from the section underneath, with its own field and its own
 * button. Someone who had wired up a service still had to know which of the
 * two boxes to paste into.
 *
 * So the routes are tried here instead of being chosen by hand: the connected
 * service first, because somebody who set one up meant it to be used and it
 * reaches furthest, then this site's endpoint, which cascades on its own
 * (provider, then YouTube, then a plain file address).
 *
 * An address that leads to several things — a post with four images, a video
 * and its audio — comes back as several streams rather than a decision the
 * panel has to make on the visitor's behalf. Showing them is what the panel
 * already did for YouTube's formats, so it costs nothing here.
 */
/**
 * The choices made in the service settings — mode, quality, audio format.
 *
 * The address field is now the only way to load through a connected service,
 * so it has to honour them; the separate button that used to was the only
 * thing that did.
 */
function storedServiceChoices(): Partial<ServiceSettings> {
  try {
    const raw = localStorage.getItem('sondra:service') ?? localStorage.getItem('lizge:service')
    if (!raw) return {}
    const { downloadMode, videoQuality, audioFormat } = JSON.parse(raw) as Partial<ServiceSettings>
    return {
      ...(downloadMode ? { downloadMode } : {}),
      ...(videoQuality ? { videoQuality } : {}),
      ...(audioFormat ? { audioFormat } : {}),
    }
  } catch {
    return {}
  }
}

export async function resolveViaService(url: string, signal?: AbortSignal): Promise<StudioResult> {
  const connected = serviceConnection()
  if (connected.endpoint) {
    try {
      const outcome = await resolveMedia(
        url,
        { ...DEFAULT_SERVICE, ...storedServiceChoices(), endpoint: connected.endpoint },
        connected.apiKey,
        signal,
      )
      if (outcome.kind === 'file') return fromServiceItems([outcome.item], url)
      if (outcome.kind === 'picker') return fromServiceItems(outcome.items, 'Mehrere Dateien')
      if (outcome.kind === 'local') {
        const job = outcome.job
        const ext = localJobExtension(job)
        return {
          kind: 'provider',
          source: 'service',
          title: job.filename,
          author: null,
          durationSeconds: null,
          thumbnail: null,
          streams: [
            {
              id: 'dienst-lokal',
              label: 'Volle Auflösung — wird hier zusammengefügt',
              hasVideo: job.type !== 'audio',
              hasAudio: job.type !== 'mute',
              width: null,
              height: null,
              ext,
              mime: job.mimeType,
              bytes: null,
              token: '',
              job,
            },
          ],
        }
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
      // A service that cannot answer is not the end of the road: this site's
      // own endpoint may still know the address.
    }
  }

  let response: Response
  try {
    response = await fetch('/api/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new StudioError(
      'offline',
      'Der Dienst war nicht erreichbar. Läuft die Seite gerade lokal aus dem Dateisystem, gibt es ' +
        'ihn nicht — dann hilft nur der Weg über das eigene Gerät.',
    )
  }

  const data = (await response.json().catch(() => null)) as
    | (StudioResult & { error?: string; message?: string })
    | null
  if (!response.ok || !data) {
    throw new StudioError(
      data?.error ?? String(response.status),
      data?.message ?? `Der Dienst antwortete mit ${response.status}.`,
    )
  }
  return data
}

export interface StreamProgress {
  /** Bytes fetched so far. */
  loaded: number
  /** Total, once it is known. */
  total: number | null
}

/**
 * Fetches one stream through the proxy and hands back the bytes.
 *
 * The first request doubles as the question "how big is this": the
 * `Content-Range` header on a partial response carries the total, which is how
 * the progress bar gets a denominator even when the resolver could not say.
 */
export async function downloadStream(
  stream: StudioStream,
  options: { onProgress?: (progress: StreamProgress) => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const { onProgress, signal } = options

  // A service tunnel is fetched straight from the browser: it sent the header
  // that permits it, and routing it through this site's proxy would add a hop
  // that serves nobody.
  if (stream.job) {
    const done = await finishLocalJob(stream.job, { onProgress, signal })
    return done.bytes
  }

  if (stream.directUrl) {
    const media = await fetchMedia(
      stream.directUrl,
      // The two halves of the app count progress with different words; this is
      // the whole of the translation between them.
      (p) => onProgress?.({ loaded: p.receivedBytes, total: p.totalBytes }),
      signal,
    )
    return media.bytes
  }

  const parts: Uint8Array[] = []
  let loaded = 0
  let total = stream.bytes

  for (let offset = 0; total === null || offset < total; offset += CHUNK) {
    const end = offset + CHUNK - 1
    const response = await fetch(`/api/stream?t=${encodeURIComponent(stream.token)}`, {
      headers: { range: `bytes=${offset}-${end}` },
      signal,
    })

    if (response.status === 403) {
      throw new StudioError('expired', 'Der Link ist abgelaufen. Bitte die Adresse noch einmal suchen.')
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null
      throw new StudioError('upstream', detail?.message ?? `Der Dienst antwortete mit ${response.status}.`)
    }

    const buffer = new Uint8Array(await response.arrayBuffer())
    parts.push(buffer)
    loaded += buffer.byteLength
    onProgress?.({ loaded, total })

    const range = response.headers.get('content-range')
    if (total === null && range) {
      const declared = Number(range.split('/')[1])
      if (Number.isFinite(declared) && declared > 0) total = declared
    }

    // A server that ignored the Range header sent the whole thing in one go,
    // and a short chunk means the end. Either way there is nothing left to ask
    // for, and looping again would fetch the same bytes forever.
    if (response.status !== 206 || buffer.byteLength < CHUNK) break
  }

  const whole = new Uint8Array(loaded)
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.byteLength
  }
  return whole
}

/** A filename that survives every filesystem, from a video title. */
export function filenameFor(result: StudioResult, stream: StudioStream): string {
  const stem =
    result.title
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'download'
  return stem.toLowerCase().endsWith(`.${stream.ext}`) ? stem : `${stem}.${stream.ext}`
}
