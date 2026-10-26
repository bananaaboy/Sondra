/**
 * SQLite 3 binary database engine (`SQLite format 3\0`) for Sondra.
 *
 * Reads and writes spec-compliant SQLite 3 database files (4096-byte pages,
 * B-tree table leaf `0x0d` and interior `0x05` pages, overflow pages, and
 * `sqlite_schema`) directly in memory without external native or WASM
 * dependencies, so it works identically in the browser, in Electron, in
 * Google Drive sync, and in Node.js verification scripts.
 *
 * Relational schema inside `Sondra-Merkliste.sqlite`:
 *   - `merkliste_items`: core series/film entries and settings
 *   - `merkliste_seasons`: per-season episode counts, watched lists, parts, covers
 *   - `merkliste_history`: watch history log with timestamps
 *   - `merkliste_removals`: tombstone timestamps for cross-device sync
 *   - `app_state`: flexible key-value store for general application state
 */

const PAGE_SIZE = 4096
const SQLITE_MAGIC = 'SQLite format 3\0'
const LEAF_MAX_PAYLOAD = PAGE_SIZE - 35 // 4061
const LEAF_MIN_PAYLOAD = Math.floor(((PAGE_SIZE - 12) * 32) / 255) - 23 // 489
const OVERFLOW_CHUNK_SIZE = PAGE_SIZE - 4 // 4092

export type SqlValue = null | number | string | Uint8Array

export interface SqlTableDefinition {
  name: string
  createSql: string
  columns: string[]
}

export const SONDRA_TABLES: Record<string, SqlTableDefinition> = {
  merkliste_items: {
    name: 'merkliste_items',
    createSql:
      'CREATE TABLE merkliste_items (id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, language TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER, mode TEXT NOT NULL, audio_format TEXT NOT NULL, video_pref TEXT NOT NULL, audio_pref TEXT NOT NULL, auto_transcribe INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT, last_opened_at INTEGER, cover TEXT, cover_frame_json TEXT, tile_format TEXT, notes TEXT, rating REAL, episode_duration INTEGER, film_duration INTEGER, durations_json TEXT, tags_json TEXT, online_available_json TEXT, opening REAL, intros_json TEXT, goal_json TEXT, sort_order INTEGER NOT NULL)',
    columns: [
      'id',
      'url',
      'title',
      'language',
      'season',
      'episode',
      'mode',
      'audio_format',
      'video_pref',
      'audio_pref',
      'auto_transcribe',
      'updated_at',
      'status',
      'last_opened_at',
      'cover',
      'cover_frame_json',
      'tile_format',
      'notes',
      'rating',
      'episode_duration',
      'film_duration',
      'durations_json',
      'tags_json',
      'online_available_json',
      'opening',
      'intros_json',
      'goal_json',
      'sort_order',
    ],
  },
  merkliste_seasons: {
    name: 'merkliste_seasons',
    createSql:
      'CREATE TABLE merkliste_seasons (item_id TEXT NOT NULL, season_number INTEGER NOT NULL, episodes INTEGER, watched_json TEXT NOT NULL, title TEXT, cover TEXT, cover_frame_json TEXT, parts_json TEXT, sort_order INTEGER NOT NULL)',
    columns: [
      'item_id',
      'season_number',
      'episodes',
      'watched_json',
      'title',
      'cover',
      'cover_frame_json',
      'parts_json',
      'sort_order',
    ],
  },
  merkliste_history: {
    name: 'merkliste_history',
    createSql:
      'CREATE TABLE merkliste_history (entry_id TEXT NOT NULL, item_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, watched_at INTEGER NOT NULL, sort_order INTEGER NOT NULL)',
    columns: ['entry_id', 'item_id', 'season', 'episode', 'watched_at', 'sort_order'],
  },
  merkliste_removals: {
    name: 'merkliste_removals',
    createSql: 'CREATE TABLE merkliste_removals (item_id TEXT NOT NULL, removed_at INTEGER NOT NULL)',
    columns: ['item_id', 'removed_at'],
  },
  app_state: {
    name: 'app_state',
    createSql: 'CREATE TABLE app_state (key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    columns: ['key', 'value_json', 'updated_at'],
  },
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/* -------------------------------------------------------------------------- */
/* Varint & Record Encoding / Decoding                                        */
/* -------------------------------------------------------------------------- */

export function encodeVarint(value: number): Uint8Array {
  let v = Math.floor(value)
  if (v < 0) v = 0
  if (v <= 0x7f) return new Uint8Array([v])
  const groups: number[] = []
  while (v > 0 && groups.length < 8) {
    groups.push(v & 0x7f)
    v = Math.floor(v / 128)
  }
  groups.reverse()
  for (let i = 0; i < groups.length - 1; i += 1) {
    groups[i] |= 0x80
  }
  return new Uint8Array(groups)
}

export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0
  for (let i = 0; i < 8; i += 1) {
    const b = bytes[offset + i] ?? 0
    value = value * 128 + (b & 0x7f)
    if ((b & 0x80) === 0) {
      return { value, length: i + 1 }
    }
  }
  const b9 = bytes[offset + 8] ?? 0
  value = value * 256 + b9
  return { value, length: 9 }
}

function encodeIntBytes(value: number, byteCount: number): Uint8Array {
  const out = new Uint8Array(byteCount)
  const view = new DataView(out.buffer)
  if (byteCount === 1) {
    view.setInt8(0, value)
  } else if (byteCount === 2) {
    view.setInt16(0, value, false)
  } else if (byteCount === 3) {
    const v = value < 0 ? value + 0x1000000 : value
    out[0] = (v >>> 16) & 0xff
    out[1] = (v >>> 8) & 0xff
    out[2] = v & 0xff
  } else if (byteCount === 4) {
    view.setInt32(0, value, false)
  } else if (byteCount === 6) {
    const hi = Math.floor(value / 0x100000000)
    const lo = value >>> 0
    view.setInt16(0, hi, false)
    view.setUint32(2, lo, false)
  } else if (byteCount === 8) {
    view.setBigInt64(0, BigInt(Math.trunc(value)), false)
  }
  return out
}

function decodeIntBytes(bytes: Uint8Array, offset: number, byteCount: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, byteCount)
  if (byteCount === 1) return view.getInt8(0)
  if (byteCount === 2) return view.getInt16(0, false)
  if (byteCount === 3) {
    const raw = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
    return raw & 0x800000 ? raw - 0x1000000 : raw
  }
  if (byteCount === 4) return view.getInt32(0, false)
  if (byteCount === 6) {
    const hi = view.getInt16(0, false)
    const lo = view.getUint32(2, false)
    return hi * 0x100000000 + lo
  }
  if (byteCount === 8) {
    return Number(view.getBigInt64(0, false))
  }
  return 0
}

function encodeColumnValue(val: SqlValue): { serialType: number; body: Uint8Array } {
  if (val === null || val === undefined) {
    return { serialType: 0, body: new Uint8Array(0) }
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      return { serialType: 0, body: new Uint8Array(0) }
    }
    if (Number.isInteger(val)) {
      if (val === 0) return { serialType: 8, body: new Uint8Array(0) }
      if (val === 1) return { serialType: 9, body: new Uint8Array(0) }
      if (val >= -128 && val <= 127) return { serialType: 1, body: encodeIntBytes(val, 1) }
      if (val >= -32768 && val <= 32767) return { serialType: 2, body: encodeIntBytes(val, 2) }
      if (val >= -8388608 && val <= 8388607) return { serialType: 3, body: encodeIntBytes(val, 3) }
      if (val >= -2147483648 && val <= 2147483647) return { serialType: 4, body: encodeIntBytes(val, 4) }
      if (val >= -140737488355328 && val <= 140737488355327) return { serialType: 5, body: encodeIntBytes(val, 6) }
      return { serialType: 6, body: encodeIntBytes(val, 8) }
    }
    const floatBytes = new Uint8Array(8)
    new DataView(floatBytes.buffer).setFloat64(0, val, false)
    return { serialType: 7, body: floatBytes }
  }
  if (typeof val === 'string') {
    const body = encoder.encode(val)
    return { serialType: body.byteLength * 2 + 13, body }
  }
  if (val instanceof Uint8Array) {
    return { serialType: val.byteLength * 2 + 12, body: val }
  }
  const textBody = encoder.encode(String(val))
  return { serialType: textBody.byteLength * 2 + 13, body: textBody }
}

export function encodeRecord(values: SqlValue[]): Uint8Array {
  const encodedCols = values.map(encodeColumnValue)
  const serialVarints = encodedCols.map((c) => encodeVarint(c.serialType))
  const serialBytesLen = serialVarints.reduce((sum, b) => sum + b.byteLength, 0)

  let headerLenVarint = encodeVarint(serialBytesLen + 1)
  if (headerLenVarint.byteLength + serialBytesLen !== serialBytesLen + 1) {
    headerLenVarint = encodeVarint(serialBytesLen + headerLenVarint.byteLength)
  }
  const totalHeaderLen = headerLenVarint.byteLength + serialBytesLen
  const totalBodyLen = encodedCols.reduce((sum, c) => sum + c.body.byteLength, 0)

  const record = new Uint8Array(totalHeaderLen + totalBodyLen)
  let pos = 0
  record.set(headerLenVarint, pos)
  pos += headerLenVarint.byteLength
  for (const sv of serialVarints) {
    record.set(sv, pos)
    pos += sv.byteLength
  }
  for (const col of encodedCols) {
    record.set(col.body, pos)
    pos += col.body.byteLength
  }
  return record
}

export function decodeRecord(payload: Uint8Array): SqlValue[] {
  if (payload.byteLength === 0) return []
  const { value: headerSize, length: firstVarintLen } = decodeVarint(payload, 0)
  const serialTypes: number[] = []
  let pos = firstVarintLen
  while (pos < headerSize && pos < payload.byteLength) {
    const { value: st, length } = decodeVarint(payload, pos)
    serialTypes.push(st)
    pos += length
  }

  let bodyPos = headerSize
  const values: SqlValue[] = []
  for (const st of serialTypes) {
    if (st === 0) {
      values.push(null)
    } else if (st === 8) {
      values.push(0)
    } else if (st === 9) {
      values.push(1)
    } else if (st >= 1 && st <= 6) {
      const byteCounts = [0, 1, 2, 3, 4, 6, 8]
      const len = byteCounts[st]
      values.push(decodeIntBytes(payload, bodyPos, len))
      bodyPos += len
    } else if (st === 7) {
      const view = new DataView(payload.buffer, payload.byteOffset + bodyPos, 8)
      values.push(view.getFloat64(0, false))
      bodyPos += 8
    } else if (st >= 12 && st % 2 === 0) {
      const len = (st - 12) / 2
      values.push(payload.slice(bodyPos, bodyPos + len))
      bodyPos += len
    } else if (st >= 13 && st % 2 === 1) {
      const len = (st - 13) / 2
      values.push(decoder.decode(payload.subarray(bodyPos, bodyPos + len)))
      bodyPos += len
    } else {
      values.push(null)
    }
  }
  return values
}

/* -------------------------------------------------------------------------- */
/* Page & B-Tree Builder                                                      */
/* -------------------------------------------------------------------------- */

class PageAllocator {
  private pages: Uint8Array[] = []

  allocatePage(): { pageNumber: number; page: Uint8Array } {
    const page = new Uint8Array(PAGE_SIZE)
    this.pages.push(page)
    return { pageNumber: this.pages.length, page }
  }

  getPage(pageNumber: number): Uint8Array {
    return this.pages[pageNumber - 1]
  }

  get count(): number {
    return this.pages.length
  }

  toBytes(): Uint8Array {
    const total = new Uint8Array(this.pages.length * PAGE_SIZE)
    for (let i = 0; i < this.pages.length; i += 1) {
      total.set(this.pages[i], i * PAGE_SIZE)
    }
    return total
  }
}

function buildLeafCell(allocator: PageAllocator, rowId: number, payload: Uint8Array): Uint8Array {
  const P = payload.byteLength
  const pVarint = encodeVarint(P)
  const rVarint = encodeVarint(rowId)

  if (P <= LEAF_MAX_PAYLOAD) {
    const cell = new Uint8Array(pVarint.byteLength + rVarint.byteLength + P)
    cell.set(pVarint, 0)
    cell.set(rVarint, pVarint.byteLength)
    cell.set(payload, pVarint.byteLength + rVarint.byteLength)
    return cell
  }

  const K = LEAF_MIN_PAYLOAD + ((P - LEAF_MIN_PAYLOAD) % OVERFLOW_CHUNK_SIZE)
  const localLen = K <= LEAF_MAX_PAYLOAD ? K : LEAF_MIN_PAYLOAD

  // Allocate overflow chain for payload[localLen..P]
  let remOffset = localLen
  let firstOverflowPage = 0
  let prevOverflowPage: Uint8Array | null = null

  while (remOffset < P) {
    const chunkLen = Math.min(OVERFLOW_CHUNK_SIZE, P - remOffset)
    const { pageNumber, page } = allocator.allocatePage()
    if (firstOverflowPage === 0) firstOverflowPage = pageNumber
    if (prevOverflowPage) {
      new DataView(prevOverflowPage.buffer).setUint32(0, pageNumber, false)
    }
    page.set(payload.subarray(remOffset, remOffset + chunkLen), 4)
    prevOverflowPage = page
    remOffset += chunkLen
  }

  const cell = new Uint8Array(pVarint.byteLength + rVarint.byteLength + localLen + 4)
  let pos = 0
  cell.set(pVarint, pos)
  pos += pVarint.byteLength
  cell.set(rVarint, pos)
  pos += rVarint.byteLength
  cell.set(payload.subarray(0, localLen), pos)
  pos += localLen
  new DataView(cell.buffer).setUint32(pos, firstOverflowPage, false)
  return cell
}

function writeLeafPage(page: Uint8Array, headerOffset: number, cells: Uint8Array[]): void {
  const view = new DataView(page.buffer)
  let contentOffset = PAGE_SIZE
  const ptrOffsets: number[] = []

  for (const cell of cells) {
    contentOffset -= cell.byteLength
    page.set(cell, contentOffset)
    ptrOffsets.push(contentOffset)
  }

  page[headerOffset] = 0x0d // Table B-Tree Leaf
  view.setUint16(headerOffset + 1, 0, false) // first freeblock
  view.setUint16(headerOffset + 3, cells.length, false) // cell count
  view.setUint16(headerOffset + 5, contentOffset === PAGE_SIZE ? 0 : contentOffset, false)
  page[headerOffset + 7] = 0 // fragmented free bytes

  let ptrPos = headerOffset + 8
  for (const ptr of ptrOffsets) {
    view.setUint16(ptrPos, ptr, false)
    ptrPos += 2
  }
}

function buildInteriorCell(leftChildPage: number, maxRowId: number): Uint8Array {
  const keyVarint = encodeVarint(maxRowId)
  const cell = new Uint8Array(4 + keyVarint.byteLength)
  new DataView(cell.buffer).setUint32(0, leftChildPage, false)
  cell.set(keyVarint, 4)
  return cell
}

function writeInteriorPage(page: Uint8Array, headerOffset: number, cells: Uint8Array[], rightChildPage: number): void {
  const view = new DataView(page.buffer)
  let contentOffset = PAGE_SIZE
  const ptrOffsets: number[] = []

  for (const cell of cells) {
    contentOffset -= cell.byteLength
    page.set(cell, contentOffset)
    ptrOffsets.push(contentOffset)
  }

  page[headerOffset] = 0x05 // Table B-Tree Interior
  view.setUint16(headerOffset + 1, 0, false)
  view.setUint16(headerOffset + 3, cells.length, false)
  view.setUint16(headerOffset + 5, contentOffset === PAGE_SIZE ? 0 : contentOffset, false)
  page[headerOffset + 7] = 0
  view.setUint32(headerOffset + 8, rightChildPage, false)

  let ptrPos = headerOffset + 12
  for (const ptr of ptrOffsets) {
    view.setUint16(ptrPos, ptr, false)
    ptrPos += 2
  }
}

/**
 * Writes a table's rows into B-Tree pages (automatically splitting into multiple
 * leaf pages and interior tree levels if the rows exceed a single 4096-byte page)
 * and returns the root page number.
 */
function writeTableBTree(
  allocator: PageAllocator,
  rows: SqlValue[][],
  fixedRootPage?: { pageNumber: number; page: Uint8Array; headerOffset: number },
): number {
  const builtCells: { rowId: number; cell: Uint8Array }[] = rows.map((row, idx) => {
    const rowId = idx + 1
    const payload = encodeRecord(row)
    const cell = buildLeafCell(allocator, rowId, payload)
    return { rowId, cell }
  })

  // Check if all cells fit on the root page as a single leaf page
  const rootHeaderOffset = fixedRootPage ? fixedRootPage.headerOffset : 0
  const maxSinglePageBytes = PAGE_SIZE - rootHeaderOffset - 8
  const totalSingleBytes = builtCells.reduce((sum, c) => sum + c.cell.byteLength + 2, 0)

  if (totalSingleBytes <= maxSinglePageBytes) {
    const target = fixedRootPage ?? allocator.allocatePage()
    writeLeafPage(
      target.page,
      rootHeaderOffset,
      builtCells.map((c) => c.cell),
    )
    return target.pageNumber
  }

  // Otherwise, pack cells into leaf pages and build interior level(s) above them
  const leafGroups: { pageNumber: number; maxRowId: number }[] = []
  let currentCells: Uint8Array[] = []
  let currentUsed = 0
  let currentMaxRowId = 0
  const leafCapacity = PAGE_SIZE - 8

  for (const item of builtCells) {
    const needed = item.cell.byteLength + 2
    if (currentCells.length > 0 && currentUsed + needed > leafCapacity) {
      const { pageNumber, page } = allocator.allocatePage()
      writeLeafPage(page, 0, currentCells)
      leafGroups.push({ pageNumber, maxRowId: currentMaxRowId })
      currentCells = []
      currentUsed = 0
    }
    currentCells.push(item.cell)
    currentUsed += needed
    currentMaxRowId = item.rowId
  }
  if (currentCells.length > 0) {
    const { pageNumber, page } = allocator.allocatePage()
    writeLeafPage(page, 0, currentCells)
    leafGroups.push({ pageNumber, maxRowId: currentMaxRowId })
  }

  // Recursively collapse child groups into interior pages until a single root group remains
  let currentLevel = leafGroups
  while (currentLevel.length > 1) {
    const interiorCells = currentLevel.slice(0, -1).map((g) => ({
      maxRowId: g.maxRowId,
      cell: buildInteriorCell(g.pageNumber, g.maxRowId),
    }))
    const rightChild = currentLevel[currentLevel.length - 1]
    const totalInteriorBytes = interiorCells.reduce((sum, c) => sum + c.cell.byteLength + 2, 0)

    if (totalInteriorBytes <= PAGE_SIZE - rootHeaderOffset - 12) {
      const target = fixedRootPage ?? allocator.allocatePage()
      writeInteriorPage(
        target.page,
        rootHeaderOffset,
        interiorCells.map((c) => c.cell),
        rightChild.pageNumber,
      )
      return target.pageNumber
    }

    // Multiple interior pages needed at this level
    const nextLevel: { pageNumber: number; maxRowId: number }[] = []
    let groupStart = 0
    while (groupStart < currentLevel.length) {
      let groupEnd = groupStart
      let used = 0
      while (groupEnd + 1 < currentLevel.length) {
        const cell = buildInteriorCell(currentLevel[groupEnd].pageNumber, currentLevel[groupEnd].maxRowId)
        if (groupEnd > groupStart && used + cell.byteLength + 2 > PAGE_SIZE - 12) break
        used += cell.byteLength + 2
        groupEnd += 1
      }
      if (groupEnd === groupStart) {
        // Single child left; carry forward to next level
        nextLevel.push(currentLevel[groupStart])
        groupStart += 1
      } else {
        const subChildren = currentLevel.slice(groupStart, groupEnd + 1)
        const subCells = subChildren.slice(0, -1).map((c) => buildInteriorCell(c.pageNumber, c.maxRowId))
        const subRight = subChildren[subChildren.length - 1]
        const { pageNumber, page } = allocator.allocatePage()
        writeInteriorPage(page, 0, subCells, subRight.pageNumber)
        nextLevel.push({ pageNumber, maxRowId: subRight.maxRowId })
        groupStart = groupEnd + 1
      }
    }
    currentLevel = nextLevel
  }

  return currentLevel[0].pageNumber
}

function writeDatabaseHeader(page1: Uint8Array, totalPages: number): void {
  for (let i = 0; i < 16; i += 1) {
    page1[i] = SQLITE_MAGIC.charCodeAt(i)
  }
  const view = new DataView(page1.buffer)
  view.setUint16(16, PAGE_SIZE, false) // page size = 4096
  page1[18] = 1 // write version
  page1[19] = 1 // read version
  page1[20] = 0 // reserved space per page
  page1[21] = 64 // max embedded payload fraction
  page1[22] = 32 // min embedded payload fraction
  page1[23] = 32 // leaf payload fraction
  view.setUint32(24, 1, false) // file change counter
  view.setUint32(28, totalPages, false) // size of database in pages
  view.setUint32(32, 0, false) // first freelist trunk page
  view.setUint32(36, 0, false) // total freelist pages
  view.setUint32(40, 1, false) // schema cookie
  view.setUint32(44, 4, false) // schema format number = 4
  view.setUint32(48, 0, false) // default page cache size
  view.setUint32(52, 0, false) // largest root b-tree page
  view.setUint32(56, 1, false) // text encoding = 1 (UTF-8)
  view.setUint32(60, 2, false) // user version = 2
  view.setUint32(64, 0, false) // incremental vacuum
  view.setUint32(68, 0x534f4e44, false) // Application ID = "SOND"
  view.setUint32(92, 1, false) // version-valid-for
  view.setUint32(96, 3045000, false) // SQLITE_VERSION_NUMBER
}

/* -------------------------------------------------------------------------- */
/* Database Writer & Reader                                                   */
/* -------------------------------------------------------------------------- */

export interface SqliteDatabaseInput {
  tables: {
    definition: SqlTableDefinition
    rows: SqlValue[][]
  }[]
}

/**
 * Serializes tables and rows into a valid SQLite 3 binary file (`Uint8Array`).
 */
export function buildSqliteDatabase(input: SqliteDatabaseInput): Uint8Array {
  const allocator = new PageAllocator()
  // Page 1 is always `sqlite_schema`
  const page1 = allocator.allocatePage()

  const schemaRows: SqlValue[][] = []
  for (const tbl of input.tables) {
    const rootPage = writeTableBTree(allocator, tbl.rows)
    schemaRows.push(['table', tbl.definition.name, tbl.definition.name, rootPage, tbl.definition.createSql])
  }

  writeTableBTree(allocator, schemaRows, {
    pageNumber: page1.pageNumber,
    page: page1.page,
    headerOffset: 100,
  })

  writeDatabaseHeader(page1.page, allocator.count)
  return allocator.toBytes()
}

/**
 * Checks whether a byte array or string begins with the 16-byte `SQLite format 3\0` header.
 */
export function isSqliteBytes(input: Uint8Array | string): boolean {
  if (typeof input === 'string') {
    return input.startsWith('SQLite format 3\0') || input.startsWith('U1FMaXRlIGZvcm1hdCAzAA==')
  }
  if (input.byteLength < 100) return false
  for (let i = 0; i < 16; i += 1) {
    if (input[i] !== SQLITE_MAGIC.charCodeAt(i)) return false
  }
  return true
}

function readLeafCellPayload(dbBytes: Uint8Array, pageSize: number, cellOffset: number): { rowId: number; payload: Uint8Array } {
  const usableSize = pageSize - dbBytes[20]
  const maxLocal = usableSize - 35
  const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23
  const overflowChunk = usableSize - 4

  let pos = cellOffset
  const { value: payloadSize, length: pLen } = decodeVarint(dbBytes, pos)
  pos += pLen
  const { value: rowId, length: rLen } = decodeVarint(dbBytes, pos)
  pos += rLen

  if (payloadSize <= maxLocal) {
    return {
      rowId,
      payload: dbBytes.subarray(pos, pos + payloadSize),
    }
  }

  const K = minLocal + ((payloadSize - minLocal) % overflowChunk)
  const localLen = K <= maxLocal ? K : minLocal
  const fullPayload = new Uint8Array(payloadSize)
  fullPayload.set(dbBytes.subarray(pos, pos + localLen), 0)

  const view = new DataView(dbBytes.buffer, dbBytes.byteOffset + pos + localLen, 4)
  let nextOverflowPage = view.getUint32(0, false)
  let written = localLen

  let safety = 0
  const maxPages = Math.ceil(dbBytes.byteLength / pageSize) + 2
  while (nextOverflowPage > 0 && written < payloadSize && safety < maxPages) {
    safety += 1
    const pageStart = (nextOverflowPage - 1) * pageSize
    if (pageStart < 0 || pageStart + 4 > dbBytes.byteLength) break
    const ovView = new DataView(dbBytes.buffer, dbBytes.byteOffset + pageStart, 4)
    nextOverflowPage = ovView.getUint32(0, false)
    const take = Math.min(overflowChunk, payloadSize - written)
    fullPayload.set(dbBytes.subarray(pageStart + 4, pageStart + 4 + take), written)
    written += take
  }

  return { rowId, payload: fullPayload }
}

function readTableBTreeRows(dbBytes: Uint8Array, pageSize: number, pageNumber: number, visited = new Set<number>()): SqlValue[][] {
  if (pageNumber < 1 || visited.has(pageNumber)) return []
  visited.add(pageNumber)

  const pageStart = (pageNumber - 1) * pageSize
  if (pageStart < 0 || pageStart + pageSize > dbBytes.byteLength) return []

  const headerOffset = pageNumber === 1 ? 100 : 0
  const pageType = dbBytes[pageStart + headerOffset]
  const view = new DataView(dbBytes.buffer, dbBytes.byteOffset + pageStart, pageSize)
  const cellCount = view.getUint16(headerOffset + 3, false)

  if (pageType === 0x0d) {
    const rows: SqlValue[][] = []
    const ptrArrayStart = headerOffset + 8
    for (let i = 0; i < cellCount; i += 1) {
      const cellOffsetInPage = view.getUint16(ptrArrayStart + i * 2, false)
      const { payload } = readLeafCellPayload(dbBytes, pageSize, pageStart + cellOffsetInPage)
      rows.push(decodeRecord(payload))
    }
    return rows
  }

  if (pageType === 0x05) {
    const rows: SqlValue[][] = []
    const rightChildPage = view.getUint32(headerOffset + 8, false)
    const ptrArrayStart = headerOffset + 12
    for (let i = 0; i < cellCount; i += 1) {
      const cellOffsetInPage = view.getUint16(ptrArrayStart + i * 2, false)
      const leftChildPage = view.getUint32(cellOffsetInPage, false)
      rows.push(...readTableBTreeRows(dbBytes, pageSize, leftChildPage, visited))
    }
    rows.push(...readTableBTreeRows(dbBytes, pageSize, rightChildPage, visited))
    return rows
  }

  return []
}

export interface ParsedSqliteDatabase {
  tables: Map<string, { createSql: string; rows: SqlValue[][] }>
}

/**
 * Reads a SQLite 3 binary file (`Uint8Array`) and returns all tables and their rows.
 */
export function readSqliteDatabase(dbBytes: Uint8Array): ParsedSqliteDatabase {
  if (!isSqliteBytes(dbBytes)) {
    throw new Error('Ungültige SQLite-Datei (Header stimmt nicht mit SQLite format 3 überein).')
  }
  const view = new DataView(dbBytes.buffer, dbBytes.byteOffset, dbBytes.byteLength)
  const rawPageSize = view.getUint16(16, false)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize

  const schemaRows = readTableBTreeRows(dbBytes, pageSize, 1)
  const tables = new Map<string, { createSql: string; rows: SqlValue[][] }>()

  for (const row of schemaRows) {
    const type = row[0]
    const tblName = row[2]
    const rootPage = row[3]
    const sql = row[4]
    if (type === 'table' && typeof tblName === 'string' && typeof rootPage === 'number' && rootPage >= 1) {
      const tableRows = readTableBTreeRows(dbBytes, pageSize, rootPage)
      tables.set(tblName, {
        createSql: typeof sql === 'string' ? sql : '',
        rows: tableRows,
      })
    }
  }

  return { tables }
}

/* -------------------------------------------------------------------------- */
/* Base64 Helpers for LocalStorage & Text Transport                           */
/* -------------------------------------------------------------------------- */

export function sqliteBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  if (typeof btoa === 'function') return btoa(binary)
  return Buffer.from(bytes).toString('base64')
}

export function base64ToSqliteBytes(b64: string): Uint8Array {
  const clean = b64.trim()
  if (typeof atob === 'function') {
    const binary = atob(clean)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  }
  return new Uint8Array(Buffer.from(clean, 'base64'))
}

export function coerceToSqliteBytes(input: Uint8Array | string): Uint8Array | null {
  if (input instanceof Uint8Array) {
    return isSqliteBytes(input) ? input : null
  }
  const trimmed = input.trim()
  if (input.startsWith(SQLITE_MAGIC)) {
    const out = new Uint8Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      out[i] = input.charCodeAt(i) & 0xff
    }
    return isSqliteBytes(out) ? out : null
  }
  if (trimmed.startsWith('U1FMaXRlIGZvcm1hdCAzAA')) {
    try {
      const bytes = base64ToSqliteBytes(trimmed)
      return isSqliteBytes(bytes) ? bytes : null
    } catch {
      return null
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* High-Level Relational Mapping for Sondra Merkliste & App State             */
/* -------------------------------------------------------------------------- */

export interface SqliteAppStateEntry {
  value: unknown
  updatedAt: number
}

export interface SqliteMerklisteSnapshot<TItem = Record<string, unknown>> {
  items: TItem[]
  removed: Record<string, number>
  appState?: Record<string, SqliteAppStateEntry>
}

function safeJsonParse<T>(raw: SqlValue): T | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/**
 * Serializes Sondra's Merkliste items, seasons, watch history, removals, and
 * flexible `app_state` into a spec-compliant SQLite 3 binary file (`Uint8Array`).
 */
export function serializeSondraSqlite(snapshot: SqliteMerklisteSnapshot<Record<string, unknown>>): Uint8Array {
  const itemRows: SqlValue[][] = []
  const seasonRows: SqlValue[][] = []
  const historyRows: SqlValue[][] = []
  const removalRows: SqlValue[][] = []
  const appStateRows: SqlValue[][] = []

  snapshot.items.forEach((item, itemIdx) => {
    const id = String(item.id ?? `merk-${itemIdx}`)
    itemRows.push([
      id,
      String(item.url ?? ''),
      String(item.title ?? 'Ohne Namen'),
      String(item.language ?? 'auto'),
      typeof item.season === 'number' ? item.season : 1,
      typeof item.episode === 'number' ? item.episode : null,
      item.mode === 'audio' ? 'audio' : 'video',
      String(item.audioFormat ?? 'mp3'),
      String(item.videoPref ?? 'untouched'),
      String(item.audioPref ?? 'high'),
      item.autoTranscribe ? 1 : 0,
      typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
      typeof item.status === 'string' ? item.status : null,
      typeof item.lastOpenedAt === 'number' ? item.lastOpenedAt : null,
      typeof item.cover === 'string' ? item.cover : null,
      item.coverFrame ? JSON.stringify(item.coverFrame) : null,
      typeof item.tileFormat === 'string' ? item.tileFormat : null,
      typeof item.notes === 'string' ? item.notes : null,
      typeof item.rating === 'number' ? item.rating : null,
      typeof item.episodeDuration === 'number' ? item.episodeDuration : null,
      typeof item.filmDuration === 'number' ? item.filmDuration : null,
      item.durations ? JSON.stringify(item.durations) : null,
      Array.isArray(item.tags) ? JSON.stringify(item.tags) : null,
      item.onlineAvailable ? JSON.stringify(item.onlineAvailable) : null,
      typeof item.opening === 'number' ? item.opening : null,
      Array.isArray(item.intros) ? JSON.stringify(item.intros) : null,
      item.goal ? JSON.stringify(item.goal) : null,
      itemIdx,
    ])

    if (Array.isArray(item.seasons)) {
      item.seasons.forEach((rawSeason: unknown, sIdx: number) => {
        if (!rawSeason || typeof rawSeason !== 'object') return
        const s = rawSeason as Record<string, unknown>
        seasonRows.push([
          id,
          typeof s.number === 'number' ? s.number : sIdx + 1,
          typeof s.episodes === 'number' ? s.episodes : null,
          JSON.stringify(Array.isArray(s.watched) ? s.watched : []),
          typeof s.title === 'string' ? s.title : null,
          typeof s.cover === 'string' ? s.cover : null,
          s.coverFrame ? JSON.stringify(s.coverFrame) : null,
          Array.isArray(s.parts) ? JSON.stringify(s.parts) : null,
          sIdx,
        ])
      })
    }

    if (Array.isArray(item.history)) {
      item.history.forEach((rawHist: unknown, hIdx: number) => {
        if (!rawHist || typeof rawHist !== 'object') return
        const h = rawHist as Record<string, unknown>
        historyRows.push([
          String(h.id ?? `wh-${itemIdx}-${hIdx}`),
          id,
          typeof h.season === 'number' ? h.season : 1,
          typeof h.episode === 'number' ? h.episode : 1,
          typeof h.at === 'number' ? h.at : Date.now(),
          hIdx,
        ])
      })
    }
  })

  for (const [itemId, removedAt] of Object.entries(snapshot.removed ?? {})) {
    if (typeof removedAt === 'number') {
      removalRows.push([itemId, removedAt])
    }
  }

  for (const [key, entry] of Object.entries(snapshot.appState ?? {})) {
    if (entry && typeof entry === 'object') {
      appStateRows.push([
        key,
        JSON.stringify(entry.value ?? null),
        typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      ])
    }
  }

  return buildSqliteDatabase({
    tables: [
      { definition: SONDRA_TABLES.merkliste_items, rows: itemRows },
      { definition: SONDRA_TABLES.merkliste_seasons, rows: seasonRows },
      { definition: SONDRA_TABLES.merkliste_history, rows: historyRows },
      { definition: SONDRA_TABLES.merkliste_removals, rows: removalRows },
      { definition: SONDRA_TABLES.app_state, rows: appStateRows },
    ],
  })
}

/**
 * Deserializes a SQLite 3 binary file (`Uint8Array` or base64/binary string)
 * back into Sondra's relational Merkliste items, removals, and `app_state`.
 */
export function deserializeSondraSqlite(input: Uint8Array | string): SqliteMerklisteSnapshot<Record<string, unknown>> {
  const bytes = coerceToSqliteBytes(input)
  if (!bytes) {
    throw new Error('Die Datei ist keine gültige SQLite-Datenbank.')
  }
  const db = readSqliteDatabase(bytes)

  const seasonsByItem = new Map<string, { sortOrder: number; season: Record<string, unknown> }[]>()
  for (const row of db.tables.get('merkliste_seasons')?.rows ?? []) {
    const itemId = String(row[0] ?? '')
    if (!itemId) continue
    const seasonObj: Record<string, unknown> = {
      number: typeof row[1] === 'number' ? row[1] : 1,
      episodes: typeof row[2] === 'number' ? row[2] : null,
      watched: safeJsonParse<number[]>(row[3]) ?? [],
    }
    if (typeof row[4] === 'string' && row[4]) seasonObj.title = row[4]
    if (typeof row[5] === 'string' && row[5]) seasonObj.cover = row[5]
    const coverFrame = safeJsonParse<Record<string, unknown>>(row[6])
    if (coverFrame) seasonObj.coverFrame = coverFrame
    const parts = safeJsonParse< unknown[] >(row[7])
    if (Array.isArray(parts)) seasonObj.parts = parts

    const sortOrder = typeof row[8] === 'number' ? row[8] : 0
    const list = seasonsByItem.get(itemId) ?? []
    list.push({ sortOrder, season: seasonObj })
    seasonsByItem.set(itemId, list)
  }

  const historyByItem = new Map<string, { sortOrder: number; entry: Record<string, unknown> }[]>()
  for (const row of db.tables.get('merkliste_history')?.rows ?? []) {
    const itemId = String(row[1] ?? '')
    if (!itemId) continue
    const entryObj: Record<string, unknown> = {
      id: String(row[0] ?? ''),
      season: typeof row[2] === 'number' ? row[2] : 1,
      episode: typeof row[3] === 'number' ? row[3] : 1,
      at: typeof row[4] === 'number' ? row[4] : 0,
    }
    const sortOrder = typeof row[5] === 'number' ? row[5] : 0
    const list = historyByItem.get(itemId) ?? []
    list.push({ sortOrder, entry: entryObj })
    historyByItem.set(itemId, list)
  }

  const rawItemRows = [...(db.tables.get('merkliste_items')?.rows ?? [])]
  rawItemRows.sort((a, b) => (typeof a[27] === 'number' ? a[27] : 0) - (typeof b[27] === 'number' ? b[27] : 0))

  const items: Record<string, unknown>[] = rawItemRows.map((row) => {
    const id = String(row[0] ?? '')
    const item: Record<string, unknown> = {
      id,
      url: String(row[1] ?? ''),
      title: String(row[2] ?? 'Ohne Namen'),
      language: String(row[3] ?? 'auto'),
      season: typeof row[4] === 'number' ? row[4] : 1,
      episode: typeof row[5] === 'number' ? row[5] : null,
      mode: row[6] === 'audio' ? 'audio' : 'video',
      audioFormat: String(row[7] ?? 'mp3'),
      videoPref: String(row[8] ?? 'untouched'),
      audioPref: String(row[9] ?? 'high'),
      autoTranscribe: Boolean(row[10]),
      updatedAt: typeof row[11] === 'number' ? row[11] : Date.now(),
    }
    if (typeof row[12] === 'string' && row[12]) item.status = row[12]
    if (typeof row[13] === 'number') item.lastOpenedAt = row[13]
    if (typeof row[14] === 'string' && row[14]) item.cover = row[14]
    const coverFrame = safeJsonParse<Record<string, unknown>>(row[15])
    if (coverFrame) item.coverFrame = coverFrame
    if (typeof row[16] === 'string' && row[16]) item.tileFormat = row[16]
    if (typeof row[17] === 'string' && row[17]) item.notes = row[17]
    if (typeof row[18] === 'number') item.rating = row[18]
    if (typeof row[19] === 'number') item.episodeDuration = row[19]
    if (typeof row[20] === 'number') item.filmDuration = row[20]
    const durations = safeJsonParse<Record<string, number>>(row[21])
    if (durations) item.durations = durations
    const tags = safeJsonParse<string[]>(row[22])
    if (Array.isArray(tags)) item.tags = tags
    const onlineAvailable = safeJsonParse<Record<string, unknown>>(row[23])
    if (onlineAvailable) item.onlineAvailable = onlineAvailable
    if (typeof row[24] === 'number') item.opening = row[24]
    const intros = safeJsonParse<unknown[]>(row[25])
    if (Array.isArray(intros)) item.intros = intros
    const goal = safeJsonParse<Record<string, unknown>>(row[26])
    if (goal) item.goal = goal

    const seasonEntries = seasonsByItem.get(id)
    if (seasonEntries && seasonEntries.length > 0) {
      seasonEntries.sort((a, b) => a.sortOrder - b.sortOrder)
      item.seasons = seasonEntries.map((s) => s.season)
    }

    const histEntries = historyByItem.get(id)
    if (histEntries && histEntries.length > 0) {
      histEntries.sort((a, b) => a.sortOrder - b.sortOrder)
      item.history = histEntries.map((h) => h.entry)
    }

    return item
  })

  const removed: Record<string, number> = {}
  for (const row of db.tables.get('merkliste_removals')?.rows ?? []) {
    const itemId = String(row[0] ?? '')
    const removedAt = row[1]
    if (itemId && typeof removedAt === 'number') {
      removed[itemId] = removedAt
    }
  }

  const appState: Record<string, SqliteAppStateEntry> = {}
  for (const row of db.tables.get('app_state')?.rows ?? []) {
    const key = String(row[0] ?? '')
    if (!key) continue
    appState[key] = {
      value: safeJsonParse<unknown>(row[1]),
      updatedAt: typeof row[2] === 'number' ? row[2] : 0,
    }
  }

  return { items, removed, appState }
}

