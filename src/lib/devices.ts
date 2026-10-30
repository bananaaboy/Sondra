/**
 * Geräte: the devices of one Google account, and files from one to another.
 *
 * Drive is the meeting place, not the road. Each device keeps one small,
 * signed record in „Sondra/Geräte“ (`deviceIdentity.ts`: its id is its key's
 * hash, so it is unique and cannot be taken over) and looks every few
 * seconds for messages addressed to it in „Sondra/Geräte/Post“. A transfer
 * is offered there, accepted there, and then runs directly between the two
 * devices over WebRTC — encrypted, and within one Wi-Fi without leaving it.
 *
 * No STUN server: none is wired in (a server of someone's choosing would
 * see every address), so a direct connection is found within the same
 * network. Where there is none, the sender is offered Drive instead — said
 * as such, since then the files do leave the device for a while; they are
 * deleted once the other side has them.
 *
 * Each device writes only its own record. One changed by anyone else fails
 * its signature, is ignored by all, and its owner writes it again on its
 * next round; copies of it are deleted by the owner. Names stay apart: a
 * device whose name another took first renames itself („Laptop 2“).
 *
 * Opt-in: nothing goes to Drive until the switch on the page „Geräte“ is on.
 */

import { create } from 'zustand'

import { ANDROID_BRIDGE } from './android'
import { IN_ANDROID_APP, IN_DESKTOP_APP } from './desktop'
import { sendToPlayer, type RemoteMedia } from './player'
import { useSession } from '../state/store'
import {
  MESSAGE_MAX_AGE,
  can,
  makeKeys,
  openMessage,
  pickDevices,
  randomId,
  sealMessage,
  shortId,
  signRecord,
  uniqueName,
  type DeviceKeys,
  type DeviceKind,
  type DeviceRecord,
} from './deviceIdentity'
import { freeName, outgoing, receiveOver, safeFileName, sendOver, splitPath, TransferError, type FileInfo, type Kept, type Sink, type SinkFor, type Wire } from './deviceTransfer'
import type { DriveClient, DriveFile } from './driveClient'
import { saveBytes } from './download'
import { deviceDrive, useDrive } from './googleDrive'

export { shortId, type DeviceRecord }

const ENABLED_KEY = 'sondra:geraete:an'
const SEEN_KEY = 'sondra:geraete:nachrichten'
const DB = 'sondra-geraet'
const STORE = 'eigen'

const REGISTRY = ['Geräte']
const POST = ['Geräte', 'Post']
const HANDOVER = ['Geräte', 'Übergabe']

/** How often: the post while the page is in front, while it is not, the list, this device's own record. */
const POLL_FRONT = 4_000
const POLL_BACK = 15_000
/** While a transfer waits for an answer or a connection: the other side should not wait on this one's rhythm. */
const POLL_BUSY = 1_200
const LIST_EVERY = 30_000
const BEAT_EVERY = 2 * 60_000
/** Seen within this counts as „offen“. */
export const ONLINE_WITHIN = 3 * 60_000
/** Devices not seen for this long are not listed. */
const FORGET_AFTER = 60 * 24 * 60 * 60_000
/**
 * After this long without a connection the transfer says „Kein direkter Weg“
 * and offers Drive — but the attempt goes on until `CONNECT_GIVE_UP`, and a
 * connection that opens late still carries the files. The answer reaches the
 * sender only on its next look at Drive, so the receiver waits longer.
 */
const CONNECT_SOFT_SENDER = 25_000
const CONNECT_SOFT_RECEIVER = 45_000
const CONNECT_GIVE_UP = 3 * 60_000
/** States in which a transfer waits on the other side. */
const WAITING: TransferState[] = ['offering', 'asking', 'connecting', 'direct-failed', 'via-drive']
const OFFER_TIMEOUT = MESSAGE_MAX_AGE

export type TransferState =
  | 'offering'
  | 'asking'
  | 'connecting'
  | 'sending'
  | 'receiving'
  | 'direct-failed'
  | 'via-drive'
  | 'done'
  | 'declined'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface Transfer {
  /** Offered to be played there, not saved: the receiver's button says „Abspielen“. */
  play?: boolean
  /** Connected, but waiting for one of the places to send in: two at a time. */
  queued?: boolean
  /** Broke off midway, with the finished part kept: the sender can go on from there. */
  resumable?: boolean
  id: string
  direction: 'out' | 'in'
  peer: string
  peerName: string
  files: FileInfo[]
  total: number
  done: number
  state: TransferState
  route?: 'direct' | 'drive'
  places?: string[]
  error?: string
  at: number
  /** Shown until closed: what arrived, where it went. */
  dismissed?: boolean
}

export type DevicesStatus = 'off' | 'waiting-drive' | 'joining' | 'ready' | 'error'

interface DevicesState {
  enabled: boolean
  status: DevicesStatus
  problem: string | null
  self: DeviceRecord | null
  devices: DeviceRecord[]
  /**
   * Entries that may be this very device before a reinstall or wiped data:
   * same kind and platform, not open now, older than this one. A new key
   * cannot take an old id — the user says „Das war dieses Gerät“, and the
   * old entry goes.
   */
  former: DeviceRecord[]
  transfers: Transfer[]
  /** Text and links other devices sent, until read or dismissed. */
  notes: Note[]
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export const useDevices = create<DevicesState>(() => ({
  enabled: readEnabled(),
  status: 'off',
  problem: null,
  self: null,
  devices: [],
  former: [],
  transfers: [],
  notes: [],
}))

const state = () => useDevices.getState()
const set = (patch: Partial<DevicesState> | ((current: DevicesState) => Partial<DevicesState>)) => useDevices.setState(patch)

function patchTransfer(id: string, patch: Partial<Transfer>) {
  set((current) => ({ transfers: current.transfers.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) }))
}

function addTransfer(transfer: Transfer) {
  // The newest first; finished ones beyond twenty fall off.
  set((current) => {
    const finished = current.transfers.filter((entry) => ['done', 'declined', 'failed', 'cancelled', 'expired'].includes(entry.state))
    const drop = new Set(finished.slice(19).map((entry) => entry.id))
    return { transfers: [transfer, ...current.transfers.filter((entry) => !drop.has(entry.id))] }
  })
}

export const isOnline = (device: DeviceRecord, now = Date.now()) => now - device.seen < ONLINE_WITHIN

/* -------------------------------------------------------------------------- */
/* What this version can do                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Written into this device's signed entry. A sender offers a feature only to
 * a device that lists it: the phones keep an older Sondra until they update,
 * and an older one ignores a message it does not know — silently, so without
 * this the sender would wait on a reply that never comes.
 */
export function ownCaps(): string[] {
  // The phone's save writes into Downloads in one go and cannot reopen a half file.
  return ['text', 'play', 'folder', ...(ANDROID_BRIDGE?.openSave ? [] : ['resume'])]
}

const sameCaps = (a: string[] | undefined, b: string[]) => [...(a ?? [])].sort().join() === [...b].sort().join()

export { can }

/** Sent by another device; read here, never acted on by itself. */
export interface Note {
  id: string
  from: string
  peerName: string
  text: string
  /** The text if it is a single web address, else null. */
  link: string | null
  at: number
  /** A request to play files that lie in Drive, here: asked first, started by a click. */
  play?: RemoteMedia[]
}

/** A film or a song, by what the sender says it is. */
export const isPlayableMime = (mime: string, name = '') =>
  /^(video|audio)\//.test(mime) || /\.(mp4|m4v|mkv|webm|mov|avi|mp3|m4a|aac|flac|ogg|opus|wav)$/i.test(name)

/** Largest film one device plays from another's file by transfer; beyond it, save the file and open it there. */
export const PLAY_TRANSFER_MAX = 2 * 1024 * 1024 * 1024
const DRIVE_ID = /^[\w-]{4,100}$/

export const TEXT_MAX = 4000
const NOTES_KEPT = 8

/** The text as an address to open — only `http` and `https`, only when it is nothing else. */
export function linkOf(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* This device                                                                */
/* -------------------------------------------------------------------------- */

interface Own {
  keys: DeviceKeys
  name: string
  created: number
  fileId?: string
  /** Asked once whether an older entry was this device; answered. */
  decided?: boolean
}

function idb<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      let request: IDBRequest<T>
      try {
        request = work(db.transaction(STORE, mode).objectStore(STORE))
      } catch (error) {
        // A value that cannot be stored throws here, inside the callback: a
        // rejection, or the promise would wait forever.
        db.close()
        reject(error)
        return
      }
      request.onsuccess = () => {
        resolve(request.result)
        db.close()
      }
      request.onerror = () => {
        reject(request.error)
        db.close()
      }
    }
  })
}

const loadOwn = () => idb<Own | undefined>('readonly', (store) => store.get('self') as IDBRequest<Own | undefined>)
const saveOwn = (own: Own) => idb('readwrite', (store) => store.put(own, 'self'))
const forgetOwn = () => idb('readwrite', (store) => store.delete('self'))

function kindHere(): DeviceKind {
  if (IN_ANDROID_APP) return 'android'
  if (IN_DESKTOP_APP) return 'windows'
  return 'browser'
}

/** „Chrome auf Windows“, „Android-App · Pixel 8“ — what this device is, in words. */
export function platformHere(): string {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const model = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(agent)?.[1]?.trim()
  if (IN_ANDROID_APP) return model && model !== 'K' ? `Android-App · ${model}` : 'Android-App'
  if (IN_DESKTOP_APP) return 'Windows-App'
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser'
  const system = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iPhone'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS X/.test(agent)
          ? 'Mac'
          : /Linux/.test(agent)
            ? 'Linux'
            : ''
  return system ? `${browser} auf ${system}` : browser
}

function defaultName(): string {
  if (IN_ANDROID_APP) return 'Handy'
  if (IN_DESKTOP_APP) return 'PC'
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android|iPhone/.test(agent)) return 'Handy'
  if (/iPad/.test(agent)) return 'Tablet'
  return 'Computer'
}

/* -------------------------------------------------------------------------- */
/* The rounds                                                                 */
/* -------------------------------------------------------------------------- */

let own: Own | null = null
let selfId = ''
let timers: number[] = []
let lastList = 0
let lastBeat = 0
let busy = false
let cleaned = false
/** File id → what was read, so an unchanged record is not fetched again. */
const recordCache = new Map<string, { modified: string | null; raw: unknown }>()

function seenMessages(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
const seen = seenMessages()
function markSeen(id: string) {
  seen.add(id)
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)))
  } catch {
    // A replay is still refused by its age.
  }
}

async function readJson(client: DriveClient, file: DriveFile): Promise<unknown> {
  const cached = recordCache.get(file.id)
  if (cached && cached.modified === file.modifiedTime) return cached.raw
  const raw = JSON.parse(new TextDecoder().decode(await client.read(file.id))) as unknown
  recordCache.set(file.id, { modified: file.modifiedTime, raw })
  return raw
}

const jsonBlob = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/** The account's devices, and this one's own record put right where it is not. */
async function refreshList(client: DriveClient, { beat }: { beat: boolean }): Promise<void> {
  if (!own) return
  const files = await client.search(`appProperties has { key='sondraArt' and value='geraet' }`)
  const raws: unknown[] = []
  const mine: DriveFile[] = []
  for (const file of files) {
    if (file.appProperties?.sondraGeraet === selfId) {
      mine.push(file)
      continue
    }
    try {
      raws.push(await readJson(client, file))
    } catch {
      // Unreadable is the same as not there.
    }
  }
  const now = Date.now()
  const others = (await pickDevices(raws)).filter((device) => device.id !== selfId && now - device.seen < FORGET_AFTER)

  // A name another device carried first is given up here, never taken from it.
  const clash = others.find(
    (device) => device.name.toLocaleLowerCase('de') === own!.name.toLocaleLowerCase('de') && device.created < own!.created,
  )
  if (clash) {
    own.name = uniqueName(own.name, others.map((device) => device.name))
    await saveOwn(own)
    beat = true
  }

  // This device's file: the one it knows, or one it finds; copies go.
  let file = mine.find((entry) => entry.id === own!.fileId) ?? mine[0]
  for (const copy of mine) if (copy !== file) await client.remove(copy.id).catch(() => undefined)
  let current: DeviceRecord | null = null
  if (file && !beat) {
    try {
      const raw = await readJson(client, file)
      const believed = (await pickDevices([raw]))[0]
      if (believed?.id === selfId && believed.name === own.name && believed.platform === platformHere() && sameCaps(believed.caps, ownCaps())) current = believed
    } catch {
      current = null
    }
  }
  if (!current) {
    current = await signRecord(own.keys, { name: own.name, kind: kindHere(), platform: platformHere(), created: own.created, seen: now, caps: ownCaps() })
    if (file) {
      file = await client.rewrite(file.id, jsonBlob(current))
    } else {
      file = await client.create(REGISTRY, `Gerät-${selfId}.json`, jsonBlob(current), {
        mime: 'application/json',
        appProperties: { sondraArt: 'geraet', sondraGeraet: selfId },
      })
    }
    recordCache.set(file.id, { modified: file.modifiedTime, raw: current })
    lastBeat = now
  }
  if (own.fileId !== file.id) {
    own.fileId = file.id
    await saveOwn(own)
  }
  // Offered for two weeks after joining: a reinstall is noticed on its first days.
  const former =
    own.decided || now - own.created > 14 * 24 * 60 * 60_000
      ? []
      : others.filter((device) => device.kind === current!.kind && device.platform === current!.platform && device.created < own!.created && !isOnline(device, now))
  set({ self: current, devices: others, former, status: 'ready', problem: null })
  lastList = now
}

/** Messages for this device: each opened once, then deleted. */
async function readPost(client: DriveClient): Promise<void> {
  if (!own) return
  const files = await client.search(`appProperties has { key='sondraAn' and value='${selfId}' }`)
  for (const file of files) {
    let raw: unknown = null
    try {
      raw = JSON.parse(new TextDecoder().decode(await client.read(file.id)))
    } catch {
      raw = null
    }
    // Read is read: a message for this device goes, believed or not.
    await client.remove(file.id).catch(() => undefined)
    let opened = await openMessage(raw, { self: selfId, devices: state().devices, now: Date.now(), seen: (id) => seen.has(id) })
    if (!opened.ok && opened.problem === 'unknown-sender') {
      // A device that joined a moment ago: the list once more, then again.
      await refreshList(client, { beat: false })
      opened = await openMessage(raw, { self: selfId, devices: state().devices, now: Date.now(), seen: (id) => seen.has(id) })
    }
    if (!opened.ok) continue
    markSeen(opened.message.id)
    await handle(opened.message.type, opened.message.from, opened.message.transfer, opened.message.body)
  }
}

/** Offers and handovers this device left that nobody took: gone after a day. */
async function cleanUp(client: DriveClient): Promise<void> {
  if (cleaned) return
  cleaned = true
  const files = await client.search(`appProperties has { key='sondraVon' and value='${selfId}' }`)
  const old = Date.now() - 24 * 60 * 60_000
  for (const file of files) {
    if (file.modifiedTime && Date.parse(file.modifiedTime) < old) await client.remove(file.id).catch(() => undefined)
  }
}

async function round(): Promise<void> {
  if (busy || !state().enabled || !own) return
  const client = deviceDrive()
  if (!client) {
    if (state().status !== 'waiting-drive') set({ status: 'waiting-drive' })
    return
  }
  busy = true
  try {
    const now = Date.now()
    if (now - lastList > LIST_EVERY || state().status !== 'ready') await refreshList(client, { beat: now - lastBeat > BEAT_EVERY })
    else if (now - lastBeat > BEAT_EVERY) await refreshList(client, { beat: true })
    await readPost(client)
    await cleanUp(client)
  } catch (error) {
    set({ status: 'error', problem: error instanceof Error ? error.message : String(error) })
  } finally {
    busy = false
  }
}

function schedule() {
  for (const timer of timers) window.clearTimeout(timer)
  timers = []
  if (!state().enabled) return
  const next = () => {
    const waiting = state().transfers.some((entry) => WAITING.includes(entry.state) && entry.state !== 'asking')
    const wait = waiting ? POLL_BUSY : document.visibilityState === 'visible' ? POLL_FRONT : POLL_BACK
    timers = [window.setTimeout(() => void round().finally(next), wait)]
  }
  void round().finally(next)
}

/** Something was just sent that the other side will answer: look again soon, not in fifteen seconds. */
function lookSoon() {
  if (!state().enabled) return
  for (const timer of timers) window.clearTimeout(timer)
  timers = [window.setTimeout(() => schedule(), 400)]
}

let started = false

/** Starts the rounds when the switch is on; called once by the app. */
export function initDevices(): void {
  if (started || typeof window === 'undefined') return
  started = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state().enabled) {
      lastList = 0
      void round()
    }
  })
  // Drive signed in later: start then.
  useDrive.subscribe((current, previous) => {
    if (current.connected && !previous.connected && state().enabled) {
      lastList = 0
      void round()
    }
  })
  if (state().enabled) void join()
}

async function join(): Promise<void> {
  set({ status: 'joining', problem: null })
  try {
    let stored = await loadOwn()
    if (!stored) {
      stored = { keys: await makeKeys(), name: defaultName(), created: Date.now() }
      await saveOwn(stored)
    }
    own = stored
    selfId = (await signRecord(own.keys, { name: own.name, kind: kindHere(), platform: platformHere(), created: own.created, seen: 0, caps: ownCaps() })).id
    lastList = 0
    lastBeat = 0
    schedule()
  } catch (error) {
    set({ status: 'error', problem: error instanceof Error ? error.message : String(error) })
  }
}

/** The switch on the page „Geräte“. Off removes this device's record from Drive; its key stays for next time. */
export async function setDevicesEnabled(enabled: boolean): Promise<void> {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // Then only for this visit.
  }
  set({ enabled })
  if (enabled) {
    await join()
    return
  }
  for (const timer of timers) window.clearTimeout(timer)
  timers = []
  const client = deviceDrive()
  if (client && own?.fileId) await client.remove(own.fileId).catch(() => undefined)
  if (own) {
    own.fileId = undefined
    await saveOwn(own)
  }
  set({ status: 'off', self: null, devices: [], notes: [] })
}

/** Leaves for good: record and key gone; joining again makes a new device. */
export async function forgetThisDevice(): Promise<void> {
  await setDevicesEnabled(false)
  await forgetOwn().catch(() => undefined)
  own = null
  selfId = ''
}

/** A new name for this device, made unique among the others'. */
export async function renameThisDevice(wanted: string): Promise<string> {
  if (!own) return ''
  const name = uniqueName(wanted, state().devices.map((device) => device.name))
  own.name = name
  await saveOwn(own)
  const client = deviceDrive()
  if (client) await refreshList(client, { beat: true })
  return name
}

/** Deletes a device's entry in Drive, and every copy of it. */
async function dropEntry(client: DriveClient, id: string): Promise<void> {
  const files = await client.search(`appProperties has { key='sondraGeraet' and value='${id}' }`)
  for (const file of files) {
    await client.remove(file.id)
    recordCache.delete(file.id)
  }
}

/**
 * „Das war dieses Gerät“: after a reinstall the old entry is this device
 * under a lost key. It goes, and this device takes its name.
 */
export async function adoptFormer(id: string): Promise<void> {
  const client = deviceDrive()
  const former = state().former.find((device) => device.id === id)
  if (!client || !own || !former || isOnline(former)) return
  await dropEntry(client, id)
  own.name = uniqueName(
    former.name,
    state().devices.filter((device) => device.id !== id).map((device) => device.name),
  )
  own.decided = true
  await saveOwn(own)
  set({ devices: state().devices.filter((device) => device.id !== id), former: [] })
  await refreshList(client, { beat: true })
}

/** „Nein, ein anderes Gerät“: the old entries stay, and the question is not asked again. */
export async function dismissFormer(): Promise<void> {
  if (!own) return
  own.decided = true
  await saveOwn(own)
  set({ former: [] })
}

/**
 * Takes an entry off the list that is not open now. Safe for a device still
 * in use: it writes its entry again on its next round and is back.
 */
export async function removeDevice(id: string): Promise<void> {
  const client = deviceDrive()
  const device = state().devices.find((entry) => entry.id === id)
  if (!client || !device || isOnline(device)) return
  await dropEntry(client, id)
  set({ devices: state().devices.filter((entry) => entry.id !== id), former: state().former.filter((entry) => entry.id !== id) })
}

export function refreshDevices(): void {
  lastList = 0
  void round()
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

async function post(to: string, type: string, transfer: string, body: unknown): Promise<void> {
  const client = deviceDrive()
  if (!client || !own) throw new Error('Google Drive ist nicht verbunden.')
  const message = await sealMessage(own.keys, { id: randomId(), from: selfId, to, at: Date.now(), type, transfer, body })
  await client.create(POST, `${type}-${message.id}.json`, jsonBlob(message), {
    mime: 'application/json',
    appProperties: { sondraAn: to, sondraVon: selfId },
  })
}

interface OfferBody {
  sdp: string
  files: FileInfo[]
  /** The same transfer again after a break: the receiver goes on from what it kept, without asking. */
  resume?: boolean
  /** One film to play on arrival instead of saving it. */
  play?: boolean
}

interface DriveBody {
  files: (FileInfo & { id: string })[]
}

/** A transfer's id as `randomId` makes it; anything else is not looked up, let alone put into a Drive query. */
const TRANSFER_ID = /^[0-9A-HJKMNP-TV-Z]{20}$/

async function handle(type: string, from: string, transferId: string, body: unknown): Promise<void> {
  if (!TRANSFER_ID.test(transferId)) return
  const transfer = state().transfers.find((entry) => entry.id === transferId)
  const peerName = state().devices.find((device) => device.id === from)?.name ?? shortId(from)
  if (type === 'text') {
    const raw = (body as { text?: unknown } | null)?.text
    const text = typeof raw === 'string' ? raw.slice(0, TEXT_MAX).trim() : ''
    if (!text || state().notes.some((note) => note.id === transferId)) return
    const note: Note = { id: transferId, from, peerName, text, link: linkOf(text), at: Date.now() }
    set((current) => ({ notes: [note, ...current.notes].slice(0, NOTES_KEPT) }))
    return
  }
  if (type === 'play') {
    const raw = (body as { items?: unknown } | null)?.items
    if (!Array.isArray(raw) || state().notes.some((note) => note.id === transferId)) return
    const items: RemoteMedia[] = raw
      .slice(0, 100)
      .filter((item): item is { id: string; name: unknown; size: unknown; type: unknown } => Boolean(item) && typeof item.id === 'string' && DRIVE_ID.test(item.id))
      .map((item) => ({ kind: 'drive' as const, id: item.id, name: safeFileName(String(item.name ?? 'Datei')), size: Number(item.size) || 0, type: String(item.type ?? '') }))
      .filter((item) => isPlayableMime(item.type, item.name))
    if (!items.length) return
    const first = items[0].name
    const text = items.length > 1 ? `„${first}“ und ${items.length - 1} weitere` : `„${first}“`
    set((current) => ({ notes: [{ id: transferId, from, peerName, text, link: null, at: Date.now(), play: items }, ...current.notes].slice(0, NOTES_KEPT) }))
    return
  }
  if (type === 'offer') {
    const offer = body as OfferBody
    if (!offer || typeof offer.sdp !== 'string' || !Array.isArray(offer.files)) return
    const files = offer.files.slice(0, FOLDER_FILES_MAX).map((file) => {
      const split = splitPath(typeof file.path === 'string' ? file.path : undefined, String(file.name))
      return {
        name: safeFileName(String(file.name)),
        size: Number(file.size) || 0,
        mime: String(file.mime || ''),
        ...(split.dir ? { path: `${split.dir}/${split.name}` } : {}),
      }
    })
    if (transfer) {
      // The same transfer again after a break: a receiver that kept the first part goes on by itself, since
      // it said yes to exactly these files; one that kept nothing treats it as a new offer and asks.
      const same =
        transfer.direction === 'in' &&
        transfer.peer === from &&
        transfer.files.length === files.length &&
        transfer.files.every((file, index) => file.name === files[index].name && file.size === files[index].size && file.path === files[index].path)
      if (!same || offer.resume !== true || !['failed', 'direct-failed'].includes(transfer.state)) return
      if (keptByTransfer.has(transferId)) {
        void continueIncoming(transfer, offer.sdp)
        return
      }
      set((current) => ({ transfers: current.transfers.filter((entry) => entry.id !== transferId) }))
    }
    const toPlay = offer.play === true && files.length === 1 && files[0].size <= PLAY_TRANSFER_MAX && isPlayableMime(files[0].mime, files[0].name)
    offers.set(transferId, offer.sdp)
    addTransfer({
      id: transferId,
      direction: 'in',
      peer: from,
      peerName,
      files,
      total: files.reduce((sum, file) => sum + file.size, 0),
      done: 0,
      state: 'asking',
      at: Date.now(),
      ...(toPlay ? { play: true } : {}),
    })
    return
  }
  if (!transfer || transfer.peer !== from) return
  if (transfer.direction === 'out') {
    const pending = outgoingPending.get(transferId)
    if (type === 'answer' && pending && typeof (body as { sdp?: unknown })?.sdp === 'string') {
      pending.answered((body as { sdp: string }).sdp)
    } else if (type === 'decline') {
      pending?.close()
      outgoingPending.delete(transferId)
      patchTransfer(transferId, { state: 'declined' })
    } else if (type === 'cancel') {
      pending?.abort.abort()
      pending?.close()
      outgoingPending.delete(transferId)
      patchTransfer(transferId, { state: 'cancelled', error: 'Auf dem anderen Gerät abgebrochen.' })
    } else if (type === 'received') {
      const places = (body as { places?: unknown })?.places
      patchTransfer(transferId, { state: 'done', route: 'drive', done: transfer.total, places: Array.isArray(places) ? places.map(String) : [] })
    }
    return
  }
  // Incoming.
  if (type === 'drive') await receiveViaDrive(transfer, body as DriveBody)
  else if (type === 'cancel') {
    incomingPending.get(transferId)?.abort()
    patchTransfer(transferId, { state: 'cancelled' })
  }
}

/* -------------------------------------------------------------------------- */
/* WebRTC                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * All candidates at once, so one message carries the whole description.
 * Eight seconds at most: a phone names its addresses over mDNS first, and
 * three seconds sent descriptions without them.
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 8000)
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(timer)
        resolve()
      }
    })
  })
}

function wireOf(channel: RTCDataChannel, pc: RTCPeerConnection): Wire {
  channel.binaryType = 'arraybuffer'
  channel.bufferedAmountLowThreshold = 1024 * 1024
  const closers: (() => void)[] = []
  const closed = () => closers.splice(0).forEach((handler) => handler())
  channel.addEventListener('close', closed)
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closed()
  })
  return {
    send: (data) => {
      // A send on a channel that closed throws something about its state; what it means is that the line is gone.
      if (channel.readyState !== 'open') throw new TransferError('closed', 'Die Verbindung brach ab.')
      channel.send(data as string)
    },
    get bufferedAmount() {
      return channel.bufferedAmount
    },
    drained: () => new Promise((resolve) => channel.addEventListener('bufferedamountlow', () => resolve(), { once: true })),
    onMessage: (handler) => channel.addEventListener('message', (event) => handler(event.data as string | ArrayBuffer)),
    onClose: (handler) => closers.push(handler),
    close: () => {
      channel.close()
      pc.close()
    },
  }
}

/** Android lets multicast in only while asked to; outside the app this does nothing. */
let multicastHolds = 0
function holdMulticast(on: boolean) {
  multicastHolds = Math.max(0, multicastHolds + (on ? 1 : -1))
  void ANDROID_BRIDGE?.multicast?.(multicastHolds > 0)
}

/**
 * The open channel, or null. After `soft` the transfer says there is no
 * direct way and offers Drive, but this keeps waiting: an answer that came
 * late, or a phone that found the other's address on the third try, still
 * connects. It stops when the connection fails for good, after
 * `CONNECT_GIVE_UP`, or when the transfer ends another way (cancelled, sent
 * through Drive).
 */
function waitOpen(id: string, pc: RTCPeerConnection, channel: Promise<RTCDataChannel>, soft: number): Promise<RTCDataChannel | null> {
  holdMulticast(true)
  return new Promise((resolve) => {
    let finished = false
    const finish = (value: RTCDataChannel | null) => {
      if (finished) return
      finished = true
      window.clearTimeout(softTimer)
      window.clearTimeout(hardTimer)
      unsubscribe()
      holdMulticast(false)
      resolve(value)
    }
    const softTimer = window.setTimeout(() => {
      if (state().transfers.find((entry) => entry.id === id)?.state === 'connecting') patchTransfer(id, { state: 'direct-failed' })
    }, soft)
    const hardTimer = window.setTimeout(() => finish(null), CONNECT_GIVE_UP)
    const unsubscribe = useDevices.subscribe((current) => {
      const transfer = current.transfers.find((entry) => entry.id === id)
      if (!transfer || !['connecting', 'direct-failed'].includes(transfer.state)) finish(null)
    })
    const watch = () => {
      if (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed') finish(null)
    }
    pc.addEventListener('iceconnectionstatechange', watch)
    pc.addEventListener('connectionstatechange', watch)
    void channel.then((ready) => {
      if (ready.readyState === 'open') finish(ready)
      else ready.addEventListener('open', () => finish(ready), { once: true })
    })
  })
}

/** Still waiting on a direct way (or shown as having none, but not yet given up)? */
const stillDirect = (id: string) => ['connecting', 'direct-failed'].includes(state().transfers.find((entry) => entry.id === id)?.state ?? '')

/* -------------------------------------------------------------------------- */
/* Sending                                                                    */
/* -------------------------------------------------------------------------- */

interface OutgoingPending {
  files: File[]
  infos: FileInfo[]
  answered: (sdp: string) => void
  close: () => void
  abort: AbortController
}

const outgoingPending = new Map<string, OutgoingPending>()

/** Most files in one transfer: the list travels in a single message through Drive. */
export const FOLDER_FILES_MAX = 300

/** At most this many transfers send at once; the rest wait their turn on their open channel. */
const SEND_SLOTS = 2
let slotsBusy = 0
const slotQueue: (() => void)[] = []

function takeSlot(signal: AbortSignal, onWait: () => void): Promise<(() => void) | null> {
  const release = () => {
    slotsBusy -= 1
    slotQueue.shift()?.()
  }
  if (slotsBusy < SEND_SLOTS) {
    slotsBusy += 1
    return Promise.resolve(release)
  }
  onWait()
  return new Promise((resolve) => {
    const start = () => {
      signal.removeEventListener('abort', leave)
      slotsBusy += 1
      resolve(release)
    }
    const leave = () => {
      const at = slotQueue.indexOf(start)
      if (at >= 0) slotQueue.splice(at, 1)
      resolve(null)
    }
    slotQueue.push(start)
    signal.addEventListener('abort', leave, { once: true })
  })
}

/** Offers files to another device; it says yes or no there. */
export async function sendToDevice(deviceId: string, files: File[], options: { play?: boolean; paths?: string[] } = {}): Promise<string> {
  const device = state().devices.find((entry) => entry.id === deviceId)
  if (!device || !files.length) throw new Error('Gerät oder Dateien fehlen.')
  if (options.play && !can(device, 'play')) throw new Error(`Auf „${device.name}“ läuft eine ältere Version von Sondra. Mit dem nächsten Update geht es.`)
  if (options.play && (files.length !== 1 || files[0].size > PLAY_TRANSFER_MAX)) throw new Error('Zum Abspielen geht eine Datei bis 2 GB; grössere bitte senden und dort öffnen.')
  if (options.paths && !can(device, 'folder')) throw new Error(`Auf „${device.name}“ läuft eine ältere Version von Sondra. Ordner gehen nach deren Update.`)
  if (files.length > FOLDER_FILES_MAX) throw new Error(`Das sind ${files.length} Dateien; eine Übertragung nimmt bis ${FOLDER_FILES_MAX}. Senden Sie sie in Teilen oder als ZIP.`)
  const id = randomId()
  const infos: FileInfo[] = files.map((file, index) => {
    const placed = options.paths?.[index]
    const split = placed ? splitPath(placed, file.name) : null
    return {
      name: split ? split.name : safeFileName(file.name),
      size: file.size,
      mime: file.type || 'application/octet-stream',
      ...(split?.dir ? { path: `${split.dir}/${split.name}` } : {}),
    }
  })
  addTransfer({
    id,
    direction: 'out',
    peer: deviceId,
    peerName: device.name,
    files: infos,
    total: infos.reduce((sum, file) => sum + file.size, 0),
    done: 0,
    state: 'offering',
    at: Date.now(),
    ...(options.play ? { play: true } : {}),
  })

  await offerOut(id, deviceId, files, infos, { play: options.play })
  return id
}

/**
 * The offer itself: a connection prepared, its description sent, and then —
 * once it is answered and open — the files over it. Also what „Fortsetzen“
 * runs again for a transfer that broke.
 */
async function offerOut(id: string, deviceId: string, files: File[], infos: FileInfo[], options: { play?: boolean; resume?: boolean }): Promise<void> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const channel = pc.createDataChannel('sondra', { ordered: true })
  const abort = new AbortController()
  let answered: (sdp: string) => void = () => undefined
  const answer = new Promise<string>((resolve) => (answered = resolve))
  outgoingPending.set(id, { files, infos, answered, close: () => pc.close(), abort })

  try {
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)
    await post(deviceId, 'offer', id, { sdp: pc.localDescription?.sdp ?? '', files: infos, ...(options.play ? { play: true } : {}), ...(options.resume ? { resume: true } : {}) } satisfies OfferBody)
    lookSoon()
  } catch (error) {
    pc.close()
    outgoingPending.delete(id)
    patchTransfer(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
    return
  }

  void (async () => {
    const sdp = await Promise.race([answer, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), OFFER_TIMEOUT))])
    const current = state().transfers.find((entry) => entry.id === id)
    if (!current || current.state !== 'offering') return
    if (sdp === null) {
      pc.close()
      outgoingPending.delete(id)
      patchTransfer(id, { state: 'expired' })
      return
    }
    patchTransfer(id, { state: 'connecting' })
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp })
    } catch {
      patchTransfer(id, { state: 'direct-failed' })
      return
    }
    const open = await waitOpen(id, pc, Promise.resolve(channel), CONNECT_SOFT_SENDER)
    if (!open || !stillDirect(id)) {
      pc.close()
      if (stillDirect(id)) patchTransfer(id, { state: 'direct-failed' })
      return
    }
    const release = await takeSlot(abort.signal, () => patchTransfer(id, { queued: true }))
    if (!release) {
      pc.close()
      outgoingPending.delete(id)
      return
    }
    patchTransfer(id, { state: 'sending', route: 'direct', error: undefined, queued: false, resumable: false })
    let broke = false
    try {
      const places = await sendOver(
        wireOf(channel, pc),
        files.map((file, index) => outgoing(file, infos[index].name, infos[index].path)),
        { signal: abort.signal, onProgress: ({ done }) => patchTransfer(id, { done }) },
      )
      patchTransfer(id, { state: 'done', done: infos.reduce((sum, file) => sum + file.size, 0), places })
      window.setTimeout(() => pc.close(), 1000)
    } catch (error) {
      const code = error instanceof TransferError ? error.code : 'failed'
      // A broken line is not the end: the files stay at hand, and „Fortsetzen“ goes on from what the other side kept.
      broke = code === 'closed' && can(state().devices.find((entry) => entry.id === deviceId), 'resume')
      patchTransfer(id, {
        state: code === 'cancelled' ? 'cancelled' : code === 'refused' ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(broke ? { resumable: true } : {}),
      })
    } finally {
      release()
      if (!broke) outgoingPending.delete(id)
    }
  })()
}

/** When no direct way was found: through Drive, after the user said so. */
export async function sendViaDrive(id: string): Promise<void> {
  const transfer = state().transfers.find((entry) => entry.id === id)
  const pending = outgoingPending.get(id)
  const client = deviceDrive()
  if (!transfer || !pending || !client) return
  patchTransfer(id, { state: 'via-drive', route: 'drive', done: 0, error: undefined })
  try {
    const placed: DriveBody['files'] = []
    let before = 0
    for (const [index, file] of pending.files.entries()) {
      const info = transfer.files[index]
      const made = await client.create(HANDOVER, info.name, file, {
        mime: info.mime,
        appProperties: { sondraUebergabe: id, sondraVon: selfId },
        signal: pending.abort.signal,
        onProgress: (loaded) => patchTransfer(id, { done: before + loaded }),
      })
      before += info.size
      placed.push({ ...info, id: made.id })
    }
    await post(transfer.peer, 'drive', id, { files: placed } satisfies DriveBody)
    // `received` from the other side finishes it.
  } catch (error) {
    patchTransfer(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
  }
}

/** After a break: the same files again to the same device, which goes on from what it kept. */
export async function resumeTransfer(id: string): Promise<void> {
  const transfer = state().transfers.find((entry) => entry.id === id)
  const pending = outgoingPending.get(id)
  if (!transfer || !pending || transfer.direction !== 'out' || !transfer.resumable) return
  patchTransfer(id, { state: 'offering', error: undefined, resumable: false })
  await offerOut(id, transfer.peer, pending.files, pending.infos, { play: transfer.play, resume: true })
}

export function cancelTransfer(id: string): void {
  const transfer = state().transfers.find((entry) => entry.id === id)
  if (!transfer) return
  if (transfer.direction === 'out') {
    const pending = outgoingPending.get(id)
    pending?.abort.abort()
    pending?.close()
    outgoingPending.delete(id)
    void post(transfer.peer, 'cancel', id, {}).catch(() => undefined)
  } else {
    incomingPending.get(id)?.abort()
    incomingPending.delete(id)
    // Over the channel the sender hears it there; waiting for Drive, only by message.
    void post(transfer.peer, 'cancel', id, {}).catch(() => undefined)
  }
  patchTransfer(id, { state: 'cancelled' })
}

export function dismissTransfer(id: string): void {
  const transfer = state().transfers.find((entry) => entry.id === id)
  // Closing a broken transfer gives up on it: no one goes on from here.
  if (transfer?.resumable) {
    void dropKept(id)
    outgoingPending.delete(id)
  }
  patchTransfer(id, { dismissed: true, resumable: false })
}

/**
 * Drive's own files to be played on another device: no transfer, only the
 * names of the files in Drive — that device streams them itself, with its own
 * sign-in. It is asked first.
 */
export async function playOnDevice(deviceId: string, items: Pick<RemoteMedia, 'id' | 'name' | 'size' | 'type'>[]): Promise<void> {
  const device = state().devices.find((entry) => entry.id === deviceId)
  if (!device) throw new Error('Dieses Gerät ist nicht mehr in der Liste.')
  if (!can(device, 'play')) throw new Error(`Auf „${device.name}“ läuft eine ältere Version von Sondra. Mit dem nächsten Update geht es.`)
  const playable = items.filter((item) => isPlayableMime(item.type, item.name)).slice(0, 100)
  if (!playable.length) throw new Error('Das lässt sich nicht abspielen.')
  await post(deviceId, 'play', randomId(), { items: playable.map(({ id, name, size, type }) => ({ id, name, size, type })) })
  lookSoon()
}

/** „Abspielen“ on a card: what the other device asked to be played starts here. */
export function playNote(id: string): void {
  const note = state().notes.find((entry) => entry.id === id)
  if (!note?.play) return
  dismissNote(id)
  playHere(note.play)
}

export function dismissNote(id: string): void {
  set((current) => ({ notes: current.notes.filter((note) => note.id !== id) }))
}

/**
 * A line of text or a link to another device. It waits in Drive until that
 * device looks (and is deleted there once read); nothing says it arrived, so
 * the sender is told only that it was sent.
 */
export async function sendText(deviceId: string, text: string): Promise<void> {
  const device = state().devices.find((entry) => entry.id === deviceId)
  if (!device) throw new Error('Dieses Gerät ist nicht mehr in der Liste.')
  if (!can(device, 'text')) throw new Error(`Auf „${device.name}“ läuft eine ältere Version von Sondra. Mit dem nächsten Update geht es.`)
  const clean = text.trim().slice(0, TEXT_MAX)
  if (!clean) throw new Error('Es gibt nichts zu senden.')
  await post(deviceId, 'text', randomId(), { text: clean })
  lookSoon()
}

/* -------------------------------------------------------------------------- */
/* Receiving                                                                  */
/* -------------------------------------------------------------------------- */

const offers = new Map<string, string>()
const incomingPending = new Map<string, { abort: () => void; sinkFor: SinkFor }>()

const HANDLE_KEY = 'empfang'

/** A folder handle from an earlier visit, if the browser still lets it be written. */
async function storedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await idb<FileSystemDirectoryHandle | undefined>('readonly', (store) => store.get(HANDLE_KEY) as IDBRequest<FileSystemDirectoryHandle | undefined>)
    if (!handle) return null
    const permissioned = handle as FileSystemDirectoryHandle & {
      queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>
      requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>
    }
    if ((await permissioned.queryPermission?.({ mode: 'readwrite' })) === 'granted') return handle
    if ((await permissioned.requestPermission?.({ mode: 'readwrite' })) === 'granted') return handle
    return null
  } catch {
    return null
  }
}

type DirectoryPicker = (options: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>

/** Where received files go here; must be called in the click that accepted. */
async function receiveTarget(): Promise<{ sinkFor: SinkFor; where: string }> {
  const bridge = ANDROID_BRIDGE
  if (bridge?.openSave) {
    return {
      where: 'Downloads/Sondra',
      sinkFor: async (file) => {
        // A folder's files go into their folders; an app before 1.1.23 saves them flat.
        const save = await bridge.openSave(file.name, file.mime || 'application/octet-stream', splitPath(file.path, file.name).dir)
        return {
          write: (chunk) => save.write(chunk),
          close: () => save.close(),
          abort: async () => save.abort(),
        }
      },
    }
  }
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  if (picker) {
    let folder = await storedFolder()
    if (!folder) {
      try {
        folder = await picker({ id: 'sondra-empfang', mode: 'readwrite', startIn: 'downloads' })
        await idb('readwrite', (store) => store.put(folder, HANDLE_KEY)).catch(() => undefined)
      } catch {
        folder = null
      }
    }
    if (folder) {
      const root = folder
      // Folders already looked into, with the names in them.
      const listed = new Map<string, { handle: FileSystemDirectoryHandle; taken: Set<string> }>()
      const folderAt = async (path: string) => {
        const known = listed.get(path)
        if (known) return known
        let handle = root
        for (const part of path.split('/').filter(Boolean)) handle = await handle.getDirectoryHandle(part, { create: true })
        const taken = new Set<string>()
        for await (const name of (handle as unknown as { keys: () => AsyncIterable<string> }).keys()) taken.add(name)
        const entry = { handle, taken }
        listed.set(path, entry)
        return entry
      }
      return {
        where: root.name,
        sinkFor: async (file, _index, piece) => {
          // A half file from before the break: reopened and written on from where it ends.
          const again = piece?.token as { dir: FileSystemDirectoryHandle; name: string; shown: string } | undefined
          let dirHandle: FileSystemDirectoryHandle
          let name: string
          let shown: string
          if (again) {
            dirHandle = again.dir
            name = again.name
            shown = again.shown
          } else {
            const split = splitPath(file.path, file.name)
            const here = await folderAt(split.dir)
            name = freeName(split.name, (candidate) => here.taken.has(candidate))
            here.taken.add(name)
            dirHandle = here.handle
            shown = `${root.name}/${split.dir ? `${split.dir}/` : ''}${name}`
          }
          const handle = await dirHandle.getFileHandle(name, { create: !again })
          const writable = await handle.createWritable(again ? { keepExistingData: true } : undefined)
          let bytes = again ? piece!.bytes : 0
          if (again) await (writable as unknown as { seek: (position: number) => Promise<void> }).seek(bytes)
          return {
            write: async (chunk) => {
              await writable.write(chunk as Uint8Array<ArrayBuffer>)
              bytes += chunk.byteLength
            },
            close: async () => {
              await writable.close()
              return shown
            },
            abort: async () => {
              await writable.abort().catch(() => undefined)
              await dirHandle.removeEntry(name).catch(() => undefined)
            },
            // The line broke: closing keeps what was written, and the file is as long as `bytes`.
            suspend: async () => {
              await writable.close()
              return {
                bytes,
                token: { dir: dirHandle, name, shown },
                intact: async () => (await (await dirHandle.getFileHandle(name)).getFile()).size === bytes,
                discard: async () => {
                  await dirHandle.removeEntry(name).catch(() => undefined)
                },
              }
            },
          }
        },
      }
    }
  }
  // Firefox, Safari: held, then handed to the browser's downloads. A broken
  // transfer keeps what it held, for as long as the page is open.
  return {
    where: 'Downloads',
    sinkFor: async (file, _index, piece) => {
      const parts: Uint8Array<ArrayBuffer>[] = (piece?.token as Uint8Array<ArrayBuffer>[] | undefined) ?? []
      let bytes = piece?.bytes ?? 0
      return {
        write: async (chunk) => {
          parts.push(chunk as Uint8Array<ArrayBuffer>)
          bytes += chunk.byteLength
        },
        close: async () => {
          // No folders here: the path becomes part of the name.
          const flat = splitPath(file.path, file.name)
          const name = flat.dir ? `${flat.dir.split('/').join(' – ')} – ${flat.name}` : flat.name
          saveBytes(new Blob(parts, { type: file.mime }), name, file.mime)
          parts.length = 0
          return `Downloads/${name}`
        },
        abort: async () => {
          parts.length = 0
        },
        suspend: async () => ({ bytes, token: parts, discard: async () => void (parts.length = 0) }),
      }
    },
  }
}

/**
 * A film to play, not to keep: collected in blocks of 32 MB, so the browser
 * can move them out of memory as they pile up, and handed over whole.
 */
function playTarget(arrived: (file: File) => void): { sinkFor: SinkFor; where: string } {
  return {
    where: 'Player',
    sinkFor: async (info) => {
      const blocks: Blob[] = []
      let parts: Uint8Array<ArrayBuffer>[] = []
      let held = 0
      const flush = () => {
        if (!parts.length) return
        blocks.push(new Blob(parts))
        parts = []
        held = 0
      }
      return {
        write: async (chunk) => {
          parts.push(chunk as Uint8Array<ArrayBuffer>)
          held += chunk.byteLength
          if (held >= 32 * 1024 * 1024) flush()
        },
        close: async () => {
          flush()
          arrived(new File(blocks, info.name, { type: info.mime || 'video/mp4' }))
          return 'Player'
        },
        abort: async () => {
          parts = []
          blocks.length = 0
        },
      }
    },
  }
}

/** A film received to be played, until it is: by the channel or through Drive. */
const arrivedToPlay = new Map<string, File>()
function startArrived(id: string): void {
  const file = arrivedToPlay.get(id)
  arrivedToPlay.delete(id)
  if (file) playHere([file])
}

/** The file to the player, and the player in front. */
function playHere(items: (File | RemoteMedia)[]): void {
  sendToPlayer(items, true)
  useSession.getState().setPanel('player')
}

/** „Annehmen“: the place for the files is chosen in this click, then the answer goes back. */
export async function acceptTransfer(id: string): Promise<void> {
  const transfer = state().transfers.find((entry) => entry.id === id)
  const sdp = offers.get(id)
  if (!transfer || transfer.state !== 'asking' || !sdp) return
  patchTransfer(id, { state: 'connecting' })
  let target: Awaited<ReturnType<typeof receiveTarget>>
  try {
    target = transfer.play ? playTarget((file) => arrivedToPlay.set(id, file)) : await receiveTarget()
  } catch (error) {
    patchTransfer(id, { state: 'failed', error: error instanceof Error ? error.message : String(error) })
    return
  }
  await receiveOn(id, transfer, sdp, target)
}

/** What a broken transfer kept on this side, and the place it was being written to. */
const keptByTransfer = new Map<string, { kept: Kept; target: { sinkFor: SinkFor; where: string } }>()

/** The sender took up a transfer that broke: it goes on from what was kept, with no question asked again. */
async function continueIncoming(transfer: Transfer, sdp: string): Promise<void> {
  const entry = keptByTransfer.get(transfer.id)
  if (!entry) return
  patchTransfer(transfer.id, { state: 'connecting', error: undefined, resumable: false })
  await receiveOn(transfer.id, transfer, sdp, entry.target, entry.kept)
}

/** The connection, the answer, and the files over it — for a first attempt and for one after a break. */
async function receiveOn(id: string, transfer: Transfer, sdp: string, target: { sinkFor: SinkFor; where: string }, kept?: Kept): Promise<void> {
  const control = new AbortController()
  incomingPending.set(id, { abort: () => control.abort(), sinkFor: target.sinkFor })

  const pc = new RTCPeerConnection({ iceServers: [] })
  const channelArrived = new Promise<RTCDataChannel>((resolve) => pc.addEventListener('datachannel', (event) => resolve(event.channel)))
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp })
    await pc.setLocalDescription(await pc.createAnswer())
    await gathered(pc)
    await post(transfer.peer, 'answer', id, { sdp: pc.localDescription?.sdp ?? '' })
    lookSoon()
  } catch (error) {
    pc.close()
    patchTransfer(id, { state: 'direct-failed', error: error instanceof Error ? error.message : String(error) })
    return
  }
  offers.delete(id)

  const channel = await waitOpen(id, pc, channelArrived, CONNECT_SOFT_RECEIVER)
  if (!channel || !stillDirect(id)) {
    pc.close()
    // The sender is asked whether to go through Drive; its message finishes this.
    if (stillDirect(id)) patchTransfer(id, { state: 'direct-failed' })
    return
  }
  patchTransfer(id, { state: 'receiving', route: 'direct', error: undefined })
  try {
    const places = await receiveOver(wireOf(channel, pc), target.sinkFor, {
      signal: control.signal,
      onProgress: ({ done }) => patchTransfer(id, { done }),
      kept,
      // Only a transfer that can go on from here keeps anything: not the film on its way to the player.
      onKept: transfer.play
        ? undefined
        : (left) => {
            keptByTransfer.set(id, { kept: left, target })
            if (Object.keys(left.pieces).length + Object.keys(left.places).length > 0) patchTransfer(id, { resumable: true })
          },
    })
    keptByTransfer.delete(id)
    patchTransfer(id, { state: 'done', done: transfer.total, places, resumable: false })
    window.setTimeout(() => pc.close(), 1000)
    startArrived(id)
  } catch (error) {
    const code = error instanceof TransferError ? error.code : 'failed'
    if (code !== 'closed') void dropKept(id)
    patchTransfer(id, {
      state: code === 'cancelled' || code === 'refused' ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    incomingPending.delete(id)
  }
}

/** Gives up what a broken transfer kept: the half files go. */
async function dropKept(id: string): Promise<void> {
  const entry = keptByTransfer.get(id)
  keptByTransfer.delete(id)
  if (!entry) return
  await Promise.all(Object.values(entry.kept.pieces).map((piece) => piece.discard?.().catch(() => undefined)))
}

export async function declineTransfer(id: string): Promise<void> {
  const transfer = state().transfers.find((entry) => entry.id === id)
  if (!transfer) return
  offers.delete(id)
  patchTransfer(id, { state: 'declined', dismissed: true })
  await post(transfer.peer, 'decline', id, {}).catch(() => undefined)
}

async function receiveViaDrive(transfer: Transfer, body: DriveBody): Promise<void> {
  const client = deviceDrive()
  const pending = incomingPending.get(transfer.id)
  if (!client || !pending || !Array.isArray(body?.files)) return
  let aborted = false
  const control = { abort: () => (aborted = true), sinkFor: pending.sinkFor }
  incomingPending.set(transfer.id, control)
  patchTransfer(transfer.id, { state: 'via-drive', route: 'drive', done: 0, error: undefined })
  const places: string[] = []
  let before = 0
  try {
    // Only what was put there for this transfer is fetched and deleted — never another file by its id.
    const handed = new Set(
      (await client.search(`appProperties has { key='sondraUebergabe' and value='${transfer.id}' }`))
        .filter((file) => file.appProperties?.sondraVon === transfer.peer)
        .map((file) => file.id),
    )
    for (const [index, entry] of body.files.entries()) {
      if (!handed.has(String(entry.id))) throw new Error('Eine Datei in Drive gehört nicht zu dieser Übertragung.')
      const split = splitPath(typeof entry.path === 'string' ? entry.path : undefined, String(entry.name))
      const info: FileInfo = {
        name: safeFileName(String(entry.name)),
        size: Number(entry.size) || 0,
        mime: String(entry.mime || ''),
        ...(split.dir ? { path: `${split.dir}/${split.name}` } : {}),
      }
      const sink: Sink = await pending.sinkFor(info, index)
      const response = await client.open(String(entry.id))
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Drive lieferte nichts')
      let loaded = 0
      for (;;) {
        if (aborted) {
          await reader.cancel().catch(() => undefined)
          await sink.abort()
          throw new TransferError('cancelled')
        }
        const { done, value } = await reader.read()
        if (done) break
        await sink.write(value)
        loaded += value.byteLength
        patchTransfer(transfer.id, { done: before + loaded })
      }
      places.push(await sink.close())
      before += info.size
      await client.remove(String(entry.id)).catch(() => undefined)
    }
    patchTransfer(transfer.id, { state: 'done', done: transfer.total, places })
    startArrived(transfer.id)
    await post(transfer.peer, 'received', transfer.id, { places }).catch(() => undefined)
  } catch (error) {
    patchTransfer(transfer.id, {
      state: error instanceof TransferError && error.code === 'cancelled' ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    incomingPending.delete(transfer.id)
  }
}

/** Others' devices that are on now, the most recently seen first. */
export function onlineDevices(devices: DeviceRecord[], now = Date.now()): DeviceRecord[] {
  return devices.filter((device) => isOnline(device, now))
}
