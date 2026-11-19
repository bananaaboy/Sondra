/**
 * Writes the table the native sharing (`native/sondra-merk`, `share.rs`) is tested against: lists packed,
 * deflated, cut into links and put back together, the file, the text, the comparison with one's own list
 * — each with the web app's own answer. A link made there must open here and the other way round.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import {
  compareShared,
  decodeShare,
  encodeShare,
  packList,
  readShared,
  readShareFile,
  shareFile,
  shareLinks,
  shareText,
  titleKey,
  unpackList,
  type PartStore,
  type SharedItem,
  type SharedList,
} from '../src/lib/merkShare'
import { createMerkItem, type SavedLinkItem } from '../src/lib/merkliste'

const outDir = 'native/sondra-merk/tests/golden'
mkdirSync(outDir, { recursive: true })

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16))

// A list as JSON: pictures as hex.
const plain = (list: SharedList | null) =>
  list && {
    name: list.name,
    items: list.items.map((item) => ({ ...item, thumb: item.thumb ? hex(item.thumb) : undefined })),
  }

const raw34 = Uint8Array.from([0, ...Array.from({ length: 33 }, (_, i) => (i * 37 + 11) & 0xff)])
const webp = Uint8Array.from([1, 0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9])
const jpeg = Uint8Array.from([2, 0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])
const bad = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

const item = (title: string, more: Partial<SharedItem> = {}): SharedItem => ({ title, ...more })
const lists: Record<string, SharedList> = {
  empty: { v: 2, name: '', items: [] },
  small: {
    v: 2,
    name: 'Mia',
    items: [
      item('Frieren', { season: 1, episode: 12, seen: 11, rating: 4 }),
      item('Dark', { status: 'done', season: 3, episode: 8, seen: 26, rating: 5 }),
      item('One Piece', { status: 'paused', season: 0, episode: 2, seen: 1000 }),
      item('Naruto', { status: 'dropped', season: 1, episode: 1, seen: 0 }),
      item('Später Titel', { status: 'later', season: 1, episode: 1, seen: 0 }),
    ],
  },
  noProgress: { v: 2, name: 'Ohne Fortschritt', items: [item('A', { rating: 3 }), item('B', { status: 'done' }), item('Ünïcode — Ärger')] },
  thumbs: {
    v: 2,
    name: 'Bilder',
    items: [
      item('Mit Winzig', { season: 1, episode: 2, seen: 1, thumb: raw34 }),
      item('Mit WebP', { season: 1, episode: 1, seen: 0, thumb: webp, tile: 'manga' }),
      item('Mit JPEG', { season: 2, episode: 1, seen: 3, thumb: jpeg }),
      item('Falsches Bild', { season: 1, episode: 1, seen: 0, thumb: bad }),
      item('Manga ohne Bild', { season: 1, episode: 1, seen: 0, tile: 'manga' }),
    ],
  },
  odd: {
    v: 2,
    name: 'Name\twith\u0001controls and a name that is far longer than forty characters allow',
    items: [
      item('Zeile\nUmbruch\tTab\u0007'),
      item('x'.repeat(200), { season: 1, episode: 1, seen: 0 }),
      item('😀'.repeat(70)),
      item('Zahlen', { season: 1001, episode: 10_001, seen: 100_001, rating: 9 }),
      item('Grenzen', { season: 1000, episode: 10_000, seen: 100_000, rating: 5 }),
    ],
  },
  big: {
    v: 2,
    name: 'Gross',
    items: Array.from({ length: 220 }, (_, i) =>
      item(`Serie Nummer ${i} — ${'abcdefghij'.slice(0, 1 + (i % 10))} ${i * 7919}`, {
        status: (['watching', 'later', 'paused', 'done', 'dropped'] as const)[i % 5],
        season: 1 + (i % 4),
        episode: 1 + ((i * 3) % 24),
        seen: (i * 5) % 97,
        rating: i % 6,
        ...(i % 11 === 0 ? { thumb: Uint8Array.from([0, ...Array.from({ length: 33 }, (_, k) => (i * 31 + k * 17) & 0xff)]) } : {}),
      }),
    ),
  },
}

const packedCases = []
for (const [key, list] of Object.entries(lists)) {
  const packed = packList(list)
  const link = await encodeShare(list)
  const file = await shareFile(list)
  packedCases.push({
    key,
    list: plain(list),
    packed: hex(packed),
    unpacked: plain(unpackList(packed)),
    link,
    decoded: plain(await decodeShare(link)),
    file: hex(file),
    fileRead: plain(await readShareFile(file)),
    text: shareText(list),
    textWithLinks: shareText(list, ['https://x.example/#g=aaaa', 'https://x.example/#g=bbbb']),
    textWithOne: shareText(list, ['https://x.example/#g=aaaa']),
  })
}

// What a broken or cut-off packing makes of itself.
const small = packList(lists.small)
const cuts = [0, 1, 2, 3, 5, 9, 20, 40, small.length - 1].filter((n) => n >= 0 && n <= small.length)
const brokenCases = [
  ...cuts.map((n) => ({ what: `cut at ${n}`, bytes: hex(small.subarray(0, n)), list: plain(unpackList(small.subarray(0, n))) })),
  { what: 'wrong version', bytes: hex(Uint8Array.from([3, 0, 0, 0, 0])), list: plain(unpackList(Uint8Array.from([3, 0, 0, 0, 0]))) },
  { what: 'count 600', bytes: hex(Uint8Array.from([2, 0, 0, 0xd8, 0x04, 0])), list: plain(unpackList(Uint8Array.from([2, 0, 0, 0xd8, 0x04, 0]))) },
]
const json = new TextEncoder().encode(JSON.stringify({ v: 1, name: 'Alt ', items: [{ title: ' Frieren ', status: 'done', rating: 4, season: 2, episode: 3, seen: 5 }, { title: '' }, { title: 'X', rating: 0, season: -1 }, 7, { notitle: 1 }] }))
brokenCases.push({ what: 'v1 json', bytes: hex(json), list: plain(unpackList(json)) })

// Links in parts, and the parts put back together in any order.
class Memory implements PartStore {
  all: Record<string, { of: number; got: Record<string, string>; at: number }> = {}
  read() {
    return JSON.parse(JSON.stringify(this.all))
  }
  write(all: typeof this.all) {
    this.all = JSON.parse(JSON.stringify(all))
  }
}
const origin = 'https://sondra.example'
const links = await shareLinks(lists.big, origin, 700)
const prefix = `${origin}/#g=`
const parts = links.map((link) => link.slice(prefix.length))
const orders = [parts.map((_, i) => i), parts.map((_, i) => parts.length - 1 - i), parts.map((_, i) => (i * 3) % parts.length)].filter((o) => new Set(o).size === parts.length)
const NOW = 1_700_000_000_000
const partCases = await Promise.all(orders.map(async (order) => {
  const store = new Memory()
  const steps = []
  for (let n = 0; n < order.length; n += 1) {
    steps.push(readShared(parts[order[n]], store, NOW + n))
  }
  return { order, parts: order.map((i) => parts[i]), steps: (await Promise.all(steps)).map((r) => (r.kind === 'list' ? { kind: 'list', list: plain(r.list) } : r)) }
}))
const stale = new Memory()
const first = await readShared(parts[0], stale, NOW)
const later = await readShared(parts[1], stale, NOW + 3 * 24 * 60 * 60 * 1000)
const odd = [await readShared('abcd.0.3.xyz', new Memory(), NOW), await readShared('abcd.4.3.xyz', new Memory(), NOW), await readShared('abcd.1.1.xyz', new Memory(), NOW), await readShared('nonsense!', new Memory(), NOW), await readShared('', new Memory(), NOW)]
const linksFor = {
  single: await shareLinks(lists.small, origin),
  bigCount: links.length,
  big: links,
  tooMany: (await shareLinks({ v: 2, name: '', items: Array.from({ length: 500 }, (_, i) => item(`${i} ${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, { thumb: Uint8Array.from([0, ...Array.from({ length: 33 }, () => Math.floor(Math.random() * 256))]) })) }, origin, 300)).length,
}

// Against one's own list.
const mk = (raw: Record<string, unknown>) => createMerkItem({ updatedAt: 1, ...raw } as Partial<SavedLinkItem>)
const mine = [mk({ id: '1', title: 'frieren' }), mk({ id: '2', title: 'Dárk' }), mk({ id: '3', title: 'Nur Hier' }), mk({ id: '4', title: '  naruto   ' })]
const compared = compareShared(lists.small, mine)
const keys = ['Ärger', 'ärger', 'A  b', 'ﬁ', 'Ⅳ', 'Straße', 'İstanbul', 'Éclair', 'éclair', '  Leer ', 'Frieren']

const out = {
  packed: packedCases,
  broken: brokenCases,
  parts: { origin, links, cases: partCases, stale: { first, later }, odd, linksFor },
  keys: keys.map((k) => ({ k, key: titleKey(k) })),
  compare: { mine: mine.map((i) => ({ id: i.id, title: i.title })), list: 'small', both: compared.both.map((i) => i.title), fresh: compared.fresh.map((i) => i.title), onlyMine: compared.onlyMine },
}
// The random parts of `tooMany` only check a count; it is not kept.
delete (out.parts.linksFor as Record<string, unknown>).tooMany
writeFileSync(`${outDir}/share.json`, JSON.stringify(out, null, 1) + '\n')
console.log(`Teilen: ${packedCases.length} Listen, ${partCases.length} Reihenfolgen, ${links.length} Teile`)
