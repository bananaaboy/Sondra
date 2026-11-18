// The grouped tab row (Bearbeiten, Ton, Aufnehmen behind one button each, the
// rest behind „Mehr“ on a phone) and the tab „Handy spiegeln“: the five steps
// are there, „Handy verbinden“ asks the browser for a device, closing the
// picker is answered in words, and a browser without WebUSB gets one honest
// sentence and no dead button. The phone itself is not here: there is no
// ADB device in a test run, so the connection and the picture were never run
// against real hardware.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()

const mockUsb = () => {
  window.__usbAsked = 0
  const usb = {
    requestDevice: async () => {
      window.__usbAsked += 1
      throw new DOMException('No device selected.', 'NotFoundError')
    },
    getDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(Navigator.prototype, 'usb', { get: () => usb, configurable: true })
}
const hideUsb = () => Object.defineProperty(Navigator.prototype, 'usb', { get: () => undefined, configurable: true })

/* -- the tab row on a desktop ------------------------------------------------------------------- */
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(mockUsb)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { if (!harmless(e)) errors.push(String(e)) })
  await page.goto(BASE)
  await page.waitForSelector('[data-tab]')
  await page.waitForTimeout(700)
  const labels = await page.locator('[data-tab]').allInnerTexts()
  check('Reiter: neun Einträge, nichts hinter „Mehr“', labels.length === 9 && (await page.getByRole('button', { name: /^Mehr/ }).count()) === 0, labels.join(' | '))
  check('Reiter: Gruppen Bearbeiten, Ton, Aufnehmen', ['Bearbeiten', 'Ton', 'Aufnehmen'].every((name) => labels.some((label) => label.trim() === name)), labels.join(' | '))

  const group = page.locator('[data-group="ton"]')
  await group.click()
  await page.waitForTimeout(400)
  const items = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts()
  check('Gruppe Ton: sechs Werkzeuge im Menü', items.length === 6 && items.some((text) => text.includes('Mischen')), items.join(' | '))
  check('Gruppe Ton: Menü hängt unter ihrem Knopf', await page.evaluate(() => {
    const button = document.querySelector('[data-group="ton"]').getBoundingClientRect()
    const menu = document.querySelector('[role="menu"]').getBoundingClientRect()
    return Math.abs(menu.left - button.left) < 4 && menu.top >= button.bottom
  }))
  await page.locator('[role="menu"]').getByRole('menuitem', { name: /^Mischen/ }).click()
  await page.waitForTimeout(500)
  check('Mischen: Adresse #mischen', (await page.evaluate(() => location.hash)) === '#mischen')
  check('Mischen: Knopf der Gruppe sagt „Ton · Mischen“', (await group.innerText()).trim() === 'Ton · Mischen' && (await group.getAttribute('aria-current')) === 'page')
  const rule = await page.locator('[data-tabrule]').boundingBox()
  const box = await group.boundingBox()
  check('Mischen: Strich unter der Gruppe', Math.abs(rule.x - (box.x + 12)) < 2, `${rule.x} vs ${box.x}`)
  check('Mischen: Menü zu', (await page.locator('[role="menu"]').count()) === 0)

  // Keyboard: Enter opens, Escape closes and gives the focus back.
  await group.focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  check('Tastatur: Enter öffnet, Fokus im Menü', (await page.locator('[role="menu"]').count()) === 1 && (await page.evaluate(() => document.activeElement?.getAttribute('role'))) === 'menuitem')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('Tastatur: Escape schliesst, Fokus zurück', (await page.locator('[role="menu"]').count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('data-group'))) === 'ton')

  // Every tool is still reachable by its address.
  const slugs = ['umwandeln', 'video', 'bilder', 'untertitel', 'ton', 'mischen', 'spuren-trennen', 'lautstaerke', 'zerschneiden', 'tonart', 'bildschirm', 'spiegeln', 'mikrofon']
  let seen = 0
  for (const slug of slugs) {
    await page.evaluate((s) => { history.pushState(null, '', `#${s}`); window.dispatchEvent(new PopStateEvent('popstate')) }, slug)
    await page.waitForTimeout(150)
    if ((await page.locator('[data-tab][aria-current="page"]').count()) === 1) seen += 1
  }
  check('Jedes Werkzeug hat einen gewählten Reiter', seen === slugs.length, `${seen}/${slugs.length}`)

  /* -- Handy spiegeln --------------------------------------------------------------------------- */
  await page.goto(`${BASE}#spiegeln`)
  await page.getByRole('heading', { name: 'Handy spiegeln' }).waitFor({ timeout: 15000 })
  check('Spiegeln: fünf Schritte', (await page.locator('ol > li').count()) === 5)
  check('Spiegeln: Build-Nummer und USB-Debugging erklärt', (await page.getByText('Build-Nummer').count()) > 0 && (await page.getByText('USB-Debugging einschalten').count()) > 0)
  await page.screenshot({ path: OUT + 'spiegeln-desktop.png' })
  await page.getByRole('button', { name: 'Handy verbinden' }).click()
  await page.getByText('Es wurde kein Handy gewählt').waitFor({ timeout: 10000 })
  check('Spiegeln: „Handy verbinden“ fragt den Browser', (await page.evaluate(() => window.__usbAsked)) === 1)
  check('Spiegeln: Knopf wieder frei nach dem Schliessen', await page.getByRole('button', { name: 'Handy verbinden' }).isEnabled())
  const help = page.getByText('Wenn es nicht klappt')
  await help.click()
  check('Spiegeln: Hilfe nennt adb kill-server', (await page.getByText('adb kill-server').count()) > 0)
  check('Spiegeln: keine Fehler', errors.length === 0, errors.join(' | '))
  await context.close()
}

/* -- no WebUSB -------------------------------------------------------------------------------- */
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(hideUsb)
  const page = await context.newPage()
  await page.goto(`${BASE}#spiegeln`)
  await page.getByText('kann kein Handy über USB ansprechen').waitFor({ timeout: 15000 })
  check('Ohne WebUSB: ein Satz, kein toter Knopf', (await page.getByRole('button', { name: 'Handy verbinden' }).count()) === 0)
  await context.close()
}

/* -- a phone-width screen --------------------------------------------------------------------- */
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  await context.addInitScript(mockUsb)
  const page = await context.newPage()
  await page.goto(`${BASE}#mischen`)
  await page.waitForSelector('[data-tab]')
  await page.waitForTimeout(800)
  const more = page.getByRole('button', { name: /^Mehr/ })
  check('Handybreite: „Mehr“ da, gewählte Gruppe in der Zeile', (await more.count()) === 1 && (await page.locator('[data-tab][aria-current="page"]').count()) === 1)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  check('Handybreite: nichts schiebt die Seite breiter', !overflow)
  await more.click()
  await page.waitForTimeout(300)
  const menu = await page.locator('[role="menu"]').boundingBox()
  check('Handybreite: Menü bleibt im Bild', menu.x >= 0 && menu.x + menu.width <= 390, JSON.stringify(menu))
  await page.screenshot({ path: OUT + 'spiegeln-handy-mehr.png' })
  await page.keyboard.press('Escape')
  await context.close()
}

await browser.close()
finish()
