/**
 * Files from one device to another over a data channel: the protocol, apart
 * from WebRTC so `scripts/verify-devices.mts` can run it under Node.
 *
 * In order: `start` (what comes), `ready` (the other side has a place for
 * it), then per file `file`, its bytes in 64 KB pieces, `end`; then `done`,
 * and the receiver answers `saved` with where each file went.
 *
 * The receiver writes as it goes — to a folder, to Downloads on a phone —
 * and says every 4 MB how far it got (`ack`). The sender stays at most
 * 16 MB ahead of that. Without it a phone that writes slower than the Wi-Fi
 * delivers would hold the whole film in memory before the first byte
 * reached the disk.
 */

export interface Wire {
  send(data: string | ArrayBuffer): void
  readonly bufferedAmount: number
  /** Resolves once the channel's own buffer has room again. */
  drained(): Promise<void>
  onMessage(handler: (data: string | ArrayBuffer) => void): void
  onClose(handler: () => void): void
  close(): void
}

export interface FileInfo {
  name: string
  size: number
  mime: string
  /**
   * Where it lay in a folder that was sent, `/`-separated and with the name
   * last: „Anime/Staffel 1/Folge 1.mkv“. Absent for a single file.
   */
  path?: string
}

export interface OutgoingFile extends FileInfo {
  read(start: number, end: number): Promise<ArrayBuffer>
}

/** Where one received file goes. `close` answers where it is, in words. */
export interface Sink {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<string>
  abort(): Promise<void>
}

export type SinkFor = (file: FileInfo, index: number) => Promise<Sink>

export const CHUNK = 64 * 1024
const ACK_EVERY = 4 * 1024 * 1024
const AHEAD = 16 * 1024 * 1024
const BUFFER_HIGH = 4 * 1024 * 1024

export class TransferError extends Error {
  code: 'cancelled' | 'closed' | 'refused' | 'failed'
  constructor(code: TransferError['code'], message: string = code) {
    super(message)
    this.code = code
  }
}

type Control =
  | { t: 'start'; files: FileInfo[] }
  | { t: 'ready' }
  | { t: 'file'; i: number }
  | { t: 'end'; i: number }
  | { t: 'done' }
  | { t: 'ack'; bytes: number }
  | { t: 'saved'; places: string[] }
  | { t: 'cancel' }
  | { t: 'error'; message: string }

const say = (wire: Wire, control: Control) => wire.send(JSON.stringify(control))

function parse(data: string): Control | null {
  try {
    const value = JSON.parse(data) as Control
    return value && typeof value === 'object' && typeof value.t === 'string' ? value : null
  } catch {
    return null
  }
}

export interface Progress {
  done: number
  total: number
}

/** Sends the files; resolves with where the other side put each. */
export function sendOver(
  wire: Wire,
  files: OutgoingFile[],
  { onProgress, signal }: { onProgress?: (progress: Progress) => void; signal?: AbortSignal } = {},
): Promise<string[]> {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  return new Promise<string[]>((resolve, reject) => {
    let acked = 0
    let finished = false
    let wake: (() => void) | null = null
    let readyWait: (() => void) | null = null
    let ready = false
    const nudge = () => {
      const run = wake
      wake = null
      run?.()
    }
    const fail = (error: TransferError) => {
      if (finished) return
      finished = true
      nudge()
      readyWait?.()
      reject(error)
    }
    signal?.addEventListener('abort', () => {
      try {
        say(wire, { t: 'cancel' })
      } catch {
        // The channel may be gone already.
      }
      fail(new TransferError('cancelled'))
      wire.close()
    })
    wire.onClose(() => fail(new TransferError('closed', 'Die Verbindung brach ab.')))
    wire.onMessage((data) => {
      if (typeof data !== 'string') return
      const control = parse(data)
      if (!control) return
      if (control.t === 'ready') {
        ready = true
        readyWait?.()
      } else if (control.t === 'ack') {
        acked = Math.max(acked, control.bytes)
        onProgress?.({ done: acked, total })
        nudge()
      } else if (control.t === 'saved') {
        if (finished) return
        finished = true
        onProgress?.({ done: total, total })
        resolve(control.places)
      } else if (control.t === 'cancel') {
        fail(new TransferError('refused', 'Auf dem anderen Gerät abgebrochen.'))
      } else if (control.t === 'error') {
        fail(new TransferError('failed', control.message))
      }
    })

    void (async () => {
      say(wire, { t: 'start', files: files.map(({ name, size, mime, path }) => ({ name, size, mime, ...(path ? { path } : {}) })) })
      if (!ready) await new Promise<void>((done) => (readyWait = done))
      let sent = 0
      for (let i = 0; i < files.length && !finished; i += 1) {
        const file = files[i]
        say(wire, { t: 'file', i })
        for (let at = 0; at < file.size && !finished; at += CHUNK) {
          const piece = await file.read(at, Math.min(at + CHUNK, file.size))
          while (!finished && wire.bufferedAmount > BUFFER_HIGH) await wire.drained()
          while (!finished && sent - acked > AHEAD) await new Promise<void>((done) => (wake = done))
          if (finished) return
          wire.send(piece)
          sent += piece.byteLength
        }
        if (!finished) say(wire, { t: 'end', i })
      }
      if (!finished) say(wire, { t: 'done' })
    })().catch((error: unknown) => {
      try {
        say(wire, { t: 'error', message: 'Datei nicht lesbar' })
      } catch {
        // Ignore
      }
      fail(new TransferError('failed', error instanceof Error ? error.message : String(error)))
    })
  })
}

/**
 * Takes files as they come. `onStart` hears what is coming before the first
 * byte; resolves with where each went.
 */
export function receiveOver(
  wire: Wire,
  sinkFor: SinkFor,
  { onStart, onProgress, signal }: { onStart?: (files: FileInfo[]) => void; onProgress?: (progress: Progress) => void; signal?: AbortSignal } = {},
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let files: FileInfo[] = []
    let total = 0
    let written = 0
    let lastAck = 0
    let sink: Sink | null = null
    const places: string[] = []
    let finished = false
    // Everything in the order it came: a write never overtakes the `end` before it.
    let chain: Promise<void> = Promise.resolve()

    const fail = (error: TransferError) => {
      if (finished) return
      finished = true
      const open = sink
      sink = null
      void open?.abort().catch(() => undefined)
      reject(error)
    }
    signal?.addEventListener('abort', () => {
      try {
        say(wire, { t: 'cancel' })
      } catch {
        // Ignore
      }
      fail(new TransferError('cancelled'))
      wire.close()
    })
    wire.onClose(() => fail(new TransferError('closed', 'Die Verbindung brach ab.')))

    const step = (work: () => Promise<void>) => {
      chain = chain.then(async () => {
        if (finished) return
        try {
          await work()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          try {
            say(wire, { t: 'error', message: `Nicht gespeichert: ${message}` })
          } catch {
            // Ignore
          }
          fail(new TransferError('failed', message))
        }
      })
    }

    wire.onMessage((data) => {
      if (finished) return
      if (typeof data !== 'string') {
        const bytes = new Uint8Array(data)
        step(async () => {
          if (!sink) throw new Error('Daten ohne Datei')
          await sink.write(bytes)
          written += bytes.byteLength
          onProgress?.({ done: written, total })
          if (written - lastAck >= ACK_EVERY) {
            lastAck = written
            say(wire, { t: 'ack', bytes: written })
          }
        })
        return
      }
      const control = parse(data)
      if (!control) return
      if (control.t === 'start') {
        files = control.files
        total = files.reduce((sum, file) => sum + file.size, 0)
        onStart?.(files)
        say(wire, { t: 'ready' })
      } else if (control.t === 'file') {
        const index = control.i
        step(async () => {
          const info = files[index]
          if (!info) throw new Error('Unbekannte Datei')
          sink = await sinkFor(info, index)
        })
      } else if (control.t === 'end') {
        const index = control.i
        step(async () => {
          if (!sink) throw new Error('Datei ohne Anfang')
          places[index] = await sink.close()
          sink = null
        })
      } else if (control.t === 'done') {
        step(async () => {
          say(wire, { t: 'ack', bytes: written })
          say(wire, { t: 'saved', places })
          finished = true
          onProgress?.({ done: total, total })
          resolve(places)
        })
      } else if (control.t === 'cancel') {
        fail(new TransferError('refused', 'Auf dem anderen Gerät abgebrochen.'))
      } else if (control.t === 'error') {
        fail(new TransferError('failed', control.message))
      }
    })
  })
}

/** A file as read by the sender, from a File or Blob. */
export function outgoing(file: Blob & { name?: string }, name = file.name ?? 'Datei', path?: string): OutgoingFile {
  return {
    name,
    ...(path ? { path } : {}),
    size: file.size,
    mime: file.type || 'application/octet-stream',
    read: (start, end) => file.slice(start, end).arrayBuffer(),
  }
}

/** „Film (2).mp4“ when „Film.mp4“ is taken. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/** A file name as every system takes it: no slashes, no reserved characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180)
  return cleaned || 'Datei'
}

/** Most folders levels a received folder keeps. */
const PATH_DEPTH = 8

/**
 * A path as it came from the other device, made safe to build on disk: each
 * part cleaned like a file name, nothing that climbs out (`..`) or stands for
 * where it is (`.`), no absolute start, at most eight levels. `dir` is the
 * folder part (`/`-separated, may be empty), `name` the file.
 */
export function splitPath(path: string | undefined, fallback: string): { dir: string; name: string } {
  const parts = String(path ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map(safeFileName)
    .slice(0, PATH_DEPTH + 1)
  if (parts.length === 0) return { dir: '', name: safeFileName(fallback) }
  const name = parts.pop() as string
  return { dir: parts.join('/'), name }
}
