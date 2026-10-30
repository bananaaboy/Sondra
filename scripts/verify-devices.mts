// Devices of one account: ids that cannot be claimed, records that cannot be
// overwritten unnoticed, names that stay apart, messages that cannot be
// forged or replayed, and files that arrive whole with the sender held back
// by a slow receiver.
import {
  can,
  checkRecord,
  deviceIdOf,
  makeKeys,
  openMessage,
  pickDevices,
  randomId,
  sealMessage,
  signRecord,
  uniqueName,
  type DeviceRecord,
} from '../src/lib/deviceIdentity'
import { freeName, outgoing, receiveOver, safeFileName, sendOver, splitPath, TransferError, type Sink, type Wire } from '../src/lib/deviceTransfer'

let failed = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const now = Date.now()
const laptop = await makeKeys()
const phone = await makeKeys()
const intruder = await makeKeys()

const laptopRecord = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now, seen: now })
const phoneRecord = await signRecord(phone, { name: 'Handy', kind: 'android', platform: 'Android-App', created: now, seen: now })

// --- Paths of a received folder --------------------------------------------
const place = (path: string | undefined) => JSON.stringify(splitPath(path, 'Fallback.txt'))
check('Pfad: Ordner und Name getrennt', place('Anime/Staffel 1/Folge 1.mkv') === JSON.stringify({ dir: 'Anime/Staffel 1', name: 'Folge 1.mkv' }))
check('Pfad: ohne Ordner nur der Name', place('Folge.mkv') === JSON.stringify({ dir: '', name: 'Folge.mkv' }))
check('Pfad: „..“ klettert nirgends hinaus', !splitPath('../../etc/passwd', 'x').dir.includes('..') && splitPath('../../etc/passwd', 'x').name === 'passwd', place('../../etc/passwd'))
check('Pfad: absoluter Anfang wird relativ', place('/etc/hosts') === JSON.stringify({ dir: 'etc', name: 'hosts' }))
check('Pfad: Laufwerk und Rückstriche sind Zeichen im Namen, keine Ordner', splitPath('C:\\Windows\\x.txt', 'x').dir === '' && !/[:\\]/.test(splitPath('C:\\Windows\\x.txt', 'x').name), place('C:\\Windows\\x.txt'))
check('Pfad: leer gilt der Ersatzname', place(undefined) === JSON.stringify({ dir: '', name: 'Fallback.txt' }) && place('') === place(undefined) && place('//./..//') === place(undefined))
check('Pfad: höchstens acht Ordner tief', splitPath(`${Array.from({ length: 20 }, (_, n) => `d${n}`).join('/')}/datei.txt`, 'x').dir.split('/').length <= 9)
check('Pfad: „.“ und „..“ als Namen sind Datei', splitPath('a/b/..', 'x').name === 'b' && !place('a/./b').includes('"."'))

// --- Capabilities ---------------------------------------------------------
// A record written by a version without them (no `caps`) must still verify, and
// one with them must not be changeable by hand: a sender trusts this list to
// decide what it may offer.
const modern = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now, seen: now, caps: ['text', 'play', 'folder'] })
check('Eintrag ohne Fähigkeiten gilt weiter', (await checkRecord(JSON.parse(JSON.stringify(laptopRecord)))) !== null && laptopRecord.caps === undefined)
check('Eintrag mit Fähigkeiten gilt', (await checkRecord(JSON.parse(JSON.stringify(modern)))) !== null && can(modern, 'text') && !can(modern, 'resume'))
check('Fähigkeiten sind gleich geordnet signiert', JSON.stringify((await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now, seen: now, caps: ['folder', 'text', 'play'] })).caps) === JSON.stringify(modern.caps))
check('Fähigkeit nachträglich dazugeschrieben: abgelehnt', (await checkRecord({ ...laptopRecord, caps: ['play'] })) === null)
check('Fähigkeit nachträglich gestrichen: abgelehnt', (await checkRecord({ ...modern, caps: ['text'] })) === null)
check('Ein Gerät ohne Liste kann nichts davon', !can(laptopRecord, 'text') && !can(undefined, 'text'))
const junk = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now, seen: now, caps: ['Text!'] })
check('Unsinn in der Liste: abgelehnt', (await checkRecord(JSON.parse(JSON.stringify(junk)))) === null)

// --- Identity -------------------------------------------------------------
check('Id ist der Hash des Schlüssels', laptopRecord.id === (await deviceIdOf(laptop.publicJwk)))
check('Zwei Geräte, zwei Ids', laptopRecord.id !== phoneRecord.id)
check('Id hat 20 Zeichen', laptopRecord.id.length === 20, laptopRecord.id)
check('Gültiger Eintrag wird geglaubt', (await checkRecord(JSON.parse(JSON.stringify(laptopRecord)))) !== null)

const renamed = { ...laptopRecord, name: 'Mein Laptop' }
check('Umbenannt von fremder Hand: abgelehnt', (await checkRecord(renamed)) === null)

const stolenId = await signRecord(intruder, { name: 'Laptop', kind: 'windows', platform: 'x', created: now, seen: now + 10 })
const claimed = { ...stolenId, id: laptopRecord.id }
check('Fremder Schlüssel unter fremder Id: abgelehnt', (await checkRecord(claimed)) === null)

const resigned = { ...laptopRecord, key: intruder.publicJwk }
check('Schlüssel ausgetauscht: abgelehnt', (await checkRecord(resigned)) === null)

const ownPrivate = await crypto.subtle.exportKey('jwk', laptop.privateKey).then(
  () => 'lesbar',
  () => 'nicht lesbar',
)
check('Privater Schlüssel lässt sich nicht auslesen', ownPrivate === 'nicht lesbar')

// --- Picking the devices --------------------------------------------------
const older = await signRecord(laptop, { name: 'Laptop', kind: 'windows', platform: 'Windows-App', created: now, seen: now - 60_000 })
const picked = await pickDevices([older, laptopRecord, renamed, claimed, phoneRecord, { nonsense: true }, null])
check('Je Id ein Gerät, Fälschungen fallen weg', picked.length === 2, picked.map((d) => d.name).join(', '))
check('Der zuletzt gesehene Eintrag gilt', picked.find((d) => d.id === laptopRecord.id)?.seen === now)

// --- Names ----------------------------------------------------------------
check('Freier Name bleibt', uniqueName('Tablet', ['Laptop', 'Handy']) === 'Tablet')
check('Belegter Name bekommt eine Zahl', uniqueName('laptop ', ['Laptop', 'Handy']) === 'laptop 2')
check('Auch die Zahl wird weitergezählt', uniqueName('Laptop', ['Laptop', 'Laptop 2']) === 'Laptop 3')
check('Leerer Name wird „Gerät“', uniqueName('   ', []) === 'Gerät')
check('Steuerzeichen fallen weg', uniqueName('Lap\u0000top\n', []) === 'Laptop')

// --- Messages -------------------------------------------------------------
const devices: DeviceRecord[] = [laptopRecord, phoneRecord]
const seenIds = new Set<string>()
const open = (raw: unknown, at = now) => openMessage(raw, { self: phoneRecord.id, devices, now: at, seen: (id) => seenIds.has(id) })
const message = await sealMessage(laptop, { id: randomId(), from: laptopRecord.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T1', body: { files: 1 } })
const opened = await open(JSON.parse(JSON.stringify(message)))
check('Nachricht vom Laptop ans Handy wird geöffnet', opened.ok)
seenIds.add(message.id)
const replay = await open(message)
check('Dieselbe Nachricht zweimal: abgelehnt', !replay.ok && replay.problem === 'replayed')

const changed = { ...message, id: randomId(), body: { files: 99 } }
const forged = await open(changed)
check('Inhalt verändert: abgelehnt', !forged.ok && forged.problem === 'forged')

const asLaptop = await sealMessage(intruder, { id: randomId(), from: laptopRecord.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T2', body: {} })
const impersonated = await open(asLaptop)
check('Mit fremdem Schlüssel im Namen des Laptops: abgelehnt', !impersonated.ok && impersonated.problem === 'forged')

const stranger = await sealMessage(intruder, { id: randomId(), from: stolenId.id, to: phoneRecord.id, at: now, type: 'offer', transfer: 'T3', body: {} })
const unknown = await open(stranger)
check('Von einem unbekannten Gerät: abgelehnt', !unknown.ok && unknown.problem === 'unknown-sender')

const forLaptop = await sealMessage(phone, { id: randomId(), from: phoneRecord.id, to: laptopRecord.id, at: now, type: 'offer', transfer: 'T4', body: {} })
const notMine = await open(forLaptop)
check('Für ein anderes Gerät: nicht geöffnet', !notMine.ok && notMine.problem === 'not-for-me')

const old = await sealMessage(laptop, { id: randomId(), from: laptopRecord.id, to: phoneRecord.id, at: now - 20 * 60_000, type: 'offer', transfer: 'T5', body: {} })
const stale = await open(old)
check('Älter als 15 Minuten: abgelehnt', !stale.ok && stale.problem === 'stale')

// --- Transfer -------------------------------------------------------------
/** Two ends of a channel in memory; delivery a tick later, like a network. */
function pair(): [Wire, Wire] {
  const make = () => {
    const handlers: ((data: string | ArrayBuffer) => void)[] = []
    const closers: (() => void)[] = []
    return { handlers, closers }
  }
  const a = make()
  const b = make()
  let closed = false
  const end = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): Wire => ({
    send(data) {
      if (closed) throw new Error('closed')
      const copy = typeof data === 'string' ? data : data.slice(0)
      setTimeout(() => other.handlers.forEach((handler) => handler(copy)), 0)
    },
    bufferedAmount: 0,
    drained: () => Promise.resolve(),
    onMessage: (handler) => self.handlers.push(handler),
    onClose: (handler) => self.closers.push(handler),
    close() {
      if (closed) return
      closed = true
      setTimeout(() => [...a.closers, ...b.closers].forEach((handler) => handler()), 0)
    },
  })
  return [end(a, b), end(b, a)]
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)))
  return bytes
}

const filmBytes = randomBytes(37 * 1024 * 1024 + 123)
const noteBytes = new TextEncoder().encode('Hallo vom Laptop')
const emptyBytes = new Uint8Array(0)
const film = outgoing(new Blob([filmBytes], { type: 'video/mp4' }), 'Film.mp4')
const note = outgoing(new Blob([noteBytes], { type: 'text/plain' }), 'Notiz.txt')
const empty = outgoing(new Blob([emptyBytes]), 'leer.bin')

const received = new Map<string, Uint8Array[]>()
let maxAhead = 0
let writtenTotal = 0
let sentTotal = 0
/** A slow disk: every write waits, so the sender has to be held back. */
const slowSink = (name: string): Sink => {
  const parts: Uint8Array[] = []
  received.set(name, parts)
  return {
    async write(chunk) {
      await new Promise((done) => setTimeout(done, 0))
      parts.push(chunk)
      writtenTotal += chunk.byteLength
    },
    close: async () => `Downloads/Sondra/${name}`,
    abort: async () => undefined,
  }
}
const [senderWire, receiverWire] = pair()
const originalSend = senderWire.send.bind(senderWire)
senderWire.send = (data) => {
  if (typeof data !== 'string') {
    sentTotal += data.byteLength
    maxAhead = Math.max(maxAhead, sentTotal - writtenTotal)
  }
  originalSend(data)
}
let announced: string[] = []
const receiving = receiveOver(receiverWire, async (file) => slowSink(file.name), { onStart: (files) => (announced = files.map((f) => f.name)) })
const places = await sendOver(senderWire, [film, note, empty])
await receiving

const join = (parts: Uint8Array[] | undefined) => {
  const all = new Uint8Array((parts ?? []).reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts ?? []) {
    all.set(part, at)
    at += part.byteLength
  }
  return all
}
const same = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((value, index) => value === b[index])
check('Empfänger kennt die Dateien vorher', announced.join(',') === 'Film.mp4,Notiz.txt,leer.bin')
check('Film kommt Byte für Byte an', same(join(received.get('Film.mp4')), filmBytes), `${filmBytes.byteLength} Bytes`)
check('Notiz kommt an', same(join(received.get('Notiz.txt')), noteBytes))
check('Leere Datei kommt an', received.has('leer.bin') && join(received.get('leer.bin')).byteLength === 0)
check('Absender erfährt, wo alles liegt', places.join(' | ') === 'Downloads/Sondra/Film.mp4 | Downloads/Sondra/Notiz.txt | Downloads/Sondra/leer.bin')
check('Absender bleibt höchstens 16 MB + ein Stück voraus', maxAhead <= 16 * 1024 * 1024 + 4 * 1024 * 1024 + 65536, `${(maxAhead / 1048576).toFixed(1)} MB`)

// Cancelled on the receiving side.
const [s2, r2] = pair()
const stop = new AbortController()
const receiving2 = receiveOver(r2, async (file) => slowSink(`b-${file.name}`), {
  signal: stop.signal,
  onProgress: ({ done }) => {
    if (done > 2 * 1024 * 1024) stop.abort()
  },
}).catch((error: unknown) => error)
const sending2 = await sendOver(s2, [film]).then(
  () => null,
  (error: unknown) => error,
)
const receiverError = await receiving2
check('Abbruch beim Empfänger: Absender erfährt es', sending2 instanceof TransferError && ['refused', 'closed'].includes(sending2.code), String((sending2 as Error)?.message))
check('Abbruch beim Empfänger: Empfänger bricht ab', receiverError instanceof TransferError && receiverError.code === 'cancelled')

// --- Resuming after a break -----------------------------------------------
// Three files; the line dies in the middle of the second. The receiver keeps
// the first whole and the second half, the sender is asked again and sends
// only what is missing — and every byte still arrives once, in order.
{
  const a = outgoing(new Blob([randomBytes(5 * 1024 * 1024 + 7)]), 'a.bin')
  const bBytes = randomBytes(20 * 1024 * 1024 + 99)
  const b = outgoing(new Blob([bBytes]), 'b.bin')
  const c = outgoing(new Blob([randomBytes(300_000)]), 'c.bin')
  const sources = [a, b, c]
  const stored = new Map<string, Uint8Array[]>()
  const sinkKeeping = (name: string, held?: Uint8Array[]): Sink => {
    const parts = held ?? []
    stored.set(name, parts)
    const size = () => parts.reduce((sum, part) => sum + part.byteLength, 0)
    return {
      write: async (chunk) => {
        parts.push(chunk)
      },
      close: async () => `Downloads/${name}`,
      abort: async () => {
        stored.delete(name)
      },
      suspend: async () => ({ bytes: size(), token: name, intact: async () => size() > 0 }),
    }
  }
  const sinkFor = async (file: { name: string }, _index: number, piece?: { token: unknown }) =>
    sinkKeeping(file.name, piece ? stored.get(String(piece.token)) : undefined)

  // First attempt: cut the line after ~9 MB (a is whole, b a third in).
  const [s1, r1] = pair()
  let bytesOut = 0
  const send1 = s1.send.bind(s1)
  s1.send = (data) => {
    if (typeof data !== 'string') {
      bytesOut += data.byteLength
      if (bytesOut > 9 * 1024 * 1024) {
        s1.close()
        return
      }
    }
    send1(data)
  }
  let kept: import('../src/lib/deviceTransfer').Kept | null = null
  const got1 = receiveOver(r1, sinkFor, { onKept: (state) => (kept = state) }).catch((error: unknown) => error)
  const out1 = await sendOver(s1, sources).catch((error: unknown) => error)
  await got1
  await new Promise((done) => setTimeout(done, 20))
  check('Abgebrochen: beide Seiten wissen es', out1 instanceof TransferError && out1.code === 'closed')
  check('Abgebrochen: der Empfänger hat Datei a ganz und b zum Teil behalten', Boolean(kept) && Object.keys(kept!.places).join() === '0' && Boolean(kept!.pieces[1]) && kept!.pieces[1].bytes > 0 && kept!.pieces[1].bytes < bBytes.byteLength, JSON.stringify(kept && { places: kept.places, bytes: kept.pieces[1]?.bytes }))

  // Second attempt on a new line: only the rest goes.
  const [s2b, r2b] = pair()
  let bytesAgain = 0
  const send2 = s2b.send.bind(s2b)
  s2b.send = (data) => {
    if (typeof data !== 'string') bytesAgain += data.byteLength
    send2(data)
  }
  const got2 = receiveOver(r2b, sinkFor, { kept: kept ?? undefined })
  const where2 = await sendOver(s2b, sources)
  await got2
  const total = sources.reduce((sum, file) => sum + file.size, 0)
  check('Fortgesetzt: nur der Rest wird gesendet', bytesAgain < total - 5 * 1024 * 1024 && bytesAgain >= total - kept!.pieces[1].bytes - a.size - 1, `${bytesAgain} von ${total}`)
  check('Fortgesetzt: b kommt Byte für Byte an', same(join(stored.get('b.bin')), bBytes))
  check('Fortgesetzt: der Absender erfährt alle drei Orte', where2.join(' | ') === 'Downloads/a.bin | Downloads/b.bin | Downloads/c.bin', where2.join(' | '))

  // A piece that is no longer as it was left starts over.
  const [s3, r3] = pair()
  let bytesAll = 0
  const send3 = s3.send.bind(s3)
  s3.send = (data) => {
    if (typeof data !== 'string') bytesAll += data.byteLength
    send3(data)
  }
  const stale = { places: {}, pieces: { 1: { bytes: 3 * 1024 * 1024, token: 'weg', intact: async () => false } } }
  const got3 = receiveOver(r3, async (file) => sinkKeeping(`neu-${file.name}`), { kept: stale })
  await sendOver(s3, sources)
  await got3
  check('Verändertes Stück: von vorn, nichts Falsches angehängt', bytesAll === total && same(join(stored.get('neu-b.bin')), bBytes))
}

// --- Names on disk --------------------------------------------------------
const takenNames = new Set(['Film.mp4', 'Film (2).mp4'])
check('Freier Dateiname', freeName('Film.mp4', (n) => takenNames.has(n)) === 'Film (3).mp4')
check('Unerlaubte Zeichen werden ersetzt', safeFileName('a/b:c*?.mp4') === 'a_b_c__.mp4')
check('Name aus Punkten wird „Datei“', safeFileName('...') === 'Datei')

if (failed) {
  console.error(`${failed} Prüfung(en) gescheitert`)
  process.exit(1)
}
console.log('Geräte: alles geprüft.')
