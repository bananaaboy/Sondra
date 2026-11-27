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
  check('Reiter: zehn Einträge, nichts hinter „Mehr“', labels.length === 10 && (await page.getByRole('button', { name: /^Mehr/ }).count()) === 0, labels.join(' | '))
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


/* -- the window, with a phone of our own ---------------------------------------------------------
 * There is no ADB device here, so the page is given a stand-in for the connection (the page's own
 * seam for tests): it paints a picture and writes down what the window sends. That checks the
 * window, the mouse and the keyboard; the real connection is not touched. */
const fakePhone = () => {
  window.__log = []
  const log = (entry) => window.__log.push(entry)
  window.__sondraMirrorTest = async ({ canvas, onStep }) => {
    onStep('select')
    canvas.width = 360
    canvas.height = 640
    const g = canvas.getContext('2d')
    const wall = g.createLinearGradient(0, 0, 360, 640)
    wall.addColorStop(0, '#264653'); wall.addColorStop(1, '#e9c46a')
    g.fillStyle = wall; g.fillRect(0, 0, 360, 640)
    g.fillStyle = '#fff'; g.font = '600 56px sans-serif'; g.fillText('9:41', 28, 150)
    g.font = '20px sans-serif'; g.fillText('Mittwoch, 18. November', 30, 184)
    const colors = ['#e76f51', '#2a9d8f', '#f4a261', '#8ecae6', '#b5838d', '#6d597a', '#90be6d', '#f9c74f']
    for (let i = 0; i < 16; i += 1) { g.fillStyle = colors[i % 8]; g.beginPath(); g.roundRect(30 + (i % 4) * 82, 250 + Math.floor(i / 4) * 92, 60, 60, 16); g.fill() }
    g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.roundRect(24, 560, 312, 70, 24); g.fill()
    const listeners = {}
    return {
      deviceName: 'Pixel 8', size: { width: 360, height: 640 }, keyboard: 'uhid', audio: 'on',
      onSize() {}, onKeyboard() {}, onAudio() {}, closed: new Promise(() => {}),
      setMuted: (m) => log(['mute', m]),
      sendKey: async (e) => log(['key', e.code, e.down ? 'down' : 'up']),
      releaseKeys: async () => log(['release']),
      key: async (k) => log(['button', k]),
      openNotifications: async () => log(['notifications']),
      touch: async (kind, x, y) => log(['touch', kind, Math.round(x * 100), Math.round(y * 100)]),
      scroll: async () => log(['scroll']),
      screenshot: async () => undefined,
      stop: async () => log(['stop']),
    }
  }
}
const noPip = () => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true })
for (const [label, withoutPip] of [['Bild-in-Bild', false], ['einfaches Fenster', true]]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', colorScheme: 'dark' })
  await context.addInitScript(mockUsb)
  await context.addInitScript(fakePhone)
  if (withoutPip) await context.addInitScript(noPip)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { if (!harmless(e)) errors.push(String(e)) })
  await page.goto(`${BASE}#spiegeln`)
  await page.getByRole('heading', { name: 'Handy spiegeln' }).waitFor({ timeout: 15000 })
  const view = page.getByRole('region', { name: 'Handy Pixel 8' })
  check(`${label}: vor dem Verbinden ist kein Handy da`, (await view.count()) === 0)
  await page.getByRole('button', { name: 'Handy verbinden' }).click()
  await view.waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  const log = () => page.evaluate(() => window.__log)
  const count = async (kind, what) => (await log()).filter((e) => e[0] === kind && (what === undefined || e[1] === what)).length

  // In the page it is part of the tab: not floating, nothing to pull
  const position = await view.evaluate((e) => getComputedStyle(e).position)
  check(`${label}: in der Seite ist es ein Block des Tabs, kein schwebendes Fenster`, position !== 'fixed' && position !== 'absolute' && (await page.locator('.cursor-grab').count()) === 0 && (await page.getByRole('separator', { name: 'Größe ändern' }).count()) === 0, position)
  const vb = await view.boundingBox()
  check(`${label}: der Block steht im Bild, rechts neben den Hinweisen`, vb.x > 600 && vb.x + vb.width <= 1440 && vb.height > 400, JSON.stringify(vb))
  check(`${label}: Tastatur ist verbunden, ohne dass man etwas tun muss`, (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Handy' && (await page.getByText(/Tastatur verbunden/).count()) === 1)
  await page.screenshot({ path: OUT + `spiegeln-seite-${withoutPip ? 'fenster' : 'pip'}.png` })

  // keyboard
  await page.keyboard.press('KeyA')
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift')
  await page.keyboard.press('ArrowLeft')
  let entries = await log()
  const keys = entries.filter((e) => e[0] === 'key').map((e) => e.slice(1).join(':'))
  check(`${label}: A, Umschalt+Z und Pfeil gehen als Tasten ans Handy`, ['KeyA:down', 'KeyA:up', 'ShiftLeft:down', 'KeyZ:down', 'KeyZ:up', 'ShiftLeft:up', 'ArrowLeft:down', 'ArrowLeft:up'].every((k) => keys.includes(k)), keys.join(' '))
  await page.keyboard.press('Control+Alt+Escape')
  const before = await count('key')
  await page.keyboard.press('KeyB')
  entries = await log()
  check(`${label}: Strg+Alt+Esc gibt die Tastatur zurück`, (await count('key')) === before && entries.some((e) => e[0] === 'release') && (await page.getByText(/Ins Fenster klicken/).count()) === 1)

  // mouse
  const canvas = view.locator('canvas')
  const cb = await canvas.boundingBox()
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 4)
  await page.mouse.click(cb.x + 20, cb.y + 20, { button: 'right' })
  await page.mouse.click(cb.x + 20, cb.y + 20, { button: 'middle' })
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(200)
  entries = await log()
  const touches = entries.filter((e) => e[0] === 'touch')
  check(`${label}: Klick ist Tippen`, touches.length >= 2 && touches[0][1] === 'down' && Math.abs(touches[0][2] - 50) <= 2 && Math.abs(touches[0][3] - 25) <= 2, JSON.stringify(touches.slice(0, 2)))
  check(`${label}: Rechtsklick ist Zurück, Mittelklick ist Start, Mausrad scrollt`, entries.some((e) => e[0] === 'button' && e[1] === 'back') && entries.some((e) => e[0] === 'button' && e[1] === 'home') && entries.some((e) => e[0] === 'scroll'))
  await view.getByRole('button', { name: 'Lauter' }).click()
  await view.getByRole('button', { name: 'Benachrichtigungen' }).click()
  await view.getByRole('button', { name: 'Ton ausschalten' }).click()
  entries = await log()
  check(`${label}: Knöpfe: Lauter, Benachrichtigungen, Ton aus`, entries.some((e) => e[0] === 'button' && e[1] === 'volumeUp') && entries.some((e) => e[0] === 'notifications') && entries.some((e) => e[0] === 'mute' && e[1] === true))

  // only on the button: a window of its own
  check(`${label}: es gibt noch kein zweites Fenster`, context.pages().length === 1)
  const popupAsked = context.waitForEvent('page', { timeout: 10000 }).catch(() => null)
  await view.getByRole('button', { name: 'In einem eigenen Fenster öffnen' }).click()
  const popup = await popupAsked
  check(`${label}: erst der Knopf öffnet das eigene Fenster`, Boolean(popup) && context.pages().length === 2)
  if (popup) {
    await popup.waitForSelector('canvas', { timeout: 10000 })
    await popup.waitForTimeout(500)
    check(`${label}: das Bild ist im eigenen Fenster, in der Seite steht der Hinweis`, (await popup.locator('canvas').count()) === 1 && (await view.locator('canvas').count()) === 0 && (await page.getByText('Das Handy steht in einem eigenen Fenster').count()) >= 1)
    const look = await popup.evaluate(() => {
      const rail = document.querySelector('button[aria-label="Zurück"]')
      const box = rail?.getBoundingClientRect()
      return { rail: box ? Math.round(box.width) : 0 }
    })
    check(`${label}: das Fenster hat das Aussehen der Seite (Knöpfe 36 px)`, look.rail === 36, JSON.stringify(look))
    await popup.screenshot({ path: OUT + `spiegeln-eigenes-fenster-${withoutPip ? 'fenster' : 'pip'}.png` })
    const sizeBefore = await popup.locator('canvas').boundingBox()
    await popup.setViewportSize({ width: 500, height: 620 }).catch(() => undefined)
    await popup.waitForFunction((was) => Math.abs(document.querySelector('canvas').getBoundingClientRect().height - was) > 20, sizeBefore.height, { timeout: 5000 }).catch(() => undefined)
    await popup.waitForTimeout(300)
    const sizeAfter = await popup.locator('canvas').boundingBox()
    check(`${label}: das Bild füllt das Fenster, in seiner Form`, Math.abs(sizeAfter.width / sizeAfter.height - 360 / 640) < 0.02, `${sizeBefore.width}x${sizeBefore.height} → ${sizeAfter.width}x${sizeAfter.height}`)
    const k0 = await count('key'); const b0 = await count('button', 'back'); const v0 = await count('button', 'volumeUp')
    const pc = await popup.locator('canvas').boundingBox()
    await popup.mouse.click(pc.x + pc.width / 2, pc.y + pc.height / 2)
    await popup.keyboard.press('KeyQ')
    await popup.mouse.click(pc.x + 10, pc.y + 10, { button: 'right' })
    await popup.getByRole('button', { name: 'Lauter' }).click()
    check(`${label}: Tastatur, Maus und Knöpfe gehen von dort ans Handy`, (await count('key')) >= k0 + 2 && (await count('button', 'back')) === b0 + 1 && (await count('button', 'volumeUp')) === v0 + 1)
    await popup.close()
    await page.waitForTimeout(600)
    check(`${label}: Schließen holt das Handy zurück in die Seite`, (await view.locator('canvas').count()) === 1 && (await page.getByRole('button', { name: 'In einem eigenen Fenster öffnen' }).count()) === 1)
  }
  await page.getByRole('button', { name: 'Beenden' }).first().click()
  await page.waitForTimeout(400)
  check(`${label}: Beenden gibt das Handy frei`, (await view.count()) === 0 && (await log()).some((e) => e[0] === 'stop'))
  check(`${label}: keine Fehler`, errors.length === 0, errors.join(' | '))
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
