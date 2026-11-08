// „Ordner“: the folders opened before are offered again — in the bar beside a mouse, as buttons
// on the empty page — and a remembered folder that has since vanished is read once, not for ever.
// The folders are real ones (the page's private file system), so the handles can be remembered.
import { BASE, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
await context.addInitScript(() => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(window.__pick, { create: true })
  }
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})

await page.goto(`${BASE}#ordner`)
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  for (const [dir, file] of [
    ['Anime', 'Frieren S01E01.mp4'],
    ['Musik', 'Lied.mp3'],
  ]) {
    try {
      await root.removeEntry(dir, { recursive: true })
    } catch {
      /* not there yet */
    }
    const folder = await root.getDirectoryHandle(dir, { create: true })
    const handle = await folder.getFileHandle(file, { create: true })
    const out = await handle.createWritable()
    await out.write(new Uint8Array(64))
    await out.close()
  }
})
await page.evaluate(() => localStorage.clear())
await page.reload()

const choose = async (name, label) => {
  await page.evaluate((n) => {
    window.__pick = n
  }, name)
  await page.getByRole('button', { name: label }).first().click()
}

await choose('Anime', 'Ordner wählen')
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })
check('Ein einziger Ordner: kein „Zuletzt“, es gäbe nichts anderes zu öffnen', (await page.getByRole('button', { name: 'Zuletzt', exact: true }).count()) === 0)

await choose('Musik', 'Anderer Ordner')
await page.getByText('Lied.mp3').first().waitFor({ timeout: 15_000 })
const recent = page.getByRole('button', { name: 'Zuletzt', exact: true })
check('Zwei Ordner: „Zuletzt“ steht in der Leiste', (await recent.count()) === 1)
await recent.click()
const items = await page.getByRole('menuitem').allInnerTexts()
check('Das Menü nennt den anderen Ordner, nicht den offenen', items.length === 1 && items[0].trim() === 'Anime', items.join(' | '))
await page.keyboard.press('Escape')
check('Escape schliesst das Menü', (await page.getByRole('menu').count()) === 0)

await recent.click()
await page.getByRole('menuitem', { name: 'Anime' }).click()
await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15_000 })
check('Ein Klick im Menü öffnet den Ordner', true)

await page.reload()
await page.waitForTimeout(800)
const text = await page.locator('main').innerText()
check('Neu geladen: der zuletzt geöffnete Ordner wird angeboten oder steht schon da', /Anime/.test(text), text.replace(/\s+/g, ' ').slice(0, 120))
check('…und der andere ebenso', /Musik/.test(text) || (await page.getByRole('button', { name: 'Zuletzt', exact: true }).count()) === 1)

// A folder that has gone: the page says so once and stays usable, instead of reading it again and again.
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry('Anime', { recursive: true })
})
await page.reload()
await page.waitForTimeout(2500)
const alive = await Promise.race([page.evaluate(() => 1 + 1), new Promise((resolve) => setTimeout(() => resolve('hängt'), 3000))])
check('Ein verschwundener Ordner: die Seite bleibt bedienbar', alive === 2, String(alive))
const after = await page.getByRole('button', { name: /Ordner wählen/ }).count()
check('…und „Ordner wählen“ steht weiter da', after > 0)

check('Keine Fehler auf der Seite', errors.length === 0, errors.join('; '))
await browser.close()
finish()
