/**
 * FFmpeg compiled to WebAssembly, running in the visitor's browser.
 *
 * How the pieces fit together
 * ---------------------------
 * `@ffmpeg/ffmpeg` is a thin RPC client. Calling `new FFmpeg()` gives you a
 * handle; `load()` spawns a dedicated Web Worker and hands it three URLs:
 *
 *   · coreURL   — the Emscripten JS glue for the ffmpeg core
 *   · wasmURL   — the compiled ffmpeg binary itself
 *   · workerURL — the pthread worker, multi-threaded core only
 *
 * Every `exec()` call is then forwarded to that worker, so transcoding never
 * blocks the UI thread. The worker owns an in-memory MEMFS filesystem: files are
 * written with `writeFile`, processed, and read back with `readFile`. Nothing is
 * ever sent anywhere — MEMFS lives in the tab's heap and dies with the tab.
 *
 * Why the URLs are imported rather than hard-coded
 * ------------------------------------------------
 * Most examples fetch the core from a CDN via `toBlobURL`. That would make every
 * visitor's browser announce itself to a third party on first use, which defeats
 * the point of this app. Instead both cores are dependencies, and Vite's `?url`
 * suffix emits them as ordinary hashed assets served from our own origin.
 *
 * Single-threaded vs multi-threaded core
 * --------------------------------------
 * `@ffmpeg/core-mt` is several times faster, but pthreads need SharedArrayBuffer,
 * which the browser only exposes to cross-origin-isolated documents (COOP +
 * COEP — see vite.config.ts and public/_headers). Where isolation is missing the
 * single-threaded core loads instead, and everything still works, just slower.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
// `?url` emits each file as a plain asset and hands back its hashed URL — the
// Emscripten glue and the .wasm must reach the browser untouched, not bundled.
import coreUrl from '@ffmpeg/core?url'
import coreWasmUrl from '@ffmpeg/core/wasm?url'
import coreMtUrl from '@ffmpeg/core-mt?url'
import coreMtWasmUrl from '@ffmpeg/core-mt/wasm?url'
import coreMtWorkerUrl from '@ffmpeg/core-mt/worker?url'

import { detectCapabilities, suggestedThreads } from './capabilities'

export interface FfmpegStatus {
  loaded: boolean
  multiThreaded: boolean
  threads: number
}

/**
 * How far the core has got.
 *
 * The binary is thirty-odd megabytes, which on a slow line is a long time to
 * look at nothing. Reporting real bytes rather than a spinner is the difference
 * between "it is working" and "it has hung", so the wasm is fetched here with a
 * streaming read and handed to the worker as a blob — one download, honest
 * numbers.
 */
export interface FfmpegBoot {
  state: 'idle' | 'loading' | 'ready' | 'error'
  receivedBytes: number
  /** Null when the server sent no length, which makes the bar indeterminate. */
  totalBytes: number | null
  message: string
  error: string | null
}

type BootHandler = (boot: FfmpegBoot) => void

type LogHandler = (line: string) => void
type ProgressHandler = (fraction: number) => void
type StatusHandler = (status: FfmpegStatus) => void

const logHandlers = new Set<LogHandler>()
const progressHandlers = new Set<ProgressHandler>()
const statusHandlers = new Set<StatusHandler>()
const bootHandlers = new Set<BootHandler>()

let boot: FfmpegBoot = {
  state: 'idle',
  receivedBytes: 0,
  totalBytes: null,
  message: 'Noch nicht geladen',
  error: null,
}

/** Subscribe to load progress. Fires immediately with the current state. */
export function onFfmpegBoot(handler: BootHandler): () => void {
  bootHandlers.add(handler)
  handler(boot)
  return () => {
    bootHandlers.delete(handler)
  }
}

export function ffmpegBoot(): FfmpegBoot {
  return boot
}

function setBoot(patch: Partial<FfmpegBoot>): void {
  boot = { ...boot, ...patch }
  bootHandlers.forEach((handler) => handler(boot))
}

/**
 * Fetches a URL while reporting how much has arrived, and hands back the URL
 * the core should load from.
 *
 * Where the server lets the browser keep the file (the hashed assets are
 * cached for a year, here and in the app), that is the plain URL: the worker's
 * own fetch then comes out of the cache, and the browser can keep the
 * *compiled* module too. A blob URL is never cached, so every start compiled
 * thirty megabytes of WebAssembly again. Otherwise it is a blob of the bytes
 * just read, so they do not cross the network twice.
 *
 * Falls back to the plain URL where the body cannot be streamed; the core still
 * loads, the bar just cannot say how far along it is.
 */
async function fetchWithProgress(url: string): Promise<string> {
  // Same credentials mode as the core's own fetch, so both read one cache entry.
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${url} antwortete mit ${response.status}`)

  // `content-length` counts the bytes on the wire, while the reader hands over
  // decoded ones. Where the server compressed the binary those are different
  // numbers — around three to one for this wasm — and a bar built on the wrong
  // one fills up at a third of the way and then lies. So the length is only
  // trusted when nothing was encoded, and it is dropped again if the decoded
  // stream overtakes it anyway, which catches hosts that hide the header.
  const declared = Number(response.headers.get('content-length'))
  const encoded = (response.headers.get('content-encoding') ?? '').trim() !== ''
  let totalBytes = !encoded && Number.isFinite(declared) && declared > 0 ? declared : null
  const cacheable = /max-age=[1-9]/.test(response.headers.get('cache-control') ?? '')

  const reader = response.body?.getReader()
  if (!reader) return url

  setBoot({ totalBytes, receivedBytes: 0 })

  const chunks: Uint8Array[] = []
  let received = 0
  let reportedAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!cacheable) chunks.push(value)
    received += value.byteLength
    if (totalBytes !== null && received > totalBytes) totalBytes = null
    // A few times a second is a moving bar; every chunk was hundreds of
    // renders while the page was still starting.
    const now = performance.now()
    if (now - reportedAt > 100) {
      reportedAt = now
      setBoot({ receivedBytes: received, totalBytes })
    }
  }
  setBoot({ receivedBytes: received, totalBytes })

  if (cacheable) return url
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/wasm' }))
}

export function onFfmpegLog(handler: LogHandler): () => void {
  logHandlers.add(handler)
  return () => {
    logHandlers.delete(handler)
  }
}

export function onFfmpegProgress(handler: ProgressHandler): () => void {
  progressHandlers.add(handler)
  return () => {
    progressHandlers.delete(handler)
  }
}

let instance: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null
let status: FfmpegStatus = { loaded: false, multiThreaded: false, threads: 1 }

export function ffmpegStatus(): FfmpegStatus {
  return status
}

/** Subscribe to load/unload transitions. Fires immediately with the state. */
export function onFfmpegStatus(handler: StatusHandler): () => void {
  statusHandlers.add(handler)
  handler(status)
  return () => {
    statusHandlers.delete(handler)
  }
}

function setStatus(next: FfmpegStatus): void {
  status = next
  statusHandlers.forEach((handler) => handler(next))
}

/** Absolute URL — the worker resolves these against its own script location. */
const absolute = (url: string) => new URL(url, window.location.href).href

/**
 * Loads the core, once. Concurrent callers share the same promise so two panels
 * starting at the same time do not each pull down a copy of the binary.
 */
export async function loadFfmpeg(): Promise<FFmpeg> {
  if (instance && status.loaded) return instance
  if (loading) return loading

  loading = (async () => {
    const caps = detectCapabilities()
    const multiThreaded = caps.ffmpegMultiThread
    const ffmpeg = new FFmpeg()

    setBoot({
      state: 'loading',
      receivedBytes: 0,
      totalBytes: null,
      error: null,
      message: multiThreaded ? 'FFmpeg wird geholt (mehrfädig)' : 'FFmpeg wird geholt',
    })

    ffmpeg.on('log', ({ message }) => {
      logHandlers.forEach((handler) => handler(message))
    })
    ffmpeg.on('progress', ({ progress }) => {
      // ffmpeg reports > 1 while flushing; clamp so progress bars behave.
      const fraction = Math.max(0, Math.min(1, progress))
      progressHandlers.forEach((handler) => handler(fraction))
    })

    // The binary comes down here rather than inside `load()`, so its arrival can
    // be measured. The glue and the pthread worker are small enough to leave to
    // the library.
    const wasmURL = await fetchWithProgress(absolute(multiThreaded ? coreMtWasmUrl : coreWasmUrl))
    setBoot({ message: 'FFmpeg wird gestartet' })

    await ffmpeg.load({
      // `classWorkerURL` is deliberately omitted. The library falls back to
      // `new URL('./worker.js', import.meta.url)`, which the bundler rewrites
      // into a properly bundled worker chunk. Passing a `?url` asset instead
      // would ship that file with its relative imports unresolved, and the
      // worker would die on its first import.
      coreURL: absolute(multiThreaded ? coreMtUrl : coreUrl),
      wasmURL,
      // Only the MT core spawns pthread workers of its own.
      ...(multiThreaded ? { workerURL: absolute(coreMtWorkerUrl) } : {}),
    })

    // The worker has the binary by now. Revoking on a delay rather than at once,
    // because an eager revoke has bitten this codebase before with downloads.
    if (wasmURL.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(wasmURL), 60_000)

    instance = ffmpeg
    setStatus({
      loaded: true,
      multiThreaded,
      threads: multiThreaded ? suggestedThreads(caps) : 1,
    })
    setBoot({ state: 'ready', message: 'FFmpeg bereit', error: null })
    return ffmpeg
  })()

  try {
    return await loading
  } catch (error) {
    loading = null
    instance = null
    setStatus({ ...status, loaded: false })
    setBoot({
      state: 'error',
      message: 'FFmpeg konnte nicht geladen werden',
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/** Frees the worker and its heap. Worth doing after a large job. */
export async function unloadFfmpeg(): Promise<void> {
  if (!instance) return
  try {
    await instance.terminate()
  } finally {
    instance = null
    loading = null
    setStatus({ loaded: false, multiThreaded: false, threads: 1 })
    setBoot({ state: 'idle', message: 'Noch nicht geladen', receivedBytes: 0, totalBytes: null })
  }
}

export interface RunOptions {
  /** Files to place in MEMFS before the run, keyed by in-filesystem name. */
  input: Record<string, Uint8Array>
  /** Files to read back out afterwards. */
  output: string[]
  /** The argument list, exactly as it would follow `ffmpeg` on a command line. */
  args: string[]
  signal?: AbortSignal
  /**
   * The inputs belong to this run alone and may be handed to the worker
   * as they are — detached afterwards, not copied first. For bytes that were
   * fetched only to be merged, the copy was a second full file in memory.
   */
  consumeInput?: boolean
}

export interface RunResult {
  files: Record<string, Uint8Array>
  logs: string[]
}

/**
 * One core, one job at a time.
 *
 * There is a single FFmpeg instance behind all of this, and its worker cannot
 * service two `exec` calls at once — it dies with "null function or function
 * signature mismatch", an error that names nothing useful and points at
 * whichever job was unlucky enough to be second. That is not a rare corner:
 * the session sidebar decodes the selected file's audio to draw a waveform,
 * and a panel that starts a render while that is still running overlaps it.
 *
 * So every caller queues. The chain is on the promise itself rather than a
 * boolean, which means a caller never has to poll and the order of arrival is
 * the order of execution.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  // Failures must not poison the chain for everyone behind them.
  queue = next.catch(() => undefined)
  return next
}

/**
 * Writes inputs to MEMFS, runs one ffmpeg invocation, reads the outputs back,
 * and cleans up — so a long session does not slowly fill the heap with old jobs.
 */
export function runFfmpeg(options: RunOptions): Promise<RunResult> {
  return enqueue(() => runFfmpegNow(options))
}

async function runFfmpegNow({ input, output, args, signal, consumeInput = false }: RunOptions): Promise<RunResult> {
  const ffmpeg = await loadFfmpeg()
  const logs: string[] = []
  const stopLogging = onFfmpegLog((line) => {
    logs.push(line)
    if (logs.length > 500) logs.shift()
  })

  const abort = () => {
    // Terminating is the only way to interrupt a running core; the next call
    // transparently reloads it.
    void unloadFfmpeg()
  }
  signal?.addEventListener('abort', abort, { once: true })

  const written = Object.keys(input)
  try {
    for (const [name, bytes] of Object.entries(input)) {
      // `writeFile` puts the caller's ArrayBuffer in the transfer list, which
      // detaches it — the session asset would be an empty husk afterwards and
      // could never be converted, decoded or re-used again. The copy is the
      // price of keeping the input intact.
      await ffmpeg.writeFile(name, consumeInput ? bytes : bytes.slice())
    }

    const code = await ffmpeg.exec(args)
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError')
    if (code !== 0) {
      // A non-zero exit usually means ffmpeg called exit(), and exit() takes
      // the WebAssembly runtime with it. The core looks alive afterwards and
      // fails on the next call with "null function or function signature
      // mismatch" — an error about the previous job, reported against the next
      // one. Reloading here keeps a failure local to the run that caused it.
      const tail = logs.slice(-8).join('\n')
      await unloadFfmpeg().catch(() => undefined)
      throw new Error(`FFmpeg endete mit Code ${code}.\n${tail}`)
    }

    const files: Record<string, Uint8Array> = {}
    for (const name of output) {
      const data = await ffmpeg.readFile(name)
      files[name] = typeof data === 'string' ? new TextEncoder().encode(data) : data
    }
    return { files, logs }
  } finally {
    stopLogging()
    signal?.removeEventListener('abort', abort)
    // Best-effort cleanup; a failed run may not have created every file.
    if (instance) {
      for (const name of [...written, ...output]) {
        try {
          await instance.deleteFile(name)
        } catch {
          /* file was never created */
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience wrappers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Decodes anything FFmpeg understands into a WAV the Web Audio API accepts.
 * Used as the fallback when `decodeAudioData` rejects a container.
 */
export async function decodeToWav(bytes: Uint8Array, filename: string, signal?: AbortSignal): Promise<Uint8Array> {
  const inputName = `in_${sanitize(filename)}`
  const { files } = await runFfmpeg({
    input: { [inputName]: bytes },
    output: ['out.wav'],
    args: ['-i', inputName, '-vn', '-c:a', 'pcm_f32le', '-f', 'wav', 'out.wav'],
    signal,
  })
  return files['out.wav']
}

/** MEMFS has no directories in play here, so keep names flat and safe. */
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-64)
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                     */
/* -------------------------------------------------------------------------- */

export interface MediaFacts {
  durationSeconds: number | null
  width: number | null
  height: number | null
  frameRate: number | null
  videoCodec: string | null
  audioCodec: string | null
  sampleRate: number | null
  channels: string | null
}

const EMPTY_FACTS: MediaFacts = {
  durationSeconds: null,
  width: null,
  height: null,
  frameRate: null,
  videoCodec: null,
  audioCodec: null,
  sampleRate: null,
  channels: null,
}

/**
 * What a file actually contains, according to FFmpeg.
 *
 * The browser answers this for free through a `<video>` element — but only for
 * the codecs it can play, and a Chromium build without H.264 or a Firefox
 * without system codecs will simply report a duration of zero. That silence is
 * indistinguishable from a broken file, and it leaves every control that needs
 * a length disabled with no explanation.
 *
 * So when the browser cannot answer, FFmpeg is asked. The obvious way — `-i`
 * with no output at all — is a trap in a WebAssembly build: ffmpeg treats
 * "nothing to do" as an error and calls `exit(1)`, and `exit` tears down the
 * whole runtime. The core survives the probe but every later run dies with
 * "null function or function signature mismatch", which looks like a bug
 * anywhere but here.
 *
 * Writing a tenth of a second to the null muxer instead ends with exit code 0
 * and prints the same stream information. The core is reloaded anyway if the
 * exit code is not 0, so a build without that muxer costs one reload rather
 * than a broken session.
 */
export function probeMedia(
  bytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
): Promise<MediaFacts> {
  return enqueue(() => probeMediaNow(bytes, filename, signal))
}

async function probeMediaNow(
  bytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
): Promise<MediaFacts> {
  const ffmpeg = await loadFfmpeg()
  const name = `probe_${sanitize(filename)}`
  const logs: string[] = []
  const stopLogging = onFfmpegLog((line) => logs.push(line))

  try {
    await ffmpeg.writeFile(name, bytes.slice())
    await ffmpeg
      .exec(['-hide_banner', '-i', name, '-t', '0.1', '-f', 'null', '-'])
      .catch(() => 1)
    const facts = signal?.aborted ? EMPTY_FACTS : parseProbe(logs.join('\n'))
    return facts
  } catch {
    await unloadFfmpeg().catch(() => undefined)
    return EMPTY_FACTS
  } finally {
    stopLogging()
    // Always, not only after a non-zero exit. Measured: a probe run leaves the
    // core in a state where the very next job dies with "null function or
    // function signature mismatch", even when the probe itself reported
    // success — the same argument lists run clean through a native FFmpeg, so
    // it is the runtime and not the arguments. A reload costs a few seconds in
    // the rare case a file needs probing at all; a wedged core costs the
    // session.
    await unloadFfmpeg().catch(() => undefined)
  }
}

/** Pulls the facts out of what FFmpeg printed to its log. */
export function parseProbe(text: string): MediaFacts {
  const facts: MediaFacts = { ...EMPTY_FACTS }

  const duration = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (duration) {
    facts.durationSeconds =
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  }

  const video = text.match(/Stream #\d+:\d+.*?: Video:\s*([\w\d]+)[^\n]*/)
  if (video) {
    facts.videoCodec = video[1]
    // The first WxH on the video line is the frame size. Anything later is an
    // aspect ratio or a display size, so the search stops at the first hit.
    const size = video[0].match(/(\d{2,5})x(\d{2,5})/)
    if (size) {
      facts.width = Number(size[1])
      facts.height = Number(size[2])
    }
    const fps = video[0].match(/([\d.]+)\s*fps/)
    if (fps) facts.frameRate = Number(fps[1])
  }

  const audio = text.match(/Stream #\d+:\d+.*?: Audio:\s*([\w\d]+)[^\n]*/)
  if (audio) {
    facts.audioCodec = audio[1]
    const rate = audio[0].match(/(\d{4,6})\s*Hz/)
    if (rate) facts.sampleRate = Number(rate[1])
    const layout = audio[0].match(/\b(mono|stereo|5\.1|7\.1|quad)\b/)
    if (layout) facts.channels = layout[1]
  }

  return facts
}
