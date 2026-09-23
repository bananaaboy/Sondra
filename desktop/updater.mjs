/**
 * Keeping the installed app current.
 *
 * electron-updater reads `latest.yml` from the newest GitHub release, which
 * the Desktop workflow uploads next to the installer. A newer version is
 * downloaded in the background and checked against the SHA-512 in that file;
 * nothing interrupts work while it happens. Once it is there, one question:
 * restart now, or later — "later" installs it when Sondra is closed anyway.
 *
 * Sondra installs for all users, so the update asks Windows for permission
 * the same way the setup did.
 */

import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 20_000
const EVERY_MS = 6 * 60 * 60 * 1000

export function startUpdates({ log, dialog, window }) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: () => {},
    debug: () => {},
    warn: (message) => log(`Update: ${message}`),
    error: (message) => log(`Update: ${message}`),
  }

  autoUpdater.on('update-available', (info) => log(`Update ${info.version} gefunden, wird geladen`))
  autoUpdater.on('update-not-available', (info) => log(`Keine neuere Fassung (neueste: ${info.version})`))
  autoUpdater.on('error', (failure) => log(`Update nicht möglich: ${failure?.message ?? failure}`))

  let asked = false
  autoUpdater.on('update-downloaded', async (info) => {
    log(`Update ${info.version} geladen und geprüft`)
    if (asked) return
    asked = true
    const parent = window()
    const options = {
      type: 'info',
      title: 'Sondra',
      message: `Sondra ${info.version} ist bereit.`,
      detail:
        'Jetzt neu starten und aktualisieren? Mit „Später“ wird die neue Fassung installiert, ' +
        'wenn Sie Sondra das nächste Mal schliessen. Offene Dateien der Sitzung gehen beim ' +
        'Neustart verloren — vorher speichern, was Sie behalten wollen.',
      buttons: ['Jetzt neu starten', 'Später'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (response === 0) {
      log(`Update ${info.version}: Neustart`)
      // Silent: no installer pages, just the Windows permission prompt, and
      // Sondra opens again afterwards.
      autoUpdater.quitAndInstall(true, true)
    }
  })

  const check = () =>
    autoUpdater.checkForUpdates().catch((failure) => log(`Update-Prüfung fehlgeschlagen: ${failure?.message ?? failure}`))
  setTimeout(check, FIRST_CHECK_MS).unref?.()
  setInterval(check, EVERY_MS).unref?.()
}
