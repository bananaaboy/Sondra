// Series without the work: one field adds one, the folder tells which series it holds, the Merkliste
// keeps what is not needed every day behind „Mehr“, and the start page goes on where you stopped.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
const errors = []
const open = async (seed) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
  await context.addInitScript(
    ({ list }) => {
      try {
        if (list && !sessionStorage.getItem('seeded')) {
          localStorage.setItem('sondra:saved_links', JSON.stringify(list))
          sessionStorage.setItem('seeded', '1')
        }
      } catch {
        /* private window */
      }
      // A folder kept in memory, with what the folder API gives for listing and reading.
      const names = ['Frieren S01E01.webm', 'Frieren S01E02.webm', 'Frieren S01E03.webm', 'Spy x Family - 01.webm', 'Spy x Family - 02.webm', "Ocean's 11.webm", 'Notiz.txt']
      const entries = names.map((name) => ({
        name,
        kind: 'file',
        async getFile() {
          return new File([new Uint8Array(16)], name, { type: name.endsWith('.txt') ? 'text/plain' : 'video/webm' })
        },
      }))
      const folder = {
        name: 'Serien',
        kind: 'directory',
        async queryPermission() {
          return 'granted'
        },
        async requestPermission() {
          return 'granted'
        },
        async *values() {
          yield* entries
        },
      }
      window.showDirectoryPicker = async () => folder
    },
    { list: seed ?? null },
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  return { context, page }
}
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sondra:saved_links') ?? '[]'))

/* -- an empty list leads, one field adds ---------------------------------------------------------- */
{
  const { context, page } = await open()
  await page.goto(`${BASE}#merkliste`)
  await page.waitForTimeout(800)
  check('Leere Merkliste: zwei Wege statt eines Formulars', (await page.getByRole('button', { name: 'Ordner mit Serien wählen' }).count()) === 1 && (await page.getByRole('button', { name: 'Eine Serie eintippen' }).count()) === 1)
  await page.screenshot({ path: `${OUT}serien-leer.png` })

  await page.getByRole('button', { name: 'Eine Serie eintippen' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const field = dialog.getByLabel('Name der Serie oder Adresse')
  await page.waitForTimeout(400)
  check('„Serie hinzufügen“: ein Feld, und es hat den Fokus', await field.evaluate((el) => el === document.activeElement), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)))
  check('…ohne Staffeln, Folgenzahl, Cover und Tags vorweg', (await dialog.getByText('Staffeln & Episoden').count()) === 0 && (await dialog.getByText(/^Tags/).count()) === 0)
  await field.fill('Frieren')
  await dialog.getByRole('radio', { name: 'Schon angefangen' }).click()
  check('„Schon angefangen“ fragt nur nach der nächsten Folge', (await dialog.getByText('Nächste Folge:').count()) === 1)
  await page.screenshot({ path: `${OUT}serien-hinzufuegen.png` })
  await dialog.getByRole('button', { name: 'Auf die Merkliste' }).click()
  await page.waitForTimeout(500)
  const [item] = await saved(page)
  check('Gespeichert: Name, bei Folge 2, nichts über die Länge geraten', item?.title === 'Frieren' && item.episode === 2 && item.seasons?.[0]?.episodes === null && item.seasons?.[0]?.watched?.join() === '1', JSON.stringify(item?.seasons))

  // The „Mehr“ of the list: history, shuffle, statistics, sharing, view.
  await page.getByRole('button', { name: 'Mehr', exact: true }).click()
  const menu = page.locator('div.drop')
  check('Kopfzeile: „Mehr“ hält Verlauf, Würfeln, Statistiken, Teilen', (await menu.getByText('Verlauf').count()) === 1 && (await menu.getByText(/Statistiken/).count()) === 1 && (await menu.getByText('Liste teilen').count()) === 1)
  await page.screenshot({ path: `${OUT}serien-mehr.png` })
  await page.keyboard.press('Escape')
  check('Escape schliesst „Mehr“', (await page.locator('div.drop').count()) === 0)
  check('Die Kopfzeile selbst: Suche fehlt bei wenigen Einträgen, „Würfeln“ steht nicht mehr daneben', (await page.getByRole('button', { name: 'Würfeln' }).count()) === 0)

  // The series page: one way forward.
  await page.getByText('Frieren').first().click()
  await page.getByRole('button', { name: 'Folge 2 gesehen' }).waitFor()
  check('Serienseite: „Folge 2 gesehen“ und „Bearbeiten“, der Rest hinter „Mehr“', (await page.getByRole('button', { name: 'Bearbeiten' }).count()) === 1 && (await page.getByRole('button', { name: 'Online prüfen' }).count()) === 0 && (await page.getByRole('button', { name: 'Empfehlen' }).count()) === 0)
  await page.getByRole('button', { name: 'Mehr', exact: true }).click()
  check('…„Empfehlen“ steht im Menü', (await page.getByText('Empfehlen').count()) === 1)
  await page.screenshot({ path: `${OUT}serien-serie.png` })
  await context.close()
}

/* -- the folder tells which series it holds ------------------------------------------------------ */
{
  const { context, page } = await open()
  await page.goto(`${BASE}#ordner`)
  await page.getByRole('button', { name: 'Ordner wählen' }).first().click()
  await page.getByText('Frieren S01E01.webm').first().waitFor({ timeout: 20_000 })
  const offer = page.locator('section[aria-labelledby="ordner-neu"]')
  await offer.waitFor()
  const text = await offer.innerText({ timeout: 3000 }).catch(() => '(verschwunden)')
  check('Ordner: „2 Serien erkannt“, der einzelne Film nicht', text.includes('2 Serien erkannt') && !text.includes('Ocean'), text.replace(/\s+/g, ' ').slice(0, 160))
  check('…mit der Zahl der Folgen', /3 Folgen/.test(text) && /2 Folgen/.test(text))
  await page.screenshot({ path: `${OUT}serien-ordner.png` })
  await offer.getByRole('button', { name: 'Alle auf die Merkliste' }).click()
  await page.waitForTimeout(500)
  const list = await saved(page)
  check('„Alle auf die Merkliste“: beide stehen darauf, am Schauen, mit der ersten Folge im Ordner', list.length === 2 && list.every((entry) => entry.status === 'watching') && list.some((entry) => entry.title === 'Frieren' && entry.episode === 1), list.map((entry) => `${entry.title}:${entry.episode}`).join(' '))
  check('…und sagt es, mit dem Weg dorthin', /2 Serien stehen jetzt auf der Merkliste/.test(await offer.innerText()) && (await offer.getByRole('button', { name: 'Ansehen' }).count()) === 1)
  await page.screenshot({ path: `${OUT}serien-ordner-danach.png` })
  check('Danach stehen die Folgen unter ihrer Serie', (await page.getByText('Frieren · Staffel 1').count()) === 1, '')
  await context.close()
}

/* -- „Nicht fragen“ is kept ---------------------------------------------------------------------- */
{
  const { context, page } = await open()
  await page.goto(`${BASE}#ordner`)
  await page.getByRole('button', { name: 'Ordner wählen' }).first().click()
  const offer = page.locator('section[aria-labelledby="ordner-neu"]')
  await offer.waitFor({ timeout: 20_000 })
  await offer.getByRole('button', { name: 'Nicht fragen' }).first().click()
  const ignored = await page.evaluate(() => JSON.parse(localStorage.getItem('sondra:ordner:ignoriert') ?? '[]'))
  check('„Nicht fragen“ merkt den Titel', ignored.length === 1 && (await offer.innerText()).includes('Eine Serie erkannt'), ignored.join())
  await page.getByRole('button', { name: 'Neu einlesen' }).click()
  await page.waitForTimeout(800)
  check('…und fragt nach dem Neu-Einlesen nicht wieder', (await page.locator('section[aria-labelledby="ordner-neu"]').getByText(ignored[0] ?? '§', { exact: false }).count()) === 0)
  await context.close()
}

/* -- the start page goes on where you stopped ---------------------------------------------------- */
{
  const now = Date.now()
  const seed = ['Frieren', 'Spy x Family', 'Violet Evergarden'].map((title, at) => ({
    id: `s${at}`,
    title,
    url: '',
    season: 1,
    episode: 3 + at,
    status: 'watching',
    updatedAt: now - at * 3_600_000,
    seasons: [{ number: 1, episodes: 12, watched: [1, 2] }],
  }))
  const { context, page } = await open(seed)
  await page.goto(BASE)
  await page.waitForTimeout(900)
  check('Startseite: „Heute weiterschauen“ mit den drei zuletzt geschauten', (await page.getByRole('heading', { name: 'Heute weiterschauen' }).count()) === 1 && (await page.locator('section[aria-labelledby="start-weiter"] button').count()) === 3)
  await page.screenshot({ path: `${OUT}serien-start.png` })
  await page.locator('section[aria-labelledby="start-weiter"] button').first().click()
  await page.getByRole('button', { name: 'Folge 3 gesehen' }).waitFor({ timeout: 10_000 }).catch(() => undefined)
  check('Ein Klick öffnet die Serie, bei der Folge, wo Sie standen', (await page.getByRole('button', { name: 'Folge 3 gesehen' }).count()) === 1)
  await context.close()
}

check('Keine Fehler auf der Seite', errors.length === 0, errors.join('; '))
await browser.close()
finish()
