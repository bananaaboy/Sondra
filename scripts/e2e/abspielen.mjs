// The player on a phone: a tap on the picture brings the controls back and they stay long enough to use,
// a tap while they are up puts them away, a double tap skips without them flickering.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const film = fs.readFileSync(path.join(here, 'film.webm'))

const browser = await launch(['--autoplay-policy=no-user-gesture-required'])
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block',
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await page.goto(`${BASE}#abspielen`)
await page.locator('input[type=file]').first().setInputFiles({ name: 'Film.webm', mimeType: 'video/webm', buffer: film })
await page.waitForFunction(() => document.querySelector('.sondra-player video'), null, { timeout: 20_000 })
await page.evaluate(() => document.querySelector('.sondra-player video')?.play().catch(() => undefined))
await page.waitForFunction(() => {
  const video = document.querySelector('.sondra-player video')
  return video && !video.paused && video.currentTime > 0.3
}, null, { timeout: 15_000 })

const bar = page.locator('.sondra-player div.absolute.inset-x-0.bottom-0.z-20')
const up = async () => Number(await bar.evaluate((node) => getComputedStyle(node).opacity)) > 0.9
const gone = async () => Number(await bar.evaluate((node) => getComputedStyle(node).opacity)) < 0.1
const box = async () => (await page.locator('.sondra-player video').boundingBox())
const at = async (fx, fy) => {
  const b = await box()
  return { x: b.x + b.width * fx, y: b.y + b.height * fy }
}
// The upper part of the control bar is only a scrim over the picture: a tap there is a tap on the picture.
const scrim = async (fx) => {
  const b = await box()
  const s = await bar.boundingBox()
  return { x: b.x + b.width * fx, y: s.y + 18 }
}
const time = () => page.evaluate(() => document.querySelector('.sondra-player video').currentTime)

// Playing starts with the controls up; left alone they step aside — later for a finger than for a mouse's four seconds.
const playedAt = Date.now()
await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.sondra-player div.absolute.inset-x-0.bottom-0.z-20')).opacity) < 0.1, null, { timeout: 14_000 })
const stayed = (Date.now() - playedAt) / 1000
check('Allein gelassen tritt die Steuerung nach etwa 7 s beiseite, nicht nach 4', stayed >= 6 && stayed <= 10, `${stayed.toFixed(1)} s`)

// The reported bug: a tap on a hidden control bar showed it for a moment and put it away at once.
await page.touchscreen.tap(...Object.values(await scrim(0.5)))
await page.waitForTimeout(400)
check('Hidden: ein Tipp holt die Steuerung zurück', await up())
await page.waitForTimeout(2500)
check('…und sie bleibt, statt gleich wieder zu verschwinden', await up())
await page.screenshot({ path: `${OUT}abspielen-handy.png` })

// The clear part of the picture above the bar answers a tap the same way.
await page.touchscreen.tap(...Object.values(await at(0.5, 0.08)))
await page.waitForTimeout(900)
check('Ein Tipp ins freie Bild blendet die Steuerung aus', await gone())
await page.touchscreen.tap(...Object.values(await at(0.5, 0.08)))
await page.waitForTimeout(400)
check('…und der nächste holt sie zurück', await up())

// A tap on a control works while it is up.
await page.getByRole('button', { name: /^Pause/ }).tap()
await page.waitForTimeout(300)
check('Ein Knopf in der Leiste lässt sich treffen: Pause', await page.evaluate(() => document.querySelector('.sondra-player video').paused))
await page.getByRole('button', { name: /^Abspielen/ }).tap()
await page.waitForFunction(() => !document.querySelector('.sondra-player video').paused, null, { timeout: 5000 })
await page.waitForTimeout(400)

// A tap on the picture while the controls are up puts them away (after the double-tap window).
await page.touchscreen.tap(...Object.values(await scrim(0.5)))
await page.waitForTimeout(900)
check('Steuerung oben: ein Tipp aufs Bild blendet sie aus', await gone())

// Double tap on the right side skips ahead and brings the controls up, without a flash between.
await page.touchscreen.tap(...Object.values(await scrim(0.5)))
await page.waitForTimeout(400)
check('Wieder da', await up())
const before = await time()
const right = await scrim(0.85)
await page.touchscreen.tap(right.x, right.y)
await page.waitForTimeout(120)
await page.touchscreen.tap(right.x, right.y)
const samples = []
for (let i = 0; i < 6; i += 1) {
  samples.push(await up())
  await page.waitForTimeout(100)
}
check('Doppeltipp rechts springt vor', (await time()) - before > 6, `${((await time()) - before).toFixed(1)} s`)
check('…und die Steuerung flackert dabei nicht', samples.every(Boolean), samples.map((s) => (s ? '1' : '0')).join(''))

check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
