/**
 * The page the website's Anytype link writes (`merklisteToMarkdown` in `src/lib/anytype.ts`): a fixed list
 * as Markdown, and the list as the page's data block carries it. The native `sondra-anytype` must read this
 * page and write the same readable part.
 *
 *   npm run native:golden
 */
import { mkdirSync, writeFileSync } from 'node:fs'

// The page's code asks the app through window.sondraApp; nothing is asked here.
Object.assign(globalThis, {
  window: { sondraApp: {}, addEventListener: () => {}, removeEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
})
const { merklisteToMarkdown } = await import('../src/lib/anytype')
const merk = await import('../src/lib/merkliste')

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
const items = [
  merk.createMerkItem({
    id: 'jojo', title: 'JoJo *Part 2*', season: 2, episode: 3, url: ' https://example.org/jojo ', rating: 4, notes: 'Zeile eins\n  Zeile zwei | mit Strich',
    cover: 'data:image/webp;base64,AAAA', updatedAt: 100,
    seasons: [{ number: 1, episodes: 26, watched: range(1, 26) }, { number: 2, episodes: 39, watched: [1, 2] }],
  }),
  merk.createMerkItem({ id: 'dark', title: 'Dark', season: 1, episode: 1, status: 'later', cover: 'https://bild.example/dark.jpg', updatedAt: 100, seasons: [{ number: 1, episodes: 10, watched: [] }] }),
  merk.createMerkItem({ id: 'film', title: 'Ein Film', season: 0, episode: null, status: 'done', updatedAt: 90, seasons: [{ number: 0, episodes: 1, watched: [1] }] }),
  merk.createMerkItem({ id: 'offen', title: 'Offen', season: 1, episode: 5, status: 'paused', updatedAt: 80, seasons: [{ number: 1, episodes: null, watched: [1, 2, 3, 4] }] }),
]
const removed = { alt: 77 }

mkdirSync('native/sondra-anytype/tests/golden', { recursive: true })
writeFileSync(
  'native/sondra-anytype/tests/golden/page.json',
  JSON.stringify({ markdown: merklisteToMarkdown(items, removed), titles: items.map((item) => item.title), ids: items.map((item) => item.id), removed }, null, 1) + '\n',
)
