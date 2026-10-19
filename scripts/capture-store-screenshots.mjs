/**
 * Captures 1920x1080 Microsoft Store screenshots for every tab in exact navbar order.
 *
 *   node scripts/capture-store-screenshots.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright-core'
import { startServer } from '../desktop/server.mjs'

const PORT = 4188
const OUT_DIR = path.resolve('screenshots')
const ARTIFACT_DIR = path.resolve('C:\\Users\\lizge.navajeetharan\\.gemini\\antigravity\\brain\\0e239057-5090-41eb-9bf0-62914d6f86a7\\screenshots')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-screens-'))

/* -- generate sample media ------------------------------------------------- */

function makeWav(filename, seconds = 6, baseFreq = 220) {
  const rate = 44100
  const frames = rate * seconds
  const notes = [baseFreq, baseFreq * 1.25, baseFreq * 1.5, baseFreq * 1.875]
  const data = Buffer.alloc(44 + frames * 4)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + frames * 4, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(2, 22)
  data.writeUInt32LE(rate, 24)
  data.writeUInt32LE(rate * 4, 28)
  data.writeUInt16LE(4, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(frames * 4, 40)
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate
    const beat = t % 0.5
    let sample = Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-beat * 30)) * t) * Math.exp(-beat * 12) * 0.7
    sample += Math.sin(2 * Math.PI * notes[Math.floor(t / 0.5) % 4] * t) * 0.25
    data.writeInt16LE(Math.round(sample * 32767), 44 + i * 4)
    data.writeInt16LE(Math.round(sample * 0.9 * 32767), 46 + i * 4)
  }
  const file = path.join(TMP, filename)
  fs.writeFileSync(file, data)
  return file
}

const beatFile = makeWav('Beat_Demo_120BPM.wav', 8, 261.63)
const vocalFile = makeWav('Vocal_Podcast_Spur.wav', 6, 329.63)

// Video & Photo via FFmpeg
const videoFile = path.join(TMP, 'Video_Projekt_1080p.mp4')
const photoFile = path.join(TMP, 'Foto_Aufnahme_Studio.png')

try {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=4:size=1920x1080:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      videoFile,
    ],
    { stdio: 'ignore' },
  )
} catch {
  // ffmpeg fallback
}

try {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=1920x1080:rate=1',
      '-frames:v',
      '1',
      photoFile,
    ],
    { stdio: 'ignore' },
  )
} catch {
  // png fallback
}

/* -- find browser ---------------------------------------------------------- */

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

if (!chromePath) {
  console.error('Kein Browser (Chrome oder Edge) gefunden.')
  process.exit(1)
}

/* -- start server ---------------------------------------------------------- */

const server = await startServer({ root: path.resolve('dist'), port: PORT })
console.log(`Server läuft auf ${server.url}`)

const browser = await chromium.launch({
  executablePath: chromePath,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
})

const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'de-DE',
  colorScheme: 'dark',
})

await context.addInitScript(() => {
  try {
    localStorage.setItem('sondra:theme', 'dark')
    localStorage.setItem('lizge:theme', 'dark')
  } catch {}
  document.documentElement.setAttribute('data-theme', 'dark')
})

const page = await context.newPage()
await page.goto(server.url)
await page.waitForLoadState('networkidle')
await page.evaluate(() => {
  try {
    localStorage.setItem('sondra:theme', 'dark')
    localStorage.setItem('lizge:theme', 'dark')
  } catch {}
  document.documentElement.setAttribute('data-theme', 'dark')
})
await page.waitForTimeout(1000)

/* -- Exact Navbar Tabs Order ----------------------------------------------- */

const TABS = [
  { num: '01', id: 'start', label: 'Start', slug: 'start' },
  { num: '02', id: 'downloader', label: 'Herunterladen', slug: 'herunterladen' },
  { num: '03', id: 'converter', label: 'Umwandeln', slug: 'umwandeln' },
  { num: '04', id: 'audio', label: 'Ton', slug: 'ton' },
  { num: '05', id: 'video', label: 'Video', slug: 'video' },
  { num: '06', id: 'player', label: 'Abspielen', slug: 'abspielen' },
  { num: '07', id: 'images', label: 'Bilder', slug: 'bilder' },
  { num: '08', id: 'mix', label: 'Mischen', slug: 'mischen' },
  { num: '09', id: 'stems', label: 'Spuren trennen', slug: 'spuren-trennen' },
  { num: '10', id: 'normalize', label: 'Lautstärke', slug: 'lautstaerke' },
  { num: '11', id: 'sampler', label: 'Zerschneiden', slug: 'zerschneiden' },
  { num: '12', id: 'harmony', label: 'Tonart', slug: 'tonart' },
  { num: '13', id: 'subtitles', label: 'Untertitel', slug: 'untertitel' },
  { num: '14', id: 'screen', label: 'Bildschirm', slug: 'bildschirm' },
  { num: '15', id: 'mic', label: 'Mikrofon', slug: 'mikrofon' },
]

async function saveScreen(filename) {
  const dest1 = path.join(OUT_DIR, filename)
  const dest2 = path.join(ARTIFACT_DIR, filename)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.screenshot({ path: dest1, fullPage: false })
      fs.copyFileSync(dest1, dest2)
      console.log(`✓ Screenshot gespeichert: ${filename}`)
      return
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 800))
    }
  }
}

async function clickTab(id) {
  const button = page.locator(`button[data-panel="${id}"]`).first()
  if (await button.isVisible()) {
    await button.click()
  } else {
    const tabEntry = TABS.find((t) => t.id === id)
    await page.evaluate((slug) => {
      window.location.hash = slug
    }, tabEntry.slug)
  }
  await page.waitForTimeout(1000)
}

async function selectAssetByKeyword(keyword) {
  await page.evaluate((kw) => {
    const s = window.__useSession?.getState?.()
    if (!s) return
    const asset = s.assets.find((a) => a.name.toLowerCase().includes(kw.toLowerCase()))
    if (asset) {
      s.setActiveAsset(asset.id)
    }
  }, keyword)
  await page.waitForTimeout(600)
}

// 1. Tab: Start (clean overview)
console.log('1. Start...')
await clickTab('start')
await page.waitForTimeout(800)
await saveScreen('01-start.png')

// 2. Tab: Herunterladen (clean downloader)
console.log('2. Herunterladen...')
await clickTab('downloader')
await page.waitForTimeout(800)
// Fill a sample title or address so it looks real
const input = page.locator('input[type="text"], input[type="url"]').first()
if (await input.isVisible()) {
  await input.fill('https://youtu.be/Beispiel-Song')
}
await page.waitForTimeout(400)
await saveScreen('02-herunterladen.png')

// Now ingest demo files into the session for rich DAW tools
console.log('Ingesting demo files for rich editor screenshots...')
const fileInput = page.locator('input[type="file"]').first()
const filesToIngest = [beatFile, vocalFile]
if (fs.existsSync(videoFile)) filesToIngest.push(videoFile)
if (fs.existsSync(photoFile)) filesToIngest.push(photoFile)

await fileInput.setInputFiles(filesToIngest)
await page.waitForTimeout(2500)

// 3. Tab: Umwandeln
console.log('3. Umwandeln...')
await selectAssetByKeyword('Video')
await clickTab('converter')
await page.waitForTimeout(1200)
await saveScreen('03-umwandeln.png')

// 4. Tab: Ton
console.log('4. Ton...')
await selectAssetByKeyword('Beat')
await clickTab('audio')
await page.waitForTimeout(2000)
await saveScreen('04-ton.png')

// 5. Tab: Video
console.log('5. Video...')
await selectAssetByKeyword('Video')
await clickTab('video')
await page.waitForTimeout(2000)
await saveScreen('05-video.png')

// 6. Tab: Abspielen
console.log('6. Abspielen...')
await selectAssetByKeyword('Video')
await clickTab('player')
await page.waitForTimeout(800)
const playerPill = page.locator('main button').filter({ hasText: /Video_Projekt/ }).first()
if (await playerPill.isVisible()) {
  await playerPill.click().catch(() => {})
  await page.waitForTimeout(2000)
}
await saveScreen('06-abspielen.png')
// Remove item from player playlist so miniBar doesn't float over other tabs
const removePlayerBtn = page.locator('button[title="Aus der Liste nehmen"]').first()
if (await removePlayerBtn.isVisible()) {
  await removePlayerBtn.click().catch(() => {})
  await page.waitForTimeout(600)
}

// 7. Tab: Bilder
console.log('7. Bilder...')
await selectAssetByKeyword('Foto')
await clickTab('images')
await page.waitForTimeout(1500)
await saveScreen('07-bilder.png')

// 8. Tab: Mischen
console.log('8. Mischen...')
await selectAssetByKeyword('Beat')
await clickTab('mix')
await page.waitForTimeout(1500)
await saveScreen('08-mischen.png')

// 9. Tab: Spuren trennen
console.log('9. Spuren trennen...')
await selectAssetByKeyword('Beat')
await clickTab('stems')
await page.waitForTimeout(1000)
const separateBtn = page.getByRole('button', { name: /^Spuren trennen/ }).first()
if (await separateBtn.isVisible()) {
  await separateBtn.click().catch(() => {})
  await page.locator('text=Spuren').nth(1).waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await saveScreen('09-spuren-trennen.png')

// 10. Tab: Lautstärke
console.log('10. Lautstärke...')
await selectAssetByKeyword('Beat')
await clickTab('normalize')
await page.waitForTimeout(1000)
const normBtn = page.getByRole('button', { name: /Messen und normalisieren/ }).first()
if (await normBtn.isVisible()) {
  await normBtn.click().catch(() => {})
  await page.locator('text=Nachher').waitFor({ timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await saveScreen('10-lautstaerke.png')

// 11. Tab: Zerschneiden
console.log('11. Zerschneiden...')
await selectAssetByKeyword('Beat')
await clickTab('sampler')
await page.waitForTimeout(2000)
// Hit "Schneiden" so MPC pads and slices populate nicely
const cutBtn = page.getByRole('button', { name: /Schneiden/ }).first()
if (await cutBtn.isVisible()) {
  await cutBtn.click().catch(() => {})
  await page.waitForTimeout(1200)
}
await saveScreen('11-zerschneiden.png')

// 12. Tab: Tonart
console.log('12. Tonart...')
await selectAssetByKeyword('Beat')
await clickTab('harmony')
await page.waitForTimeout(1000)
const analyzeBtn = page.getByRole('button', { name: /Analysieren/ }).first()
if (await analyzeBtn.isVisible()) {
  await analyzeBtn.click().catch(() => {})
  await page.locator('button:has-text("Analysiert")').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => {})
  const detailRadio = page.getByRole('radio', { name: 'Detail' }).first()
  if (await detailRadio.isVisible()) {
    await detailRadio.click().catch(() => {})
  }
  await page.waitForTimeout(1000)
}
await saveScreen('12-tonart.png')

// 13. Tab: Untertitel
console.log('13. Untertitel...')
await selectAssetByKeyword('Video')
await clickTab('subtitles')
await page.waitForTimeout(1200)
await saveScreen('13-untertitel.png')

// 14. Tab: Bildschirm
console.log('14. Bildschirm...')
await clickTab('screen')
await page.waitForTimeout(1200)
await saveScreen('14-bildschirm.png')

// 15. Tab: Mikrofon
console.log('15. Mikrofon...')
await clickTab('mic')
await page.waitForTimeout(1200)
await saveScreen('15-mikrofon.png')

console.log('Alle 15 Screenshots erfolgreich erstellt!')

await browser.close()
process.exit(0)
