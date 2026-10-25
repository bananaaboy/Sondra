/**
 * The Merkliste in Anytype, from the page's side: the page „Sondra ·
 * Merkliste" that the app keeps in a space the user picked, and the
 * merge between it and this device's list.
 *
 * Only in the app. The app's main process talks to Anytype on this computer
 * (desktop/anytype.mjs) and holds the key; the page sends one action at a
 * time through the preload. In a browser there is no way: Anytype's API
 * sends no CORS headers, so no web page can read its answers.
 *
 * The page in Anytype has two parts. On top, the list as people read it —
 * what is being watched, where, how far — which Anytype brings to the
 * user's other devices, the phone included. Below, the same list as data
 * (base64 in a code block, so no Markdown conversion on Anytype's side can
 * bend it), from which Sondra on another computer takes it back.
 */

import { APP_BRIDGE } from './desktop'
import {
  adoptRemovals,
  caughtUp,
  itemProgress,
  merkItems,
  createMerkItem,
  merkRemovals,
  mergeShared,
  seasonName,
  takeShared,
  seasonProgress,
  seasonsOf,
  setMerkItems,
  travelling,
  type SavedLinkItem,
} from './merkliste'

export type AnytypeError =
  | 'unreachable'
  | 'unauthorized'
  | 'no-space'
  | 'wrong-code'
  | 'missing'
  | 'busy'
  | 'rejected'
  | 'forbidden'
  | 'not-granted'
  | 'unreadable'
  | 'failed'
/** A failure carries Anytype's own reason in `detail`, for the log and the dialog. */
type Answer<T> = ({ ok: true } & T) | { ok: false; error: AnytypeError; detail?: string }

export interface FoundNote {
  id: string
  name: string
  itemCount: number
}

export interface AnytypeStatus {
  /** Anytype is open on this computer and answers. */
  reachable: boolean
  /** Sondra holds a key from Anytype. */
  paired: boolean
  /** The key outlives the app (the system can encrypt it). */
  lasting: boolean
  space: { id: string; name: string } | null
  note?: { id: string; name: string } | null
}

/** True in the app, where the main process can reach Anytype. */
export const anytypeAvailable = Boolean(APP_BRIDGE?.anytype)

function ask<T>(action: string, ...args: unknown[]): Promise<Answer<T>> {
  const send = APP_BRIDGE?.anytype
  if (!send) return Promise.resolve({ ok: false, error: 'unreachable' })
  return send(action, ...args).then(
    (answer) => answer as Answer<T>,
    () => ({ ok: false, error: 'failed' }) as const,
  )
}

export const anytype = {
  status: () => ask<AnytypeStatus>('status'),
  challenge: () => ask<{ challengeId: string }>('challenge'),
  pair: (challengeId: string, code: string) => ask<object>('pair', challengeId, code),
  spaces: () => ask<{ spaces: { id: string; name: string }[] }>('spaces'),
  listNotes: (spaceId?: string) => ask<{ notes: FoundNote[] }>('listNotes', spaceId),
  useSpace: (id: string, name: string, objectId?: string, objectName?: string) =>
    ask<object>('useSpace', id, name, objectId, objectName),
  createNote: (spaceId: string, name: string, spaceName?: string) =>
    ask<{ id: string; name: string }>('createNote', spaceId, name, spaceName),
  forget: () => ask<object>('forget'),
}

/** What each failure means, in a sentence. */
export const ANYTYPE_PROBLEM: Record<AnytypeError, string> = {
  unreachable: 'Anytype antwortet auf diesem Rechner gerade nicht. Abgeglichen wird, sobald es wieder offen ist.',
  unauthorized: 'Anytype hat den Zugang zurückgezogen. Bitte neu verbinden.',
  'no-space': 'Es ist noch kein Space gewählt.',
  'wrong-code': 'Dieser Code passt nicht. Fordern Sie einen neuen an.',
  missing: 'Die Seite in Anytype ist nicht mehr da; beim nächsten Abgleich legt Sondra sie neu an.',
  busy: 'Anytype ist gerade beschäftigt. Gleich noch einmal.',
  rejected: 'Anytype hat die Anfrage abgelehnt.',
  forbidden:
    'In diesem Space darf Sondra nichts anlegen oder ändern — Sie haben dort nur Leserechte, oder Sondra wurde beim Verbinden nur Lesen erlaubt. Wählen Sie einen anderen Space oder verbinden Sie neu.',
  'not-granted':
    'Diesen Space hat Anytype für Sondra nicht freigegeben. Wählen Sie einen freigegebenen Space, oder verbinden Sie neu und geben Sie ihn beim Bestätigen in Anytype frei.',
  unreadable:
    'Der Datenblock auf der Seite in Anytype lässt sich nicht lesen. Sondra schreibt nicht darüber, damit dort nichts verloren geht. Wählen Sie unter „Anytype“ eine andere Notiz oder legen Sie eine neue an.',
  failed: 'Der Abgleich mit Anytype ist gescheitert. Die Einzelheiten stehen in sondra.log.',
}

/* -------------------------------------------------------------------------- */
/* The page in Anytype                                                         */
/* -------------------------------------------------------------------------- */

const DATA_HEADING = '## Sondra-Daten'
const DATA_FENCE = 'sondra-merkliste'

const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]#<>|])/g, '\\$1')

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): string {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function stand(item: SavedLinkItem): string {
  const progress = itemProgress(item)
  const seen = progress.total ? `${progress.watched} von ${progress.total} gesehen` : `${progress.watched} gesehen`
  if (caughtUp(seasonsOf(item))) return `Alles gesehen · ${seen}`
  if ((item.status ?? 'watching') === 'later' && progress.watched === 0) return 'Nicht angefangen'
  const where = item.episode === null ? (item.season === 0 ? 'Filme' : `Staffel ${item.season}`) : item.season === 0 ? `Film ${item.episode}` : `Staffel ${item.season}, Folge ${item.episode}`
  return `${where} · ${seen}`
}

/** The list as a page: readable on top, the data underneath. */
export function merklisteToMarkdown(items: SavedLinkItem[], removed: Record<string, number>): string {
  const lines: string[] = [
    'Diese Seite schreibt Sondra. Abgehakt wird in Sondra; was hier von Hand geändert wird, überschreibt der nächste Abgleich.',
    '',
  ]
  const groups: [string, string][] = [
    ['watching', 'Am Schauen'],
    ['later', 'Später'],
    ['paused', 'Pausiert'],
    ['done', 'Fertig'],
    ['dropped', 'Abgebrochen'],
  ]
  for (const [status, heading] of groups) {
    const entries = items.filter((item) => (item.status ?? 'watching') === status)
    if (entries.length === 0) continue
    lines.push(`## ${heading}`, '')
    for (const item of entries) {
      const stars = item.rating ? ` · ${'★'.repeat(item.rating)}` : ''
      lines.push(`- **${escapeMarkdown(item.title)}** — ${stand(item)}${stars}`)
      const seasons = seasonsOf(item)
        .map((season) => {
          const progress = seasonProgress(season)
          return `${seasonName(season)}: ${progress.total ? `${progress.watched} von ${progress.total}` : `${progress.watched} gesehen`}`
        })
        .join(' · ')
      if (seasons) lines.push(`  ${escapeMarkdown(seasons)}`)
      if (item.notes) lines.push(`  ${escapeMarkdown(item.notes.replace(/\s+/g, ' '))}`)
      if (item.url.trim()) lines.push(`  ${item.url.trim()}`)
    }
    lines.push('')
  }
  const data = dataOf(items, removed)
  lines.push(DATA_HEADING, '', 'Aus diesem Block nimmt Sondra auf einem anderen Rechner die Liste zurück. Bitte nicht ändern.', '', '```' + DATA_FENCE)
  for (let i = 0; i < data.length; i += 76) lines.push(data.slice(i, i + 76))
  lines.push('```', '')
  return lines.join('\n')
}

/** The list as the data block carries it. */
function dataOf(items: SavedLinkItem[], removed: Record<string, number>): string {
  return toBase64(JSON.stringify({ kind: DATA_FENCE, version: 1, items: items.map(travelling), removed }))
}

/** The list back out of the page — null when the data block is missing or bent. */
export function merklisteFromMarkdown(
  markdown: string,
): { items: SavedLinkItem[]; removed: Record<string, number>; data: string } | null {
  let block: string | null = null
  const start = markdown.indexOf('```' + DATA_FENCE)
  if (start !== -1) {
    const end = markdown.indexOf('```', start + 3 + DATA_FENCE.length)
    block = markdown.slice(start + 3 + DATA_FENCE.length, end === -1 ? undefined : end)
  } else {
    // Anytype drops code fence language identifiers when converting (```sondra-merkliste -> ```)
    const headingIndex = markdown.indexOf(DATA_HEADING)
    const searchFrom = headingIndex !== -1 ? headingIndex : 0
    const fenceStart = markdown.indexOf('```', searchFrom)
    if (fenceStart !== -1) {
      const fenceEnd = markdown.indexOf('```', fenceStart + 3)
      block = markdown.slice(fenceStart + 3, fenceEnd === -1 ? undefined : fenceEnd)
    }
  }
  if (block === null) return null
  // Whatever Anytype did to the lines, only base64 characters count.
  const data = block.replace(/[^A-Za-z0-9+/=]/g, '')
  try {
    const parsed = JSON.parse(fromBase64(data)) as { kind?: string; items?: unknown; removed?: unknown }
    if (parsed.kind !== DATA_FENCE || !Array.isArray(parsed.items)) return null
    const items = parsed.items
      .filter((item): item is Partial<SavedLinkItem> => Boolean(item) && typeof item === 'object')
      .map((item) => createMerkItem(item))
    const removed: Record<string, number> = {}
    if (parsed.removed && typeof parsed.removed === 'object') {
      for (const [id, at] of Object.entries(parsed.removed as Record<string, unknown>)) if (typeof at === 'number') removed[id] = at
    }
    return { items, removed, data }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Keeping the two in step                                                     */
/* -------------------------------------------------------------------------- */

export interface SyncResult {
  /** Series that came from Anytype or changed through it. */
  received: number
  at: number
}

let running: Promise<Answer<SyncResult>> | null = null
/** The list as Anytype holds it after the last round. */
let inAnytype = ''

/** Resets the cached remote state, e.g. when connecting a new space or note. */
export function resetAnytypeCache(): void {
  inAnytype = ''
}

/**
 * „Aus Anytype laden“, the default when connecting to a page that already
 * holds a list: the page's list becomes this device's, with pictures from
 * files kept where the same series had one. A page without a list yet
 * (`empty`) changes nothing here; the next round writes this list there.
 */
export async function loadFromAnytype(): Promise<Answer<{ loaded: number; before: SavedLinkItem[]; empty: boolean }>> {
  await running?.catch(() => undefined)
  const read = await ask<{ markdown: string | null }>('read')
  if (!read.ok) return read
  const before = merkItems()
  const remote = read.markdown ? merklisteFromMarkdown(read.markdown) : null
  if (!remote) {
    if (read.markdown?.includes(DATA_HEADING)) return { ok: false, error: 'unreadable' }
    return { ok: true, loaded: 0, before, empty: true }
  }
  setMerkItems(takeShared(before, remote))
  adoptRemovals({ ...merkRemovals(), ...remote.removed })
  inAnytype = dataOf(merkItems(), merkRemovals())
  return { ok: true, loaded: remote.items.length, before, empty: false }
}

/** True when this list is what the last round left in Anytype — nothing to send. */
export function inStepWithAnytype(items: SavedLinkItem[]): boolean {
  return inAnytype !== '' && inAnytype === dataOf(items, merkRemovals())
}

/**
 * One round: read the page, merge it into this device's list, write the
 * merged list back — unless the page already holds exactly that. Compared
 * with what is in Anytype, not with what this device wrote last: another
 * computer may have written an older list since. Rounds never overlap; a
 * call during one waits for it.
 */
export function syncMerkliste(): Promise<Answer<SyncResult>> {
  running ??= (async (): Promise<Answer<SyncResult>> => {
    const read = await ask<{ markdown: string | null }>('read')
    if (!read.ok) return read
    let received = 0
    const remote = read.markdown ? merklisteFromMarkdown(read.markdown) : null
    // A page that carries a data block Sondra cannot read holds another
    // device's list, maybe; writing this one over it would lose that.
    if (!remote && read.markdown?.includes(DATA_HEADING)) return { ok: false, error: 'unreadable' }
    if (remote) {
      const before = merkItems()
      const merged = mergeShared(before, remote)
      const known = new Map(before.map((item) => [item.id, item.updatedAt]))
      received = merged.items.filter((item) => known.get(item.id) !== item.updatedAt).length
      if (received > 0 || merged.items.length !== before.length) setMerkItems(merged.items)
      adoptRemovals(merged.removed)
    }
    const data = dataOf(merkItems(), merkRemovals())
    if (!remote || remote.data !== data) {
      const written = await ask<object>('write', merklisteToMarkdown(merkItems(), merkRemovals()))
      if (!written.ok) return written
    }
    inAnytype = data
    return { ok: true, received, at: Date.now() }
  })().finally(() => {
    running = null
  })
  return running
}
