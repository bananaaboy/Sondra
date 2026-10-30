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
// A folder on this device: delete goes into „Sondra-Papierkorb“ first, and „Rückgängig“ brings it back.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(() => {
    // A folder kept in memory, with what the folder API gives: listing, files, folders, removing, moving.
    const directory = (name) => {
      const entries = new Map()
      const self = {
        name,
        kind: 'directory',
        entries,
        async queryPermission() {
          return 'granted'
        },
        async requestPermission() {
          return 'granted'
        },
        async *values() {
          for (const [entryName, entry] of entries) yield entry
        },
        async getDirectoryHandle(child, options) {
          if (!entries.has(child)) {
            if (!options?.create) throw new DOMException('weg', 'NotFoundError')
            entries.set(child, directory(child))
          }
          return entries.get(child)
        },
        async getFileHandle(child, options) {
          if (!entries.has(child)) {
            if (!options?.create) throw new DOMException('weg', 'NotFoundError')
            entries.set(child, file(child, new Uint8Array(0), self))
          }
          return entries.get(child)
        },
        async removeEntry(child) {
          if (!entries.delete(child)) throw new DOMException('weg', 'NotFoundError')
        },
      }
      return self
    }
    const file = (name, bytes, parent) => {
      const handle = {
        name,
        kind: 'file',
        bytes,
        parent,
        async getFile() {
          return new File([handle.bytes], name, { type: 'video/mp4' })
        },
        async move(to, newName) {
          handle.parent.entries.delete(handle.name)
          handle.name = newName ?? handle.name
          handle.parent = to
          to.entries.set(handle.name, handle)
        },
      }
      return handle
    }
    const root = directory('Anime')
    const season = directory('Staffel 1')
    root.entries.set('Staffel 1', season)
    season.entries.set('Folge 1.mp4', file('Folge 1.mp4', new Uint8Array(2000).fill(1), season))
    season.entries.set('Folge 2.mp4', file('Folge 2.mp4', new Uint8Array(2000).fill(2), season))
    window.__root = root
    window.showDirectoryPicker = async () => root
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  await page.goto(`${BASE}#ordner`)
  await page.getByRole('button', { name: 'Ordner wählen' }).click()
  await page.getByText('Staffel 1', { exact: true }).first().click()
  await page.getByText('Folge 1.mp4').first().waitFor({ timeout: 15_000 })
  await page.getByText('Folge 1.mp4').first().click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'Löschen …' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const text = await dialog.innerText()
  check('Lokal: der Dialog nennt den Papierkorb und lässt „Endgültig löschen“ zu', /Sondra-Papierkorb/.test(text) && (await dialog.getByRole('button', { name: 'Endgültig löschen' }).count()) === 1, text.replace(/\s+/g, ' ').slice(0, 120))
  await page.screenshot({ path: `${OUT}lokal-papierkorb.png` })
  await dialog.getByRole('button', { name: 'In den Papierkorb' }).click()
  await page.getByText(/im Ordner „Sondra-Papierkorb“/).waitFor({ timeout: 10_000 })
  const binHas = () => page.evaluate(() => [...window.__root.entries.get('Sondra-Papierkorb').entries.keys()])
  check('Lokal: die Datei liegt im Papierkorb, nicht mehr im Ordner', (await binHas()).join() === 'Folge 1.mp4' && (await page.getByText('Folge 1.mp4').count()) === 0)
  check('Lokal: der Papierkorb steht nicht in der Liste, die andere Folge schon', (await page.getByText('Sondra-Papierkorb', { exact: true }).count()) === 0 && (await page.getByText('Folge 2.mp4').count()) > 0)
  await page.getByRole('button', { name: 'Rückgängig' }).click()
  await page.getByText('Folge 1.mp4').first().waitFor({ timeout: 10_000 })
  check('Lokal: nach „Rückgängig“ ist sie wieder da und der Papierkorb leer', (await binHas()).length === 0 && (await page.getByText(/zurückgelegt/).count()) > 0)
  // Subtitles: the dialog says where the model comes from before anything is loaded.
  await page.getByText('Folge 1.mp4').first().click({ modifiers: ['Control'] })
  await page.getByRole('button', { name: 'Untertitel erzeugen' }).click()
  const subs = page.getByRole('dialog')
  await subs.waitFor()
  const subsText = await subs.innerText()
  check('Untertitel: das Fenster nennt Hugging Face und dass der Ton das Gerät nicht verlässt', /Hugging Face/.test(subsText) && /verlässt es nicht/.test(subsText), subsText.replace(/\s+/g, ' ').slice(0, 100))
  check('Untertitel: Sprache und Genauigkeit stehen zur Wahl, „Beginnen“ wartet auf den Klick', (await subs.getByRole('combobox').count()) === 2 && (await subs.getByRole('button', { name: 'Beginnen' }).isEnabled()))
  await page.screenshot({ path: `${OUT}untertitel.png` })
  await subs.getByRole('button', { name: 'Schliessen', exact: true }).click()
  check('Lokal: keine Fehler', errors.length === 0, errors.join(' | '))
  await context.close()
}

// A folder of 3000 files: the first page at once, the rest as one scrolls, Ctrl+A takes every file — also those not on screen.
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  await context.addInitScript(() => {
    const root = {
      name: 'Gross',
      kind: 'directory',
      async queryPermission() {
        return 'granted'
      },
      async requestPermission() {
        return 'granted'
      },
      async *values() {
        for (let n = 1; n <= 3000; n += 1) {
          const name = `Folge ${String(n).padStart(4, '0')}.mp4`
          yield { kind: 'file', name, getFile: async () => new File([new Uint8Array(10)], name, { type: 'video/mp4' }) }
        }
      },
      async removeEntry() {},
    }
    window.showDirectoryPicker = async () => root
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  await page.goto(`${BASE}#ordner`)
  const started = Date.now()
  await page.getByRole('button', { name: 'Ordner wählen' }).click()
  await page.getByText('Folge 0001.mp4').first().waitFor({ timeout: 30_000 })
  const firstPage = Date.now() - started
  const count = () => page.locator('[role=option]').count()
  check('3000 Dateien: die erste Seite steht gleich da, nicht alle auf einmal', (await count()) > 0 && (await count()) <= 480, `${await count()} Kacheln nach ${firstPage} ms`)
  for (let i = 0; i < 8; i += 1) {
    await page.mouse.wheel(0, 6000)
    await page.waitForTimeout(250)
  }
  const grown = await count()
  check('3000 Dateien: beim Scrollen kommen die nächsten von selbst', grown > 480, `${grown} Kacheln`)
  await page.getByText('Folge 0001.mp4').first().click()
  await page.keyboard.press('Control+a')
  await page.waitForTimeout(400)
  check('3000 Dateien: Strg+A wählt jede Datei, auch die noch nicht gezeigten', /3\s?000 ausgewählt|3000 ausgewählt/.test((await page.locator('main').innerText()).replace(/\u2009|\u202f|\u00a0/g, ' ')), (await page.locator('main').innerText()).match(/\d[\d' ]* ausgewählt/)?.[0] ?? 'kein Zähler')
  await page.screenshot({ path: `${OUT}gross.png` })
  check('3000 Dateien: keine Fehler', errors.length === 0, errors.join(' | '))
  await context.close()
}

await browser.close()
finish()
