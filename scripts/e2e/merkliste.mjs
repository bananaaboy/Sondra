// The Merkliste's statistics: the year in review from dated episodes, with a
// seeded list — the year of today and the one before, so it never goes stale.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const year = new Date().getFullYear()
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime()
const items = [
  {
    id: 'a', title: 'Frieren', url: '', season: 1, episode: 5, status: 'watching', updatedAt: Date.now(), episodeDuration: 25,
    history: [
      { id: '1', season: 1, episode: 1, at: at(year, 3, 1) },
      { id: '2', season: 1, episode: 2, at: at(year, 3, 2) },
      { id: '3', season: 1, episode: 3, at: at(year, 3, 3) },
      { id: '4', season: 1, episode: 4, at: at(year - 1, 11, 9) },
    ],
  },
  {
    id: 'b', title: 'Nana', url: '', season: 1, episode: 3, status: 'watching', updatedAt: Date.now(), episodeDuration: 20,
    history: [{ id: '5', season: 1, episode: 1, at: at(year, 3, 3) }, { id: '6', season: 1, episode: 2, at: at(year, 7, 20) }],
  },
]
await context.addInitScript((seed) => localStorage.setItem('sondra:saved_links', JSON.stringify(seed)), items)
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await page.goto(`${BASE}#merkliste`)
await page.getByRole('button', { name: 'Statistiken zur Merkliste öffnen' }).click()
const dialog = page.getByRole('dialog')
await dialog.waitFor()
const heading = dialog.getByRole('heading', { name: `Rückblick ${year}` })
await heading.waitFor({ timeout: 10_000 })
const text = await dialog.innerText()
check('Rückblick: das Jahr und seine Folgen (5)', /Rückblick/.test(text) && /Folgen\s*5/.test(text.replace(/\n+/g, ' ')), text.replace(/\s+/g, ' ').slice(text.indexOf('Rückblick'), text.indexOf('Rückblick') + 140))
check('Rückblick: die Reihenfolge der Serien (Frieren vor Nana)', text.indexOf('Frieren') > -1 && text.indexOf('Frieren') < text.indexOf('Nana', text.indexOf('Frieren')))
check('Rückblick: das Vorjahr steht zur Wahl', (await dialog.getByRole('radio', { name: String(year - 1) }).count()) === 1)
await dialog.getByRole('radio', { name: String(year - 1) }).click()
await dialog.getByRole('heading', { name: `Rückblick ${year - 1}` }).waitFor({ timeout: 5000 })
check('Rückblick: das Vorjahr zeigt seine eine Folge', /Folgen\s*1\b/.test((await dialog.innerText()).replace(/\n+/g, ' ')))
check('Rückblick: sagt, seit wann Daten da sind', /Mit Datum festgehalten seit dem/.test(await dialog.innerText()))
await page.screenshot({ path: `${OUT}rueckblick.png` })
check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
