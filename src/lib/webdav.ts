/**
 * The page's side of the WebDAV target (desktop/webdav.mjs): a NAS, Nextcloud
 * or any server that speaks MKCOL and PUT, entered by the user — nothing is
 * built in. Only the Windows app can reach one (these servers send no CORS
 * headers), so elsewhere there is a sentence instead of a dead button.
 *
 * The password goes to the app once and never comes back: the page learns
 * whether there is one (`hasPassword`), not what it is. The files are sent by
 * the app's own server — from the copy it just wrote (`/api/direct-save`) or
 * from bytes the page hands over (`/api/webdav-upload`), never from a path
 * the page names.
 */

import { create } from 'zustand'

import { APP_BRIDGE, IN_DESKTOP_APP } from './desktop'

export interface WebdavStatus {
  configured: boolean
  url: string
  username: string
  basePath: string
  hasPassword: boolean
  /** False when the system has no store to keep the password in: it lasts until the app closes. */
  remembered: boolean
}

export interface WebdavInput {
  url: string
  username: string
  basePath: string
  /** `undefined` keeps the saved password, `''` removes it. */
  password?: string
}

/** Where a failure came from, as the app names it. */
export type WebdavCode =
  | 'no-address'
  | 'bad-address'
  | 'credentials-in-address'
  | 'not-configured'
  | 'unauthorized'
  | 'forbidden'
  | 'missing'
  | 'full'
  | 'too-large'
  | 'redirect'
  | 'certificate'
  | 'unknown-host'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'no-webdav'
  | 'bad-name'
  | 'failed'

/** Only the Windows app: it has the bridge, and the server that sends. */
export const WEBDAV_SUPPORTED = IN_DESKTOP_APP && typeof APP_BRIDGE?.webdav === 'function'

/** The sentence for a failure — what happened and, where there is one, what to do. */
export function webdavProblem(code: string | undefined, detail?: string): string {
  const tail = detail ? ` (${detail})` : ''
  switch (code) {
    case 'no-address':
      return 'Es ist keine WebDAV-Adresse eingetragen.'
    case 'bad-address':
      return 'Die Adresse muss mit http:// oder https:// beginnen.'
    case 'credentials-in-address':
      return 'Benutzername und Passwort gehören in ihre eigenen Felder, nicht in die Adresse.'
    case 'not-configured':
      return 'WebDAV ist noch nicht eingerichtet.'
    case 'unauthorized':
      return 'Der Server hat die Anmeldung abgelehnt. Prüfen Sie Benutzername und Passwort — bei Nextcloud braucht es ein App-Passwort.'
    case 'forbidden':
      return 'Der Server erlaubt hier kein Schreiben. Prüfen Sie die Rechte dieses Benutzers für den Zielpfad.'
    case 'missing':
      return `Der Server kennt diese Adresse nicht${tail}. Prüfen Sie die Adresse bis zum Ordner des Benutzers.`
    case 'full':
      return 'Auf dem Server ist kein Platz mehr.'
    case 'too-large':
      return 'Der Server nimmt Dateien dieser Grösse nicht an. Bei einem Proxy davor hilft meist eine höhere Obergrenze für Uploads.'
    case 'redirect':
      return 'Der Server leitet weiter. Tragen Sie die Adresse genau so ein, wie der Browser sie am Ende zeigt — meistens mit https://.'
    case 'certificate':
      return 'Dem Zertifikat des Servers vertraut dieser Computer nicht. Ein selbst ausgestelltes Zertifikat muss in Windows als vertrauenswürdig eingetragen sein.'
    case 'unknown-host':
      return 'Diesen Servernamen findet der Computer nicht. Prüfen Sie die Schreibweise und ob Sie im selben Netz wie das NAS sind.'
    case 'refused':
      return 'Der Server nimmt unter dieser Adresse keine Verbindung an. Prüfen Sie den Port und ob der WebDAV-Dienst läuft.'
    case 'timeout':
      return 'Der Server antwortet nicht. Ist er an und erreichbar?'
    case 'no-webdav':
      return 'Unter dieser Adresse läuft kein WebDAV. Bei Nextcloud endet sie auf /remote.php/dav/files/<Benutzer>.'
    case 'bad-name':
      return 'Der Dateiname ist für den Server nicht brauchbar.'
    case 'unreachable':
      return `Der Server ist nicht erreichbar${tail}.`
    default:
      return `WebDAV hat nicht geklappt${tail}.`
  }
}

interface WebdavState {
  status: WebdavStatus | null
  busy: boolean
}

export const useWebdav = create<WebdavState>(() => ({ status: null, busy: false }))

const bridge = () => APP_BRIDGE?.webdav

/** Reads what the app holds; call when a panel opens. */
export async function refreshWebdav(): Promise<WebdavStatus | null> {
  const ask = bridge()
  if (!ask) return null
  try {
    const status = (await ask('status')) as WebdavStatus
    useWebdav.setState({ status })
    return status
  } catch {
    return null
  }
}

/** True when a download can go to the WebDAV folder now. */
export function webdavReady(): boolean {
  return WEBDAV_SUPPORTED && Boolean(useWebdav.getState().status?.configured)
}

/** Saves the entry; the answer says which part was wrong when the address was refused. */
export async function configureWebdav(input: WebdavInput): Promise<{ ok: boolean; message: string }> {
  const ask = bridge()
  if (!ask) return { ok: false, message: webdavProblem('not-configured') }
  const answer = (await ask('configure', input)) as (WebdavStatus & { ok: boolean; code?: string }) | undefined
  if (!answer?.ok) return { ok: false, message: webdavProblem(answer?.code) }
  const { ok: _ok, code: _code, ...status } = answer
  useWebdav.setState({ status })
  return { ok: true, message: '' }
}

/** Asks the server whether the folder answers with what was saved. */
export async function testWebdav(): Promise<{ ok: boolean; message: string }> {
  const ask = bridge()
  if (!ask) return { ok: false, message: webdavProblem('not-configured') }
  const answer = (await ask('test')) as { ok: boolean; folder?: 'there' | 'new'; code?: string; detail?: string }
  if (!answer.ok) return { ok: false, message: webdavProblem(answer.code, answer.detail) }
  return {
    ok: true,
    message:
      answer.folder === 'new'
        ? 'Der Server antwortet. Der Zielpfad wird beim ersten Speichern angelegt.'
        : 'Der Server antwortet, der Zielpfad ist da.',
  }
}

/** Removes address, user name and password from this computer. */
export async function forgetWebdav(): Promise<void> {
  const ask = bridge()
  if (!ask) return
  const status = (await ask('forget')) as WebdavStatus
  useWebdav.setState({ status })
}

/** A failure from the app's server (`/api/direct-save` or `/api/webdav-upload`) as the sentence for it. */
export function webdavAnswerProblem(answer: { error?: string; code?: string; detail?: string } | null | undefined): string {
  if (answer?.error === 'webdav-not-configured') return webdavProblem('not-configured')
  return webdavProblem(answer?.code, answer?.detail)
}

/**
 * Bytes the page already holds — a stream FFmpeg had to touch — into the
 * WebDAV folder, through the app's server. `folder` is the slash path below
 * the folder the user entered (see `episodeFolder`).
 */
export async function putBytesToWebdav(file: {
  name: string
  bytes: Uint8Array
  mime: string
  folder: string
  signal?: AbortSignal
}): Promise<void> {
  const query = new URLSearchParams({ name: file.name, sub: file.folder })
  const response = await fetch(`/api/webdav-upload?${query}`, {
    method: 'PUT',
    headers: { 'content-type': file.mime || 'application/octet-stream' },
    body: file.bytes as Uint8Array<ArrayBuffer>,
    signal: file.signal,
  })
  if (response.ok) return
  const answer = (await response.json().catch(() => null)) as { error?: string; code?: string; detail?: string } | null
  throw new Error(webdavAnswerProblem(answer))
}
