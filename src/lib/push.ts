/**
 * Notices on the phone — the page's side (desktop/push.mjs). Sondra says when
 * a download is done, a new episode is out or a calendar entry is due; the
 * app sends it to ntfy, Telegram or Pushover, whichever the person entered.
 * Nothing is built in, and the secrets stay in the app: the page learns
 * whether one is there (`hasTelegramToken` …), never what it is.
 *
 * Only the Windows app can send (these services are reached from the main
 * process, with the person's own secrets); elsewhere there is a sentence
 * instead of a dead button.
 */

import { create } from 'zustand'

import { APP_BRIDGE, IN_DESKTOP_APP } from './desktop'

export type PushService = 'ntfy' | 'telegram' | 'pushover'

export interface PushStatus {
  configured: boolean
  service: PushService | null
  ntfyServer: string
  ntfyTopic: string
  telegramChat: string
  hasNtfyToken: boolean
  hasTelegramToken: boolean
  hasPushoverToken: boolean
  hasPushoverUser: boolean
  /** False when the system has no store to keep secrets in: they last until the app closes. */
  remembered: boolean
}

export interface PushInput {
  service: PushService
  ntfyServer?: string
  ntfyTopic?: string
  telegramChat?: string
  /** `undefined` keeps a saved secret, `''` removes it. */
  ntfyToken?: string
  telegramToken?: string
  pushoverToken?: string
  pushoverUser?: string
}

export const PUSH_SUPPORTED = IN_DESKTOP_APP && typeof APP_BRIDGE?.push === 'function'

export const PUSH_SERVICES: { id: PushService; label: string }[] = [
  { id: 'ntfy', label: 'ntfy' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'pushover', label: 'Pushover' },
]

/** What a notice may be about; each can be switched off. */
export type PushKind = 'downloads' | 'episodes' | 'reminders'

export const PUSH_KINDS: { id: PushKind; label: string }[] = [
  { id: 'downloads', label: 'Download fertig' },
  { id: 'episodes', label: 'Neue Folge erschienen' },
  { id: 'reminders', label: 'Erinnerung aus dem Kalender' },
]

const PREFS_KEY = 'sondra:push:wann'

export function pushWanted(): Record<PushKind, boolean> {
  const all = { downloads: true, episodes: true, reminders: true }
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Record<PushKind, boolean>>
    return { ...all, ...parsed }
  } catch {
    return all
  }
}

export function setPushWanted(kind: PushKind, on: boolean): Record<PushKind, boolean> {
  const next = { ...pushWanted(), [kind]: on }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next))
  } catch {
    // Only a preference.
  }
  return next
}

export const usePush = create<{ status: PushStatus | null }>(() => ({ status: null }))

export async function refreshPush(): Promise<PushStatus | null> {
  const ask = APP_BRIDGE?.push
  if (!ask) return null
  try {
    const status = (await ask('status')) as PushStatus
    usePush.setState({ status })
    return status
  } catch {
    return null
  }
}

/** The sentence for a failure — what happened and, where there is one, what to do. */
export function pushProblem(code: string | undefined, detail?: string): string {
  const tail = detail ? ` („${detail}“)` : ''
  switch (code) {
    case 'no-service':
      return 'Wählen Sie zuerst einen Dienst.'
    case 'no-server':
      return 'Tragen Sie die Adresse Ihres ntfy-Servers ein.'
    case 'bad-server':
      return 'Die Adresse muss mit http:// oder https:// beginnen.'
    case 'credentials-in-address':
      return 'Ein Zugangstoken gehört in sein eigenes Feld, nicht in die Adresse.'
    case 'no-topic':
      return 'Tragen Sie das Thema ein, das Sie in der ntfy-App abonniert haben.'
    case 'no-chat':
      return 'Tragen Sie Ihre Chat-ID ein.'
    case 'no-token':
      return 'Tragen Sie den Token Ihres Bots ein.'
    case 'no-keys':
      return 'Pushover braucht den App-Token und Ihren User-Key.'
    case 'not-configured':
      return 'Die Meldungen sind noch nicht eingerichtet.'
    case 'unauthorized':
      return `Der Dienst hat die Zugangsdaten abgelehnt${tail}. Prüfen Sie Token und Schlüssel.`
    case 'chat-not-found':
      return 'Telegram kennt diese Chat-ID nicht. Schreiben Sie Ihrem Bot einmal eine Nachricht und prüfen Sie die ID.'
    case 'missing':
      return `Der Server kennt diese Adresse nicht${tail}. Prüfen Sie Adresse und Thema.`
    case 'busy':
      return 'Der Dienst bremst gerade. Versuchen Sie es in einer Minute noch einmal.'
    case 'certificate':
      return 'Dem Zertifikat des Servers vertraut dieser Computer nicht. Sondra vertraut, was Windows vertraut.'
    case 'unknown-host':
      return 'Diesen Servernamen findet der Computer nicht.'
    case 'refused':
      return 'Der Server nimmt unter dieser Adresse keine Verbindung an.'
    case 'timeout':
      return 'Der Dienst antwortet nicht.'
    case 'unreachable':
      return 'Der Dienst ist nicht erreichbar.'
    default:
      return `Die Meldung ist nicht angekommen${tail}.`
  }
}

/** Saves the entry; the answer says which part was missing or wrong. */
export async function configurePush(input: PushInput): Promise<{ ok: boolean; message: string }> {
  const ask = APP_BRIDGE?.push
  if (!ask) return { ok: false, message: pushProblem('not-configured') }
  const answer = (await ask('configure', input)) as (PushStatus & { ok: boolean; code?: string }) | undefined
  if (!answer) return { ok: false, message: pushProblem(undefined) }
  const { ok, code, ...status } = answer
  usePush.setState({ status })
  return ok ? { ok: true, message: '' } : { ok: false, message: pushProblem(code) }
}

/** Sends a test notice with what was saved. */
export async function testPush(): Promise<{ ok: boolean; message: string }> {
  const ask = APP_BRIDGE?.push
  if (!ask) return { ok: false, message: pushProblem('not-configured') }
  const answer = (await ask('test')) as { ok: boolean; code?: string; detail?: string }
  return answer.ok ? { ok: true, message: 'Die Test-Meldung ist unterwegs. Schauen Sie auf Ihr Handy.' } : { ok: false, message: pushProblem(answer.code, answer.detail) }
}

/** Removes the service and every secret from this computer. */
export async function forgetPush(): Promise<void> {
  const ask = APP_BRIDGE?.push
  if (!ask) return
  usePush.setState({ status: (await ask('forget')) as PushStatus })
}

// The app's status is read once at the start, so a notice can go out before any settings dialog was opened.
if (PUSH_SUPPORTED) void refreshPush()

/** True when a notice can go out now. */
export function pushReady(): boolean {
  return PUSH_SUPPORTED && Boolean(usePush.getState().status?.configured)
}

/**
 * One notice to the phone, if the person set it up and wants this kind.
 * Fire and forget: a failure is nothing to interrupt a download for — the
 * test in the settings is where it shows.
 */
export function sendPush(kind: PushKind, title: string, body: string): void {
  const ask = APP_BRIDGE?.push
  if (!ask || !pushReady() || !pushWanted()[kind]) return
  void ask('send', { title, body }).catch(() => undefined)
}
