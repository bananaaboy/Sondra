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
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', colorScheme: 'dark' })
  await context.addInitScript(mockUsb)
  await context.addInitScript(fakePhone)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { if (!harmless(e)) errors.push(String(e)) })
  await page.goto(`${BASE}#spiegeln`)
  await page.getByRole('heading', { name: 'Handy spiegeln' }).waitFor({ timeout: 15000 })
  const win = page.getByRole('group', { name: 'Handy Pixel 8' })
  check('Fenster: vor dem Verbinden nicht da', (await win.count()) === 0 || !(await win.isVisible()))
  await page.getByRole('button', { name: 'Handy verbinden' }).click()
  await win.waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
  const log = () => page.evaluate(() => window.__log)
  const box0 = await win.boundingBox()
  check('Fenster: steht im Bild, rechts oben', box0.x > 600 && box0.y >= 0 && box0.x + box0.width <= 1440 && box0.y + box0.height <= 900, JSON.stringify(box0))
  check('Fenster: hat den Fokus, Tastatur ist verbunden', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Handy' && (await page.getByText(/Tastatur verbunden/).count()) === 1)
  await page.screenshot({ path: OUT + 'spiegeln-fenster.png' })

  // keyboard: the first key already goes to the phone
  await page.keyboard.press('KeyA')
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Shift')
  await page.keyboard.press('ArrowLeft')
  let entries = await log()
  const keys = entries.filter((e) => e[0] === 'key').map((e) => e.slice(1).join(':'))
  check('Tastatur: A, Umschalt+Z und Pfeil gehen als Tasten ans Handy', ['KeyA:down', 'KeyA:up', 'ShiftLeft:down', 'KeyZ:down', 'KeyZ:up', 'ShiftLeft:up', 'ArrowLeft:down', 'ArrowLeft:up'].every((k) => keys.includes(k)), keys.join(' '))
  await page.keyboard.press('Control+Alt+Escape')
  const before = (await log()).filter((e) => e[0] === 'key').length
  await page.keyboard.press('KeyB')
  entries = await log()
  check('Tastatur: Strg+Alt+Esc gibt sie zurück, danach geht B nicht mehr ans Handy', entries.filter((e) => e[0] === 'key').length === before && entries.some((e) => e[0] === 'release') && (await page.getByText(/Ins Fenster klicken/).count()) === 1)

  // mouse: left, right, middle, wheel
  const canvas = win.locator('canvas')
  const cb = await canvas.boundingBox()
  await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 4)
  await page.mouse.click(cb.x + 20, cb.y + 20, { button: 'right' })
  await page.mouse.click(cb.x + 20, cb.y + 20, { button: 'middle' })
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(200)
  entries = await log()
  const touches = entries.filter((e) => e[0] === 'touch')
  check('Maus: Klick ist Tippen in der Mitte, oben', touches.length >= 2 && touches[0][1] === 'down' && Math.abs(touches[0][2] - 50) <= 2 && Math.abs(touches[0][3] - 25) <= 2, JSON.stringify(touches.slice(0, 2)))
  check('Maus: Rechtsklick ist Zurück, Mittelklick ist Start', entries.some((e) => e[0] === 'button' && e[1] === 'back') && entries.some((e) => e[0] === 'button' && e[1] === 'home'))
  check('Maus: Mausrad scrollt', entries.some((e) => e[0] === 'scroll'))
  check('Maus: Klick ins Fenster holt die Tastatur zurück', (await page.getByText(/Tastatur verbunden/).count()) === 1)

  // buttons of the phone
  await win.getByRole('button', { name: 'Lauter' }).click()
  await win.getByRole('button', { name: 'Benachrichtigungen' }).click()
  await win.getByRole('button', { name: 'Ton ausschalten' }).click()
  entries = await log()
  check('Knöpfe: Lauter, Benachrichtigungen, Ton aus', entries.some((e) => e[0] === 'button' && e[1] === 'volumeUp') && entries.some((e) => e[0] === 'notifications') && entries.some((e) => e[0] === 'mute' && e[1] === true))

  // pull the window by its title bar
  const bar = win.locator('div.cursor-grab')
  const bb = await bar.boundingBox()
  await page.mouse.move(bb.x + 60, bb.y + 20)
  await page.mouse.down()
  await page.mouse.move(bb.x - 140, bb.y + 160, { steps: 8 })
  await page.mouse.up()
  const box1 = await win.boundingBox()
  check('Ziehen: die Titelleiste trägt das Fenster', Math.abs(box1.x - (box0.x - 200)) <= 3 && Math.abs(box1.y - (box0.y + 140)) <= 3, `${box0.x},${box0.y} → ${box1.x},${box1.y}`)
  // …but never out of reach
  await page.mouse.move(box1.x + 60, box1.y + 20)
  await page.mouse.down()
  await page.mouse.move(-2000, -2000, { steps: 4 })
  await page.mouse.up()
  const box2 = await win.boundingBox()
  check('Ziehen: ein Rest des Fensters bleibt im Bild, die Leiste oben', box2.x + box2.width >= 80 && box2.y >= 0, JSON.stringify(box2))
  await page.mouse.move(box2.x + 60, box2.y + 20)
  await page.mouse.down()
  await page.mouse.move(500, 160, { steps: 6 })
  await page.mouse.up()

  // larger at the corner
  const box3 = await win.boundingBox()
  const corner = win.getByRole('separator', { name: 'Größe ändern' })
  const cr = await corner.boundingBox()
  await page.mouse.move(cr.x + 9, cr.y + 9)
  await page.mouse.down()
  await page.mouse.move(cr.x + 9 + 40, cr.y + 9 + 80, { steps: 6 })
  await page.mouse.up()
  const box4 = await win.boundingBox()
  check('Größe: die Ecke macht das Fenster grösser, das Bild bleibt in seiner Form', box4.height > box3.height + 40 && box4.width > box3.width, `${box3.width}x${box3.height} → ${box4.width}x${box4.height}`)
  const cb4 = await canvas.boundingBox()
  check('Größe: das Bild behält 9:16', Math.abs(cb4.width / cb4.height - 360 / 640) < 0.01, String(cb4.width / cb4.height))
  await page.screenshot({ path: OUT + 'spiegeln-fenster-gezogen.png' })

  // where it stands is remembered
  const stored = await page.evaluate(() => localStorage.getItem('sondra:spiegeln:fenster'))
  await page.reload()
  await page.getByRole('heading', { name: 'Handy spiegeln' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Handy verbinden' }).click()
  await win.waitFor({ timeout: 10000 })
  await page.waitForTimeout(300)
  const box5 = await win.boundingBox()
  check('Fenster: Ort und Größe sind nach dem Neuladen wieder da', Boolean(stored) && Math.abs(box5.x - box4.x) <= 3 && Math.abs(box5.y - box4.y) <= 3 && Math.abs(box5.width - box4.width) <= 3, `${box4.x},${box4.y} / ${box5.x},${box5.y}`)


  // a window of its own: a real window of the browser, away from the page's edge
  await page.getByRole('button', { name: 'Fenster zurückholen' }).click()
  const popupAsked = context.waitForEvent('page', { timeout: 10000 }).catch(() => null)
  await win.getByRole('button', { name: 'In einem eigenen Fenster öffnen' }).click()
  const popup = await popupAsked
  check('Eigenes Fenster: das Handy öffnet sich in einem zweiten Fenster', Boolean(popup))
  if (popup) {
    await popup.waitForSelector('canvas', { timeout: 10000 })
    await popup.waitForTimeout(500)
    check('Eigenes Fenster: das Bild ist dort, nicht mehr in der Seite', (await popup.locator('canvas').count()) === 1 && (await win.locator('canvas').count()) === 0 && !(await win.isVisible()))
    const look = await popup.evaluate(() => {
      const rail = document.querySelector('button[aria-label="Zurück"]')
      const box = rail?.getBoundingClientRect()
      return { rail: box ? Math.round(box.width) : 0, bg: getComputedStyle(document.body).backgroundColor, dark: document.documentElement.getAttribute('data-theme') }
    })
    check('Eigenes Fenster: die Seite hat ihr Aussehen mitgenommen (Knöpfe 36 px)', look.rail === 36, JSON.stringify(look))
    await popup.screenshot({ path: OUT + 'spiegeln-eigenes-fenster.png' })
    const sizeBefore = await popup.locator('canvas').boundingBox()
    await popup.setViewportSize({ width: 500, height: 620 })
    await popup.waitForFunction((was) => Math.abs(document.querySelector('canvas').getBoundingClientRect().height - was) > 20, sizeBefore.height, { timeout: 8000 }).catch(() => undefined)
    await popup.waitForTimeout(300)
    const sizeAfter = await popup.locator('canvas').boundingBox()
    check('Eigenes Fenster: das Bild folgt der Größe des Fensters, in seiner Form', sizeAfter.width !== sizeBefore.width && Math.abs(sizeAfter.width / sizeAfter.height - 360 / 640) < 0.02, `${sizeBefore.width}x${sizeBefore.height} → ${sizeAfter.width}x${sizeAfter.height}`)
    const count = async (kind, what) => (await log()).filter((e) => e[0] === kind && (what === undefined || e[1] === what)).length
    const before2 = await count('key')
    const backs = await count('button', 'back')
    const ups = await count('button', 'volumeUp')
    const pc = await popup.locator('canvas').boundingBox()
    await popup.mouse.click(pc.x + pc.width / 2, pc.y + pc.height / 2)
    await popup.keyboard.press('KeyQ')
    await popup.mouse.click(pc.x + 10, pc.y + 10, { button: 'right' })
    entries = await log()
    check('Eigenes Fenster: Tastatur und Maus gehen von dort ans Handy', entries.filter((e) => e[0] === 'key').length >= before2 + 2 && entries.some((e) => e[0] === 'key' && e[1] === 'KeyQ' && e[2] === 'down') && (await count('button', 'back')) === backs + 1, JSON.stringify({ keys: entries.filter((e) => e[0] === 'key').length, before2, backs, nowBacks: await count('button', 'back'), tail: entries.slice(-4) }))
    await popup.getByRole('button', { name: 'Lauter' }).click()
    check('Eigenes Fenster: die Knöpfe des Handys sind da', (await count('button', 'volumeUp')) === ups + 1)
    await popup.close()
    await page.waitForTimeout(500)
    check('Eigenes Fenster: schließen holt das Handy zurück in die Seite', (await win.isVisible()) && (await win.locator('canvas').count()) === 1)
  }

  // back to the first place; and the end
  await page.getByRole('button', { name: 'Fenster zurückholen' }).click()
  await page.waitForTimeout(300)
  const box6 = await win.boundingBox()
  check('„Fenster zurückholen“ bringt es an den ersten Platz', box6.x > 600 && box6.y < 200, JSON.stringify(box6))
  await page.getByRole('button', { name: 'Beenden' }).first().click()
  await page.waitForTimeout(400)
  check('Beenden: das Fenster geht, das Handy wird freigegeben', !(await win.isVisible()) && (await log()).some((e) => e[0] === 'stop'))
  check('Fenster: keine Fehler', errors.length === 0, errors.join(' | '))
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
