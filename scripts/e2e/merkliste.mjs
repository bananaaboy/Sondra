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
await dialog.getByRole('button', { name: 'Schliessen' }).first().click().catch(() => page.keyboard.press('Escape'))

// Share: make the link on this list, open it in another browser that holds a list of its own.
await page.keyboard.press('Escape')
await page.getByRole('button', { name: 'Teilen' }).click()
const share = page.getByRole('dialog')
await share.waitFor()
await share.getByLabel(/Ihr Name/).fill('Mia')
const linkField = share.getByLabel('Link')
await page.waitForFunction(() => /#geteilt=/.test(document.querySelector('dialog[open] input[readonly]')?.value ?? ''), null, { timeout: 10_000 })
const link = await linkField.inputValue()
check('Teilen: der Link trägt die Liste im Hash, ohne Adressen der Folgen', /#geteilt=/.test(link) && link.length < 8000 && !link.includes('geheim'), `${link.length} Zeichen`)
await page.screenshot({ path: `${OUT}teilen.png` })

const other = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
await other.addInitScript(() => {
  if (!sessionStorage.getItem('seeded')) {
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('sondra:saved_links', JSON.stringify([{ id: 'x', title: 'Frieren', url: '', season: 1, episode: 1, status: 'watching', updatedAt: Date.now() }]))
  }
})
const guest = await other.newPage()
guest.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await guest.goto(link.replace(/^https?:\/\/[^/]+\//, BASE))
const shared = guest.getByRole('dialog')
await shared.getByText('Merkliste von Mia').waitFor({ timeout: 15_000 })
const sharedText = await shared.innerText()
check('Teilen: der Gast sieht die Liste mit dem Namen und beiden Serien', /Frieren/.test(sharedText) && /Nana/.test(sharedText) && /2 Einträge/.test(sharedText), sharedText.replace(/\s+/g, ' ').slice(0, 120))
check('Teilen: was schon da ist, wird nicht doppelt angeboten', (await shared.getByRole('button', { name: /1 Eintrag zu meiner Merkliste/ }).count()) === 1)
await guest.screenshot({ path: `${OUT}teilen-gast.png` })
await shared.getByRole('button', { name: /zu meiner Merkliste/ }).click()
await shared.getByText(/1 hinzugefügt/).waitFor({ timeout: 5000 })
const titles = await guest.evaluate(() => JSON.parse(localStorage.getItem('sondra:saved_links') ?? '[]').map((item) => item.title).sort())
check('Teilen: danach steht Nana auf der Liste des Gastes, Frieren nur einmal', titles.join() === 'Frieren,Nana', titles.join())
await other.close()

// A broken link says so and breaks nothing.
const broken = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const bad = await broken.newPage()
bad.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await bad.goto(`${BASE}#geteilt=AAAAAAAA`)
await bad.getByText('Der Link ist nicht lesbar').waitFor({ timeout: 10_000 })
check('Teilen: ein kaputter Link wird gesagt, die Seite bleibt heil', true)
await broken.close()

check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
