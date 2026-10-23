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
 * The Merkliste is not only sent: with its switch on, the file in Drive is
 * the list every device signed in to the same account shares — read,
 * merged with this device's, written back when they differ, as with
 * Anytype, and on the website as well.
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

import { ANDROID_BRIDGE } from './android'
import { APP_BRIDGE } from './desktop'
import { createDriveClient, DriveError, folderPath, type DriveErrorCode, type DriveFile, type DriveFolder } from './driveClient'
import {
  adoptRemovals,
  merkItems,
  merkRemovals,
  mergeShared,
  onMerkliste,
  readSharedFile,
  setMerkItems,
  sharedFileText,
  sharedKey,
  type SavedLinkItem,
} from './merkliste'
import type { EpisodeHint } from './episodeMatch'
import { hintProperties, seasonPath } from './folder'
import { buildProjectFile, loadProjectBytes } from './project'
import { useSession, type Asset, type AssetKind } from '../state/store'

export { DriveError, folderPath, type DriveErrorCode, type DriveFile, type DriveFolder }

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const DEFAULT_CLIENT_ID = '736809827454-0mtp3prv4tvrrm7p7v8pfmv25brccdpe.apps.googleusercontent.com'
/** The website's OAuth client („Webanwendung"); from Vercel/build env or project default. */
const WEB_CLIENT_ID: string = (
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  import.meta.env.GOOGLE_CLIENT_ID ||
  DEFAULT_CLIENT_ID
).trim()
/** Exchanges codes and keeps the website's lasting sign-in; the client secret lives only there. */
const TOKEN_API = '/api/google-token'
/** The channel `public/google-drive.html` answers on. */
const CHANNEL = 'sondra-google-drive'
const SETTINGS_KEY = 'sondra:drive'
export const MERKLISTE_FILE = 'Sondra-Merkliste.json'
/** The Merkliste is brought in step this long after its last change. */
const MERKLISTE_DELAY = 2500

/** The app's sign-in — the Windows app's or Android's, both in the browser with PKCE, the same actions. */
const APP_DRIVE = APP_BRIDGE?.drive ?? ANDROID_BRIDGE?.drive ?? null
const IN_APP = Boolean(APP_DRIVE)
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

export type DriveJobKind = 'project' | 'file' | 'download'

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
  /** The Merkliste is kept in step with the file in „Merkliste“. */
  merkliste: boolean
  /** Connected before (the website keeps no token, only the fact). */
  linked: boolean
  email: string
  name: string
  /** The last round that went through. */
  merklisteAt: number
  /** Folder ids per account, checked once a visit before they are used. */
  folders: Record<string, Partial<Record<DriveFolder, string>>>
  /** Custom Web OAuth client ID, if entered in settings. */
  clientId?: string
}

const DEFAULT_SETTINGS: DriveSettings = {
  autoDownloads: true,
  merkliste: true,
  linked: false,
  email: '',
  name: '',
  merklisteAt: 0,
  folders: {},
  clientId: '',
}

/** Kept here by an earlier version: a client secret and a refresh token, neither of which belongs in the page. */
const RETIRED_SETTINGS = ['clientSecret', 'refreshToken']

function readSettings(): DriveSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const stored = JSON.parse(raw) as Record<string, unknown>
    if (RETIRED_SETTINGS.some((key) => key in stored)) {
      for (const key of RETIRED_SETTINGS) delete stored[key]
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored))
    }
    return { ...DEFAULT_SETTINGS, ...(stored as Partial<DriveSettings>) }
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
  /** The Merkliste's rounds with the file in Drive. */
  merkSync: MerkSync
}

export type MerkSyncProblem = DriveErrorCode | 'unreadable'

export interface MerkSync {
  running: boolean
  /** When the last round went through; 0 before one did on this visit. */
  at: number
  /** Series that came from Drive or changed through it in the last round. */
  received: number
  problem: { code: MerkSyncProblem; detail?: string } | null
}

export const useDrive = create<DriveState>(() => ({
  configured: !IN_APP || Boolean(APP_DRIVE),
  ready: !IN_APP,
  connected: false,
  signingIn: false,
  lasting: true,
  account: null,
  jobs: [],
  settings: readSettings(),
  problem: null,
  merkSync: { running: false, at: 0, received: 0, problem: null },
}))

export function getWebClientId(): string {
  const custom = state().settings.clientId?.trim()
  return custom || WEB_CLIENT_ID
}

/**
 * Whether `api/google-token.js` holds a secret, and for which client: then a
 * sign-in on the website lasts. Asked once a visit; until it answers, and
 * where there is no such function (a static copy, `vite dev`), the sign-in
 * is for the hour.
 */
let lastingClient: string | null = null
let lastingAsked: Promise<void> | null = null
function askLasting(): Promise<void> {
  lastingAsked ??= fetch(TOKEN_API, { cache: 'no-store' })
    .then((res) => (res.ok ? (res.json() as Promise<{ lasting?: boolean; clientId?: string }>) : null))
    .then((body) => {
      lastingClient = body?.lasting && body.clientId ? body.clientId : null
    })
    .catch(() => {})
  return lastingAsked
}
/** A client id entered in the dialog is not the one the secret belongs to. */
const lastingHere = () => lastingClient !== null && lastingClient === getWebClientId()

interface TokenAnswer {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
  detail?: string
}

async function tokenApi(body: Record<string, string>): Promise<{ status: number; body: TokenAnswer }> {
  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: ((await res.json().catch(() => ({}))) as TokenAnswer) ?? {} }
}

/** The cookie answered 401 once: no use asking again before the next sign-in. */
let cookieGone = false
let refreshing: Promise<string | null> | null = null

/** A new hour from the lasting sign-in, or null when there is none. One request at a time. */
function refreshWeb(): Promise<string | null> {
  refreshing ??= (async () => {
    // Disconnected meanwhile: the answer belongs to the sign-in just ended.
    const at = connection
    try {
      const answer = await tokenApi({ action: 'refresh' })
      if (at !== connection) return null
      if (answer.status === 200 && answer.body.access_token) {
        holdWebToken(answer.body.access_token, Number(answer.body.expires_in) || 3600)
        set({ connected: true })
        return answer.body.access_token
      }
      if (answer.status === 401) cookieGone = true
    } catch {
      // Offline: the next request tries again.
    }
    return null
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

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
  const send = APP_DRIVE
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
    if (webTokenUsable()) return
    // A lasting sign-in renews itself; only without one does the header ask again.
    if (state().settings.linked && lastingHere() && !cookieGone) {
      void refreshWeb().then((next) => {
        if (!next) set({ connected: false })
      })
    } else set({ connected: false })
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

  if (state().settings.linked && !cookieGone) {
    await askLasting()
    if (lastingHere()) {
      const token = await refreshWeb()
      if (token) return token
    }
  }

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
 *
 * With a secret in `api/google-token.js` Google sends a code, the function
 * exchanges it and keeps the refresh token in a cookie the page never sees;
 * without, Google sends the hour-long token straight back.
 */
function signInWeb(): Promise<void> {
  const clientId = getWebClientId()
  if (!clientId) return Promise.reject(new DriveError('not-configured'))
  const stateId = crypto.getRandomValues(new Uint32Array(4)).join('-')
  const url = new URL(AUTH_URL)
  const hint = state().settings.email
  const redirectUri = new URL('google-drive.html', document.baseURI).toString()
  const useCode = lastingHere()

  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: useCode ? 'code' : 'token',
    scope: DRIVE_SCOPE,
    state: stateId,
    include_granted_scopes: 'true',
    // A refresh token comes only with the consent screen, so it is asked for.
    ...(useCode ? { access_type: 'offline', prompt: 'consent' } : hint ? {} : { prompt: 'select_account' }),
    ...(hint ? { login_hint: hint } : {}),
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
    channel.onmessage = async (event: MessageEvent) => {
      const data = event.data as {
        state?: string
        access_token?: string
        code?: string
        expires_in?: string
        scope?: string
        error?: string
      } | null
      if (!data || data.state !== stateId) return
      if (data.error) return done(new DriveError(data.error === 'access_denied' ? 'denied' : 'failed', data.error))
      if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(DRIVE_SCOPE)) return done(new DriveError('scope'))

      if (data.code) {
        try {
          const answer = await tokenApi({ action: 'code', code: data.code, redirectUri })
          if (answer.status !== 200 || !answer.body.access_token) {
            return done(new DriveError('failed', answer.body.detail || answer.body.error || `HTTP ${answer.status}`))
          }
          if (typeof answer.body.scope === 'string' && !answer.body.scope.split(/\s+/).includes(DRIVE_SCOPE)) return done(new DriveError('scope'))
          cookieGone = false
          holdWebToken(answer.body.access_token, Number(answer.body.expires_in) || 3600)
          done(null)
        } catch (err) {
          done(new DriveError('offline', String((err as Error)?.message ?? err)))
        }
        return
      }

      if (!data.access_token) return done(new DriveError('failed', 'kein Token'))
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
      // The list in step once the switch is on — first of all, before anything else changes it.
      if (state().settings.merkliste) void syncMerklisteWithDrive()
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
  else {
    if (webToken) {
      // Withdrawn at Google as well; the answer cannot be read across origins,
      // and does not need to be.
      void fetch(`${REVOKE_URL}?${new URLSearchParams({ token: webToken.token })}`, { method: 'POST', mode: 'no-cors' }).catch(() => {})
    }
    // The lasting sign-in: the function withdraws it and drops the cookie.
    if (lastingClient !== null) void tokenApi({ action: 'signout' }).catch(() => {})
    cookieGone = true
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
  saveSettings({ linked: false, email: '', name: '', folders: {}, merklisteAt: 0 })
  inDrive = ''
  set({ merkSync: { running: false, at: 0, received: 0, problem: null } })
  log('Google Drive getrennt')
}

/** Once at start: in the app, whether it is set up and signed in. */
let started = false
export function initDrive(): void {
  if (started) return
  started = true
  onMerkliste(() => scheduleMerkliste())
  answerStreamTokens()
  // Back at the window after a while: another device may have changed the list.
  window.addEventListener('focus', () => {
    if (Date.now() - lastRound > FOCUS_GAP) void syncMerklisteWithDrive({ quiet: true })
  })
  if (!IN_APP) {
    // Signed in to stay: connected again without a click.
    void askLasting().then(() => {
      if (!state().settings.linked || !lastingHere()) return
      return accessToken(false)
        .then(async () => {
          const account = await client.account().catch(() => null)
          if (account) {
            saveSettings({ email: account.email, name: account.name })
            set({ connected: true, account })
          }
          void pump()
          if (state().settings.merkliste) void syncMerklisteWithDrive()
        })
        .catch(() => {})
    })
    return
  }
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
    if (state().settings.merkliste) void syncMerklisteWithDrive()
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
    let jobs = current.jobs
    const finished = jobs.filter((entry) => entry.status === 'done' || entry.status === 'skipped' || entry.status === 'failed')
    if (finished.length >= KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED + 1).map((entry) => entry.id))
      jobs = jobs.filter((entry) => !drop.has(entry.id))
    }
    return { jobs: [...jobs, { ...job, id, status: 'waiting', loaded: 0, at: Date.now() }] }
  })
  payloads.set(id, payload)
  // Jobs dropped from the list leave their payload behind.
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

/**
 * A result straight into Drive, without the session (Wunsch vom 23.10.2026:
 * „Sachen direkt auf die Drive speichern, ohne sie in die Sitzung zu
 * bringen“): a download into „Heruntergeladen“, anything else into the
 * folder of its kind. Not signed in yet, the click signs in. Returns the
 * job's id, so the button can show how far it is.
 */
export function saveResultToDrive(file: { name: string; bytes: Uint8Array | Blob; mime: string; folder: DriveFolder }): string {
  const blob =
    file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime })
  const id = enqueue(
    { kind: file.folder === 'downloads' ? 'download' : 'file', name: file.name, folder: file.folder, total: blob.size },
    { data: () => blob, mode: 'skip-same', mime: file.mime || undefined },
  )
  if (!canRun() && !state().signingIn) void connectDrive()
  return id
}

/* -------------------------------------------------------------------------- */
/* The Merkliste, shared through Drive                                         */
/* -------------------------------------------------------------------------- */

/** What the file in Drive held after the last round, as `sharedKey`. */
let inDrive = ''
let round: Promise<void> | null = null
let roundAgain = false
/** Set while a round puts the merged list in place, so that is not taken for a change. */
let applying = false
let lastRound = 0
/** Coming back to the window starts a round only after this long. */
const FOCUS_GAP = 60_000

const setSync = (patch: Partial<MerkSync>) => set((current) => ({ merkSync: { ...current.merkSync, ...patch } }))

/** True when this list is what the last round left in Drive — nothing to send. */
export function inStepWithDrive(items: SavedLinkItem[]): boolean {
  return inDrive !== '' && inDrive === sharedKey(items, merkRemovals())
}

/**
 * One round: read „Sondra-Merkliste.json“, merge it into this device's
 * list (`mergeShared`: per series the side changed last wins, removals
 * stay removed, pictures from files stay on their device), write the
 * merged list back unless the file already holds exactly that. Compared
 * with the file, not with what this device wrote last: another one may
 * have written since. A file Sondra cannot read is never written over.
 */
async function merkRound(quiet: boolean): Promise<void> {
  const current = state()
  if (!driveLinked(current)) return
  if (!canRun()) {
    // The website's hour is up: said where the list is shown, asked for by a click.
    if (!quiet) setSync({ running: false, problem: { code: 'expired' } })
    return
  }
  const started = connection
  setSync({ running: true })
  try {
    const file = await client.find('merkliste', MERKLISTE_FILE)
    const remote = file ? readSharedFile(new TextDecoder().decode(await client.read(file.id))) : null
    if (file && !remote) {
      setSync({ running: false, problem: { code: 'unreadable' } })
      log(`${MERKLISTE_FILE} in Google Drive ist keine Merkliste — nicht überschrieben`, 'warn')
      return
    }
    if (started !== connection) return
    let received = 0
    if (remote) {
      const before = merkItems()
      const merged = mergeShared(before, remote)
      const known = new Map(before.map((item) => [item.id, item.updatedAt]))
      received = merged.items.filter((item) => known.get(item.id) !== item.updatedAt).length
      applying = true
      try {
        if (received > 0 || merged.items.length !== before.length) setMerkItems(merged.items)
        adoptRemovals(merged.removed)
      } finally {
        applying = false
      }
    }
    const key = sharedKey(merkItems(), merkRemovals())
    if (!remote || remote.key !== key) {
      const text = sharedFileText(merkItems(), merkRemovals())
      await client.put('merkliste', MERKLISTE_FILE, new Blob([text], { type: 'application/json' }), { mode: 'replace', mime: 'application/json' })
      if (started !== connection) return
      log(`Merkliste in Google Drive abgeglichen (${merkItems().length} Einträge${received ? `, ${received} von dort` : ''})`)
    } else if (received > 0) {
      log(`Merkliste aus Google Drive: ${received} ${received === 1 ? 'Serie' : 'Serien'} neu oder geändert`)
    }
    inDrive = key
    const at = Date.now()
    setSync({ running: false, at, received, problem: null })
    saveSettings({ merklisteAt: at })
  } catch (error) {
    if (started !== connection) return
    const code = error instanceof DriveError ? error.code : 'failed'
    const detail = error instanceof DriveError ? error.detail : String((error as Error)?.message ?? error)
    setSync({ running: false, problem: { code, detail } })
    if (code !== 'expired') log(`Merkliste nicht mit Google Drive abgeglichen: ${DRIVE_PROBLEM[code]}${detail ? ` (${detail})` : ''}`, 'warn')
  } finally {
    lastRound = Date.now()
  }
}

/**
 * Brings the Merkliste in step with Drive. Rounds never overlap: a call
 * during one asks for another right after it. `quiet`: a round nobody
 * asked for says nothing when the website's sign-in is missing.
 */
export function syncMerklisteWithDrive({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  const current = state()
  if (!current.settings.merkliste || !driveLinked(current)) return Promise.resolve()
  if (round) {
    roundAgain = true
    return round
  }
  round = (async () => {
    do {
      roundAgain = false
      await merkRound(quiet)
    } while (roundAgain)
  })().finally(() => {
    round = null
  })
  return round
}

/** A round now, from a click — on the website signing in first when its hour is up. */
export async function syncMerklisteNow(): Promise<void> {
  if (!canRun() && !IN_APP) {
    if (!(await connectDrive())) return
    // Signing in starts a round of its own.
    return round ?? syncMerklisteWithDrive()
  }
  return syncMerklisteWithDrive()
}

let merklisteTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMerkliste() {
  if (applying) return
  const current = state()
  if (!current.settings.merkliste || !driveLinked(current) || inStepWithDrive(merkItems())) return
  if (merklisteTimer) clearTimeout(merklisteTimer)
  merklisteTimer = setTimeout(() => {
    merklisteTimer = null
    void syncMerklisteWithDrive({ quiet: true })
  }, MERKLISTE_DELAY)
}

export function setDriveSetting(
  patch: Partial<Pick<DriveSettings, 'autoDownloads' | 'merkliste' | 'clientId'>>,
): void {
  saveSettings(patch)
  if (patch.merkliste) void syncMerklisteWithDrive()
  if (patch.merkliste === false) setSync({ running: false, problem: null })
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

/** Everything in Sondra's folder in Drive, its subfolders walked through. On the website a click may sign in first. */
export async function readDriveTree(options: { signal?: AbortSignal; onProgress?: (files: number) => void; limit?: number } = {}) {
  await ready()
  return client.tree(options)
}

/** Whether Drive can be read right now, without a click to sign in. */
export const driveReadable = (): boolean => driveLinked() && canRun()

/** One file's bytes, from Drive. */
export async function readDriveFile(id: string, signal?: AbortSignal, onProgress?: (loaded: number) => void): Promise<Uint8Array> {
  await ready()
  return client.read(id, signal, onProgress)
}

/**
 * Episodes in Drive filed into a series' season: the folder
 * „Sondra/Serien/<Titel>/Staffel n“ made where missing, each file moved
 * there, and noted on it which episode it is — private to Sondra, so the
 * Merkliste knows it whatever the file is called. Returns where they went.
 */
export async function fileIntoSeason(
  files: { id: string; parent?: string; hint: EpisodeHint }[],
  { title, season, onProgress }: { title: string; season: number; onProgress?: (done: number) => void },
): Promise<string> {
  await ready()
  const path = seasonPath(title, season)
  const target = await client.folderAt(path)
  let done = 0
  for (const file of files) {
    await client.move(file.id, { to: target, from: file.parent, appProperties: hintProperties(file.hint) })
    done += 1
    onProgress?.(done)
  }
  const where = `Sondra/${path.join('/')}`
  log(`${files.length} ${files.length === 1 ? 'Folge' : 'Folgen'} nach ${where} eingeordnet`)
  return where
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A film in Drive is played from there, piece by piece as the player asks
 * for it: the service worker answers `drive-media/<id>` on this origin
 * with ranges it fetches from Drive. A media element cannot send Drive the
 * token itself, and putting it into an address would hand it to whatever
 * logs addresses. The worker asks this page for a token when it needs one
 * and keeps it only in memory, as the page does.
 */
function answerStreamTokens(): void {
  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; refused?: boolean } | null
    const port = event.ports[0]
    if (!data || data.type !== 'drive-token-wanted' || !port) return
    accessToken(Boolean(data.refused)).then(
      (token) => port.postMessage({ token }),
      () => port.postMessage({ token: null }),
    )
  })
}

let streaming: Promise<boolean> | null = null

/** Whether a worker that knows `drive-media/` is in charge of this page. */
function canStream(): Promise<boolean> {
  const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker?.controller : null
  if (!worker) return Promise.resolve(false)
  streaming ??= new Promise<boolean>((resolve) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => resolve(false), 1500)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      resolve(event.data === 'drive-media')
    }
    worker.postMessage({ type: 'drive-ping' }, [channel.port2])
  }).then((answer) => {
    // A worker from an older build may be replaced by one that can; ask again next time.
    if (!answer) streaming = null
    return answer
  })
  return streaming
}

/** The address to play a file in Drive from, or null when it has to be fetched whole. */
export async function driveMediaUrl(file: { id: string; size: number; type: string }): Promise<string | null> {
  if (!(await canStream())) return null
  const query = new URLSearchParams({ size: String(file.size), type: file.type || 'application/octet-stream' })
  return new URL(`drive-media/${encodeURIComponent(file.id)}?${query}`, document.baseURI).toString()
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
