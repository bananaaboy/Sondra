/**
 * Who a device is, in a way no other device can claim.
 *
 * Every device makes one key pair (ECDSA P-256) the first time it joins; the
 * private key cannot be taken out of the browser (`extractable: false`) and
 * stays in this device's IndexedDB. Its id is the hash of its public key, so
 * an id cannot be chosen, only earned: two devices never share one, and a
 * record that names an id with another key is simply not that device.
 *
 * Every record a device puts into Drive, and every message it sends another,
 * is signed. All devices of one Google account can write each other's files —
 * Drive knows no finer rights than the account — so a record changed by
 * anyone but its owner fails its signature, is ignored, and its owner writes
 * it again on its next round. That is what „cannot be overwritten“ means
 * here: it can be scribbled on, but nobody believes it.
 *
 * Pure functions, no page: `scripts/verify-devices.mts` runs them under Node.
 */

export type DeviceKind = 'windows' | 'android' | 'browser'

export interface DeviceRecord {
  v: 1
  /** The hash of `key`: 20 characters of Crockford base32. */
  id: string
  name: string
  kind: DeviceKind
  /** „Chrome auf Windows“ — what it runs on, in words. */
  platform: string
  key: JsonWebKey
  /** When it joined and when it last said it is here, ms since 1970. */
  created: number
  seen: number
  sig: string
}

export interface Envelope<T = unknown> {
  v: 1
  /** Random; a message is acted on once. */
  id: string
  from: string
  to: string
  at: number
  type: string
  transfer: string
  body: T
  sig: string
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ID_LENGTH = 20
const ID_PATTERN = new RegExp(`^[${ALPHABET}]{${ID_LENGTH}}$`)
const NAME_MAX = 40
/** How old a message may be and still count. */
export const MESSAGE_MAX_AGE = 15 * 60_000

const subtle = () => globalThis.crypto.subtle
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGNING = { name: 'ECDSA', hash: 'SHA-256' } as const

/** JSON with its keys in order, so the same value always signs the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const bytes = new Uint8Array(plain.length)
  for (let i = 0; i < plain.length; i += 1) bytes[i] = plain.charCodeAt(i)
  return bytes
}

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

/** Only what makes the key the key; a JWK may carry `ext`, `key_ops` and the like. */
function publicPart(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
}

export interface DeviceKeys {
  privateKey: CryptoKey
  publicJwk: JsonWebKey
}

/** A new key pair; the private half can sign but never be read out. */
export async function makeKeys(): Promise<DeviceKeys> {
  const pair = (await subtle().generateKey(ALGORITHM, false, ['sign', 'verify'])) as CryptoKeyPair
  const publicJwk = publicPart(await subtle().exportKey('jwk', pair.publicKey))
  return { privateKey: pair.privateKey, publicJwk }
}

/** The id a key earns: its SHA-256, the first 100 bits, in base32. */
export async function deviceIdOf(jwk: JsonWebKey): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', utf8(canonical(publicPart(jwk)))))
  return base32(digest).slice(0, ID_LENGTH)
}

/** The four characters people see beside a name: „Laptop · 7KQ2“. */
export const shortId = (id: string) => id.slice(0, 4)

export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value)

async function signValue(privateKey: CryptoKey, value: Record<string, unknown>): Promise<string> {
  const { sig: _sig, ...rest } = value
  const signature = await subtle().sign(SIGNING, privateKey, utf8(canonical(rest)))
  return toBase64Url(new Uint8Array(signature))
}

async function verifyValue(jwk: JsonWebKey, value: Record<string, unknown>): Promise<boolean> {
  if (typeof value.sig !== 'string') return false
  try {
    const key = await subtle().importKey('jwk', publicPart(jwk), ALGORITHM, false, ['verify'])
    const { sig, ...rest } = value
    return await subtle().verify(SIGNING, key, fromBase64Url(sig as string), utf8(canonical(rest)))
  } catch {
    return false
  }
}

/** A name as it may stand: trimmed, no control characters, at most 40 characters. */
export function cleanName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

/**
 * A name no other device carries: „Laptop“ when it is free, otherwise
 * „Laptop 2“, „Laptop 3“ … Compared without case and spaces at the ends.
 */
export function uniqueName(wanted: string, others: string[]): string {
  const base = cleanName(wanted) || 'Gerät'
  const taken = new Set(others.map((name) => cleanName(name).toLocaleLowerCase('de')))
  if (!taken.has(base.toLocaleLowerCase('de'))) return base
  const stem = base.replace(/\s+\d+$/, '')
  for (let n = 2; ; n += 1) {
    const candidate = cleanName(`${stem.slice(0, NAME_MAX - 4)} ${n}`)
    if (!taken.has(candidate.toLocaleLowerCase('de'))) return candidate
  }
}

/** This device's record, signed. */
export async function signRecord(keys: DeviceKeys, fields: Omit<DeviceRecord, 'v' | 'id' | 'key' | 'sig'>): Promise<DeviceRecord> {
  const id = await deviceIdOf(keys.publicJwk)
  const unsigned = {
    v: 1 as const,
    id,
    name: cleanName(fields.name) || 'Gerät',
    kind: fields.kind,
    platform: cleanName(fields.platform),
    key: keys.publicJwk,
    created: fields.created,
    seen: fields.seen,
  }
  return { ...unsigned, sig: await signValue(keys.privateKey, unsigned) }
}

/**
 * A record read from Drive, believed only if it is whole, its id is its
 * key's, and its owner signed exactly this. Anything else is null.
 */
export async function checkRecord(raw: unknown): Promise<DeviceRecord | null> {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<DeviceRecord>
  if (record.v !== 1 || !isDeviceId(record.id) || !record.key || typeof record.key !== 'object') return null
  if (typeof record.name !== 'string' || cleanName(record.name) !== record.name || !record.name) return null
  if (record.kind !== 'windows' && record.kind !== 'android' && record.kind !== 'browser') return null
  if (typeof record.platform !== 'string' || !Number.isFinite(record.created) || !Number.isFinite(record.seen)) return null
  if ((await deviceIdOf(record.key)) !== record.id) return null
  if (!(await verifyValue(record.key, record as Record<string, unknown>))) return null
  return record as DeviceRecord
}

/**
 * The devices of the account from what Drive holds: per id the believable
 * record seen last. Copies, replays of older records and forgeries drop out.
 */
export async function pickDevices(raws: unknown[]): Promise<DeviceRecord[]> {
  const best = new Map<string, DeviceRecord>()
  for (const raw of raws) {
    const record = await checkRecord(raw)
    if (!record) continue
    const known = best.get(record.id)
    if (!known || record.seen > known.seen) best.set(record.id, record)
  }
  return [...best.values()].sort((a, b) => b.seen - a.seen)
}

/** A message to another device, signed by this one. */
export async function sealMessage<T>(
  keys: DeviceKeys,
  fields: { id: string; from: string; to: string; at: number; type: string; transfer: string; body: T },
): Promise<Envelope<T>> {
  const unsigned = { v: 1 as const, ...fields }
  return { ...unsigned, sig: await signValue(keys.privateKey, unsigned as unknown as Record<string, unknown>) }
}

export type MessageProblem = 'malformed' | 'not-for-me' | 'unknown-sender' | 'forged' | 'stale' | 'replayed'

/**
 * A message is acted on only if it is for this device, from a device the
 * account knows, signed by that device's key, recent, and new.
 */
export async function openMessage(
  raw: unknown,
  { self, devices, now, seen }: { self: string; devices: DeviceRecord[]; now: number; seen: (id: string) => boolean },
): Promise<{ ok: true; message: Envelope } | { ok: false; problem: MessageProblem }> {
  if (!raw || typeof raw !== 'object') return { ok: false, problem: 'malformed' }
  const message = raw as Partial<Envelope>
  if (message.v !== 1 || typeof message.id !== 'string' || typeof message.type !== 'string' || typeof message.transfer !== 'string') {
    return { ok: false, problem: 'malformed' }
  }
  if (!isDeviceId(message.from) || !isDeviceId(message.to) || !Number.isFinite(message.at)) return { ok: false, problem: 'malformed' }
  if (message.to !== self) return { ok: false, problem: 'not-for-me' }
  const sender = devices.find((device) => device.id === message.from)
  if (!sender) return { ok: false, problem: 'unknown-sender' }
  if (!(await verifyValue(sender.key, message as Record<string, unknown>))) return { ok: false, problem: 'forged' }
  if (Math.abs(now - (message.at as number)) > MESSAGE_MAX_AGE) return { ok: false, problem: 'stale' }
  if (seen(message.id)) return { ok: false, problem: 'replayed' }
  return { ok: true, message: message as Envelope }
}

/** A random id for a message or a transfer. */
export function randomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  return base32(bytes)
}
