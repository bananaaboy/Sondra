/**
 * Minimal ZIP writer, store-only.
 *
 * Exporting four stems or sixteen slices one file at a time means fighting the
 * browser's download prompt sixteen times. A ZIP fixes that, and the obvious
 * way to get one is a compression library — but every payload here is already
 * compressed audio or video, where DEFLATE buys a percent or two at best. So
 * this stores entries uncompressed and stays a hundred lines instead of adding
 * a dependency to the bundle of an app that is meant to be auditable.
 *
 * Writes Zip64 end-of-archive records when an archive exceeds the 32-bit
 * limits, so a batch of large files does not silently produce a broken file.
 */

export interface ZipEntry {
  name: string
  data: Uint8Array
  /** Defaults to now. */
  date?: Date
}

/** CRC-32, table built once on first use. */
let crcTable: Uint32Array | null = null

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time, the only timestamp the base format carries. */
function dosTimestamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Cleans one entry path.
 *
 * Forward slashes survive, because they are how a ZIP expresses folders — the
 * stems of one track belong in a directory of their own. Everything that could
 * escape that directory does not: no leading slash, no `..` segment, none of
 * the characters Windows refuses in a filename.
 */
function cleanPath(name: string): string {
  const segments = name
    .split('/')
    .map((segment) => segment.replace(/[\\:*?"<>|]+/g, '_').replace(/^\.+$/, '').trim())
    .filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments.join('/') : 'datei'
}

/** Entry names must be unique, or unzip tools silently drop the duplicates. */
function uniqueNames(entries: ZipEntry[]): string[] {
  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const clean = cleanPath(entry.name)
    const count = seen.get(clean) ?? 0
    seen.set(clean, count + 1)
    if (count === 0) return clean
    const dot = clean.lastIndexOf('.')
    const slash = clean.lastIndexOf('/')
    return dot > slash && dot > 0
      ? `${clean.slice(0, dot)}_${count + 1}${clean.slice(dot)}`
      : `${clean}_${count + 1}`
  })
}

const ZIP64_LIMIT = 0xffffffff

export function createZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const names = uniqueNames(entries).map((name) => encoder.encode(name))

  // One pass to size the buffer exactly — growing it would copy megabytes.
  let localSize = 0
  let centralSize = 0
  for (let i = 0; i < entries.length; i += 1) {
    localSize += 30 + names[i].byteLength + entries[i].data.byteLength
    centralSize += 46 + names[i].byteLength + 20 // 20 bytes of Zip64 extra field
  }
  const total = localSize + centralSize + 22 + 56 + 20 // EOCD + Zip64 EOCD + locator

  const buffer = new ArrayBuffer(total)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let offset = 0

  const u16 = (value: number) => {
    view.setUint16(offset, value, true)
    offset += 2
  }
  const u32 = (value: number) => {
    view.setUint32(offset, value >>> 0, true)
    offset += 4
  }
  const u64 = (value: number) => {
    view.setBigUint64(offset, BigInt(value), true)
    offset += 8
  }
  const raw = (value: Uint8Array) => {
    bytes.set(value, offset)
    offset += value.byteLength
  }

  const records: { crc: number; size: number; offset: number }[] = []

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const name = names[i]
    const { time, date } = dosTimestamp(entry.date ?? new Date())
    const crc = crc32(entry.data)
    const start = offset

    u32(0x04034b50) // local file header
    u16(45) // version needed — 4.5 for Zip64
    u16(0x0800) // UTF-8 names
    u16(0) // stored, no compression
    u16(time)
    u16(date)
    u32(crc)
    u32(Math.min(entry.data.byteLength, ZIP64_LIMIT))
    u32(Math.min(entry.data.byteLength, ZIP64_LIMIT))
    u16(name.byteLength)
    u16(0) // no extra field on the local header
    raw(name)
    raw(entry.data)

    records.push({ crc, size: entry.data.byteLength, offset: start })
  }

  const centralStart = offset

  for (let i = 0; i < entries.length; i += 1) {
    const name = names[i]
    const record = records[i]
    const { time, date } = dosTimestamp(entries[i].date ?? new Date())

    u32(0x02014b50) // central directory header
    u16(45)
    u16(45)
    u16(0x0800)
    u16(0)
    u16(time)
    u16(date)
    u32(record.crc)
    u32(Math.min(record.size, ZIP64_LIMIT))
    u32(Math.min(record.size, ZIP64_LIMIT))
    u16(name.byteLength)
    u16(20) // Zip64 extra field
    u16(0) // comment
    u16(0) // disk
    u16(0) // internal attributes
    u32(0) // external attributes
    u32(Math.min(record.offset, ZIP64_LIMIT))
    raw(name)

    // Zip64 extra field: the real sizes and offset, always written so a large
    // archive stays readable whether or not any single entry overflows.
    u16(0x0001)
    u16(16)
    u64(record.size)
    u64(record.size)
  }

  const centralBytes = offset - centralStart

  // Zip64 end of central directory
  const zip64Start = offset
  u32(0x06064b50)
  u64(44) // size of this record minus 12
  u16(45)
  u16(45)
  u32(0)
  u32(0)
  u64(entries.length)
  u64(entries.length)
  u64(centralBytes)
  u64(centralStart)

  // Zip64 locator
  u32(0x07064b50)
  u32(0)
  u64(zip64Start)
  u32(1)

  // End of central directory
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(Math.min(entries.length, 0xffff))
  u16(Math.min(entries.length, 0xffff))
  u32(Math.min(centralBytes, ZIP64_LIMIT))
  u32(Math.min(centralStart, ZIP64_LIMIT))
  u16(0)

  return bytes.subarray(0, offset) as Uint8Array<ArrayBuffer>
}

/**
 * The name an archive is saved under: what was typed, made safe for every
 * file system, with exactly one `.zip` on the end — or the suggestion, when
 * the field was left empty. `stem` is the same name without the extension,
 * for the folder the files sit in inside the archive.
 */
export function zipName(typed: string, suggestion: string): { file: string; stem: string } {
  const clean = (value: string) =>
    value
      .trim()
      .replace(/\.zip$/i, '')
      // Reserved on Windows or anywhere; control characters never belong in a
      // name. Before a space or at the end such a character just goes („Mix:
      // Live?" → „Mix Live"); between words it becomes a dash („A/B" → „A-B").
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+(?=\s|$)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      // Windows drops a trailing dot or space without a word.
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120)
  let stem = clean(typed) || clean(suggestion) || 'sondra'
  // Device names Windows will not take as a file name, extension or not.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `${stem}_`
  return { file: `${stem}.zip`, stem }
}

/**
 * Two entries with one name overwrite each other when the archive is
 * unpacked. The later ones become „Name (2).ext", „Name (3).ext".
 */
export function uniqueEntryNames(entries: ZipEntry[]): ZipEntry[] {
  const taken = new Set<string>()
  return entries.map((entry) => {
    let name = entry.name
    const dot = name.lastIndexOf('.')
    const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    for (let count = 2; taken.has(name.toLowerCase()); count += 1) name = `${base} (${count})${extension}`
    taken.add(name.toLowerCase())
    return name === entry.name ? entry : { ...entry, name }
  })
}
