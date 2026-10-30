// Two devices, one Google account: a laptop in Chrome and a phone in the
// Android app (bridge mocked), both against a Drive kept in this process.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BASE, FOLDER, OUT, check, create, drive, files, finish, launch, now, sha } from './lib.mjs'

/* ---------------- Two devices ---------------- */
const browser = await launch(['--disable-features=WebRtcHideLocalIpsWithMdns'])

async function device({ name, android }) {
  const context = await browser.newContext({
    viewport: android ? { width: 400, height: 860 } : { width: 1280, height: 900 },
    userAgent: android
      ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 SondraAndroid/1.1.21'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    serviceWorkers: 'block',
  })
  await context.route('https://www.googleapis.com/**', drive)
  await context.addInitScript(
    ([android, enabled]) => {
      localStorage.setItem('sondra:drive', JSON.stringify({ linked: true, email: 'test@example.com' }))
      localStorage.setItem('sondra:drive:token', JSON.stringify({ token: 'tok', expiresAt: Date.now() + 3600_000 }))
      if (enabled) localStorage.setItem('sondra:geraete:an', '1')
      // Strips the other side's addresses on demand: no direct way, as between two networks.
      const Original = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Original {
        setRemoteDescription(description) {
          if (window.__noDirect && description?.sdp) {
            description = { type: description.type, sdp: description.sdp.split('\r\n').filter((line) => !line.startsWith('a=candidate')).join('\r\n') }
          }
          return super.setRemoteDescription(description)
        }
      }
      // Cuts the line after so many bytes of file data have gone out: a break in the middle of a transfer.
      const sendOriginal = RTCDataChannel.prototype.send
      window.__sentBytes = 0
      RTCDataChannel.prototype.send = function (data) {
        if (typeof data !== 'string' && data.byteLength) {
          window.__sentBytes += data.byteLength
          if (window.__cutAfter && window.__sentBytes > window.__cutAfter) {
            window.__cutAfter = 0
            this.close()
            return
          }
        }
        return sendOriginal.call(this, data)
      }
      window.__saved = {}
      if (android) {
        const saves = new Map()
        let handles = 0
        const port = {
          onmessage: null,
          postMessage(raw) {
            const m = JSON.parse(raw)
            const reply = (answer) => setTimeout(() => port.onmessage?.({ data: JSON.stringify({ id: m.id, answer }) }), 5)
            if (m.type === 'save-begin') {
              const handle = `h${(handles += 1)}`
              saves.set(handle, { name: m.name, dir: m.dir ?? '', parts: [] })
              reply({ ok: true, handle })
            } else if (m.type === 'save-chunk') {
              saves.get(m.handle).parts.push(m.data)
              reply({ ok: true })
            } else if (m.type === 'save-end') {
              const save = saves.get(m.handle)
              window.__saved[(save.dir ? `${save.dir}/` : '') + save.name] = save.parts
              reply({ ok: true, where: `Downloads/Sondra/${save.name}` })
            } else if (m.type === 'save-abort') {
              saves.delete(m.handle)
            } else if (m.type === 'opened') reply([])
            else reply({ ok: false, error: 'rejected' })
          },
        }
        window.SondraNative = port
      } else {
        // A folder the user picked, kept in memory — with folders inside it.
        const directory = (name, prefix) => {
          const entries = new Map()
          return {
            name,
            kind: 'directory',
            async *keys() {
              yield* entries.keys()
            },
            async getDirectoryHandle(child, options) {
              if (!entries.has(child)) {
                if (!options?.create) throw new DOMException('nicht da', 'NotFoundError')
                entries.set(child, directory(child, `${prefix}${child}/`))
              }
              return entries.get(child)
            },
            async getFileHandle(fileName, options) {
              if (!entries.has(fileName) && !options?.create) throw new DOMException('nicht da', 'NotFoundError')
              return {
                async getFile() {
                  const bytes = entries.get(fileName) ?? new Uint8Array(0)
                  return new File([bytes], fileName)
                },
                async createWritable(writeOptions) {
                  let all = writeOptions?.keepExistingData ? new Uint8Array(entries.get(fileName) ?? []) : new Uint8Array(0)
                  let position = all.length
                  return {
                    async seek(to) {
                      position = to
                    },
                    async write(chunk) {
                      const piece = new Uint8Array(chunk)
                      if (position + piece.length > all.length) {
                        const grown = new Uint8Array(position + piece.length)
                        grown.set(all)
                        all = grown
                      }
                      all.set(piece, position)
                      position += piece.length
                    },
                    async close() {
                      entries.set(fileName, all)
                      let text = ''
                      for (let i = 0; i < all.length; i += 0x8000) text += String.fromCharCode(...all.subarray(i, i + 0x8000))
                      window.__saved[`${prefix}${fileName}`] = [btoa(text)]
                    },
                    async abort() {},
                  }
                },
              }
            },
            async removeEntry(fileName) {
              entries.delete(fileName)
            },
          }
        }
        const dir = directory('Downloads', '')
        window.showDirectoryPicker = async () => dir
      }
    },
    [android, android],
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|google-token|Failed to load resource/.test(message.text())) errors.push(`console: ${message.text()}`)
  })
  await page.goto(`${BASE}#geraete`)
  return { name, page, context, errors }
}

const savedBytes = async (page, fileName) =>
  page.evaluate((n) => {
    const parts = window.__saved[n]
    if (!parts) return null
    return parts.join('|')
  }, fileName)
const decode = (joined) => Buffer.concat(joined.split('|').map((part) => Buffer.from(part, 'base64')))

const laptop = await device({ name: 'Laptop', android: false })
const phone = await device({ name: 'Handy', android: true })

// The laptop joins with its button; the phone was switched on already.
await laptop.page.getByRole('button', { name: 'Dieses Gerät verbinden' }).click()
const otherRow = (page, label) => page.locator('li').filter({ hasText: label }).filter({ has: page.getByRole('button', { name: 'Dateien senden' }) })
await otherRow(laptop.page, 'Handy').waitFor({ timeout: 30_000 })
await laptop.page.waitForTimeout(500)
check('Laptop sieht das Handy', await otherRow(laptop.page, 'Handy').isVisible())
await phone.page.getByRole('button', { name: 'Umbenennen' }).waitFor({ timeout: 30_000 })
// The phone lists others every 30 s; a return to the page asks at once.
await phone.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
await otherRow(phone.page, 'Computer').waitFor({ timeout: 40_000 })
check('Handy sieht den Laptop', true)

const registry = () => [...files.values()].filter((file) => file.appProperties?.sondraArt === 'geraet')
check('Je Gerät genau eine Datei im Register', registry().length === 2, registry().map((f) => f.name).join(', '))
const ids = registry().map((file) => file.appProperties.sondraGeraet)
check('Zwei verschiedene Kennungen', new Set(ids).size === 2 && ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{20}$/.test(id)), ids.join(' '))

// Unique names: the laptop wants the phone's name.
await laptop.page.getByRole('button', { name: 'Umbenennen' }).click()
await laptop.page.getByLabel('Name dieses Geräts').fill('Handy')
await laptop.page.getByRole('button', { name: 'Speichern' }).click()
await laptop.page.getByText('trägt schon ein anderes Gerät').waitFor({ timeout: 15_000 })
const laptopName = await laptop.page.locator('section[aria-labelledby=geraete-dieses]').innerText()
check('Belegter Name wird nicht übernommen', /Handy 2/.test(laptopName), laptopName.replace(/\s+/g, ' ').slice(0, 120))
await laptop.page.getByRole('button', { name: 'Umbenennen' }).click()
await laptop.page.getByLabel('Name dieses Geräts').fill('Laptop')
await laptop.page.getByRole('button', { name: 'Speichern' }).click()
await laptop.page.waitForTimeout(800)

// Tampering: someone rewrites the phone's record by hand, and plants a copy under its id.
const phoneFile = registry().find((file) => JSON.parse(file.bytes.toString()).kind === 'android')
const phoneId = phoneFile.appProperties.sondraGeraet
const original = JSON.parse(phoneFile.bytes.toString())
phoneFile.bytes = Buffer.from(JSON.stringify({ ...original, name: 'Gehackt' }))
phoneFile.modifiedTime = now()
const laptopRecord = JSON.parse(registry().find((file) => file !== phoneFile).bytes.toString())
const planted = create(
  { name: `Gerät-${phoneId}.json`, mimeType: 'application/json', parents: phoneFile.parents, appProperties: { sondraArt: 'geraet', sondraGeraet: phoneId } },
  Buffer.from(JSON.stringify({ ...laptopRecord, id: phoneId, name: 'Falsches Handy' })),
)
await laptop.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
await laptop.page.waitForTimeout(6000)
const laptopView = await laptop.page.locator('main').innerText()
check('Veränderter Eintrag wird nicht geglaubt', !/Gehackt|Falsches Handy/.test(laptopView))
await phone.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
let restored = false
for (let i = 0; i < 40 && !restored; i += 1) {
  await phone.page.waitForTimeout(1000)
  const current = files.get(phoneFile.id)
  restored = Boolean(current) && JSON.parse(current.bytes.toString()).name === 'Handy' && !files.has(planted.id)
}
check('Das Handy schreibt seinen Eintrag wieder und löscht die Kopie', restored)

// Direct: 12 MB from the laptop to the phone.
const film = Buffer.alloc(12 * 1024 * 1024 + 77)
for (let i = 0; i < film.length; i += 1) film[i] = (i * 31 + (i >> 9)) & 255
await otherRow(laptop.page, 'Handy').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Film.mp4', mimeType: 'video/mp4', buffer: film })
await phone.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
await phone.page.screenshot({ path: `${OUT}handy-angebot.png`, fullPage: true })
await phone.page.getByRole('button', { name: 'Annehmen' }).click()
await phone.page.getByText(/Von „Laptop“ gespeichert/).waitFor({ timeout: 60_000 })
await laptop.page.getByText(/Angekommen auf „Handy“/).waitFor({ timeout: 30_000 })
const directSaved = await savedBytes(phone.page, 'Film.mp4')
check('Direkt: Film kommt Byte für Byte auf dem Handy an', directSaved && sha(decode(directSaved)) === sha(film), `${film.length} Bytes`)
const directText = await laptop.page.locator('main').innerText()
check('Direkt: Laptop zeigt, wo es liegt', /Downloads\/Sondra\/Film\.mp4/.test(directText))
check('Direkt: nichts davon lag in Drive', ![...files.values()].some((file) => file.name === 'Film.mp4'))
await laptop.page.screenshot({ path: `${OUT}laptop-gesendet.png`, fullPage: true })

// No direct way: through Drive, after the click.
await phone.page.evaluate(() => (window.__noDirect = true))
await laptop.page.evaluate(() => (window.__noDirect = true))
const note = Buffer.from('Notiz über Drive '.repeat(20000))
await otherRow(laptop.page, 'Handy').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Notiz.txt', mimeType: 'text/plain', buffer: note })
await phone.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
await phone.page.getByRole('button', { name: 'Annehmen' }).click()
await laptop.page.getByRole('button', { name: 'Über Google Drive senden' }).waitFor({ timeout: 45_000 })
await laptop.page.screenshot({ path: `${OUT}laptop-kein-weg.png`, fullPage: true })
await laptop.page.getByRole('button', { name: 'Über Google Drive senden' }).click()
await phone.page.getByText(/Von „Laptop“ gespeichert/).nth(1).waitFor({ timeout: 60_000 }).catch(() => undefined)
await laptop.page.getByText(/Angekommen auf „Handy“/).nth(1).waitFor({ timeout: 40_000 })
const viaDrive = await savedBytes(phone.page, 'Notiz.txt')
check('Über Drive: Notiz kommt an', viaDrive && sha(decode(viaDrive)) === sha(note))
check('Über Drive: danach nicht mehr in Drive', ![...files.values()].some((file) => file.name === 'Notiz.txt'))

// The other way: from the phone to the laptop, into its folder.
await phone.page.evaluate(() => (window.__noDirect = false))
await laptop.page.evaluate(() => (window.__noDirect = false))
const photo = Buffer.alloc(300_000, 7)
await otherRow(phone.page, 'Laptop').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Foto.jpg', mimeType: 'image/jpeg', buffer: photo })
await laptop.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
await laptop.page.getByRole('button', { name: 'Annehmen' }).click()
await laptop.page.getByText(/Von „Handy“ gespeichert/).waitFor({ timeout: 40_000 }).catch(async () => {
  console.log('LAPTOP:', (await laptop.page.locator('main').innerText()).slice(-1500))
  console.log('PHONE:', (await phone.page.locator('main').innerText()).slice(-1200))
  console.log('ERR', laptop.errors, phone.errors)
})
const intoFolder = await savedBytes(laptop.page, 'Foto.jpg')
check('Handy → Laptop: Foto liegt im gewählten Ordner', intoFolder && sha(decode(intoFolder)) === sha(photo))

// Folders, both ways, with their folders; then three transfers at once through the queue of two.
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ordner-'))
const anime = path.join(tree, 'Anime')
fs.mkdirSync(path.join(anime, 'Staffel 1'), { recursive: true })
fs.mkdirSync(path.join(anime, 'Staffel 2'))
fs.writeFileSync(path.join(anime, 'Staffel 1', 'Folge 1.txt'), 'eins')
fs.writeFileSync(path.join(anime, 'Staffel 1', 'Folge 2.txt'), 'zwei')
fs.writeFileSync(path.join(anime, 'Staffel 2', 'Folge 1.txt'), 'drei')
const savedNames = (page) => page.evaluate(() => Object.keys(window.__saved))
const waitSaved = (page, names) => page.waitForFunction((wanted) => wanted.every((n) => window.__saved[n]), names, { timeout: 30_000 }).catch(() => undefined)
await otherRow(laptop.page, 'Handy').locator('input[webkitdirectory]').setInputFiles(anime)
await phone.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
check('Ordner: das Handy sieht „Anime (3 Dateien)“', /Anime \(3 Dateien\)/.test(await phone.page.locator('main').innerText()))
await phone.page.getByRole('button', { name: 'Annehmen' }).click()
await waitSaved(phone.page, ['Anime/Staffel 1/Folge 1.txt', 'Anime/Staffel 1/Folge 2.txt', 'Anime/Staffel 2/Folge 1.txt'])
const onPhone = await savedNames(phone.page)
check('Ordner → Handy: jede Datei in ihrem Ordner', ['Anime/Staffel 1/Folge 1.txt', 'Anime/Staffel 1/Folge 2.txt', 'Anime/Staffel 2/Folge 1.txt'].every((n) => onPhone.includes(n)), onPhone.filter((n) => n.startsWith('Anime')).join(', '))
check('Ordner → Handy: zwei „Folge 1.txt“ überschreiben sich nicht', decode((await savedBytes(phone.page, 'Anime/Staffel 2/Folge 1.txt')) ?? '').toString() === 'drei')
await otherRow(phone.page, 'Laptop').locator('input[webkitdirectory]').setInputFiles(anime)
await laptop.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
await laptop.page.getByRole('button', { name: 'Annehmen' }).click()
await waitSaved(laptop.page, ['Anime/Staffel 1/Folge 1.txt', 'Anime/Staffel 1/Folge 2.txt', 'Anime/Staffel 2/Folge 1.txt'])
const onLaptop = await savedNames(laptop.page)
check('Ordner → Laptop: Unterordner im gewählten Ordner angelegt', ['Anime/Staffel 1/Folge 1.txt', 'Anime/Staffel 2/Folge 1.txt'].every((n) => onLaptop.includes(n)), onLaptop.filter((n) => n.startsWith('Anime')).join(', '))
for (const name of ['Eins.bin', 'Zwei.bin', 'Drei.bin']) {
  await otherRow(laptop.page, 'Handy').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024, name.length) })
}
for (let i = 0; i < 3; i += 1) {
  await phone.page.getByRole('button', { name: 'Annehmen' }).first().waitFor({ timeout: 30_000 })
  await phone.page.getByRole('button', { name: 'Annehmen' }).first().click()
}
for (const name of ['Eins.bin', 'Zwei.bin', 'Drei.bin']) {
  await phone.page.waitForFunction((n) => Boolean(window.__saved[n]), name, { timeout: 60_000 })
}
check('Drei Übertragungen auf einmal: alle kommen an, die Warteschlange läuft leer', true)
fs.rmSync(tree, { recursive: true, force: true })

// A break in the middle: the line is cut after ~5 MB, the laptop keeps what came, and „Fortsetzen“ sends the rest.
{
  const big = Buffer.alloc(14 * 1024 * 1024 + 321)
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 13 + (i >> 11)) & 255
  await phone.page.evaluate(() => {
    window.__cutAfter = window.__sentBytes + 5 * 1024 * 1024
  })
  await otherRow(phone.page, 'Laptop').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Gross.bin', mimeType: 'application/octet-stream', buffer: big })
  await laptop.page.getByRole('button', { name: 'Annehmen' }).waitFor({ timeout: 30_000 })
  await laptop.page.getByRole('button', { name: 'Annehmen' }).click()
  const resume = phone.page.getByRole('button', { name: 'Fortsetzen' })
  await resume.waitFor({ timeout: 60_000 })
  const brokenText = await phone.page.locator('main').innerText()
  check('Abbruch: das Handy bietet „Fortsetzen“ an', /Fortsetzen/.test(brokenText))
  await phone.page.screenshot({ path: `${OUT}handy-unterbrochen.png`, fullPage: true })
  const sentBefore = await phone.page.evaluate(() => window.__sentBytes)
  await resume.click()
  // The half file is in „saved“ from the break on; whole means its full length.
  await laptop.page.waitForFunction((length) => (window.__saved['Gross.bin']?.[0]?.length ?? 0) >= length, Math.ceil(big.length / 3) * 4, { timeout: 60_000 }).catch(() => undefined)
  await laptop.page.waitForTimeout(500)
  const sentAfter = await phone.page.evaluate(() => window.__sentBytes)
  const whole = await savedBytes(laptop.page, 'Gross.bin')
  check('Fortgesetzt: Datei kommt Byte für Byte an, ohne Doppeltes', whole && sha(decode(whole)) === sha(big), `${whole ? decode(whole).length : 0} von ${big.length}`)
  check('Fortgesetzt: nur der Rest wurde noch gesendet', sentAfter - sentBefore < big.length - 4 * 1024 * 1024, `${((sentAfter - sentBefore) / 1048576).toFixed(1)} MB`)
}

// Declined.
await otherRow(laptop.page, 'Handy').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Nein.txt', mimeType: 'text/plain', buffer: Buffer.from('nein') })
await phone.page.getByRole('button', { name: 'Ablehnen' }).waitFor({ timeout: 30_000 })
await phone.page.getByRole('button', { name: 'Ablehnen' }).click()
await laptop.page.getByText('„Handy“ hat abgelehnt.').waitFor({ timeout: 30_000 })
check('Abgelehnt kommt beim Laptop an', true)

// Text and links: a card on the other device, nothing opened by itself.
await laptop.page.goto(`${BASE}#geraete`)
await otherRow(laptop.page, 'Handy').waitFor({ timeout: 30_000 })
await laptop.page.getByRole('button', { name: 'Text senden' }).click()
await laptop.page.getByLabel(/Text oder Link an/).fill('https://example.org/folge?id=7')
await laptop.page.getByRole('button', { name: 'Senden', exact: true }).click()
await laptop.page.getByText(/Gesendet — erscheint dort/).waitFor({ timeout: 20_000 })
const noteCard = phone.page.getByRole('region', { name: 'Von einem anderen Gerät gesendet' })
await noteCard.waitFor({ timeout: 30_000 })
const noteText = await noteCard.innerText()
check('Link kommt als Karte an, mit Absender und Ziel', /Link von „Computer|Link von „Laptop/.test(noteText) && /example\.org/.test(noteText), noteText.replace(/\s+/g, ' ').slice(0, 100))
await phone.page.screenshot({ path: `${OUT}handy-link.png` })
const opened = phone.context.waitForEvent('page', { timeout: 10_000 }).catch(() => null)
await noteCard.getByRole('button', { name: 'Öffnen' }).click()
const popup = await opened
check('„Öffnen“ öffnet den Link, vorher nicht', Boolean(popup) && /example\.org/.test(popup.url()), popup ? popup.url() : 'kein Fenster')
await popup?.close()
check('Die Karte ist danach weg', (await noteCard.count()) === 0)
await laptop.page.getByLabel(/Text oder Link an/).fill('javascript:alert(1)')
await laptop.page.getByRole('button', { name: 'Senden', exact: true }).click()
await noteCard.waitFor({ timeout: 30_000 })
const evil = await noteCard.innerText()
check('Ein javascript:-Text ist Text, kein Link: nur Kopieren', /Text von/.test(evil) && (await noteCard.getByRole('button', { name: 'Öffnen' }).count()) === 0, evil.replace(/\s+/g, ' ').slice(0, 80))
await noteCard.getByRole('button', { name: 'Verwerfen' }).click()
check('Verwerfen entfernt die Karte', (await noteCard.count()) === 0)
// Play on another device: a film in Drive (only its name travels), then one from a folder here (sent, played on arrival).
const sondraRoot = [...files.values()].find((f) => f.name === 'Sondra' && f.mimeType === FOLDER)
create({ name: 'Folge 2.mp4', mimeType: 'video/mp4', parents: [sondraRoot.id] }, Buffer.alloc(2000))
await laptop.page.goto(`${BASE}#ordner`)
await laptop.page.waitForTimeout(1500)
// With Drive signed in the folder reads itself; otherwise the button asks for it.
const fromDrive = laptop.page.getByRole('button', { name: 'Aus Google Drive' })
if (await fromDrive.count()) await fromDrive.click()
else await laptop.page.getByRole('button', { name: 'Neu einlesen' }).click()
await laptop.page.screenshot({ path: `${OUT}laptop-ordner.png` })
await laptop.page.getByText('Folge 2.mp4').first().click({ modifiers: ['Control'] })
await laptop.page.getByRole('button', { name: 'Auf Gerät abspielen' }).click()
await laptop.page.getByRole('menuitem', { name: /Handy/ }).click()
await laptop.page.getByText(/An „Handy“ gefragt/).waitFor({ timeout: 20_000 })
const playCard = phone.page.getByRole('region', { name: 'Von einem anderen Gerät gesendet' })
await playCard.waitFor({ timeout: 30_000 })
const playText = await playCard.innerText()
check('Drive-Film: das Handy wird gefragt, nichts startet von selbst', /Folge 2\.mp4/.test(playText) && /abspielen\?/.test(playText) && !/#abspielen/.test(phone.page.url()), playText.replace(/\s+/g, ' ').slice(0, 90))
check('Drive-Film: keine Datei ging über Drive oder den Kanal', ![...files.values()].some((f) => f.appProperties?.sondraUebergabe))
await playCard.getByRole('button', { name: 'Abspielen' }).click()
await phone.page.getByText('Folge 2', { exact: true }).first().waitFor({ timeout: 15_000 })
await phone.page.screenshot({ path: `${OUT}handy-abspielen.png`, fullPage: true })
check('Drive-Film: nach „Abspielen“ steht er im Player', /#abspielen/.test(phone.page.url()))
await phone.page.screenshot({ path: `${OUT}handy-abspielen.png` })

const episode = Buffer.alloc(3 * 1024 * 1024 + 11)
for (let i = 0; i < episode.length; i += 1) episode[i] = (i * 7 + (i >> 8)) & 255
await laptop.page.goto(`${BASE}#ordner`)
await laptop.page.evaluate((bytes) => {
  const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))
  window.showDirectoryPicker = async () => ({
    name: 'Anime',
    kind: 'directory',
    async *values() {
      yield { kind: 'file', name: 'Folge 1.mp4', getFile: async () => new File([data], 'Folge 1.mp4', { type: 'video/mp4' }) }
    },
  })
}, episode.toString('base64'))
const backToDevice = laptop.page.getByRole('button', { name: 'Ordner auf diesem Gerät' })
// From the Drive view the link picks a folder here; fresh, the button does.
if (await backToDevice.count()) await backToDevice.click()
else await laptop.page.getByRole('button', { name: 'Ordner wählen' }).click()
await laptop.page.getByText('Folge 1.mp4').first().click({ modifiers: ['Control'] })
await laptop.page.getByRole('button', { name: 'Auf Gerät abspielen' }).click()
await laptop.page.getByRole('menuitem', { name: /Handy/ }).click()
await laptop.page.getByText(/An „Handy“ angeboten/).waitFor({ timeout: 20_000 })
await phone.page.goto(`${BASE}#geraete`)
const askLine = phone.page.getByText(/möchte „Folge 1\.mp4“ auf diesem Gerät abspielen/)
await askLine.first().waitFor({ timeout: 30_000 })
check('Lokaler Film: das Handy fragt „abspielen“, nicht „annehmen“', (await phone.page.getByRole('button', { name: 'Annehmen' }).count()) === 0)
await phone.page.locator('section[aria-labelledby=geraete-uebertragungen]').getByRole('button', { name: 'Abspielen' }).click()
await phone.page.getByText(/läuft im Player/).first().waitFor({ timeout: 60_000 })
check('Lokaler Film: nach der Ankunft im Player', /#abspielen/.test(phone.page.url()))
check('Lokaler Film: nichts ist im Download-Ordner gelandet', !('Folge 1.mp4' in (await phone.page.evaluate(() => window.__saved))))
check('Post ist leer, nichts liegen geblieben', ![...files.values()].some((file) => file.appProperties?.sondraAn), [...files.values()].filter((f) => f.appProperties?.sondraAn).map((f) => f.name).join(', '))

// The card elsewhere: the laptop on the start page gets an offer.
await laptop.page.goto(`${BASE}`)
await laptop.page.waitForTimeout(1500)
await phone.page.goto(`${BASE}#geraete`)
await otherRow(phone.page, 'Laptop').locator('input[type=file]:not([webkitdirectory])').setInputFiles({ name: 'Unterwegs.txt', mimeType: 'text/plain', buffer: Buffer.from('hallo') })
await laptop.page.getByRole('region', { name: 'Übertragungen zwischen Geräten' }).waitFor({ timeout: 30_000 })
await laptop.page.screenshot({ path: `${OUT}laptop-karte.png` })
check('Annahme-Karte erscheint auch auf der Startseite', true)

// Reinstall: the phone loses its data, joins again ten minutes later, and takes over its old entry.
await phone.page.evaluate(async () => {
  await new Promise((done) => {
    const request = indexedDB.deleteDatabase('sondra-geraet')
    request.onsuccess = request.onerror = request.onblocked = () => done()
  })
  localStorage.removeItem('sondra:geraete:an')
})
await phone.page.clock.setFixedTime(new Date(Date.now() + 10 * 60_000))
// A real reload (the same address with a hash would not be one); the phone's start script switches „Geräte“ on again.
await phone.page.reload()
await phone.page.getByRole('button', { name: 'Das war dieses Gerät' }).waitFor({ timeout: 40_000 })
await phone.page.screenshot({ path: `${OUT}handy-neu-installiert.png`, fullPage: true })
const beforeAdopt = registry().length
check('Neu installiert: altes und neues Handy stehen beide im Register', beforeAdopt === 3, String(beforeAdopt))
await phone.page.getByRole('button', { name: 'Das war dieses Gerät' }).click()
let adopted = false
for (let i = 0; i < 20 && !adopted; i += 1) {
  await phone.page.waitForTimeout(500)
  const names = registry().map((file) => JSON.parse(file.bytes.toString()).name)
  adopted = registry().length === 2 && names.includes('Handy') && !names.includes('Handy 2')
}
check('Übernommen: der alte Eintrag ist weg, das neue Handy heisst wieder „Handy“', adopted, registry().map((f) => JSON.parse(f.bytes.toString()).name).join(', '))
const phoneView = await phone.page.locator('section[aria-labelledby=geraete-dieses]').innerText()
check('Das Handy zeigt seinen alten Namen', /Handy/.test(phoneView) && !/Handy 2/.test(phoneView))

for (const each of [laptop, phone]) {
  const errors = each.errors.filter((error) => !/c is not iterable|reading 'update'/.test(error))
  check(`${each.name}: keine Fehler auf der Seite`, errors.length === 0, errors.slice(0, 3).join(' | '))
}
await browser.close()
finish()
