/**
 * Google Drive's REST API, as far as Sondra uses it: one folder tree under
 * „Sondra", files put into it, listed and read back.
 *
 * Kept apart from the sign-in and from the page (`googleDrive.ts`), so
 * `scripts/verify-drive.mts` can run it under Node against a stand-in for
 * Drive. It knows nothing of tokens but where to ask for one.
 *
 * With the `drive.file` scope Sondra sees only what it put there itself: a
 * folder called „Sondra" that the user made by hand is not found, and a
 * second one appears beside it. That is the price of not asking to read the
 * whole Drive.
 */

export type DriveErrorCode =
  | 'not-configured'
  | 'unauthorized'
  | 'expired'
  | 'popup-blocked'
  | 'denied'
  | 'cancelled'
  | 'timeout'
  | 'scope'
  | 'quota'
  | 'offline'
  | 'missing'
  | 'app-outdated'
  | 'failed'

export class DriveError extends Error {
  code: DriveErrorCode
  detail: string
  constructor(code: DriveErrorCode, detail = '') {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** Where things go. Names as Drive shows them; the keys are Sondra's own. */
export type DriveFolder = 'root' | 'projects' | 'files' | 'audio' | 'video' | 'images' | 'other' | 'downloads' | 'merkliste'

export const DRIVE_TREE: Record<DriveFolder, { name: string; parent: DriveFolder | null }> = {
  root: { name: 'Sondra', parent: null },
  projects: { name: 'Projekte', parent: 'root' },
  files: { name: 'Dateien', parent: 'root' },
  audio: { name: 'Ton', parent: 'files' },
  video: { name: 'Video', parent: 'files' },
  images: { name: 'Bilder', parent: 'files' },
  other: { name: 'Andere', parent: 'files' },
  downloads: { name: 'Heruntergeladen', parent: 'root' },
  merkliste: { name: 'Merkliste', parent: 'root' },
}

/** The folder's path as Drive shows it, „Sondra/Dateien/Ton". */
export function folderPath(key: DriveFolder): string {
  const { name, parent } = DRIVE_TREE[key]
  return parent ? `${folderPath(parent)}/${name}` : name
}

export const GOOGLE_API = {
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
}

const FOLDER_TYPE = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,size,modifiedTime,mimeType'
/** Up to this, one request; above it, a resumable upload in pieces. */
const SIMPLE_LIMIT = 5 * 1024 * 1024
/** A piece of a resumable upload; Drive wants a multiple of 256 KiB. */
export const DEFAULT_CHUNK = 8 * 1024 * 1024

export interface DriveFile {
  id: string
  name: string
  size: number | null
  modifiedTime: string | null
  mimeType: string | null
  /** The folder it is in, where Drive said (the tree asks for it). */
  parents?: string[]
  /** Sondra's own notes on the file, private to it: which episode it was filed as. */
  appProperties?: Record<string, string>
}

export interface PutOptions {
  mime?: string
  /**
   * `replace`: a file of the same name becomes a new version of it (Drive
   * keeps the earlier ones). `skip-same`: one of the same name and size is
   * taken to be this one already, and nothing is sent; another size becomes
   * a new version.
   */
  mode: 'replace' | 'skip-same'
  onProgress?: (loaded: number, total: number) => void
  signal?: AbortSignal
}

export interface PutResult {
  file: DriveFile
  skipped: boolean
  replaced: boolean
}

export interface DriveClientOptions {
  /** An access token; `refused` after Drive turned the last one away. */
  token: (refused: boolean) => Promise<string>
  fetch?: typeof fetch
  endpoints?: typeof GOOGLE_API
  chunk?: number
  /** Folder ids from an earlier visit; checked once before they are used. */
  folders?: { read: () => Partial<Record<DriveFolder, string>>; write: (ids: Partial<Record<DriveFolder, string>>) => void }
  wait?: (ms: number) => Promise<void>
}

/** A string in a Drive query, quoted. */
export function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function asFile(raw: Record<string, unknown>): DriveFile {
  const size = raw.size === undefined || raw.size === null ? null : Number(raw.size)
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    size: Number.isFinite(size) ? size : null,
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : null,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : null,
    ...(Array.isArray(raw.parents) ? { parents: raw.parents.map(String) } : {}),
    ...(raw.appProperties && typeof raw.appProperties === 'object' ? { appProperties: raw.appProperties as Record<string, string> } : {}),
  }
}

/** Drive's reason for a refusal: `storageQuotaExceeded`, `rateLimitExceeded` … */
async function reasonOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } }
    const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? ''
    return `${reason} ${body.error?.message ?? ''}`.trim()
  } catch {
    return text.slice(0, 200)
  }
}

function refusal(status: number, reason: string): DriveError {
  if (status === 401) return new DriveError('expired', reason)
  if (/storageQuotaExceeded|quotaExceeded/.test(reason)) return new DriveError('quota', reason)
  if (/insufficientPermissions|insufficientScopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/.test(reason)) return new DriveError('scope', reason)
  if (status === 404) return new DriveError('missing', reason)
  return new DriveError('failed', `${status} ${reason}`.trim())
}

const retryable = (status: number, reason: string) =>
  status === 429 || status >= 500 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(reason))

const backoff = (attempt: number) => Math.min(16_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250)

/** The first byte Drive does not have yet, from a 308's `Range: bytes=0-n`. */
function nextByte(response: Response): number | null {
  const range = response.headers.get('Range')
  const match = range ? /bytes=0-(\d+)/.exec(range) : null
  return match ? Number(match[1]) + 1 : null
}

const aborted = (signal?: AbortSignal) => signal?.aborted === true

export function createDriveClient({
  token,
  fetch: send = (input, init) => fetch(input, init),
  endpoints = GOOGLE_API,
  chunk = DEFAULT_CHUNK,
  folders,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: DriveClientOptions) {
  /** One request with a token; once more with a new one when Drive refuses it. */
  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let refused = false
    for (let attempt = 0; ; attempt += 1) {
      const bearer = await token(refused)
      let response: Response
      try {
        response = await send(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer}` } })
      } catch (error) {
        if (aborted(init.signal ?? undefined)) throw error
        if (attempt < 3) {
          await wait(backoff(attempt))
          continue
        }
        throw new DriveError('offline', String((error as Error)?.message ?? error))
      }
      if (response.ok || response.status === 308) return response
      if (response.status === 401 && !refused) {
        refused = true
        continue
      }
      const reason = await reasonOf(response)
      if (retryable(response.status, reason) && attempt < 4) {
        await wait(backoff(attempt))
        continue
      }
      throw refusal(response.status, reason)
    }
  }

  async function json<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
    return (await (await call(url, init)).json()) as T
  }

  const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

  /** Folders found or made this visit; earlier ids are checked once first. */
  const known = new Map<DriveFolder, string>()
  const running = new Map<DriveFolder, Promise<string>>()

  async function folder(key: DriveFolder): Promise<string> {
    const ready = known.get(key)
    if (ready) return ready
    const pending = running.get(key)
    if (pending) return pending
    const job = (async () => {
      const { name, parent } = DRIVE_TREE[key]
      const parentId = parent ? await folder(parent) : 'root'
      // From an earlier visit: still there and not in the bin?
      const cached = folders?.read()[key]
      if (cached) {
        try {
          const meta = await json<{ trashed?: boolean; mimeType?: string }>(`${endpoints.api}/files/${encodeURIComponent(cached)}?fields=id,trashed,mimeType`)
          if (!meta.trashed && meta.mimeType === FOLDER_TYPE) return cached
        } catch (error) {
          if (!(error instanceof DriveError) || error.code !== 'missing') throw error
        }
      }
      const found = await json<{ files?: Record<string, unknown>[] }>(
        `${endpoints.api}/files?${query({
          q: `name = ${quote(name)} and mimeType = '${FOLDER_TYPE}' and ${quote(parentId)} in parents and trashed = false`,
          fields: 'files(id,name)',
          spaces: 'drive',
          pageSize: '10',
        })}`,
      )
      let id = found.files?.[0]?.id ? String(found.files[0].id) : null
      if (!id) {
        const made = await json<{ id: string }>(`${endpoints.api}/files?fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parentId] }),
        })
        id = made.id
      }
      return id
    })()
    running.set(key, job)
    try {
      const id = await job
      known.set(key, id)
      if (folders) folders.write({ ...folders.read(), [key]: id })
      return id
    } finally {
      running.delete(key)
    }
  }

  /** The newest file of this name in the folder, if there is one. */
  async function find(parentId: string, name: string): Promise<DriveFile | null> {
    const found = await json<{ files?: Record<string, unknown>[] }>(
      `${endpoints.api}/files?${query({
        q: `name = ${quote(name)} and ${quote(parentId)} in parents and mimeType != '${FOLDER_TYPE}' and trashed = false`,
        fields: `files(${FILE_FIELDS})`,
        orderBy: 'modifiedTime desc',
        spaces: 'drive',
        pageSize: '10',
      })}`,
    )
    return found.files?.[0] ? asFile(found.files[0]) : null
  }

  /** Up to five megabytes: metadata and content in one request. */
  async function simple(parentId: string, name: string, data: Blob, mime: string, existing: DriveFile | null, signal?: AbortSignal) {
    if (existing) {
      return asFile(
        await json(`${endpoints.upload}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=${FILE_FIELDS}`, {
          method: 'PATCH',
          headers: { 'Content-Type': mime },
          body: data,
          signal,
        }),
      )
    }
    const boundary = `sondra${Math.random().toString(36).slice(2)}`
    const meta = JSON.stringify({ name, parents: [parentId], mimeType: mime })
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ])
    return asFile(
      await json(`${endpoints.upload}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
        signal,
      }),
    )
  }

  /** Above five megabytes: a resumable upload, piece by piece, picked up again after a dropped connection. */
  async function resumable(parentId: string, name: string, data: Blob, mime: string, existing: DriveFile | null, options: PutOptions) {
    const size = data.size
    const opened = await call(
      existing
        ? `${endpoints.upload}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${FILE_FIELDS}`
        : `${endpoints.upload}/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: existing ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify(existing ? {} : { name, parents: [parentId], mimeType: mime }),
        signal: options.signal,
      },
    )
    const session = opened.headers.get('Location')
    if (!session) throw new DriveError('failed', 'Drive nannte keine Upload-Adresse')

    let offset = 0
    let tries = 0
    for (;;) {
      const end = Math.min(offset + chunk, size)
      let response: Response | null = null
      try {
        response = await send(session, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}` },
          body: data.slice(offset, end),
          signal: options.signal,
        })
      } catch (error) {
        if (aborted(options.signal)) throw error
      }
      if (response && (response.status === 200 || response.status === 201)) {
        options.onProgress?.(size, size)
        return asFile(await response.json())
      }
      if (response && response.status === 308) {
        // Drive says how far it got; a browser that does not show the header
        // means it took the whole piece.
        offset = nextByte(response) ?? end
        tries = 0
        options.onProgress?.(offset, size)
        continue
      }
      if (response && (response.status === 404 || response.status === 410)) {
        throw new DriveError('failed', 'Die Upload-Sitzung ist abgelaufen')
      }
      if (response) {
        const reason = await reasonOf(response)
        if (!retryable(response.status, reason)) throw refusal(response.status, reason)
      }
      // Dropped or a server hiccup: ask where it stands, then go on from there.
      tries += 1
      if (tries > 4) throw new DriveError('offline', 'Upload abgebrochen')
      await wait(backoff(tries))
      const status = await send(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, signal: options.signal }).catch(
        () => null,
      )
      if (status && (status.status === 200 || status.status === 201)) {
        options.onProgress?.(size, size)
        return asFile(await status.json())
      }
      if (status && status.status === 308) {
        offset = nextByte(status) ?? 0
        options.onProgress?.(offset, size)
      }
    }
  }

  return {
    folder,

    /** Puts a file into one of Sondra's folders. */
    async put(key: DriveFolder, name: string, data: Blob, options: PutOptions): Promise<PutResult> {
      const parentId = await folder(key)
      const existing = await find(parentId, name)
      if (existing && options.mode === 'skip-same' && existing.size === data.size) {
        options.onProgress?.(data.size, data.size)
        return { file: existing, skipped: true, replaced: false }
      }
      const mime = options.mime || data.type || 'application/octet-stream'
      options.onProgress?.(0, data.size)
      const file =
        data.size <= SIMPLE_LIMIT
          ? await simple(parentId, name, data, mime, existing, options.signal)
          : await resumable(parentId, name, data, mime, existing, options)
      options.onProgress?.(data.size, data.size)
      return { file, skipped: false, replaced: Boolean(existing) }
    },

    /** The files in one of Sondra's folders, newest first. */
    async list(key: DriveFolder): Promise<DriveFile[]> {
      const parentId = await folder(key)
      const found = await json<{ files?: Record<string, unknown>[] }>(
        `${endpoints.api}/files?${query({
          q: `${quote(parentId)} in parents and mimeType != '${FOLDER_TYPE}' and trashed = false`,
          fields: `files(${FILE_FIELDS})`,
          orderBy: 'modifiedTime desc',
          spaces: 'drive',
          pageSize: '100',
        })}`,
      )
      return (found.files ?? []).map(asFile)
    },

    /**
     * Everything below „Sondra“, its subfolders walked through: each file
     * with its path inside, „Heruntergeladen/Frieren S01E01.mp4“. Only what
     * Sondra put there — `drive.file` shows nothing else.
     */
    async tree({ limit = 20_000, signal, onProgress }: { limit?: number; signal?: AbortSignal; onProgress?: (files: number) => void } = {}) {
      const files: (DriveFile & { path: string })[] = []
      const dirs: string[] = ['']
      let truncated = false
      const queue: { id: string; path: string }[] = [{ id: await folder('root'), path: '' }]
      while (queue.length > 0) {
        const { id, path } = queue.shift()!
        let pageToken = ''
        do {
          if (aborted(signal)) throw new DOMException('Abgebrochen', 'AbortError')
          const page = await json<{ files?: Record<string, unknown>[]; nextPageToken?: string }>(
            `${endpoints.api}/files?${query({
              q: `${quote(id)} in parents and trashed = false`,
              fields: `nextPageToken,files(${FILE_FIELDS},parents,appProperties)`,
              spaces: 'drive',
              pageSize: '1000',
              ...(pageToken ? { pageToken } : {}),
            })}`,
            { signal },
          )
          for (const raw of page.files ?? []) {
            const entry = asFile(raw)
            const inside = path ? `${path}/${entry.name}` : entry.name
            if (entry.mimeType === FOLDER_TYPE) {
              dirs.push(inside)
              queue.push({ id: entry.id, path: inside })
            } else if (files.length >= limit) {
              truncated = true
            } else {
              files.push({ ...entry, path: inside })
            }
          }
          onProgress?.(files.length)
          pageToken = page.nextPageToken ?? ''
        } while (pageToken && !truncated)
      }
      return { files, dirs: dirs.sort(), truncated }
    },

    /**
     * A folder by its path below „Sondra“, made where it is missing:
     * [„Serien“, „Frieren“, „Staffel 1“]. One that is there is used, also
     * when another device made it.
     */
    async folderAt(path: string[]): Promise<string> {
      let parentId = await folder('root')
      for (const name of path) {
        const found = await json<{ files?: Record<string, unknown>[] }>(
          `${endpoints.api}/files?${query({
            q: `name = ${quote(name)} and mimeType = '${FOLDER_TYPE}' and ${quote(parentId)} in parents and trashed = false`,
            fields: 'files(id,name)',
            spaces: 'drive',
            pageSize: '10',
          })}`,
        )
        parentId = found.files?.[0]?.id
          ? String(found.files[0].id)
          : (
              await json<{ id: string }>(`${endpoints.api}/files?fields=id`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parentId] }),
              })
            ).id
      }
      return parentId
    },

    /** Moves a file into another folder, with Sondra's notes on it. */
    async move(id: string, { to, from, appProperties }: { to: string; from?: string; appProperties?: Record<string, string> }): Promise<DriveFile> {
      const params: Record<string, string> = { addParents: to, fields: `${FILE_FIELDS},parents,appProperties` }
      if (from && from !== to) params.removeParents = from
      return asFile(
        await json(`${endpoints.api}/files/${encodeURIComponent(id)}?${query(params)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: JSON.stringify(appProperties ? { appProperties } : {}),
        }),
      )
    },

    /** One file of this name in the folder, if there is one. */
    async find(key: DriveFolder, name: string): Promise<DriveFile | null> {
      return find(await folder(key), name)
    },

    async read(id: string, signal?: AbortSignal, onProgress?: (loaded: number) => void): Promise<Uint8Array> {
      const response = await call(`${endpoints.api}/files/${encodeURIComponent(id)}?alt=media`, { signal })
      if (!onProgress || !response.body) return new Uint8Array(await response.arrayBuffer())
      // Piece by piece, so a long film can say how far it got.
      const reader = response.body.getReader()
      const parts: Uint8Array[] = []
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        loaded += value.byteLength
        onProgress(loaded)
      }
      const whole = new Uint8Array(loaded)
      let at = 0
      for (const part of parts) {
        whole.set(part, at)
        at += part.byteLength
      }
      return whole
    },

    async account(): Promise<{ name: string; email: string }> {
      const about = await json<{ user?: { displayName?: string; emailAddress?: string } }>(
        `${endpoints.api}/about?fields=${encodeURIComponent('user(displayName,emailAddress)')}`,
      )
      return { name: about.user?.displayName ?? '', email: about.user?.emailAddress ?? '' }
    },
  }
}

export type DriveClient = ReturnType<typeof createDriveClient>
