/**
 * Google Drive, from the page: the sign-in, the queue of what goes there,
 * and the four things that do — projects, the session's files, downloads,
 * the Merkliste — each into its own folder under „Sondra".
 *
 * Nothing goes to Drive on its own until the user connected it, and nothing
 * but what they asked for: a project or a file on a click, downloads and the
 * Merkliste only with their switch on. It is the one place where Sondra
 * sends a user's files anywhere, and the dialog says so in so many words.
 *
 * Two ways to sign in, one way to upload:
 *
 * - On the website, Google's sign-in opens in a popup and comes back to
 *   `google-drive.html` on this origin, which hands the access token over a
 *   BroadcastChannel. Not through `window.opener`: the page is
 *   cross-origin isolated (COOP same-origin), and the trip through Google
 *   cuts the popup off from it. The token lives in memory for its hour and
 *   is never stored; after that, or after a reload, the next upload asks
 *   for one click to sign in again.
 * - In the app, the main process signs in through the system's browser and
 *   keeps the refresh token (desktop/googleDrive.mjs); the page asks it for
 *   an access token when it needs one.
 *
 * Either way the page itself sends the files to Drive (`driveClient.ts`), so
 * a large film goes there in pieces straight from the file it was picked
 * from.
 */

import { create } from 'zustand'

import { APP_BRIDGE } from './desktop'
import { createDriveClient, DriveError, folderPath, type DriveErrorCode, type DriveFile, type DriveFolder } from './driveClient'
import { exportMerkliste, importMerkliste, merkItems, onMerkliste, readMerklisteFile, type MerkImport, type SavedLinkItem } from './merkliste'
import { buildProjectFile, loadProjectBytes } from './project'
import { useSession, type Asset, type AssetKind } from '../state/store'

export { DriveError, folderPath, type DriveErrorCode, type DriveFile, type DriveFolder }

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
/** The website's OAuth client („Webanwendung"); without it Drive is not offered there. */
const WEB_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
/** The channel `public/google-drive.html` answers on. */
const CHANNEL = 'sondra-google-drive'
const SETTINGS_KEY = 'sondra:drive'
export const MERKLISTE_FILE = 'Sondra-Merkliste.json'
/** The Merkliste goes to Drive this long after its last change. */
const MERKLISTE_DELAY = 8000

const IN_APP = Boolean(APP_BRIDGE?.drive)
/** In the app, whose main process signs in; elsewhere the website's popup. */
export const DRIVE_IN_APP = IN_APP

export const DRIVE_PROBLEM: Record<DriveErrorCode, string> = {
  'not-configured': 'Google Drive ist in dieser Fassung von Sondra nicht eingerichtet.',
  unauthorized: 'Die Verbindung zu Google Drive besteht nicht mehr. Bitte neu verbinden.',
  expired: 'Die Anmeldung bei Google ist abgelaufen. Ein Klick auf „Anmelden“ macht weiter.',
  'popup-blocked': 'Der Browser hat das Anmeldefenster von Google blockiert. Erlauben Sie Pop-ups für diese Seite und versuchen Sie es noch einmal.',
  denied: 'Google hat den Zugriff nicht erlaubt — die Anmeldung wurde abgelehnt.',
  cancelled: 'Anmeldung abgebrochen.',
  timeout: 'Von Google kam keine Antwort. Wurde das Anmeldefenster geschlossen? Versuchen Sie es noch einmal.',
  scope: 'Bei der Anmeldung fehlte das Häkchen für Google Drive. Bitte neu verbinden und den Zugriff auf Drive erlauben.',
  quota: 'Ihr Google-Speicher ist voll. In Drive Platz schaffen, dann erneut versuchen.',
  offline: 'Google Drive ist gerade nicht erreichbar. Besteht eine Internetverbindung?',
  missing: 'Die Datei gibt es in Google Drive nicht mehr.',
  failed: 'Google Drive hat abgelehnt.',
}

export type DriveJobKind = 'project' | 'file' | 'download' | 'merkliste'

export interface DriveJob {
  id: string
  kind: DriveJobKind
  name: string
  folder: DriveFolder
  status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'
  loaded: number
  total: number
  /** The session file it came from, so the list can mark it. */
  assetId?: string
  error?: DriveErrorCode
  detail?: string
  at: number
}

export interface DriveSettings {
  /** Every finished download goes to „Heruntergeladen“ as well. */
  autoDownloads: boolean
  /** The Merkliste goes to „Merkliste“ after every change. */
  merkliste: boolean
  /** Connected before (the website keeps no token, only the fact). */
  linked: boolean
  email: string
  name: string
  merklisteHash: string
  merklisteAt: number
  /** Folder ids per account, checked once a visit before they are used. */
  folders: Record<string, Partial<Record<DriveFolder, string>>>
}

const DEFAULT_SETTINGS: DriveSettings = {
  autoDownloads: true,
  merkliste: true,
  linked: false,
  email: '',
  name: '',
  merklisteHash: '',
  merklisteAt: 0,
  folders: {},
}

function readSettings(): DriveSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DriveSettings>) } : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export interface DriveState {
  /** There is a Google client to sign in with (website: the build has one; app: the app has one). */
  configured: boolean
  /** The app answered whether it is; on the website at once. */
  ready: boolean
  /** Uploads can go now: a token on the website, a stored sign-in in the app. */
  connected: boolean
  /** A sign-in is open in a popup or the browser. */
  signingIn: boolean
  /** The app could keep the sign-in encrypted (else it is gone after a restart). */
  lasting: boolean
  account: { name: string; email: string } | null
  jobs: DriveJob[]
  settings: DriveSettings
  problem: { code: DriveErrorCode; detail?: string } | null
}

export const useDrive = create<DriveState>(() => ({
  configured: !IN_APP && Boolean(WEB_CLIENT_ID),
  ready: !IN_APP,
  connected: false,
  signingIn: false,
  lasting: true,
  account: null,
  jobs: [],
  settings: readSettings(),
  problem: null,
}))

const set = (patch: Partial<DriveState> | ((state: DriveState) => Partial<DriveState>)) => useDrive.setState(patch)
const state = () => useDrive.getState()

function saveSettings(patch: Partial<DriveSettings>) {
  const settings = { ...state().settings, ...patch }
  set({ settings })
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Full or blocked: the switches hold for this visit.
  }
}

const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => useSession.getState().log('drive', message, level)

/** Linked: connected before, so uploads may queue up for the next sign-in. */
export function driveLinked(current: DriveState = state()): boolean {
  return current.configured && (IN_APP ? current.connected : current.settings.linked || current.connected)
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

type Answer<T> = ({ ok: true } & T) | { ok: false; error: string; detail?: string }

function ask<T>(action: string, ...args: unknown[]): Promise<Answer<T>> {
  const send = APP_BRIDGE?.drive
  if (!send) return Promise.resolve({ ok: false, error: 'not-configured' })
  return send(action, ...args).then(
    (answer) => answer as Answer<T>,
    () => ({ ok: false, error: 'failed' }) as const,
  )
}

const KNOWN_CODES = new Set<string>(Object.keys(DRIVE_PROBLEM))
const asCode = (error: string): DriveErrorCode => (KNOWN_CODES.has(error) ? (error as DriveErrorCode) : 'failed')

/** The website's token: in memory, for its hour. */
let webToken: { token: string; expiresAt: number } | null = null
const webTokenUsable = () => webToken !== null && webToken.expiresAt - 60_000 > Date.now()
let expiryTimer: ReturnType<typeof setTimeout> | null = null

/** Keeps the website's token, and says „not connected“ when its hour is up — not first when an upload fails. */
function holdWebToken(token: string, seconds: number) {
  webToken = { token, expiresAt: Date.now() + seconds * 1000 }
  if (expiryTimer) clearTimeout(expiryTimer)
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    if (!webTokenUsable()) set({ connected: false })
  }, Math.max(0, seconds * 1000 - 60_000))
}

async function accessToken(refused: boolean): Promise<string> {
  if (IN_APP) {
    const answer = await ask<{ token: string; expiresAt: number }>('token', refused)
    if (answer.ok) return answer.token
    if (answer.error === 'unauthorized') set({ connected: false })
    throw new DriveError(asCode(answer.error), answer.detail)
  }
  if (!refused && webTokenUsable()) return webToken!.token
  webToken = null
  set({ connected: false })
  throw new DriveError('expired')
}

function makeClient() {
  return createDriveClient({
    token: accessToken,
    folders: {
      read: () => {
        const email = state().settings.email
        return email ? (state().settings.folders[email] ?? {}) : {}
      },
      write: (ids) => {
        const email = state().settings.email
        if (email) saveSettings({ folders: { ...state().settings.folders, [email]: ids } })
      },
    },
  })
}

/** Made anew for every account: it remembers which folders it found. */
let client = makeClient()

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                    */
/* -------------------------------------------------------------------------- */

let cancelWeb: (() => void) | null = null

/**
 * The popup. Opened before anything is awaited, so the click that asked for
 * it still counts and the browser lets it through.
 */
function signInWeb(): Promise<void> {
  if (!WEB_CLIENT_ID) return Promise.reject(new DriveError('not-configured'))
  const stateId = crypto.getRandomValues(new Uint32Array(4)).join('-')
  const url = new URL(AUTH_URL)
  const hint = state().settings.email
  url.search = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    redirect_uri: new URL('google-drive.html', document.baseURI).toString(),
    response_type: 'token',
    scope: DRIVE_SCOPE,
    state: stateId,
    include_granted_scopes: 'true',
    ...(hint ? { login_hint: hint } : { prompt: 'select_account' }),
  }).toString()
  const channel = new BroadcastChannel(CHANNEL)
  const popup = window.open(url.toString(), 'sondra-google', 'popup,width=520,height=680')
  if (!popup) {
    channel.close()
    return Promise.reject(new DriveError('popup-blocked'))
  }
  return new Promise((resolve, reject) => {
    const done = (error: DriveError | null) => {
      window.clearTimeout(timer)
      channel.close()
      cancelWeb = null
      if (error) reject(error)
      else resolve()
    }
    const timer = window.setTimeout(() => done(new DriveError('timeout')), 5 * 60_000)
    cancelWeb = () => done(new DriveError('cancelled'))
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { state?: string; access_token?: string; expires_in?: string; scope?: string; error?: string } | null
      if (!data || data.state !== stateId) return
      if (data.error) return done(new DriveError(data.error === 'access_denied' ? 'denied' : 'failed', data.error))
      if (!data.access_token) return done(new DriveError('failed', 'kein Token'))
      if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(DRIVE_SCOPE)) return done(new DriveError('scope'))
      holdWebToken(data.access_token, Number(data.expires_in) || 3600)
      done(null)
    }
  })
}

async function signInApp(): Promise<void> {
  const answer = await ask<{ lasting: boolean }>('connect')
  if (!answer.ok) throw new DriveError(asCode(answer.error), answer.detail)
  set({ lasting: answer.lasting })
}

/**
 * Connects, or signs in again on the website. Called from a click: the
 * popup has to open within it.
 */
export function connectDrive(): Promise<boolean> {
  if (!state().configured) return Promise.resolve(false)
  set({ signingIn: true, problem: null })
  const signedIn = IN_APP ? signInApp() : signInWeb()
  return signedIn.then(
    async () => {
      const before = state().settings.email
      const account = await client.account().catch(() => null)
      if (account?.email && account.email !== before) client = makeClient()
      saveSettings({ linked: true, email: account?.email || before, name: account?.name ?? state().settings.name })
      set({ connected: true, signingIn: false, account: account ?? state().account })
      log(`Mit Google Drive verbunden${account?.email ? ` (${account.email})` : ''}`)
      void pump()
      // The list's first backup once the switch is on.
      if (state().settings.merkliste) backupMerkliste(false)
      return true
    },
    (error: unknown) => {
      const code = error instanceof DriveError ? error.code : 'failed'
      const detail = error instanceof DriveError ? error.detail : String(error)
      set({ signingIn: false, problem: code === 'cancelled' ? null : { code, detail } })
      return false
    },
  )
}

export function cancelDriveSignIn() {
  if (IN_APP) void ask('cancel')
  else cancelWeb?.()
}

export async function disconnectDrive(): Promise<void> {
  if (IN_APP) await ask('disconnect')
  else if (webToken) {
    // Withdrawn at Google as well; the answer cannot be read across origins,
    // and does not need to be.
    void fetch(`${REVOKE_URL}?${new URLSearchParams({ token: webToken.token })}`, { method: 'POST', mode: 'no-cors' }).catch(() => {})
  }
  webToken = null
  // An upload still running belongs to the account just left: it ends there.
  connection += 1
  client = makeClient()
  for (const job of state().jobs) if (job.status === 'waiting') payloads.delete(job.id)
  set((current) => ({
    connected: false,
    account: null,
    problem: null,
    jobs: current.jobs.filter((job) => job.status !== 'waiting'),
  }))
  saveSettings({ linked: false, email: '', name: '', folders: {}, merklisteHash: '' })
  log('Google Drive getrennt')
}

/** Once at start: in the app, whether it is set up and signed in. */
let started = false
export function initDrive(): void {
  if (started) return
  started = true
  onMerkliste(() => scheduleMerkliste())
  if (!IN_APP) return
  void ask<{ configured: boolean; connected: boolean; lasting: boolean }>('status').then(async (answer) => {
    if (!answer.ok) {
      set({ ready: true, configured: false })
      return
    }
    set({ ready: true, configured: answer.configured, connected: answer.connected, lasting: answer.lasting })
    if (!answer.connected) return
    const account = await client.account().catch(() => null)
    if (account) {
      if (account.email !== state().settings.email) saveSettings({ email: account.email, name: account.name })
      set({ account })
    }
    void pump()
  })
}

/* -------------------------------------------------------------------------- */
/* The queue                                                                  */
/* -------------------------------------------------------------------------- */

interface Payload {
  data: () => Blob | Promise<Blob>
  mode: 'replace' | 'skip-same'
  mime?: string
  onDone?: (file: DriveFile) => void
}

const payloads = new Map<string, Payload>()
/** Counts disconnects; a job started before the last one does not wait for the next account. */
let connection = 0
let pumping = false
let jobCounter = 0
/** Finished jobs kept in the list. */
const KEEP_FINISHED = 20

const canRun = () => (IN_APP ? state().connected : webTokenUsable())

function patchJob(id: string, patch: Partial<DriveJob>) {
  set((current) => ({ jobs: current.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)) }))
}

function enqueue(job: Pick<DriveJob, 'kind' | 'name' | 'folder' | 'assetId'> & { total: number }, payload: Payload): string {
  const id = `drive-${Date.now()}-${(jobCounter += 1)}`
  set((current) => {
    // A newer Merkliste replaces one still waiting.
    let jobs = job.kind === 'merkliste' ? current.jobs.filter((entry) => !(entry.kind === 'merkliste' && entry.status === 'waiting')) : current.jobs
    const finished = jobs.filter((entry) => entry.status === 'done' || entry.status === 'skipped' || entry.status === 'failed')
    if (finished.length >= KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED + 1).map((entry) => entry.id))
      jobs = jobs.filter((entry) => !drop.has(entry.id))
    }
    return { jobs: [...jobs, { ...job, id, status: 'waiting', loaded: 0, at: Date.now() }] }
  })
  payloads.set(id, payload)
  // Merkliste jobs that were replaced leave their payload behind.
  for (const key of payloads.keys()) if (!state().jobs.some((entry) => entry.id === key)) payloads.delete(key)
  void pump()
  return id
}

async function run(job: DriveJob): Promise<'go-on' | 'stop'> {
  const payload = payloads.get(job.id)
  if (!payload) {
    patchJob(job.id, { status: 'failed', error: 'failed', detail: 'Inhalt nicht mehr da' })
    return 'go-on'
  }
  patchJob(job.id, { status: 'running', loaded: 0, error: undefined, detail: undefined })
  const started = connection
  try {
    const data = await payload.data()
    const result = await client.put(job.folder, job.name, data, {
      mode: payload.mode,
      mime: payload.mime,
      onProgress: (loaded, total) => patchJob(job.id, { loaded, total }),
    })
    patchJob(job.id, { status: result.skipped ? 'skipped' : 'done', loaded: data.size, total: data.size, at: Date.now() })
    payloads.delete(job.id)
    payload.onDone?.(result.file)
    log(
      result.skipped
        ? `${job.name} liegt schon in Google Drive (${folderPath(job.folder)})`
        : `${job.name} in Google Drive gespeichert (${folderPath(job.folder)}${result.replaced ? ', neue Version' : ''})`,
    )
    return 'go-on'
  } catch (error) {
    const code = error instanceof DriveError ? error.code : 'failed'
    if (started !== connection) {
      // Disconnected meanwhile: not carried over to whoever signs in next.
      payloads.delete(job.id)
      set((current) => ({ jobs: current.jobs.filter((entry) => entry.id !== job.id) }))
      return 'stop'
    }
    if (code === 'expired' || code === 'unauthorized') {
      // Waits for the next sign-in; nothing is lost.
      patchJob(job.id, { status: 'waiting', loaded: 0 })
      return 'stop'
    }
    const detail = error instanceof DriveError ? error.detail : String((error as Error)?.message ?? error)
    patchJob(job.id, { status: 'failed', error: code, detail, at: Date.now() })
    log(`${job.name} nicht in Google Drive gespeichert: ${DRIVE_PROBLEM[code]}${detail ? ` (${detail})` : ''}`, 'warn')
    return 'go-on'
  }
}

/** One upload after the other: they share one connection, and the order is the order asked. */
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const next = state().jobs.find((job) => job.status === 'waiting')
      if (!next) break
      if (!canRun()) {
        // The website's hour ran out unnoticed: say so, so the header asks to sign in.
        if (!IN_APP && state().connected) set({ connected: false })
        break
      }
      if ((await run(next)) === 'stop') break
    }
  } finally {
    pumping = false
  }
}

/** Starts the queue, signing in first on the website when its hour is up. Called from a click. */
function go(): void {
  if (canRun()) void pump()
  else if (!IN_APP && !state().signingIn) void connectDrive()
}

export function retryDriveJob(id: string): void {
  if (!payloads.has(id)) return
  patchJob(id, { status: 'waiting', loaded: 0, error: undefined, detail: undefined })
  go()
}

export function clearDriveJobs(): void {
  set((current) => ({ jobs: current.jobs.filter((job) => job.status === 'waiting' || job.status === 'running') }))
  for (const key of payloads.keys()) if (!state().jobs.some((entry) => entry.id === key)) payloads.delete(key)
}

/** Waiting for a click to sign in on the website. */
export function driveWaitsForSignIn(current: DriveState = state()): boolean {
  return !IN_APP && !current.connected && current.jobs.some((job) => job.status === 'waiting')
}

/* -------------------------------------------------------------------------- */
/* What goes there                                                            */
/* -------------------------------------------------------------------------- */

export function folderForKind(kind: AssetKind): DriveFolder {
  if (kind === 'audio') return 'audio'
  if (kind === 'video') return 'video'
  if (kind === 'image') return 'images'
  return 'other'
}

/** The file as it was picked, when it is still the same; else its bytes. */
function assetBlob(asset: Pick<Asset, 'bytes' | 'source' | 'mime' | 'sizeBytes'>): Blob {
  if (asset.source && asset.source.size === asset.bytes.byteLength) return asset.source
  return new Blob([asset.bytes as Uint8Array<ArrayBuffer>], { type: asset.mime })
}

/** The session as a project, into „Projekte“; a project of the same name gets a new version. */
export function saveProjectToDrive(customName?: string): void {
  const { bytes, fileName } = buildProjectFile(customName)
  enqueue(
    { kind: 'project', name: fileName, folder: 'projects', total: bytes.byteLength },
    { data: () => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), mode: 'replace', mime: 'application/octet-stream' },
  )
  go()
}

/** Session files, each into the folder of its kind; one that is already there stays as it is. */
export function saveAssetsToDrive(assets: Asset[]): void {
  for (const asset of assets) {
    enqueue(
      { kind: 'file', name: asset.name, folder: folderForKind(asset.kind), total: asset.sizeBytes, assetId: asset.id },
      { data: () => assetBlob(asset), mode: 'skip-same', mime: asset.mime },
    )
  }
  go()
}

/** Files from a folder on this computer, each into the folder of its kind; read where they lie. */
export function saveFilesToDrive(files: { file: File; kind: AssetKind }[]): void {
  for (const { file, kind } of files) {
    enqueue(
      { kind: 'file', name: file.name, folder: folderForKind(kind), total: file.size },
      { data: () => file, mode: 'skip-same', mime: file.type || undefined },
    )
  }
  go()
}

/** A finished download, into „Heruntergeladen“ — only with the switch on and Drive connected before. */
export function offerDownloadToDrive(file: { name: string; bytes: Uint8Array; mime: string }): void {
  const current = state()
  if (!current.settings.autoDownloads || !driveLinked(current)) return
  enqueue(
    { kind: 'download', name: file.name, folder: 'downloads', total: file.bytes.byteLength },
    { data: () => new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }), mode: 'skip-same', mime: file.mime },
  )
}

/** A short fingerprint of the list, to send it only when it changed. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}-${text.length}`
}

/** The Merkliste as one file, „Sondra-Merkliste.json“; Drive keeps the earlier versions. */
export function backupMerkliste(force: boolean): void {
  const current = state()
  if (!driveLinked(current)) return
  const items = merkItems()
  if (items.length === 0 && !force) return
  const hash = fingerprint(JSON.stringify(items))
  if (!force && hash === current.settings.merklisteHash) return
  const text = exportMerkliste(items)
  enqueue(
    { kind: 'merkliste', name: MERKLISTE_FILE, folder: 'merkliste', total: text.length },
    {
      data: () => new Blob([text], { type: 'application/json' }),
      mode: 'replace',
      mime: 'application/json',
      onDone: () => saveSettings({ merklisteHash: hash, merklisteAt: Date.now() }),
    },
  )
  if (force) go()
}

let merklisteTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMerkliste() {
  const current = state()
  if (!current.settings.merkliste || !driveLinked(current)) return
  if (merklisteTimer) clearTimeout(merklisteTimer)
  merklisteTimer = setTimeout(() => {
    merklisteTimer = null
    backupMerkliste(false)
  }, MERKLISTE_DELAY)
}

export function setDriveSetting(patch: Partial<Pick<DriveSettings, 'autoDownloads' | 'merkliste'>>): void {
  saveSettings(patch)
  if (patch.merkliste) backupMerkliste(false)
}

/* -------------------------------------------------------------------------- */
/* What comes back                                                            */
/* -------------------------------------------------------------------------- */

/** Needs a token now; on the website a click to sign in first. */
async function ready(): Promise<void> {
  if (canRun()) return
  if (IN_APP) throw new DriveError('unauthorized')
  if (!(await connectDrive())) throw new DriveError(state().problem?.code ?? 'expired')
}

export async function listDriveProjects(): Promise<DriveFile[]> {
  await ready()
  return (await client.list('projects')).filter((file) => /\.sondra$/i.test(file.name))
}

export async function openDriveProject(file: DriveFile): Promise<number> {
  await ready()
  const bytes = await client.read(file.id)
  return loadProjectBytes(bytes, file.name).assetCount
}

/** The backup in Drive read in; joins the list like a file read in (`importMerkliste`). */
export async function readMerklisteFromDrive(): Promise<{ result: MerkImport; before: SavedLinkItem[]; saved: boolean } | null> {
  await ready()
  const file = await client.find('merkliste', MERKLISTE_FILE)
  if (!file) return null
  const text = new TextDecoder().decode(await client.read(file.id))
  return importMerkliste(readMerklisteFile(text))
}

/** The folder in Drive's own page, made if it is not there yet. */
export async function driveFolderUrl(key: DriveFolder = 'root'): Promise<string> {
  await ready()
  return `https://drive.google.com/drive/folders/${encodeURIComponent(await client.folder(key))}`
}

/* -------------------------------------------------------------------------- */
/* The dialog                                                                 */
/* -------------------------------------------------------------------------- */

export const OPEN_DRIVE_EVENT = 'sondra:google-drive'

export function openDriveDialog(): void {
  window.dispatchEvent(new Event(OPEN_DRIVE_EVENT))
}
