/**
 * Drives the installed desktop app the way a person would, and says which
 * tool did what.
 *
 *   node scripts/desktop-ui-test.mjs <path to Sondra.exe or sondra> [screenshot dir]
 *
 * The smoke test in the workflow only proves that the window opens. This one
 * opens a file and presses the buttons: cut in "Ton", chop and keep one pad,
 * find the key, measure loudness, convert with FFmpeg, separate stems, render a
 * video, fetch a file by address. Every step checks that something changed,
 * not merely that a click went through — "the buttons do nothing" was the
 * report that started this.
 *
 * The app is started with a DevTools port and reached over CDP, so the thing
 * under test is the real binary with its own server, not a browser tab.
 * Needs `playwright-core` (no browser download; it only speaks CDP). The
 * microphone step uses Chromium's fake capture device, so it runs on machines
 * without a microphone too.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { chromium } from 'playwright-core'

const [executable, shotDir = path.join(os.tmpdir(), 'sondra-ui')] = process.argv.slice(2)
if (!executable) {
  console.error('Aufruf: node scripts/desktop-ui-test.mjs <Pfad zur App> [Ordner für Bildschirmfotos]')
  process.exit(2)
}
fs.mkdirSync(shotDir, { recursive: true })
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ui-'))
const PORT = 9333

/* -- a test file: eight seconds of kick and melody --------------------------- */

function beatWav(file) {
  const rate = 44100
  const frames = rate * 8
  const notes = [261.63, 329.63, 392, 523.25]
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
    sample += Math.sin(2 * Math.PI * notes[Math.floor(t / 0.5) % 4] * t) * 0.2
    data.writeInt16LE(Math.round(sample * 32767), 44 + i * 4)
    data.writeInt16LE(Math.round(sample * 0.9 * 32767), 46 + i * 4)
  }
  fs.writeFileSync(file, data)
}

const wav = path.join(work, 'beat.wav')
beatWav(wav)

/* -- start the app with a DevTools port --------------------------------------- */

const app = spawn(executable, [`--remote-debugging-port=${PORT}`, '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  // SONDRA_ASK answers the app's own questions: yes, fetch yt-dlp.
  env: { ...process.env, SONDRA_SMOKE: '', SONDRA_ASK: 'yes' },
})
app.stdout.on('data', () => {})
app.stderr.on('data', () => {})

async function waitForDevtools() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Die App hat keinen DevTools-Port geöffnet.')
}

const results = []
let page
let browser

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started })
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error).split('\n')[0], ms: Date.now() - started })
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '-').replace(/^-|-$/g, '')
  await page?.screenshot({ path: path.join(shotDir, `${String(results.length).padStart(2, '0')}-${slug}.png` ) }).catch(() => {})
}

const main = () => page.locator('main')
const mainText = async () => (await main().innerText()).replace(/\s+/g, ' ')

/** Files in the session, read from the header's file menu button. */
async function sessionCount() {
  const button = page.locator('header button[title="Dateien dieser Sitzung"]')
  if (!(await button.count())) return 0
  const text = await button.innerText()
  const extra = text.match(/\+(\d+)/)
  return extra ? Number(extra[1]) + 1 : 1
}

async function waitForText(pattern, timeout = 60_000) {
  await page.waitForFunction(
    (source) => new RegExp(source).test((document.querySelector('main')?.innerText ?? '').replace(/\s+/g, ' ')),
    pattern.source,
    { timeout },
  )
}

async function go(slug) {
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, slug)
  await page.waitForTimeout(1200)
}

async function openFile(file) {
  await page.locator('input[type=file]').first().setInputFiles(file)
  await page.waitForTimeout(1500)
}

async function dragAcross(locator, from, to) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('Wellenform nicht sichtbar.')
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}

try {
  await waitForDevtools()
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  for (let i = 0; i < 60 && !page; i += 1) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('http://127.0.0.1'))
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!page) throw new Error('Kein Fenster mit der Oberfläche gefunden.')
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  await step('Start: Seite geladen und isoliert', async () => {
    const isolated = await page.evaluate(() => window.crossOriginIsolated)
    if (!isolated) throw new Error('Nicht isoliert: FFmpeg liefe nur einfädig.')
    return `Titel „${await page.title()}"`
  })

  await step('Datei öffnen', async () => {
    await openFile(wav)
    const count = await sessionCount()
    if (count !== 1) throw new Error(`Sitzung hat ${count} Dateien statt 1.`)
    return 'beat.wav in der Sitzung'
  })

  await step('Ton: Ausschnitt behalten, umkehren, rückgängig', async () => {
    await go('ton')
    await waitForText(/Stereo/)
    const before = (await mainText()).match(/(\d+:\d\d\.\d\d) · Stereo/)?.[1]
    await dragAcross(main().locator('canvas').first(), 0.2, 0.5)
    await page.getByRole('button', { name: 'Nur den Ausschnitt behalten', exact: true }).click()
    await page.waitForTimeout(800)
    const after = (await mainText()).match(/(\d+:\d\d\.\d\d) · Stereo/)?.[1]
    if (!after || after === before) throw new Error(`Länge unverändert (${before} → ${after}).`)
    await page.getByRole('button', { name: 'Umkehren', exact: true }).click()
    await page.waitForTimeout(600)
    if (!(await mainText()).includes('Umgekehrt')) throw new Error('Umkehren steht nicht im Verlauf.')
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
    await page.waitForTimeout(600)
    if ((await mainText()).includes('Umgekehrt')) throw new Error('Rückgängig hat nichts zurückgenommen.')
    return `${before} → ${after}, Umkehren und Rückgängig wirken`
  })

  await step('Ton: in die Sitzung übernehmen', async () => {
    const before = await sessionCount()
    await page.getByRole('button', { name: 'In die Sitzung übernehmen', exact: true }).click()
    await page.waitForTimeout(800)
    const after = await sessionCount()
    if (after !== before + 1) throw new Error(`${before} → ${after} Dateien, erwartet +1.`)
    return `${before} → ${after} Dateien`
  })

  await step('Ton: Hall und Rauschentfernung live, dann übernommen', async () => {
    await page.locator('main summary', { hasText: 'Klang: Filter' }).click()
    await page.getByRole('switch', { name: /^Hall/ }).click()
    await waitForText(/Live zu hören: .*Hall/, 10_000)
    await dragAcross(main().locator('canvas').first(), 0.0, 0.05)
    await page.getByRole('button', { name: 'Rauschprofil aus der Auswahl' }).click()
    await waitForText(/Rauschen bis \d+ dB leiser/, 10_000)
    await page.waitForFunction(() => !/wird gerechnet/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Übernehmen', exact: true }).click()
    await page.waitForFunction(() => /Hall [\d,]+ s/.test(document.querySelector('aside')?.innerText ?? ''), null, { timeout: 30_000 })
    return 'live gehört, Hall und Rauschen im Verlauf'
  })

  await step('Zerschneiden: ein Pad in die Sitzung', async () => {
    // Back to the original, eight seconds long.
    await page.locator('header button[title="Dateien dieser Sitzung"]').click()
    await page.getByRole('dialog').getByText('beat.wav', { exact: true }).click()
    await page.keyboard.press('Escape')
    await go('zerschneiden')
    await page.getByRole('button', { name: 'Schneiden', exact: true }).first().click()
    await waitForText(/Pads · \d+/)
    const pads = (await mainText()).match(/Pads · (\d+)/)?.[1]
    await main().locator('button.aspect-square').nth(1).dispatchEvent('pointerdown')
    await page.waitForTimeout(300)
    const before = await sessionCount()
    await page.getByRole('button', { name: 'Pad 2 in die Sitzung' }).click()
    await page.waitForTimeout(1500)
    const after = await sessionCount()
    if (after !== before + 1) throw new Error(`${pads} Pads: ${before} → ${after} Dateien, erwartet +1.`)
    return `${pads} Pads, genau ein Pad übernommen`
  })

  await step('Zerschneiden: Beat bauen und als WAV übernehmen', async () => {
    await page.getByRole('button', { name: 'Grundbeat vorschlagen' }).click()
    const steps = await page.locator('button[aria-pressed="true"][aria-label^="Pad"]').count()
    if (steps === 0) throw new Error('Keine Schritte gesetzt.')
    const before = await sessionCount()
    await page.getByRole('button', { name: 'In die Sitzung', exact: true }).click()
    await page.waitForFunction(
      (count) => {
        const text = document.querySelector('header button[title="Dateien dieser Sitzung"]')?.textContent ?? ''
        const extra = text.match(/\+(\d+)/)
        return (extra ? Number(extra[1]) + 1 : 1) > count
      },
      before,
      { timeout: 30_000 },
    )
    return `${steps} Schritte, Pattern gerendert`
  })

  await step('Zerschneiden: Klavierrolle für ein Pad', async () => {
    await page.getByRole('button', { name: 'Klavierrolle für Pad 1', exact: true }).click()
    const grid = page.getByRole('grid', { name: 'Klavierrolle' })
    await grid.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    const box = await grid.boundingBox()
    const key = await page.locator('button[title="Tonhöhe des Pads"]').boundingBox()
    const before = await page.locator('[aria-label*="Schritt"][aria-label$="lang"]').count()
    await page.mouse.click(box.x + (box.width / 16) * 2.5, key.y + key.height / 2 - key.height * 4)
    const notes = await page.locator('[aria-label*="Schritt"][aria-label$="lang"]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    if (notes.length !== before + 1 || !notes.some((label) => label.startsWith('E4, Schritt 3'))) throw new Error(`Töne: ${notes.join(' | ')}`)
    return `${notes.length} Töne, E4 auf Schritt 3 gesetzt`
  })

  await step('Tonart: analysieren', async () => {
    await go('tonart')
    await page.getByRole('button', { name: 'Analysieren' }).click()
    await waitForText(/BPM/, 60_000)
    const text = await mainText()
    return `${text.match(/\d+ BPM/)?.[0]} · ${text.match(/[A-H][#b]?-(Dur|Moll)/)?.[0] ?? '?'}`
  })

  await step('Lautstärke: messen', async () => {
    await go('lautstaerke')
    await page.getByRole('button', { name: 'Nur messen' }).click()
    await waitForText(/-?\d+\.\d LUFS/, 60_000)
    return (await mainText()).match(/Integriert (-?\d+\.\d LUFS)/)?.[1] ?? 'gemessen'
  })

  await step('Umwandeln: WAV → MP3 mit FFmpeg', async () => {
    await go('umwandeln')
    await page.getByRole('button', { name: 'Umwandeln', exact: true }).last().click()
    await waitForText(/Ergebnis Größe [\d.]+ [KM]B/, 180_000)
    return `MP3, ${(await mainText()).match(/Ergebnis Größe ([\d.]+ [KM]B)/)?.[1]}`
  })

  await step('Spuren trennen', async () => {
    await go('spuren-trennen')
    await page.getByRole('button', { name: 'Spuren trennen', exact: true }).last().click()
    await waitForText(/Schlagzeug.*Übernehmen/, 180_000)
    return 'Gesang, Schlagzeug, Bass, Übriges'
  })

  await step('Video: aufnehmen, als MP4 fertigstellen', async () => {
    // A two-second clip with picture and sound, recorded in the app itself.
    const base64 = await page.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 })
      const context = canvas.getContext('2d')
      const audio = new AudioContext()
      const tone = audio.createOscillator()
      const sink = audio.createMediaStreamDestination()
      tone.connect(sink)
      tone.start()
      const stream = new MediaStream([...canvas.captureStream(25).getTracks(), ...sink.stream.getTracks()])
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      const chunks = []
      recorder.ondataavailable = (event) => chunks.push(event.data)
      let frame = 0
      const timer = setInterval(() => {
        context.fillStyle = `hsl(${(frame += 12) % 360} 60% 40%)`
        context.fillRect(0, 0, 320, 180)
      }, 40)
      recorder.start()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      recorder.stop()
      await new Promise((resolve) => (recorder.onstop = resolve))
      clearInterval(timer)
      tone.stop()
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary)
    })
    const clip = path.join(work, 'clip.webm')
    fs.writeFileSync(clip, Buffer.from(base64, 'base64'))
    await go('video')
    await page.locator('input[type=file]').first().setInputFiles(clip)
    await page.waitForTimeout(3000)
    // A look and a fade on top, so the new filters go through FFmpeg too.
    await main().getByRole('tab', { name: 'Bild', exact: true }).first().click()
    await page.getByRole('button', { name: 'Sepia', exact: true }).first().click()
    await page.getByRole('button', { name: 'Fertigstellen' }).first().click()
    await page.getByRole('button', { name: 'Jetzt rechnen' }).click()
    await waitForText(/Ergebnis .*\.mp4/, 180_000)
    return (await mainText()).match(/Ergebnis (\S+\.mp4 [\d.]+ [KM]B)/)?.[1] ?? 'MP4 fertig'
  })

  await step('Mikrofon: einschalten und für Podcast einstellen', async () => {
    await go('mikrofon')
    await page.getByRole('button', { name: 'Mikrofon einschalten' }).click()
    await page.getByRole('button', { name: 'Mikrofon ausschalten' }).waitFor({ timeout: 20_000 })
    await page.getByRole('radio', { name: /Podcast/ }).click()
    await page.getByRole('button', { name: /einstellen$/ }).click()
    await page.waitForFunction(
      () => /Was gemacht wurde|Hat nicht geklappt/.test(document.querySelector('main')?.innerText ?? ''),
      null,
      { timeout: 60_000 },
    )
    const text = await mainText()
    if (text.includes('Hat nicht geklappt')) throw new Error(text.match(/Hat nicht geklappt (.{0,160})/)?.[1] ?? 'fehlgeschlagen')
    const snr = text.match(/Abstand Stimme zu Hintergrund je grösser, desto klarer ([^ ]+ → [^ ]+)/)?.[1]
    await page.getByRole('button', { name: 'Mikrofon ausschalten' }).click()
    return `Abstand ${snr ?? '?'} dB, ${text.match(/Was gemacht wurde/) ? 'Bericht da' : ''}`
  })

  await step('Herunterladen: direkte Adresse', async () => {
    await go('herunterladen')
    await page.getByLabel('Adresse zum Herunterladen').fill('https://www.sondra.lizge.ch/icon-512.png')
    await page.getByRole('button', { name: 'Nachsehen' }).click()
    const before = await sessionCount()
    await page.getByRole('button', { name: 'Laden' }).first().click({ timeout: 60_000 })
    await page.waitForFunction(
      (count) => {
        const text = document.querySelector('header button[title="Dateien dieser Sitzung"]')?.textContent ?? ''
        const extra = text.match(/\+(\d+)/)
        return (extra ? Number(extra[1]) + 1 : 1) > count
      },
      before,
      { timeout: 60_000 },
    )
    return 'icon-512.png geladen'
  })

  await step('Herunterladen: Dienst der App mit yt-dlp', async () => {
    await go('herunterladen')
    await page.getByLabel('Adresse zum Herunterladen').fill('https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4')
    await page.getByRole('button', { name: 'Nachsehen' }).click()
    const before = await sessionCount()
    await page.getByRole('button', { name: 'Laden' }).first().click({ timeout: 120_000 })
    await page.waitForFunction(
      (count) => {
        const text = document.querySelector('header button[title="Dateien dieser Sitzung"]')?.textContent ?? ''
        const extra = text.match(/\+(\d+)/)
        return (extra ? Number(extra[1]) + 1 : 1) > count
      },
      before,
      { timeout: 120_000 },
    )
    const logFile =
      process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? '', 'Sondra', 'sondra.log')
        : path.join(os.homedir(), '.config', 'Sondra', 'sondra.log')
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : []
    const ytdlp = lines.filter((line) => /yt-dlp \d{4}\./.test(line)).pop()
    if (!ytdlp) throw new Error('Im Protokoll steht kein gefundenes yt-dlp.')
    return `flower.mp4 in der Sitzung · ${ytdlp.replace(/^.*ms {2}/, '').slice(0, 60)}`
  })

  await step('Herunterladen: YouTube (nur Hinweis)', async () => {
    await go('herunterladen')
    await page.getByLabel('Adresse zum Herunterladen').fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await page.getByRole('button', { name: 'Nachsehen' }).click()
    await page.waitForFunction(
      () => /Laden|Hat nicht geklappt/.test(document.querySelector('main')?.innerText ?? ''),
      null,
      { timeout: 60_000 },
    )
    if ((await mainText()).includes('Hat nicht geklappt')) {
      return `YouTube lehnt diesen Rechner ab: ${(await mainText()).match(/Hat nicht geklappt (.{0,120})/)?.[1]}`
    }
    const before = await sessionCount()
    await page.getByRole('button', { name: 'Laden' }).first().click()
    await page.waitForFunction(
      (count) => {
        const text = document.querySelector('header button[title="Dateien dieser Sitzung"]')?.textContent ?? ''
        const extra = text.match(/\+(\d+)/)
        return (extra ? Number(extra[1]) + 1 : 1) > count || /Hat nicht geklappt/.test(document.querySelector('main')?.innerText ?? '')
      },
      before,
      { timeout: 150_000 },
    )
    if ((await mainText()).includes('Hat nicht geklappt')) {
      return `Laden abgelehnt: ${(await mainText()).match(/Hat nicht geklappt (.{0,120})/)?.[1]}`
    }
    return 'Video geladen'
  })
} catch (error) {
  results.push({ name: 'Ablauf', ok: false, detail: String(error?.message ?? error), ms: 0 })
} finally {
  await browser?.close().catch(() => {})
  app.kill()
}

/* -- report ------------------------------------------------------------------- */

const width = Math.max(...results.map((result) => result.name.length))
let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  const seconds = (result.ms / 1000).toFixed(1).padStart(5)
  console.log(`${result.ok ? 'OK  ' : 'FEHL'}  ${result.name.padEnd(width)}  ${seconds} s  ${result.detail}`)
}
const summary = process.env.GITHUB_STEP_SUMMARY
if (summary) {
  const rows = results.map((result) => `| ${result.ok ? '✅' : '❌'} | ${result.name} | ${result.detail.replace(/\|/g, '/')} |`)
  fs.appendFileSync(summary, ['### Sondra-App, durchgeklickt', '', '| | Schritt | Ergebnis |', '|---|---|---|', ...rows, ''].join('\n'))
}
console.log(failed ? `\n${failed} von ${results.length} Schritten fehlgeschlagen.` : `\nAlle ${results.length} Schritte bestanden.`)
process.exit(failed ? 1 : 0)
