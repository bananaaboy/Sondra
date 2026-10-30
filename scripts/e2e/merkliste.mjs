// The Merkliste's statistics: the year in review from dated episodes, with a
// seeded list — the year of today and the one before, so it never goes stale.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const year = new Date().getFullYear()
const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime()
const items = [
  { id: 'c', title: 'Nachholen', url: '', season: 1, episode: 1, status: 'later', updatedAt: Date.now() },
  {
    id: 'a', title: 'Frieren', url: '', season: 1, episode: 5, status: 'watching', updatedAt: Date.now(), episodeDuration: 25,
    history: [
      { id: '1', season: 1, episode: 1, at: at(year, 3, 1) },
      { id: '2', season: 1, episode: 2, at: at(year, 3, 2) },
      { id: '3', season: 1, episode: 3, at: at(year, 3, 3) },
      { id: '4', season: 1, episode: 4, at: at(year - 1, 11, 9) },
    ],
  },
  {
    id: 'b', title: 'Nana', url: '', season: 1, episode: 3, status: 'watching', updatedAt: Date.now(), episodeDuration: 20,
    history: [{ id: '5', season: 1, episode: 1, at: at(year, 3, 3) }, { id: '6', season: 1, episode: 2, at: at(year, 7, 20) }],
  },
]
await context.addInitScript((seed) => localStorage.setItem('sondra:saved_links', JSON.stringify(seed)), items)
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await page.goto(`${BASE}#merkliste`)
await page.getByRole('button', { name: 'Statistiken zur Merkliste öffnen' }).click()
const dialog = page.getByRole('dialog')
await dialog.waitFor()
const heading = dialog.getByRole('heading', { name: `Rückblick ${year}` })
await heading.waitFor({ timeout: 10_000 })
const text = await dialog.innerText()
check('Rückblick: das Jahr und seine Folgen (5)', /Rückblick/.test(text) && /Folgen\s*5/.test(text.replace(/\n+/g, ' ')), text.replace(/\s+/g, ' ').slice(text.indexOf('Rückblick'), text.indexOf('Rückblick') + 140))
check('Rückblick: die Reihenfolge der Serien (Frieren vor Nana)', text.indexOf('Frieren') > -1 && text.indexOf('Frieren') < text.indexOf('Nana', text.indexOf('Frieren')))
check('Rückblick: das Vorjahr steht zur Wahl', (await dialog.getByRole('radio', { name: String(year - 1) }).count()) === 1)
await dialog.getByRole('radio', { name: String(year - 1) }).click()
await dialog.getByRole('heading', { name: `Rückblick ${year - 1}` }).waitFor({ timeout: 5000 })
check('Rückblick: das Vorjahr zeigt seine eine Folge', /Folgen\s*1\b/.test((await dialog.innerText()).replace(/\n+/g, ' ')))
check('Rückblick: sagt, seit wann Daten da sind', /Mit Datum festgehalten seit dem/.test(await dialog.innerText()))
await page.screenshot({ path: `${OUT}rueckblick.png` })
await dialog.getByRole('button', { name: 'Schliessen' }).first().click().catch(() => page.keyboard.press('Escape'))

// Share. The list holds covers (a drawn poster each), so pictures can travel in the link.
await page.keyboard.press('Escape')
const seeded = (context) =>
  context.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    const poster = (hue) => {
      const canvas = document.createElement('canvas')
      canvas.width = 200
      canvas.height = 300
      const g = canvas.getContext('2d')
      const gradient = g.createLinearGradient(0, 0, 200, 300)
      gradient.addColorStop(0, `hsl(${hue},70%,35%)`)
      gradient.addColorStop(1, `hsl(${hue + 70},70%,70%)`)
      g.fillStyle = gradient
      g.fillRect(0, 0, 200, 300)
      g.fillStyle = '#fff'
      g.beginPath()
      g.arc(100, 120, 50, 0, Math.PI * 2)
      g.fill()
      return canvas.toDataURL('image/webp', 0.8)
    }
    const list = JSON.parse(localStorage.getItem('sondra:saved_links') ?? '[]')
    localStorage.setItem('sondra:saved_links', JSON.stringify(list.map((item, n) => (item.title === 'Frieren' || item.title === 'Nana' ? { ...item, cover: poster(n * 120), url: 'https://geheim.example/x' } : item))))
  })
await seeded(context)
await page.reload()
await page.getByText('Nana', { exact: true }).first().waitFor({ timeout: 15_000 })
// One series: „Empfehlen“ on its page, with a small picture.
await page.getByText('Frieren', { exact: true }).first().click()
await page.getByRole('button', { name: 'Empfehlen' }).click()
const rec = page.getByRole('dialog')
await rec.getByText('„Frieren“ empfehlen').waitFor({ timeout: 10_000 })
await page.waitForFunction(() => /#g=/.test(document.querySelector('dialog[open] input[readonly]')?.value ?? ''), null, { timeout: 15_000 })
const recLink = await rec.getByRole('textbox', { name: 'Link', exact: true }).inputValue()
const recText = (await rec.innerText()).replace(/\s+/g, ' ')
check('Empfehlen: nur diese Serie ist gewählt, mit Bild, ein Link', /1 von 3 gewählt/.test(recText) && /1 von 1 mit Bild/.test(recText) && /Ein Link/.test(recText), recText.slice(recText.indexOf('1 von'), recText.indexOf('1 von') + 160))
check('Empfehlen: der Link ist kurz und verrät nichts', recLink.length < 2000 && !recLink.includes('geheim'), `${recLink.length} Zeichen`)
await page.screenshot({ path: `${OUT}empfehlen.png` })
await rec.getByRole('button', { name: 'Schliessen', exact: true }).last().click()

// The whole list: what is chosen by default, the ways to hand it over.
await page.keyboard.press('Escape')
await page.getByRole('button', { name: 'Merkliste', exact: true }).click()
await page.getByRole('button', { name: 'Teilen' }).click()
const share = page.getByRole('dialog')
await share.waitFor()
await share.getByLabel(/Ihr Name/).fill('Mia')
await page.waitForFunction(() => /#g=/.test(document.querySelector('dialog[open] input[readonly]')?.value ?? ''), null, { timeout: 15_000 })
const link = await share.getByRole('textbox', { name: 'Link', exact: true }).inputValue()
const shareText = (await share.innerText()).replace(/\s+/g, ' ')
check('Teilen: Am Schauen ist gewählt (2 von 3), der Link trägt die Liste im Hash, ohne Adressen der Folgen', /2 von 3 gewählt/.test(shareText) && /#g=/.test(link) && link.length < 2000 && !link.includes('geheim'), `${link.length} Zeichen`)
check('Teilen: die Bilder gehen mit (Winzig)', /2 von 2 mit Bild/.test(shareText), shareText.slice(shareText.indexOf('Winzig'), shareText.indexOf('Winzig') + 120))
await page.screenshot({ path: `${OUT}teilen.png` })
// As text, anybody reads it.
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin })
await share.getByRole('button', { name: 'Als Text kopieren' }).click()
await share.getByText(/Als Text kopiert/).waitFor({ timeout: 5000 })
const copiedText = await page.evaluate(() => navigator.clipboard.readText())
check('Teilen: als Text — Kopfzeile, eine Zeile je Serie, der Link darunter', /^Merkliste von Mia \(2\):\n• Frieren – S1E5\n• Nana – S1E3\n\nIn Sondra öffnen: https?:\/\/\S+#g=/.test(copiedText), copiedText.slice(0, 120))
// As a QR code, made here.
await share.getByRole('button', { name: 'QR-Code zeigen' }).click()
const qr = share.getByRole('img', { name: /QR-Code/ })
await qr.waitFor({ timeout: 15_000 })
const modules = await qr.locator('path').getAttribute('d')
check('Teilen: ein QR-Code wird gezeichnet', (modules?.length ?? 0) > 200 && (await qr.evaluate((node) => node.getBoundingClientRect().width)) > 200, `${modules?.length} Zeichen Pfad`)
await page.screenshot({ path: `${OUT}teilen-qr.png` })
// As a file.
const [download] = await Promise.all([page.waitForEvent('download'), share.getByRole('button', { name: 'Als Datei speichern' }).click()])
const filePath = `${OUT}liste.sondra-liste`
await download.saveAs(filePath)
check('Teilen: die Datei heisst .sondra-liste', /\.sondra-liste$/.test(download.suggestedFilename()), download.suggestedFilename())

const guestContext = async (own) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript((seed) => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('sondra:saved_links', JSON.stringify(seed))
    }
  }, own)
  return context
}
const mineOf = [
  { id: 'x', title: 'NANA', url: '', season: 1, episode: 1, status: 'watching', updatedAt: Date.now() },
  { id: 'y', title: 'Eigene', url: '', season: 1, episode: 1, status: 'watching', updatedAt: Date.now() },
]
{
  const other = await guestContext(mineOf)
  const guest = await other.newPage()
  guest.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  await guest.goto(link.replace(/^https?:\/\/[^/]+\//, BASE))
  const shared = guest.getByRole('dialog')
  await shared.getByText('Merkliste von Mia').waitFor({ timeout: 15_000 })
  const sharedText = (await shared.innerText()).replace(/\s+/g, ' ')
  check('Empfangen: der Gast sieht den Namen und den Vergleich — beide 1, nur bei ihm 1, nur bei Mia 1', /Beide haben 1/.test(sharedText) && /nur bei Ihnen 1/.test(sharedText) && /nur bei Mia 1/.test(sharedText), sharedText.slice(0, 200))
  check('Empfangen: angeboten wird nur, was neu ist (Frieren), mit seinem Bild', /Neu für Sie/.test(sharedText) && /Frieren/.test(sharedText) && (await shared.locator('img').count()) === 1 && /^data:image\//.test((await shared.locator('img').first().getAttribute('src')) ?? ''), sharedText.slice(sharedText.indexOf('Neu für Sie'), sharedText.indexOf('Neu für Sie') + 100))
  await guest.screenshot({ path: `${OUT}teilen-gast.png` })
  await shared.getByRole('radio', { name: 'als Später' }).click()
  await shared.getByRole('button', { name: /1 Eintrag zu meiner Merkliste/ }).click()
  await shared.getByText(/1 hinzugefügt/).waitFor({ timeout: 5000 })
  const stored = await guest.evaluate(() => JSON.parse(localStorage.getItem('sondra:saved_links') ?? '[]').map((item) => [item.title, item.status ?? 'watching', /^data:image\//.test(item.cover ?? '')]))
  check('Empfangen: Frieren steht danach als Später auf der Liste, mit dem kleinen Bild; Nana nicht doppelt', stored.length === 3 && stored.some(([title, status, cover]) => title === 'Frieren' && status === 'later' && cover), JSON.stringify(stored))
  await other.close()
}
// The same list as a file, dropped into a page that knows nothing of it.
{
  const other = await guestContext([])
  const guest = await other.newPage()
  guest.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  await guest.goto(BASE)
  await guest.locator('input[type=file]:not([webkitdirectory])').first().setInputFiles(filePath)
  const shared = guest.getByRole('dialog')
  await shared.getByText('Merkliste von Mia').waitFor({ timeout: 15_000 })
  check('Datei: sie öffnet dasselbe Fenster, mit beiden Serien', /Frieren/.test(await shared.innerText()) && /Nana/.test(await shared.innerText()))
  await other.close()
}

// A list too long for one link comes in parts, which find each other as they are opened.
{
  const long = Array.from({ length: 90 }, (_, n) => ({
    id: `l${n}`, title: `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)} ${n}`, url: '', season: 1, episode: 1 + (n % 9), status: 'watching', updatedAt: Date.now(),
  }))
  const sender = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await sender.addInitScript((seed) => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('sondra:saved_links', JSON.stringify(seed))
    }
  }, long)
  await sender.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin })
  const big = await sender.newPage()
  await big.goto(`${BASE}#merkliste`)
  await big.getByRole('button', { name: 'Teilen' }).click()
  const bigDialog = big.getByRole('dialog')
  await bigDialog.getByRole('button', { name: /Alle \d+ Links kopieren/ }).waitFor({ timeout: 20_000 })
  const label = await bigDialog.getByRole('button', { name: /Alle \d+ Links kopieren/ }).innerText()
  const count = Number(/\d+/.exec(label)[0])
  await bigDialog.getByRole('button', { name: /Alle \d+ Links kopieren/ }).click()
  const all = (await big.evaluate(() => navigator.clipboard.readText())).split('\n\n')
  check(`Teile: eine lange Liste kommt in ${count} Links, jeder höchstens 2000 Zeichen`, count > 1 && all.length === count && all.every((entry) => entry.length <= 2000), `${count} Teile, ${all.map((entry) => entry.length).join('+')}`)
  await big.screenshot({ path: `${OUT}teilen-teile.png` })
  // Opened one after the other, each in a fresh tab, in a mixed order.
  const receiver = await guestContext([])
  const order = [...all.keys()].reverse()
  let last
  for (const [step, index] of order.entries()) {
    last = await receiver.newPage()
    last.on('pageerror', (e) => {
      if (!harmless(e)) errors.push(String(e))
    })
    await last.goto(all[index].replace(/^https?:\/\/[^/]+\//, BASE))
    if (step < order.length - 1) {
      await last.getByText(/Teil .* von \d+ ist da/).waitFor({ timeout: 15_000 })
      check(`Teile: nach ${step + 1} von ${count} wird gewartet und gesagt, wie weit es ist`, true)
    }
  }
  await last.getByText('Geteilte Merkliste').waitFor({ timeout: 15_000 })
  await last.getByRole('button', { name: '90 Einträge zu meiner Merkliste' }).waitFor({ timeout: 15_000 })
  check('Teile: mit dem letzten Teil ist die ganze Liste da (90 Einträge)', true)
  await receiver.close()
  await sender.close()
}

// Links of the first version — JSON — still open.
{
  const other = await guestContext([])
  const guest = await other.newPage()
  const v1 = await guest.evaluate(async () => {
    const stream = new Blob([JSON.stringify({ v: 1, name: 'Alt', items: [{ title: 'Alte Serie', status: 'done', rating: 4, season: 1, episode: 3, seen: 12 }] })]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  })
  await guest.goto(`${BASE}#geteilt=${v1}`)
  const shared = guest.getByRole('dialog')
  await shared.getByText('Merkliste von Alt').waitFor({ timeout: 15_000 })
  check('Alt: ein Link der ersten Fassung öffnet sich weiter', /Alte Serie/.test(await shared.innerText()))
  await other.close()
}

// A broken link says so and breaks nothing.
const broken = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const bad = await broken.newPage()
bad.on('pageerror', (e) => {
  if (!harmless(e)) errors.push(String(e))
})
await bad.goto(`${BASE}#g=AAAAAAAA`)
await bad.getByText('Das ist nicht lesbar').waitFor({ timeout: 10_000 })
check('Teilen: ein kaputter Link wird gesagt, die Seite bleibt heil', true)
await broken.close()

check('Keine Fehler auf der Seite', errors.length === 0, errors.join(' | '))
await browser.close()
finish()
