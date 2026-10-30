// The Sondra folder in Drive: listing, selecting, and deleting into Drive's bin,
// on a desktop and a phone width. No preview next to the list any more.
import { BASE, OUT, check, create, drive, FOLDER, finish, harmless, launch } from './lib.mjs'

const root = create({ name: 'Sondra', mimeType: FOLDER })
const dl = create({ name: 'Heruntergeladen', mimeType: FOLDER, parents: [root.id] })
const a = create({ name: 'Frieren S01E01.mp4', mimeType: 'video/mp4', parents: [dl.id] }, Buffer.alloc(1000))
const b = create({ name: 'Frieren S01E02.mp4', mimeType: 'video/mp4', parents: [dl.id] }, Buffer.alloc(1000))
const c = create({ name: 'Notiz.txt', mimeType: 'text/plain', parents: [root.id] }, Buffer.from('hi'))

const browser = await launch()
for (const viewport of [{ width: 1280, height: 900 }, { width: 400, height: 860 }]) {
  for (const f of [a, b]) f.trashed = false
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' })
  await context.route('https://www.googleapis.com/**', drive)
  await context.addInitScript(() => {
    localStorage.setItem('sondra:drive', JSON.stringify({ linked: true, email: 'test@example.com' }))
    localStorage.setItem('sondra:drive:token', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 3600_000 }))
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { if (!harmless(e)) errors.push(String(e)) })
  await page.goto(BASE + '#ordner')
  const pick = page.getByRole('button', { name: 'Aus Google Drive' })
  await page.waitForTimeout(1500)
  if (await pick.count()) await pick.click()
  await page.waitForTimeout(1500)
  const sub = page.getByText('Heruntergeladen', { exact: true }).first()
  if (await sub.count()) await sub.click()
  await page.getByText('Frieren S01E01.mp4').first().waitFor({ timeout: 15000 })
  check(`${viewport.width}: Vorschau-Knopf weg`, (await page.getByRole('button', { name: 'Vorschau' }).count()) === 0)
  check(`${viewport.width}: Hinweis Papierkorb`, (await page.getByText('Gelöschtes landet im').count()) === 1)
  // find the folder Heruntergeladen if files are grouped; select two files with ctrl
  const one = page.getByText('Frieren S01E01.mp4').first()
  await one.click({ modifiers: ['Control'] })
  await page.getByText('Frieren S01E02.mp4').first().click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'Löschen …' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  check(`${viewport.width}: Dialog sagt Papierkorb`, /Papierkorb von Google Drive/.test(await dialog.innerText()))
  await page.screenshot({ path: OUT + `dialog-${viewport.width}.png` })
  await dialog.getByRole('button', { name: 'In den Papierkorb' }).click()
  await page.getByText(/im Papierkorb von Google Drive/).first().waitFor({ timeout: 10000 })
  check(`${viewport.width}: beide im Papierkorb`, a.trashed && b.trashed && !c.trashed)
  check(`${viewport.width}: aus der Liste`, (await page.getByText('Frieren S01E01.mp4').count()) === 0)
  await page.screenshot({ path: OUT + `nachher-${viewport.width}.png` })
  check(`${viewport.width}: keine Fehler`, errors.length === 0, errors.join(' | '))
  await context.close()
}
await browser.close()
finish()
