// „Beim Minimieren pausieren“: off, a film keeps playing when the page is hidden;
// on, everything that plays stops — and nothing starts again by itself.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

/** A one-second tone as a WAV, so the player has something it plays without FFmpeg. */
function tone(seconds = 20) {
  const rate = 8000
  const samples = rate * seconds
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 6000), 44 + i * 2)
  return buffer
}

const browser = await launch(['--autoplay-policy=no-user-gesture-required'])
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await page.goto(`${BASE}#abspielen`)
await page.locator('input[type=file]').first().setInputFiles({ name: 'Ton.wav', mimeType: 'audio/wav', buffer: tone() })
const media = () => page.evaluate(() => [...document.querySelectorAll('audio,video')].map((el) => ({ paused: el.paused, time: el.currentTime })))
await page.waitForFunction(() => document.querySelector('audio,video'), null, { timeout: 20_000 })
// Starts by itself, or with a click on play.
await page.evaluate(() => document.querySelector('audio,video')?.play().catch(() => undefined))
await page.waitForFunction(() => [...document.querySelectorAll('audio,video')].some((el) => !el.paused), null, { timeout: 10_000 })
const hide = () =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
const show = () =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })

await hide()
await page.waitForTimeout(300)
check('Aus: das Abspielen läuft beim Minimieren weiter', (await media()).some((el) => !el.paused))
await show()

// Switch it on in the player's settings (Zahnrad → Wiedergabe).
await page.getByRole('button', { name: /Einstellungen/ }).first().click()
await page.getByRole('menu', { name: 'Einstellungen' }).getByRole('button', { name: /^Wiedergabe/ }).click()
const toggle = page.getByRole('menuitemcheckbox', { name: /Beim Minimieren pausieren/ })
await toggle.waitFor({ timeout: 10_000 })
await page.screenshot({ path: `${OUT}pausieren-schalter.png` })
await toggle.click()
check('Der Schalter steht an und bleibt gemerkt', (await toggle.getAttribute('aria-checked')) === 'true' && (await page.evaluate(() => localStorage.getItem('sondra:pausieren-beim-minimieren'))) === '1')
await page.keyboard.press('Escape')
await page.evaluate(() => document.querySelector('audio,video')?.play().catch(() => undefined))
await page.waitForFunction(() => [...document.querySelectorAll('audio,video')].some((el) => !el.paused), null, { timeout: 10_000 })

await hide()
await page.waitForFunction(() => [...document.querySelectorAll('audio,video')].every((el) => el.paused), null, { timeout: 5000 }).catch(() => undefined)
check('An: beim Minimieren hält alles an', (await media()).every((el) => el.paused), JSON.stringify(await media()))
await show()
await page.waitForTimeout(600)
check('An: beim Zurückkommen fängt nichts von selbst wieder an', (await media()).every((el) => el.paused))
check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
