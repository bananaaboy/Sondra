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

check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
