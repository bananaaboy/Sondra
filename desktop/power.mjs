/**
 * „Danach herunterfahren“: what the page may ask of Windows once a download is
 * done — shut down, or hibernate. A fixed set of two, never a command line:
 * the page names an action, this module knows the command. Windows only; on
 * any other system the answer is „not here“ and nothing runs.
 *
 * The countdown is the page's (60 s, with „Abbrechen“). If the page dies
 * meanwhile, nothing happens — the safe way to fail. Sleep is left out on
 * purpose: `SetSuspendState` hibernates instead when hibernation is on, so a
 * „sleep“ button would do something else than it says.
 *
 * Kept free of Electron itself so `scripts/verify-power.mts` can check the
 * commands without shutting anything down.
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** The two things the page may ask for, with what Windows runs for each. */
export const POWER_COMMANDS = {
  shutdown: { cmd: 'shutdown.exe', args: ['/s', '/t', '0'] },
  hibernate: { cmd: 'shutdown.exe', args: ['/h'] },
}

/**
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {typeof nodeSpawn} [options.spawn]  replaced by the check
 * @param {(message: string) => void} [options.log]
 */
export function createPower({ platform = process.platform, spawn = nodeSpawn, log = () => {} } = {}) {
  const available = platform === 'win32'

  /** Runs one action; answers `{ ok }` or `{ ok: false, reason }` — never throws. */
  function run(action) {
    const command = Object.hasOwn(POWER_COMMANDS, action) ? POWER_COMMANDS[action] : null
    if (!command) return Promise.resolve({ ok: false, reason: 'unknown-action' })
    if (!available) return Promise.resolve({ ok: false, reason: 'not-windows' })
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(command.cmd, command.args, { windowsHide: true, stdio: 'ignore' })
      } catch (failure) {
        log(`Herunterfahren: ${action} nicht gestartet (${failure?.message ?? failure})`)
        resolve({ ok: false, reason: 'failed' })
        return
      }
      child.once('error', (failure) => {
        log(`Herunterfahren: ${action} nicht gestartet (${failure?.message ?? failure})`)
        resolve({ ok: false, reason: 'failed' })
      })
      child.once('exit', (code) => {
        if (code === 0) resolve({ ok: true })
        else {
          // `shutdown /h` answers 1 when hibernation is off in Windows.
          log(`Herunterfahren: ${action} endete mit ${code}`)
          resolve({ ok: false, reason: action === 'hibernate' ? 'hibernate-off' : 'failed' })
        }
      })
    })
  }

  /** The page's door: `status` says whether this is Windows, anything else is an action. */
  async function handle(action) {
    if (action === 'status') return { available }
    log(`Herunterfahren: ${action}`)
    return run(action)
  }

  return { available, run, handle }
}
