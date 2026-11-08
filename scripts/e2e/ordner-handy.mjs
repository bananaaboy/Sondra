// „Ordner“ on a phone, with a finger: a tap plays, a long press selects and then a tap selects,
// the sheet holds what the bar no longer has to, groups by series, new and unseen.
import { BASE, OUT, check, create, drive, finish, FOLDER, harmless, launch } from './lib.mjs'

const root = create({ name: 'Sondra', mimeType: FOLDER })
const dl = create({ name: 'Heruntergeladen', mimeType: FOLDER, parents: [root.id] })
for (const n of [1, 2, 3]) create({ name: `Frieren S01E0${n}.mp4`, mimeType: 'video/mp4', parents: [dl.id] }, Buffer.alloc(1000))
create({ name: 'Notiz.txt', mimeType: 'text/plain', parents: [dl.id] }, Buffer.from('hi'))

const browser = await launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block',
})
await context.route('https://www.googleapis.com/**', drive)
await context.addInitScript(() => {
  localStorage.setItem('sondra:drive', JSON.stringify({ linked: true, email: 'test@example.com' }))
  localStorage.setItem('sondra:drive:token', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 3600_000 }))
  // The Merkliste knows Frieren: two of twelve seen. And the folder was last looked at an hour ago.
  localStorage.setItem(
    'sondra:saved_links',
    JSON.stringify([{ id: 'fr', title: 'Frieren', url: '', season: 1, episode: 3, status: 'watching', updatedAt: Date.now(), seasons: [{ number: 1, episodes: 12, watched: [1, 2] }] }]),
  )
  if (!sessionStorage.getItem('besuch-gesetzt')) {
    localStorage.setItem('sondra:ordner:besuch', JSON.stringify({ 'drive:Google Drive': Date.now() - 3600_000 }))
    sessionStorage.setItem('besuch-gesetzt', '1')
  }
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
const cdp = await context.newCDPSession(page)

await page.goto(`${BASE}#ordner`)
await page.waitForTimeout(1200)
const pick = page.getByRole('button', { name: 'Aus Google Drive' })
if (await pick.count()) await pick.tap()
await page.getByText('Heruntergeladen', { exact: true }).first().tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })

const tile = (name) => page.locator('[role=option]').filter({ hasText: name }).first()
const centre = async (locator) => {
  const b = await locator.boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 3 }
}
const longPress = async (locator, ms = 700) => {
  const { x, y } = await centre(locator)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
const chosen = () => page.locator('[role=option][aria-selected=true]').count()

// A long press selects — and the tap that is its end plays nothing.
await longPress(tile('Frieren S01E02'))
await page.waitForTimeout(300)
check('Langes Drücken wählt die Kachel', (await chosen()) === 1 && /#ordner/.test(page.url()))
// With a selection a tap selects, too.
await tile('Frieren S01E03').tap()
await page.waitForTimeout(300)
check('Mit einer Auswahl wählt jedes Antippen', (await chosen()) === 2 && /#ordner/.test(page.url()))
await tile('Frieren S01E03').tap()
await tile('Frieren S01E02').tap()
await page.waitForTimeout(300)
check('…und wählt auch wieder ab', (await chosen()) === 0)
await page.screenshot({ path: `${OUT}ordner-handy-auswahl.png` })

// Nothing selected: a tap plays.
await tile('Frieren S01E01').tap()
await page.waitForFunction(() => location.hash === '#abspielen', null, { timeout: 8000 }).catch(() => undefined)
check('Antippen spielt ab', /#abspielen/.test(page.url()), page.url())

// One row of controls, the rest in a sheet.
await page.goBack().catch(() => undefined)
await page.goto(`${BASE}#ordner`)
await page.waitForTimeout(800)
if (await page.getByRole('button', { name: 'Aus Google Drive' }).count()) await page.getByRole('button', { name: 'Aus Google Drive' }).tap()
await page.getByText('Heruntergeladen', { exact: true }).first().tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })
const view = page.getByRole('button', { name: /^Ansicht/ })
check('Suche und „Ansicht“ stehen in einer Zeile', (await view.isVisible()) && (await page.getByPlaceholder('Im Ordner suchen…').isVisible()))
const rowBox = await page.getByPlaceholder('Im Ordner suchen…').boundingBox()
const buttonBox = await view.boundingBox()
check('…wirklich nebeneinander', Math.abs(rowBox.y - buttonBox.y) < 20, `${Math.round(rowBox.y)} / ${Math.round(buttonBox.y)}`)
check('Sortierung und Art stehen nicht mehr davor', !(await page.getByLabel('Sortieren').isVisible()) && !(await page.getByRole('radio', { name: /^Video/ }).isVisible()))
check('„Papierkorb“ bleibt in Sicht', await page.getByRole('button', { name: /^Papierkorb/ }).isVisible())
const firstTile = await tile('Frieren S01E01').boundingBox()
check('Die erste Datei beginnt in der oberen Hälfte des Schirms', firstTile.y < 430, `${Math.round(firstTile.y)} px`)
await page.screenshot({ path: `${OUT}ordner-handy-leiste.png` })
await view.tap()
const sheet = page.getByRole('dialog', { name: 'Ansicht und Ordner' })
await sheet.waitFor({ timeout: 5000 })
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}ordner-handy-blatt.png` })
check('Das Blatt hat Art, Ordnung und die anderen Ordner', (await sheet.getByRole('radio', { name: /^Video/ }).count()) === 1 && (await sheet.getByLabel('Sortieren').count()) === 1 && (await sheet.getByRole('button', { name: 'Ordner auf diesem Gerät' }).count()) === 1)
await sheet.getByRole('radio', { name: /^Andere/ }).tap()
await page.keyboard.press('Escape')
await sheet.waitFor({ state: 'detached', timeout: 5000 })
check('Escape schliesst das Blatt', (await page.getByRole('dialog', { name: 'Ansicht und Ordner' }).count()) === 0)
check('Der Filter gilt und steht als Marke da', (await page.getByRole('button', { name: /Nur Andere: aufheben/ }).isVisible()) && (await tile('Notiz').isVisible()) && (await page.getByText('Frieren S01E01.mp4').count()) === 0)
check('Der Knopf „Ansicht“ zählt die Abweichung', /1/.test(await view.innerText()), (await view.innerText()).replace(/\s+/g, ' '))
await page.getByRole('button', { name: /Nur Andere: aufheben/ }).tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 5000 })
// The backdrop closes it, too.
await view.tap()
await sheet.waitFor()
await page.mouse.click(190, 60)
await sheet.waitFor({ state: 'detached', timeout: 5000 })
check('Ein Tipp daneben schliesst das Blatt', (await page.getByRole('dialog', { name: 'Ansicht und Ordner' }).count()) === 0)
// The Drive note is folded on a phone.
const noteButton = page.locator('p').getByRole('button', { name: /^(Mehr|Weniger)$/ })
check('Der Drive-Hinweis ist eingeklappt, „Mehr“ klappt ihn auf', !(await page.getByText('Gelöschtes landet im').isVisible()) && (await noteButton.innerText()) === 'Mehr')
await noteButton.tap()
check('…und „Weniger“ klappt ihn zu', (await page.getByText('Gelöschtes landet im').isVisible()) && (await noteButton.innerText()) === 'Weniger' && (await noteButton.getAttribute('aria-expanded')) === 'true')

// „Weiterschauen“ is one row per series on a phone, without the file name. A fresh load, the folder last seen an hour ago.
await page.evaluate(() => localStorage.setItem('sondra:ordner:besuch', JSON.stringify({ 'drive:Google Drive': Date.now() - 3600_000 })))
await page.reload()
await page.waitForTimeout(800)
if (await page.getByRole('button', { name: 'Aus Google Drive' }).count()) await page.getByRole('button', { name: 'Aus Google Drive' }).tap()
await page.getByRole('heading', { name: 'Weiterschauen' }).waitFor({ timeout: 15_000 })
const next = page.getByRole('button', { name: 'Frieren', exact: true }).first()
check('Weiterschauen: Serie, Staffel und Folge von n', /Folge\s*3\s*von\s*12/.test(await page.locator('section[aria-labelledby=ordner-weiter]').innerText()))
check('…ohne den Dateinamen davor', !(await page.locator('section[aria-labelledby=ordner-weiter]').getByText('Frieren S01E03.mp4').isVisible()))
const cardBox = await page.locator('section[aria-labelledby=ordner-weiter] > div > div').first().boundingBox()
check('…eine flache Zeile', cardBox.height < 110, `${Math.round(cardBox.height)} px`)
await page.screenshot({ path: `${OUT}ordner-handy-weiter.png` })
void next
await page.getByText('Heruntergeladen', { exact: true }).first().tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })

// Under their series: a heading with the season, how many are here and how far along.
const heading = page.getByRole('button', { name: 'Frieren', exact: true })
await heading.waitFor({ timeout: 5000 })
const list = await page.locator('[role=listbox]').innerText()
check('Gruppe: Serie und Staffel', /Frieren\s*·\s*Staffel 1/.test(list.replace(/\n+/g, ' ')))
check('…wie viele hier und wie weit', /3 hier · 2 von 12 gesehen/.test(list))
check('…und „Weitere Dateien“ für den Rest', /Weitere Dateien/.test(list) && (await tile('Notiz').isVisible()))
const order = await page.locator('[role=option]').allInnerTexts()
check('Die Folgen der Reihe nach, der Rest danach', order.map((text) => /E0(\d)/.exec(text)?.[1] ?? 'x').join('') === '123x', order.map((text) => /E0(\d)|Notiz/.exec(text)?.[0]).join(' '))
await page.screenshot({ path: `${OUT}ordner-handy-gruppen.png` })

// „Ungesehen“ and „Neu“, in the sheet.
await page.getByRole('button', { name: /^Ansicht/ }).tap()
const panel = page.getByRole('dialog', { name: 'Ansicht und Ordner' })
await panel.waitFor()
check('Ungesehen zählt, was übrig bleibt (4 Dateien, 2 gesehen)', /Ungesehen\s*2/.test(await panel.innerText()))
check('Neu zählt, was nach dem letzten Besuch kam', /Neu\s*4/.test(await panel.innerText()))
await panel.getByRole('button', { name: /^Ungesehen/ }).tap()
await page.keyboard.press('Escape')
await panel.waitFor({ state: 'detached' })
check('Ungesehen: die gesehenen Folgen sind weg, der Rest bleibt', (await page.getByText('Frieren S01E01.mp4').count()) === 0 && (await page.getByText('Frieren S01E02.mp4').count()) === 0 && (await tile('Frieren S01E03').isVisible()) && (await tile('Notiz').isVisible()))
check('…als Marke da, und der Knopf zählt', (await page.getByRole('button', { name: 'Nur Ungesehenes: aufheben' }).isVisible()) && /1/.test(await page.getByRole('button', { name: /^Ansicht/ }).innerText()))
await page.getByRole('button', { name: 'Nur Ungesehenes: aufheben' }).tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 5000 })

// Remembered for this folder: list instead of tiles, and not under series.
await page.getByRole('button', { name: /^Ansicht/ }).tap()
await panel.getByRole('radio', { name: 'Liste' }).tap()
await panel.getByRole('checkbox', { name: 'Nach Serie' }).uncheck()
await page.keyboard.press('Escape')
await panel.waitFor({ state: 'detached' })
check('Nicht mehr nach Serie: keine Überschrift', (await page.getByRole('button', { name: 'Frieren', exact: true }).count()) === 0)
await page.reload()
await page.waitForTimeout(800)
if (await page.getByRole('button', { name: 'Aus Google Drive' }).count()) await page.getByRole('button', { name: 'Aus Google Drive' }).tap()
await page.getByText('Heruntergeladen', { exact: true }).first().tap()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })
await page.getByRole('button', { name: /^Ansicht/ }).tap()
check('Beim nächsten Besuch: so, wie dieser Ordner eingestellt war', (await panel.getByRole('radio', { name: 'Liste' }).getAttribute('aria-checked')) === 'true' && !(await panel.getByRole('checkbox', { name: 'Nach Serie' }).isChecked()))
await page.keyboard.press('Escape')

// The same folder at a desk, with a mouse: everything stays in the bar, as it was.
{
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await desk.route('https://www.googleapis.com/**', drive)
  await desk.addInitScript(() => {
    localStorage.setItem('sondra:drive', JSON.stringify({ linked: true, email: 'test@example.com' }))
    localStorage.setItem('sondra:drive:token', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 3600_000 }))
    localStorage.setItem('sondra:saved_links', JSON.stringify([{ id: 'fr', title: 'Frieren', url: '', season: 1, episode: 3, status: 'watching', updatedAt: Date.now(), seasons: [{ number: 1, episodes: 12, watched: [1, 2] }] }]))
    localStorage.setItem('sondra:ordner:besuch', JSON.stringify({ 'drive:Google Drive': Date.now() - 3600_000 }))
  })
  const table = await desk.newPage()
  await table.goto(`${BASE}#ordner`)
  await table.waitForTimeout(1200)
  if (await table.getByRole('button', { name: 'Aus Google Drive' }).count()) await table.getByRole('button', { name: 'Aus Google Drive' }).click()
  await table.getByText('Heruntergeladen', { exact: true }).first().click()
  await table.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })
  await table.waitForTimeout(700)
  check('Am Schreibtisch: Art, Ungesehen und Neu in der Leiste', (await table.getByRole('radio', { name: /^Video/ }).isVisible()) && (await table.getByRole('button', { name: /^Ungesehen \d+$/ }).isVisible()) && (await table.getByRole('button', { name: /^Neu \d+$/ }).isVisible()))
  check('…Sortierung, Ansicht und „Nach Serie“ ebenfalls, ohne „Ansicht“-Knopf', (await table.getByLabel('Sortieren').isVisible()) && (await table.getByRole('checkbox', { name: 'Nach Serie' }).isVisible()) && !(await table.getByRole('button', { name: /^Ansicht/ }).isVisible()))
  check('…und die Klickregeln der Maus im Hinweis', /Strg oder ⌘/.test(await table.locator('main').innerText()))
  await table.screenshot({ path: `${OUT}ordner-schreibtisch.png` })
  await desk.close()
}

check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
