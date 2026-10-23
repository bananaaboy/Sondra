/**
 * Captures high-res screenshots for all 17 tabs in exact navbar order,
 * with every tab presented "in action" (rich realistic demo data, active editors).
 *
 * Usage: node scripts/capture-all-tabs.mjs
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { startServer } from '../desktop/server.mjs'

const PORT = 4192
const OUT_DIR = path.resolve('screenshots')
const ARTIFACT_DIR = path.resolve('C:\\Users\\lizge.navajeetharan\\.gemini\\antigravity\\brain\\85960906-a393-49a5-8eae-94451fd61f44')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(ARTIFACT_DIR, { recursive: true })

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-tabs-'))

/* -- Generate sample media -------------------------------------------------- */

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

const beatFile = makeWav('Beat_Demo_128BPM.wav', 8, 261.63)
const vocalFile = makeWav('Podcast_Spur_Stimme.wav', 6, 329.63)

// Video & Photo via FFmpeg
const videoFile = path.join(TMP, 'Anime_Folge_Clip_1080p.mp4')
const photoFile = path.join(TMP, 'Cover_Grafik_Studio.png')

try {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      videoFile,
    ],
    { stdio: 'ignore' },
  )
} catch {
  // ffmpeg fallback if not available
}

try {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=1',
      '-frames:v', '1',
      photoFile,
    ],
    { stdio: 'ignore' },
  )
} catch {
  // photo fallback
}

/* -- Find Chrome or Edge ---------------------------------------------------- */

const chromePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))

if (!chromePath) {
  console.error('Kein Browser (Chrome oder Edge) gefunden.')
  process.exit(1)
}

/* -- Start Server ----------------------------------------------------------- */

const server = await startServer({ root: path.resolve('dist'), port: PORT })
console.log(`Server laeuft auf ${server.url}`)

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

const sampleMerkliste = [
  {
    id: 'iruma-kun',
    title: 'Welcome to Demon School! Iruma-kun',
    url: 'https://aniworld.to/anime/stream/welcome-to-demon-school-iruma-kun',
    status: 'watching',
    season: 1,
    episode: 3,
    tags: ['Anime', 'Favorit'],
    history: [
      { id: 'h1', season: 1, episode: 1, at: Date.now() - 86400000 * 2 },
      { id: 'h2', season: 1, episode: 2, at: Date.now() - 86400000 },
    ],
    notes: 'Staffel 1 Folge 3 steht als naechstes an. Witzig und unterhaltsam.',
  },
  {
    id: 'aot',
    title: 'Attack on Titan',
    url: 'https://aniworld.to/anime/stream/attack-on-titan',
    status: 'watching',
    season: 4,
    episode: 12,
    tags: ['Anime', 'Shonen'],
    onlineAvailable: {
      maxSeason: 4,
      maxEpisode: 28,
      checkedAt: Date.now() - 3600000,
      hasNew: true,
    },
    notes: 'The Final Season. Meisterwerk.',
  },
  {
    id: 'frieren',
    title: 'Sousou no Frieren',
    url: 'https://aniworld.to/anime/stream/frieren-beyond-journeys-end',
    status: 'done',
    season: 1,
    episode: 28,
    rating: 5,
    tags: ['Anime', 'Fantasy'],
    notes: 'Wunderschoene Musik und tiefgruendige Story.',
  },
  {
    id: 'arcane',
    title: 'Arcane',
    url: 'https://aniworld.to/anime/stream/arcane',
    status: 'later',
    season: 2,
    episode: 1,
    tags: ['Netflix', 'SciFi'],
    notes: 'Staffel 2 fuer das Wochenende eingeplant.',
  },
]

await context.addInitScript((items) => {
  try {
    localStorage.setItem('sondra:theme', 'dark')
    localStorage.setItem('lizge:theme', 'dark')
    localStorage.setItem('sondra:saved_links', JSON.stringify(items))
    localStorage.setItem('sondra:discord_rpc_enabled', 'true')
  } catch {}
  document.documentElement.setAttribute('data-theme', 'dark')
}, sampleMerkliste)

const page = await context.newPage()
await page.goto(server.url)
await page.waitForLoadState('networkidle')
await page.evaluate((items) => {
  try {
    localStorage.setItem('sondra:theme', 'dark')
    localStorage.setItem('lizge:theme', 'dark')
    localStorage.setItem('sondra:saved_links', JSON.stringify(items))
    localStorage.setItem('sondra:discord_rpc_enabled', 'true')
  } catch {}
  document.documentElement.setAttribute('data-theme', 'dark')
}, sampleMerkliste)
await page.waitForTimeout(1000)

async function saveScreen(filename) {
  const dest1 = path.join(OUT_DIR, filename)
  const dest2 = path.join(ARTIFACT_DIR, filename)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.screenshot({ path: dest1, fullPage: false })
      fs.copyFileSync(dest1, dest2)
      console.log(`[OK] Screenshot: ${filename}`)
      return
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 800))
    }
  }
}

async function clickTab(id, slug) {
  const button = page.locator(`button[data-panel="${id}"]`).first()
  if (await button.isVisible()) {
    await button.click()
  } else {
    await page.evaluate((s) => {
      window.location.hash = s
    }, slug)
  }
  await page.waitForTimeout(900)
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

// Ingest files early so all media editors have loaded files
console.log('Ingesting demo files for rich DAW & video tools...')
const fileInput = page.locator('input[type="file"]').first()
const filesToIngest = [beatFile, vocalFile]
if (fs.existsSync(videoFile)) filesToIngest.push(videoFile)
if (fs.existsSync(photoFile)) filesToIngest.push(photoFile)
await fileInput.setInputFiles(filesToIngest)
await page.waitForTimeout(2500)

// -----------------------------------------------------------------------------
// 01. Start (Kachel-Übersicht)
// -----------------------------------------------------------------------------
console.log('01. Start...')
await clickTab('start', 'start')
await page.waitForTimeout(800)
await saveScreen('01-start.png')

// -----------------------------------------------------------------------------
// 02. Ordner (Folder Library & Media Browser)
// -----------------------------------------------------------------------------
console.log('02. Ordner...')
await clickTab('folder', 'ordner')
await page.waitForTimeout(500)
await page.evaluate(() => {
  if (window.__useFolder) {
    window.__useFolder.setState({
      scan: {
        name: 'Anime & Mediensammlung',
        files: [
          { name: 'Welcome to Demon School! Iruma-kun S01E03.mp4', path: 'Welcome to Demon School! Iruma-kun S01E03.mp4', size: 480 * 1024 * 1024, modified: Date.now() - 3600000, kind: 'video' },
          { name: 'Attack on Titan S04E12.mkv', path: 'Attack on Titan S04E12.mkv', size: 1400 * 1024 * 1024, modified: Date.now() - 7200000, kind: 'video' },
          { name: 'Sousou no Frieren S01E28.mp4', path: 'Sousou no Frieren S01E28.mp4', size: 920 * 1024 * 1024, modified: Date.now() - 86400000, kind: 'video' },
          { name: 'Studio_Podcast_Master.wav', path: 'Studio_Podcast_Master.wav', size: 68 * 1024 * 1024, modified: Date.now() - 1200000, kind: 'audio' },
          { name: 'Anime_Soundtrack_Remix_128BPM.flac', path: 'Anime_Soundtrack_Remix_128BPM.flac', size: 34 * 1024 * 1024, modified: Date.now() - 5000000, kind: 'audio' },
          { name: 'Cover_Iruma_Kun_HD.png', path: 'Cover_Iruma_Kun_HD.png', size: 3800 * 1024, modified: Date.now() - 20000000, kind: 'image' },
        ],
        truncated: false,
      },
      dir: '',
      selected: new Set(['Welcome to Demon School! Iruma-kun S01E03.mp4']),
      source: 'device',
    })
  }
})
await page.waitForTimeout(800)
await saveScreen('02-ordner.png')

// -----------------------------------------------------------------------------
// 03. Herunterladen (Downloader & Serien-Steuerung)
// -----------------------------------------------------------------------------
console.log('03. Herunterladen...')
await clickTab('downloader', 'herunterladen')
await page.waitForTimeout(600)
const dlInput = page.locator('input[type="text"], input[type="url"]').first()
if (await dlInput.isVisible()) {
  await dlInput.fill('https://aniworld.to/anime/stream/welcome-to-demon-school-iruma-kun/staffel-1/episode-3')
}
await page.waitForTimeout(600)
await saveScreen('03-herunterladen.png')

// -----------------------------------------------------------------------------
// 04. Merkliste (Serien, Tags, AniWorld-Hinweis, Fortschritt)
// -----------------------------------------------------------------------------
console.log('04. Merkliste...')
await clickTab('merkliste', 'merkliste')
await page.waitForTimeout(1000)
await saveScreen('04-merkliste.png')

// -----------------------------------------------------------------------------
// 05. Umwandeln (Converter)
// -----------------------------------------------------------------------------
console.log('05. Umwandeln...')
await selectAssetByKeyword('Anime')
await clickTab('converter', 'umwandeln')
await page.waitForTimeout(1200)
await saveScreen('05-umwandeln.png')

// -----------------------------------------------------------------------------
// 06. Ton (Audio Editor)
// -----------------------------------------------------------------------------
console.log('06. Ton...')
await selectAssetByKeyword('Beat')
await clickTab('audio', 'ton')
await page.waitForTimeout(2000)
await saveScreen('06-ton.png')

// -----------------------------------------------------------------------------
// 07. Video (Video Editor)
// -----------------------------------------------------------------------------
console.log('07. Video...')
await selectAssetByKeyword('Anime')
await clickTab('video', 'video')
await page.waitForTimeout(2000)
await saveScreen('07-video.png')

// -----------------------------------------------------------------------------
// 08. Abspielen (Player)
// -----------------------------------------------------------------------------
console.log('08. Abspielen...')
await selectAssetByKeyword('Anime')
await clickTab('player', 'abspielen')
await page.waitForTimeout(800)
const playerPill = page.locator('main button').filter({ hasText: /Anime|Video/ }).first()
if (await playerPill.isVisible()) {
  await playerPill.click().catch(() => {})
  await page.waitForTimeout(2000)
}
await saveScreen('08-abspielen.png')

// Pause player so it doesn't float over remaining tabs
await page.evaluate(() => {
  document.querySelectorAll('video, audio').forEach((el) => {
    try {
      el.pause()
    } catch {}
  })
})
await page.waitForTimeout(400)

// -----------------------------------------------------------------------------
// 09. Bilder (Image Studio)
// -----------------------------------------------------------------------------
console.log('09. Bilder...')
await selectAssetByKeyword('Cover')
await clickTab('images', 'bilder')
await page.waitForTimeout(1500)
await saveScreen('09-bilder.png')

// -----------------------------------------------------------------------------
// 10. Mischen (Multitrack Mixer)
// -----------------------------------------------------------------------------
console.log('10. Mischen...')
await selectAssetByKeyword('Beat')
await clickTab('mix', 'mischen')
await page.waitForTimeout(1500)
await saveScreen('10-mischen.png')

// -----------------------------------------------------------------------------
// 11. Spuren trennen (AI Stem Separation)
// -----------------------------------------------------------------------------
console.log('11. Spuren trennen...')
await selectAssetByKeyword('Beat')
await clickTab('stems', 'spuren-trennen')
await page.waitForTimeout(1000)
const separateBtn = page.getByRole('button', { name: /^Spuren trennen/ }).first()
if (await separateBtn.isVisible()) {
  await separateBtn.click().catch(() => {})
  await page.locator('text=Spuren').nth(1).waitFor({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await saveScreen('11-spuren-trennen.png')

// -----------------------------------------------------------------------------
// 12. Lautstärke (EBU R128 / BS.1770 Normalization)
// -----------------------------------------------------------------------------
console.log('12. Lautstärke...')
await selectAssetByKeyword('Beat')
await clickTab('normalize', 'lautstaerke')
await page.waitForTimeout(1000)
const normBtn = page.getByRole('button', { name: /Messen und normalisieren/ }).first()
if (await normBtn.isVisible()) {
  await normBtn.click().catch(() => {})
  await page.locator('text=Nachher').waitFor({ timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
}
await saveScreen('12-lautstaerke.png')

// -----------------------------------------------------------------------------
// 13. Zerschneiden (Beat Slicer & MPC Pads)
// -----------------------------------------------------------------------------
console.log('13. Zerschneiden...')
await selectAssetByKeyword('Beat')
await clickTab('sampler', 'zerschneiden')
await page.waitForTimeout(2000)
const cutBtn = page.getByRole('button', { name: /Schneiden/ }).first()
if (await cutBtn.isVisible()) {
  await cutBtn.click().catch(() => {})
  await page.waitForTimeout(1200)
}
const beatBtn = page.getByRole('button', { name: /Grundbeat vorschlagen/ }).first()
if (await beatBtn.isVisible()) {
  await beatBtn.click().catch(() => {})
  await page.waitForTimeout(600)
}
await saveScreen('13-zerschneiden.png')

// -----------------------------------------------------------------------------
// 14. Tonart (Harmony, Chords & MIDI)
// -----------------------------------------------------------------------------
console.log('14. Tonart...')
await selectAssetByKeyword('Beat')
await clickTab('harmony', 'tonart')
await page.waitForTimeout(1000)
const analyzeBtn = page.getByRole('button', { name: /Analysieren/ }).first()
if (await analyzeBtn.isVisible()) {
  await analyzeBtn.click().catch(() => {})
  await page.locator('button:has-text("Analysiert")').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
  const detailRadio = page.getByRole('radio', { name: 'Detail' }).first()
  if (await detailRadio.isVisible()) {
    await detailRadio.click().catch(() => {})
  }
  await page.waitForTimeout(1000)
}
await saveScreen('14-tonart.png')

// -----------------------------------------------------------------------------
// 15. Untertitel (Whisper AI Transcription)
// -----------------------------------------------------------------------------
console.log('15. Untertitel...')
await selectAssetByKeyword('Anime')
await clickTab('subtitles', 'untertitel')
await page.waitForTimeout(800)
await page.evaluate(() => {
  const segments = [
    { start: 0.0, end: 2.1, text: 'Willkommen bei Sondra – Version 1.1.15.' },
    { start: 2.1, end: 4.0, text: 'Lokale Medienverarbeitung, Untertitel und Downloads ohne Cloud.' },
  ]
  if (window.__setProjectToolState) {
    window.__setProjectToolState('subtitles', {
      segments,
      language: 'de',
      model: 'openai/whisper-tiny',
    })
  }
  window.dispatchEvent(new CustomEvent('sondra:project-loaded'))
})
await page.waitForTimeout(1200)
await saveScreen('15-untertitel.png')

// -----------------------------------------------------------------------------
// 16. Bildschirm (Screen Recorder)
// -----------------------------------------------------------------------------
console.log('16. Bildschirm...')
await clickTab('screen', 'bildschirm')
await page.waitForTimeout(800)
await page.evaluate(() => {
  const s = window.__useSession?.getState?.()
  if (!s) return
  const videoAsset = s.assets.find((a) => a.kind === 'video' || a.name.includes('Anime') || a.name.includes('Clip'))
  if (videoAsset && window.__setProjectToolState) {
    videoAsset.name = 'Bildschirmaufnahme 2026-10-23.mp4'
    window.__setProjectToolState('screen', {
      resultAssetId: videoAsset.id,
      fixed: true,
    })
    window.dispatchEvent(new CustomEvent('sondra:project-loaded'))
  }
})
await page.waitForTimeout(1200)
await saveScreen('16-bildschirm.png')

// -----------------------------------------------------------------------------
// 17. Mikrofon (Mic Calibration & Audio Suite)
// -----------------------------------------------------------------------------
console.log('17. Mikrofon...')
await clickTab('mic', 'mikrofon')
await page.waitForTimeout(800)
await page.evaluate(() => {
  const sampleRate = 44100
  const len = sampleRate * 4
  const rawData = new Float32Array(len)
  const procData = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate
    const envelope = Math.exp(-((t % 0.6) * 4))
    const s = (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t)) * envelope * 0.35
    rawData[i] = s + (Math.random() - 0.5) * 0.05
    procData[i] = s * 0.95
  }
  const rawAudio = { channels: [rawData], sampleRate }
  const procAudio = { channels: [procData], sampleRate }

  const micResult = {
    purpose: 'podcast',
    before: {
      noiseFloorDb: -48.3,
      speechDb: -22.1,
      peakDb: -6.2,
      clipped: 0,
      snrDb: 14.2,
      humHz: null,
    },
    after: {
      noiseFloorDb: -62.1,
      speechDb: -18.0,
      peakDb: -1.0,
      clipped: 0,
      snrDb: 28.5,
      humHz: null,
      lufs: -16.0,
    },
    raw: rawAudio,
    processed: procAudio,
    steps: [
      { title: 'Rumpelfilter (80 Hz)', detail: 'Hochpass 80 Hz entfernt tiefes Rumpeln und Trittschall.' },
      { title: 'Spektrale Rauschunterdrückung', detail: 'Grundrauschen des Raums um 18 dB abgesenkt.' },
      { title: 'Expander / Noise Gate', detail: 'Sprachpausen um 12 dB gedämpft für absolute Stille im Hintergrund.' },
      { title: 'Podcast-Kompressor', detail: 'Verdichtung 3:1 gleicht Lautstärkesprünge sanft aus.' },
      { title: 'Lautheit normalisiert', detail: 'Auf Broadcast-Standard (−16,0 LUFS) gepegelt.' },
    ],
    advice: [
      { tone: 'mint', title: 'Optimaler Pegel', text: 'Der Eingangspegel liegt im perfekten Bereich für Sprachaufnahmen.' },
    ],
    apply: (src) => src,
  }

  if (window.__setProjectToolState) {
    window.__setProjectToolState('mic', {
      result: micResult,
      purpose: 'podcast',
      probe: rawAudio,
    })
    window.dispatchEvent(new CustomEvent('sondra:project-loaded'))
  }
  window.scrollTo({ top: 350, behavior: 'instant' })
})
await page.waitForTimeout(1200)
await saveScreen('17-mikrofon.png')

console.log('Alle 17 Screenshots erfolgreich erstellt!')

await browser.close()
process.exit(0)
