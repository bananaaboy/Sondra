/**
 * Sondra as an installed Windows app: its own window, its own entry in the
 * start menu, no browser in between.
 *
 * The window is Electron's Chromium pointed at `server.mjs` on 127.0.0.1. A
 * local server rather than a `file://` page or a custom protocol, for two
 * reasons: the two API functions need a real HTTP endpoint, and the isolation
 * headers (and with them SharedArrayBuffer and multi-threaded FFmpeg) come for
 * free from the same code the website already runs.
 *
 * The port is fixed where possible because the port is part of the origin,
 * and the origin is what the page's storage — theme, connected service,
 * cached FFmpeg core — is filed under. A random port every start would begin
 * every session from nothing.
 *
 * `SONDRA_SMOKE=<file>` makes the app load once, write what it saw to that
 * file, and quit. The Windows CI job uses it to test the installed app.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeTheme, Notification, powerSaveBlocker, safeStorage, session, shell } from 'electron'

import { createAnytype } from './anytype.mjs'
import { createGoogleDrive } from './googleDrive.mjs'
import { discordRpc } from './discord.mjs'
import { startDownloader } from './downloader.mjs'
import { offerFile, startServer } from './server.mjs'
import { setupUpdates } from './updater.mjs'

/**
 * Installed from the Microsoft Store (an MSIX package). The Store signs,
 * hosts and updates it; the app's own updater and fetching yt-dlp would both
 * be things the Store does not allow, so both stay off in this build.
 */
const IN_STORE = process.windowsStore === true
/**
 * The portable build (electron-builder's „portable“ target): one .exe that
 * unpacks itself into a temporary folder on every start and runs from there.
 * Its launcher says where the .exe itself lies.
 */
const PORTABLE_EXE_DIR = IN_STORE ? null : (process.env.PORTABLE_EXECUTABLE_DIR ?? null)
/**
 * Its own port beside the installed app's: both may run at once, each with
 * its own data folder, and the second would otherwise take a random port —
 * a new origin, and with it an empty Merkliste, on every start.
 */
const PORT = PORTABLE_EXE_DIR ? 47198 : 47199

/**
 * The portable build keeps everything in „Sondra-Daten“ next to the .exe, so
 * it travels with the file — on a USB stick to another computer — and leaves
 * nothing in the profile. Where that folder cannot be written (a read-only
 * share, a protected folder), it uses a folder of its own in %APPDATA%, still
 * apart from the installed app. Set before the single-instance lock, which
 * Electron files under this folder too.
 */
function portableData() {
  if (!PORTABLE_EXE_DIR) return null
  const beside = path.join(PORTABLE_EXE_DIR, 'Sondra-Daten')
  try {
    fs.mkdirSync(beside, { recursive: true })
    const probe = path.join(beside, '.schreibprobe')
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return beside
  } catch {
    return path.join(app.getPath('appData'), 'Sondra Portabel')
  }
}
const PORTABLE_DATA = portableData()
if (PORTABLE_DATA) app.setPath('userData', PORTABLE_DATA)
const SMOKE = process.env.SONDRA_SMOKE
/** Tests answer the app's questions in advance: `yes` or `no`. */
const ANSWER = process.env.SONDRA_ASK

/**
 * One Sondra at a time: a second start brings the first window forward
 * instead of fighting it for the port.
 *
 * `exit`, not `quit`: `quit` only asks, and the rest of this file went on
 * running in the second copy — it started its own server on a fallback port
 * and began opening a window before the request to quit caught up with it.
 */
const primary = app.requestSingleInstanceLock()
if (!primary) app.exit(0)

// „Geräte“: Chromium hides this computer's local addresses behind a random
// „….local“ name that the other device has to resolve over multicast —
// which phones often cannot, so a transfer to this computer found its way
// only every few tries. Only Sondra's own page runs in this window.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

let window = null

/**
 * Sondra's own log, `sondra.log` in the app's data folder
 * (%APPDATA%\Sondra on Windows). A desktop app has no console anyone reads,
 * and a start that fails with one line in a dialog is otherwise a guess.
 */
function logFile() {
  return path.join(app.getPath('userData'), 'sondra.log')
}

function log(message) {
  try {
    fs.appendFileSync(logFile(), `${new Date().toISOString()}  +${Math.round(performance.now())} ms  ${message}\n`)
  } catch {
    // Logging must never be the reason the app fails.
  }
}

/** Keep the log to one session's worth once it grows past a megabyte. */
function trimLog() {
  try {
    if (fs.statSync(logFile()).size > 1_000_000) fs.writeFileSync(logFile(), '')
  } catch {
    // No log yet.
  }
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])

/**
 * What the window shows when the page will not load: the reason, where the
 * log is, and a way to try again — instead of a dialog and a vanished app.
 */
function failurePage(reason, retryUrl) {
  const dark = nativeTheme.shouldUseDarkColors
  const [ground, ink, prose] = dark ? ['#0a110d', '#c3f4d0', '#e4ede6'] : ['#f2eee4', '#0f3e1c', '#162019']
  const html = `<!doctype html><html lang="de"><meta charset="utf-8"><title>Sondra Studio</title>
<body style="margin:0;background:${ground};color:${prose};font:16px/1.55 system-ui,sans-serif">
<main style="max-width:560px;padding:64px 32px">
<h1 style="color:${ink};font-size:24px;margin:0 0 12px">Sondra konnte die Oberfläche nicht laden</h1>
<p style="margin:0 0 16px">${escapeHtml(reason)}</p>
<p style="margin:0 0 24px">Einzelheiten stehen im Protokoll:<br><code>${escapeHtml(logFile())}</code></p>
<p style="margin:0"><a href="${escapeHtml(retryUrl)}" style="color:${ink}">Erneut versuchen</a></p>
</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/**
 * Files Windows passed on the command line: „Öffnen mit Sondra“, a file
 * dropped on the icon or the shortcut. Anything that is not an existing file
 * (flags, the executable itself) is ignored.
 */
function filesIn(argv, cwd = process.cwd()) {
  const found = []
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const file = path.resolve(cwd, arg)
    if (file === process.execPath) continue
    try {
      if (fs.statSync(file).isFile()) found.push(file)
    } catch {
      // Not a path.
    }
  }
  return found
}

/** Opened before the page could take them; handed over when it asks. */
let waitingFiles = filesIn(process.argv)

function describeFiles(files) {
  return files.map((file) => {
    let size = null
    try {
      size = fs.statSync(file).size
    } catch {
      // Gone since; the fetch will say so.
    }
    return { name: path.basename(file), size, url: offerFile(file) }
  })
}

/** The screen or window the page picked for its next getDisplayMedia. */
let capturePick = null

ipcMain.handle('sondra:capture-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
  return sources
    // Sondra's own window would record itself recording.
    .filter((source) => !(window && source.id === window.getMediaSourceId()))
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    }))
})

ipcMain.handle('sondra:capture-pick', (_event, id, audio) => {
  capturePick = typeof id === 'string' ? { id, audio: Boolean(audio) } : null
  return true
})

/**
 * The Merkliste's link to Anytype (desktop/anytype.mjs), made on first use:
 * the page asks for one action at a time and never sees the key.
 */
let anytype = null
ipcMain.handle('sondra:anytype', (_event, action, ...args) => {
  anytype ??= createAnytype({
    dataDir: app.getPath('userData'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    log,
  })
  return anytype.handle(String(action), args)
})

/**
 * Google Drive (desktop/googleDrive.mjs): the sign-in runs in the system's
 * browser, the refresh token stays here, the page gets an access token when
 * it asks and sends the files itself. The client comes in with the build
 * (scripts/build-desktop.mjs); without one the page says Drive is not set up.
 */
/* global SONDRA_GOOGLE_CLIENT_ID_BUILT, SONDRA_GOOGLE_CLIENT_SECRET_BUILT */
const GOOGLE_BUILT = {
  clientId: typeof SONDRA_GOOGLE_CLIENT_ID_BUILT === 'string' ? SONDRA_GOOGLE_CLIENT_ID_BUILT : '',
  clientSecret: typeof SONDRA_GOOGLE_CLIENT_SECRET_BUILT === 'string' ? SONDRA_GOOGLE_CLIENT_SECRET_BUILT : '',
}
let googleDrive = null
ipcMain.handle('sondra:drive', (_event, action, ...args) => {
  googleDrive ??= createGoogleDrive({
    dataDir: app.getPath('userData'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    openExternal: (url) => shell.openExternal(url),
    clientId: process.env.SONDRA_GOOGLE_CLIENT_ID || GOOGLE_BUILT.clientId || '',
    clientSecret: process.env.SONDRA_GOOGLE_CLIENT_SECRET || GOOGLE_BUILT.clientSecret || '',
    focus: () => {
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    },
    log,
  })
  return googleDrive.handle(String(action), args)
})

ipcMain.handle('sondra:take-files', () => {
  const files = waitingFiles
  waitingFiles = []
  if (files.length > 0) log(`Geöffnet mit Sondra: ${files.map((file) => path.basename(file)).join(', ')}`)
  return describeFiles(files)
})

ipcMain.handle('sondra:discord-presence', (_event, activity) => {
  discordRpc.setActivity(activity)
  return true
})

ipcMain.handle('sondra:discord-enabled', (_event, enabled) => {
  discordRpc.setEnabled(enabled)
  return true
})

// A click on a notice (a new episode) brings the window forward.
ipcMain.handle('sondra:focus', () => {
  if (!window) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
})

ipcMain.handle('sondra:always-on-top', (_event, flag) => {
  if (window) {
    window.setAlwaysOnTop(Boolean(flag), 'floating')
    return window.isAlwaysOnTop()
  }
  return false
})

ipcMain.handle('sondra:is-always-on-top', () => {
  return window ? window.isAlwaysOnTop() : false
})

ipcMain.handle('sondra:notify', (_event, title, body) => {
  try {
    if (!Notification.isSupported()) return false
    const n = new Notification({
      title: String(title || 'Sondra Studio'),
      body: String(body || ''),
    })
    n.on('click', () => {
      if (!window) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
    n.show()
    return true
  } catch {
    return false
  }
})

ipcMain.handle('sondra:get-download-dir', () => {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'herunterladen.json')
    const raw = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
    return raw.downloadDir || path.join(app.getPath('downloads'), 'Sondra')
  } catch {
    return path.join(app.getPath('downloads'), 'Sondra')
  }
})

ipcMain.handle('sondra:pick-download-dir', async () => {
  try {
    const res = window
      ? await dialog.showOpenDialog(window, {
          title: 'Zielordner für Direkt-Downloads wählen',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Zielordner für Direkt-Downloads wählen',
          properties: ['openDirectory', 'createDirectory'],
        })
    if (res.canceled || !res.filePaths?.[0]) return null
    const chosen = res.filePaths[0]
    const settingsFile = path.join(app.getPath('userData'), 'herunterladen.json')
    const existing = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {}
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ ...existing, downloadDir: chosen }, null, 2))
    return chosen
  } catch {
    return null
  }
})

let downloadPowerSaveId = null
ipcMain.handle('sondra:power-save-blocker', (_event, active) => {
  try {
    if (active) {
      if (downloadPowerSaveId === null || !powerSaveBlocker.isStarted(downloadPowerSaveId)) {
        downloadPowerSaveId = powerSaveBlocker.start('prevent-app-suspension')
      }
    } else {
      if (downloadPowerSaveId !== null && powerSaveBlocker.isStarted(downloadPowerSaveId)) {
        powerSaveBlocker.stop(downloadPowerSaveId)
        downloadPowerSaveId = null
      }
    }
    return true
  } catch {
    return false
  }
})

ipcMain.handle('sondra:set-progress-bar', (_event, progress) => {
  try {
    if (window && !window.isDestroyed()) {
      window.setProgressBar(typeof progress === 'number' && progress >= 0 ? progress : -1)
      return true
    }
    return false
  } catch {
    return false
  }
})

app.on('second-instance', (_event, argv, workingDirectory) => {
  const files = filesIn(argv, workingDirectory)
  if (files.length > 0 && window) {
    log(`Geöffnet mit Sondra (Fenster offen): ${files.map((file) => path.basename(file)).join(', ')}`)
    window.webContents.send('sondra:files', describeFiles(files))
  } else if (files.length > 0) {
    waitingFiles.push(...files)
  }
  log('Zweiter Start: bringe das offene Fenster nach vorn.')
  if (!window) return
  // `show` as well as `focus`: a window that is hidden does not come back
  // from `focus` alone, and the second start then looked like nothing at all.
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

/**
 * A GPU process that keeps dying leaves a window that paints nothing and then
 * closes. When it happens, the next starts run without hardware acceleration;
 * the page is 2D and the maths runs on the CPU either way.
 *
 * For a day, not for good. The marker used to stay forever, so one crash —
 * a driver update, a resume from sleep — left every later start drawing in
 * software, and the whole app felt slow for a reason nobody could see.
 */
const NO_GPU = () => path.join(app.getPath('userData'), 'ohne-gpu')
const NO_GPU_FOR_MS = 24 * 60 * 60 * 1000
let withoutGpu = false
try {
  const since = fs.statSync(NO_GPU()).mtimeMs
  if (Date.now() - since < NO_GPU_FOR_MS) {
    app.disableHardwareAcceleration()
    withoutGpu = true
  } else {
    fs.rmSync(NO_GPU(), { force: true })
  }
} catch {
  // No marker, or no data folder yet: first start.
}

app.on('child-process-gone', (_event, details) => {
  log(`Hilfsprozess beendet: ${details.type} · ${details.reason} (${details.exitCode})`)
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true })
      fs.writeFileSync(NO_GPU(), 'Beim nächsten Start ohne Grafikbeschleunigung.\n')
    } catch {
      // Best effort; the log already says what happened.
    }
  }
})

process.on('uncaughtException', (failure) => log(`Unbehandelt: ${failure?.stack ?? failure}`))
process.on('unhandledRejection', (failure) => log(`Unbehandelt (Promise): ${failure?.stack ?? failure}`))

/** Links to anywhere but Sondra itself open in the default browser. */
function keepInside(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(origin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
}

/**
 * The downloader service's two questions, as native dialogs: a web page can
 * cause one to appear but cannot answer it. One at a time.
 */
let asking = Promise.resolve()
function askOnce(options, answers) {
  const next = asking.then(async () => {
    if (ANSWER) return ANSWER === 'yes' ? answers[0] : null
    const { response } = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
    return answers[response] ?? null
  })
  asking = next.catch(() => null)
  return next
}

const questions = {
  install: () =>
    askOnce(
      {
        type: 'question',
        title: 'Sondra Studio',
        message: 'yt-dlp laden?',
        detail:
          'Zum Herunterladen von Videoportalen braucht Sondra yt-dlp, ein freies Programm ' +
          '(github.com/yt-dlp/yt-dlp). Sondra lädt die offizielle Fassung einmal von dort, prüft ' +
          'sie gegen die veröffentlichte Prüfsumme und legt sie in ihren eigenen Ordner. Danach ' +
          'hält sie sich einmal pro Woche selbst aktuell.\n\n' +
          'Laden Sie nur herunter, was Sie herunterladen dürfen.',
        buttons: ['yt-dlp laden', 'Abbrechen'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      },
      [true, false],
    ).then(Boolean),
  // Tests never hand over a browser's sign-in, whatever they answer otherwise.
  signIn: () =>
    ANSWER ? Promise.resolve(null) : askOnce(
      {
        type: 'question',
        title: 'Sondra Studio',
        message: 'YouTube verlangt für dieses Video eine Anmeldung.',
        detail:
          'Sondra kann die Anmeldung aus einem Browser auf diesem Rechner übernehmen, in dem Sie ' +
          'bei YouTube angemeldet sind. Sie geht nur an YouTube und verlässt diesen Rechner sonst ' +
          'nicht. Am zuverlässigsten klappt es mit Firefox; bei Chrome und Edge verhindert Windows ' +
          'das Auslesen oft.',
        buttons: ['Firefox', 'Edge', 'Chrome', 'Nicht jetzt'],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
      },
      ['firefox', 'edge', 'chrome', null],
    ),
}

/** Settle `promise`, or give up waiting after `ms` — whichever comes first. */
function within(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))])
}

async function open() {
  trimLog()
  log(`Start ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}${IN_STORE ? ' · Microsoft Store' : ''}${PORTABLE_DATA ? ` · portabel, Daten in ${PORTABLE_DATA}` : ''}`)
  if (withoutGpu) log('Ohne Grafikbeschleunigung, weil die GPU in den letzten 24 Stunden abgestürzt ist.')

  // The default menu is English and mostly developer tools; the page carries
  // its own navigation.
  Menu.setApplicationMenu(null)

  // The window comes first and is visible at once, in the theme's canvas
  // colour. It used to wait, hidden, for the page to finish loading; a load
  // that hung left an invisible Sondra running, and every later start handed
  // over to it and ended — which looked like the app opening nothing.
  window = new BrowserWindow({
    title: 'Sondra Studio',
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    show: !SMOKE,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a110d' : '#f2eee4',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The version and the updater, and nothing else, for the page.
      preload: path.join(app.getAppPath(), 'preload.cjs'),
    },
  })

  log('Fenster offen')

  // The page decides what a minimised window means („Beim Minimieren pausieren“); it only has to be told.
  window.on('minimize', () => window?.webContents.send('sondra:window-state', 'minimized'))
  window.on('restore', () => window?.webContents.send('sondra:window-state', 'restored'))

  try {
    globalShortcut.register('MediaPlayPause', () => {
      window?.webContents.send('sondra:media-action', 'toggle')
    })
    globalShortcut.register('MediaNextTrack', () => {
      window?.webContents.send('sondra:media-action', 'next')
    })
    globalShortcut.register('MediaPreviousTrack', () => {
      window?.webContents.send('sondra:media-action', 'prev')
    })
    globalShortcut.register('MediaStop', () => {
      window?.webContents.send('sondra:media-action', 'stop')
    })
  } catch (err) {
    log(`Globale Medientasten konnten nicht registriert werden: ${err?.message ?? err}`)
  }

  // Updates only for the installed Windows app, and never in a test run —
  // a test must not replace the build it is testing. The page's update
  // control is there either way and says so.
  setupUpdates({
    log,
    ipcMain,
    window: () => window,
    version: app.getVersion(),
    enabled: app.isPackaged && process.platform === 'win32' && !IN_STORE && !SMOKE && !ANSWER && process.env.SONDRA_UPDATES !== 'off',
    channel: IN_STORE ? 'store' : PORTABLE_DATA ? 'portable' : 'setup',
  })

  // The page title is written for a browser tab; the window is "Sondra
  // Studio", as in the Store and the Start menu.
  window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.on('did-finish-load', () => log(`Geladen: ${window?.webContents.getURL().slice(0, 60)}`))
  window.on('closed', () => {
    window = null
  })

  // Earlier builds shipped the site's service worker, which then sat between
  // this window and the local server. This build does not ship it; whatever a
  // previous install registered — and the ~90 MB it cached — goes here. Not
  // worth a hang, though: after a few seconds the start goes on without it.
  // Once is enough; a marker keeps every later start from doing it again.
  const swDone = path.join(app.getPath('userData'), 'service-worker-entfernt')
  if (!fs.existsSync(swDone)) {
    try {
      const cleared = await within(
        session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }),
        4000,
      )
      if (cleared === 'timeout') log('Service Worker entfernen dauert zu lange, weiter ohne.')
      else {
        log('Alte Service Worker entfernt')
        fs.mkdirSync(path.dirname(swDone), { recursive: true })
        fs.writeFileSync(swDone, '')
      }
    } catch (failure) {
      log(`Service Worker nicht entfernt: ${failure?.message ?? failure}`)
    }
  }

  // Plain files next to the app archive (see scripts/build-desktop.mjs).
  const root = process.env.SONDRA_APP_DIR ?? path.join(process.resourcesPath, 'site')
  const { url } = await startServer({ root, port: PORT, dataDir: app.getPath('userData'), onError: (message) => log(`Server: ${message}`) })
  const origin = url.replace(/\/$/, '')
  log(`Server auf ${url}`)

  // The service the downloader talks to — started here, so nobody has to run
  // a script for it. Waited for only briefly — opening a port is instant, and
  // the page looks for the service again whenever it was not there yet.
  if (process.env.SONDRA_DOWNLOADER !== 'off') {
    await within(
      startDownloader({ dataDir: app.getPath('userData'), origin, log: (message) => log(message), ask: questions, fetchesTool: !IN_STORE }).then(
        (service) => log(service ? `Dienst zum Herunterladen auf ${service.url}` : 'Port 9000 belegt: die Seite nutzt den Dienst, der dort läuft.'),
      ),
      1500,
    )
  }

  // Permissions (microphone, clipboard, notifications) only for Sondra's own
  // page, never for anything it might end up framing.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback, details) => {
    callback(Boolean(details.requestingUrl?.startsWith(origin)))
  })

  // Screen recording. A browser shows its own picker for getDisplayMedia;
  // Electron has none, so the page lists the screens and windows through the
  // preload, the user picks one there, and this handler hands exactly that
  // source over when the page asks. Nothing is chosen on the page's behalf:
  // without a pick the request is refused.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const pick = capturePick
    capturePick = null
    try {
      if (!pick || !request.securityOrigin?.startsWith(origin)) throw new Error('keine Quelle gewählt')
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      const source = sources.find((entry) => entry.id === pick.id)
      if (!source) throw new Error('Quelle nicht mehr da')
      log(`Bildschirmaufnahme: ${source.name}${pick.audio ? ' · mit Ton des Rechners' : ''}`)
      // Loopback is the whole system's sound; Windows has no per-window audio.
      callback(pick.audio && request.audioRequested ? { video: source, audio: 'loopback' } : { video: source })
    } catch (failure) {
      log(`Bildschirmaufnahme abgelehnt: ${failure?.message ?? failure}`)
      // An empty answer is a refusal; some Electron versions throw on it
      // after refusing, which is the same outcome.
      try {
        callback({})
      } catch {
        /* refused either way */
      }
    }
  })

  if (!window) return // closed while starting
  keepInside(window.webContents, origin)

  const contents = window.webContents
  contents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    log(`Laden fehlgeschlagen: ${code} ${description} · ${failedUrl}${isMainFrame ? ' (Seite)' : ''}`)
  })
  contents.on('render-process-gone', (_event, details) => {
    log(`Seitenprozess beendet: ${details.reason} (${details.exitCode})`)
    if (details.reason !== 'clean-exit' && window) void load()
  })
  contents.on('console-message', (event) => {
    if (event.level === 'error') log(`Seite: ${event.message}`)
    // The page's own notes for this log — sound, for one.
    else if (event.message.startsWith('[Sondra] ')) log(event.message.slice(9))
  })

  if (SMOKE) {
    contents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const seen = await contents.executeJavaScript(
        `({ isolated: crossOriginIsolated, heading: document.querySelector('h1,h2')?.textContent ?? null,
            tools: document.querySelectorAll('section button').length })`,
      )
      fs.writeFileSync(SMOKE, JSON.stringify({ url, ...seen, userData: app.getPath('userData') }))
      app.exit(0)
    })
  }

  /**
   * Load the page, a few times if need be. A first navigation can fail for
   * reasons that are gone a moment later — a virus scanner holding a file,
   * the loopback interface still settling after resume — and giving up on the
   * first one made a passing hiccup look like a broken install.
   */
  async function load() {
    let last = null
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!window) return
      try {
        await window.loadURL(url)
        return
      } catch (failure) {
        last = failure
        log(`Versuch ${attempt}: ${failure?.message ?? failure}`)
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
      }
    }
    if (SMOKE) {
      fs.writeFileSync(SMOKE, JSON.stringify({ error: String(last?.message ?? last) }))
      app.exit(1)
      return
    }
    if (!window) return
    await window.loadURL(failurePage(String(last?.message ?? last), url))
    window.show()
  }

  await load()

}

function registerSondraProjectIcon() {
  // The portable build writes nothing into the registry: it runs from a
  // temporary copy that is gone once it closes.
  if (process.platform !== 'win32' || IN_STORE || PORTABLE_DATA || SMOKE || !app.isPackaged) return
  const exe = process.execPath
  const entries = [
    ['HKCU\\Software\\Classes\\.sondra', '/ve', '/d', 'Sondra.Projekt', '/f'],
    ['HKCU\\Software\\Classes\\Sondra.Projekt', '/ve', '/d', 'Sondra-Projekt', '/f'],
    ['HKCU\\Software\\Classes\\Sondra.Projekt\\DefaultIcon', '/ve', '/d', `${exe},0`, '/f'],
    ['HKCU\\Software\\Classes\\Sondra.Projekt\\shell\\open\\command', '/ve', '/d', `"${exe}" "%1"`, '/f'],
  ]
  for (const args of entries) {
    execFile('reg.exe', ['add', ...args], { windowsHide: true }, () => {})
  }
}

app.setAppUserModelId('ch.lizge.sondra')

if (primary) app.whenReady().then(() => {
  registerSondraProjectIcon()
  return open().catch((failure) => {
    const message = String(failure?.message ?? failure)
    log(`Start fehlgeschlagen: ${failure?.stack ?? failure}`)
    if (SMOKE) fs.writeFileSync(SMOKE, JSON.stringify({ error: message }))
    else dialog.showErrorBox('Sondra konnte nicht starten', `${message}\n\nProtokoll: ${logFile()}`)
    app.exit(1)
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => app.quit())
