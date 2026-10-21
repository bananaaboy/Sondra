/**
 * Keeping the installed app current.
 *
 * electron-updater reads `latest.yml` from the newest GitHub release, which
 * the Desktop workflow uploads next to the installer. A newer version is
 * downloaded in the background and checked against the SHA-512 in that file;
 * nothing interrupts work while it happens. The page shows where it stands —
 * a control in the header, where the website offers the app — and installs
 * on a click there. Left alone, the update goes in when Sondra is closed.
 *
 * Sondra installs for all users, so the update asks Windows for permission
 * the same way the setup did. `nsis.packElevateHelper` is set so latest.yml
 * says so (`isAdminRightsRequired`) and the installer goes straight through
 * elevate.exe, instead of being started plainly first and retried elevated
 * only if Windows' refusal happens to arrive as the error code the updater
 * looks for.
 *
 * Everything the updater says goes to sondra.log, `info` included: when an
 * update does not arrive, the log is the only witness of which step stopped.
 *
 * The portable build cannot replace itself — it unpacks into a temporary
 * folder on every start, and electron-updater only knows the installer. It
 * reads the same latest.yml for the newest version and offers that
 * version's portable file to download (`available`, with `download`).
 */

import { net } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 20_000
const EVERY_MS = 6 * 60 * 60 * 1000
const RELEASES = 'https://github.com/bananaaboy/Sondra/releases/latest/download'

/** True when version `a` (x.y.z) is later than `b`. */
function later(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map((part) => Number.parseInt(part, 10) || 0))
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/**
 * Registers the page's questions and, when `enabled`, starts checking.
 *
 * States: off (not the installed Windows app, or a test run) · idle ·
 * checking · current · downloading (percent) · ready (version) ·
 * available (portable: a newer version to download) · error.
 */
export function setupUpdates({ log, ipcMain, window, version, enabled, channel = 'setup' }) {
  const portable = channel === 'portable'
  const download = portable ? `${RELEASES}/${process.arch === 'arm64' ? 'Sondra-Portable-arm64.exe' : 'Sondra-Portable.exe'}` : undefined
  let state = { status: enabled ? 'idle' : 'off', version, channel, download }
  const publish = (next) => {
    state = { ...next, version, channel, download }
    window()?.webContents.send('sondra:update', state)
  }

  /** A check on the page's request; set below for the way this build updates. */
  let checkNow = () => {}

  ipcMain.handle('sondra:update-state', () => state)
  ipcMain.handle('sondra:update-check', () => {
    if (!enabled) return state
    checkNow()
    return state
  })
  ipcMain.handle('sondra:update-install', () => {
    if (state.status !== 'ready') return false
    log(`Update ${state.next}: Neustart auf Wunsch`)
    // Silent: no installer pages, just the Windows permission prompt, and
    // Sondra opens again afterwards.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true)
      } catch (failure) {
        const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
        log(`Update installieren fehlgeschlagen: ${failure?.stack ?? failure}`)
        publish({ status: 'error', message, next: state.next })
      }
    })
    return true
  })

  if (!enabled) return

  if (portable) {
    const check = async () => {
      try {
        const response = await net.fetch(`${RELEASES}/latest.yml`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`latest.yml: HTTP ${response.status}`)
        const newest = /^version:\s*['"]?([\d.]+)/m.exec(await response.text())?.[1]
        if (!newest) throw new Error('latest.yml nennt keine Version')
        if (later(newest, version)) {
          log(`Portabel: ${newest} ist erschienen`)
          publish({ status: 'available', next: newest })
        } else {
          publish({ status: 'current' })
        }
      } catch (failure) {
        const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
        log(`Portabel: Update-Prüfung fehlgeschlagen: ${message}`)
        if (state.status !== 'available') publish({ status: 'error', message })
      }
    }
    checkNow = () => {
      if (state.status === 'checking') return
      publish({ status: 'checking' })
      void check()
    }
    setTimeout(check, FIRST_CHECK_MS).unref?.()
    setInterval(check, EVERY_MS).unref?.()
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (message) => log(`Update: ${message}`),
    debug: () => {},
    warn: (message) => log(`Update: ${message}`),
    error: (message) => log(`Update: ${message}`),
  }
  // Not a web installer; saying so keeps a warning out of the log.
  autoUpdater.disableWebInstaller = true

  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'downloading' && state.status !== 'ready') publish({ status: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    log(`Update ${info.version} gefunden, wird geladen`)
    publish({ status: 'downloading', next: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (progress) => {
    if (state.status === 'downloading') publish({ ...state, percent: Math.round(progress.percent ?? 0) })
  })
  autoUpdater.on('update-not-available', (info) => {
    log(`Keine neuere Fassung (neueste: ${info.version})`)
    publish({ status: 'current' })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`Update ${info.version} geladen und geprüft`)
    publish({ status: 'ready', next: info.version })
  })
  autoUpdater.on('error', (failure) => {
    const message = String(failure?.message ?? failure).split('\n')[0].slice(0, 200)
    log(`Update nicht möglich: ${failure?.stack ?? message}`)
    if (state.status !== 'ready') publish({ status: 'error', message })
  })

  const check = () =>
    autoUpdater.checkForUpdates().catch((failure) => log(`Update-Prüfung fehlgeschlagen: ${failure?.message ?? failure}`))
  checkNow = () => {
    if (state.status !== 'downloading' && state.status !== 'ready' && state.status !== 'checking') {
      // Said before the check starts, so the answer to this call already
      // reads „checking“ — returning the old state let the reply overwrite
      // the event and the button fell back to „Nach Updates suchen“.
      publish({ status: 'checking' })
      void check()
    }
  }
  setTimeout(check, FIRST_CHECK_MS).unref?.()
  setInterval(check, EVERY_MS).unref?.()
}
