/**
 * Builds Sondra as an installed desktop app: Electron window, NSIS installer.
 *
 *   npm run build:desktop            →   release/Sondra-Setup-<version>.exe  (on Windows)
 *   npm run build:desktop -- --dir   →   release/<platform>-unpacked/        (any OS, for testing)
 *
 * The installer installs per user (no admin rights), shows LIZENZ.txt before
 * installing, and adds a start-menu entry and a desktop shortcut. An NSIS
 * installer needs a Windows build machine (or wine); `.github/workflows/
 * desktop.yml` builds it on windows-latest and test-starts the installed app.
 *
 * The app carries what the website serves, minus the files that only make
 * sense on a deployment (`_headers`, `staticwebapp.config.json`) and the
 * yt-dlp bridge script, which the desktop app does not ship or start.
 * Nothing is removed from the repository by this.
 *
 * Electron lives in `desktop/package.json`, not in the root one, so the
 * website's install on Vercel does not download a 100 MB browser it never
 * runs.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

const DESKTOP = path.resolve('desktop')
const STAGE = path.join(DESKTOP, '.stage')
const RESOURCES = path.join(DESKTOP, '.build')
const SITE = path.join(DESKTOP, '.site')
const onlyDir = process.argv.includes('--dir')

/**
 * Not part of the app: deployment config, the yt-dlp bridge, and the service
 * worker. The worker exists to add isolation headers a static host cannot set
 * and to keep the site usable offline; the app's own server sets the headers
 * and is on this machine anyway. Left in, it sits between the window and that
 * server, and a fetch that fails inside it reaches the window as ERR_FAILED —
 * the likeliest source of the one reported on start.
 */
const LEFT_OUT = new Set(['_headers', 'staticwebapp.config.json', 'sondra-ytdlp.mjs', 'coi-serviceworker.js'])

function step(message) {
  console.log(`· ${message}`)
}

if (!fs.existsSync('dist/index.html')) {
  console.error('dist/ fehlt. Zuerst `npm run build` (oder gleich `npm run build:desktop`).')
  process.exit(1)
}
if (!fs.existsSync(path.join(DESKTOP, 'node_modules/electron-builder'))) {
  console.error('Electron fehlt. Einmal `npm ci --prefix desktop` ausführen.')
  process.exit(1)
}

fs.rmSync(STAGE, { recursive: true, force: true })
fs.rmSync(RESOURCES, { recursive: true, force: true })
fs.rmSync(SITE, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })
fs.mkdirSync(RESOURCES, { recursive: true })

/* -- 1. the main process, as one CommonJS file ------------------------------ */

step('Hauptprozess bündeln')
await build({
  entryPoints: ['desktop/electron.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  outfile: path.join(STAGE, 'main.cjs'),
  logLevel: 'warning',
})

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'))
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  JSON.stringify(
    {
      name: 'sondra',
      productName: 'Sondra',
      version: root.version,
      description: 'Ton, Video und Bilder bearbeiten — lokal auf diesem Rechner.',
      // Windows shows this as the publisher in Apps & Features, and the
      // Microsoft Store checks it against the publisher name of the account.
      author: 'Lizge',
      main: 'main.cjs',
    },
    null,
    2,
  ),
)

/* -- 2. the site ------------------------------------------------------------ */

step('Oberfläche kopieren')
// Beside the app archive, not inside it: electron-builder copies .site to
// resources/site as plain files. Inside app.asar the site made one 93 MB file
// that a virus scanner reads end to end whenever the app opens it — on every
// start, before the first byte of the page. As plain files, only what the
// page actually asks for is opened, and the archive holds one small script.
fs.cpSync('dist', SITE, {
  recursive: true,
  filter: (source) => !LEFT_OUT.has(path.basename(source)),
})

/* -- 3. installer resources ------------------------------------------------- */

// NSIS shows the licence as-is; a byte-order mark is what makes it read the
// umlauts as UTF-8 rather than as the system code page.
fs.writeFileSync(path.join(RESOURCES, 'LIZENZ.txt'), '\uFEFF' + fs.readFileSync('desktop/LIZENZ.txt', 'utf8'))
fs.copyFileSync('public/icon-512.png', path.join(RESOURCES, 'icon.png'))

// Third-party licences next to the installed app: the GPL notice for the
// FFmpeg core lives in desktop/lizenzen (its npm package ships none), the
// rest come from node_modules. Electron adds its own and Chromium's.
const licences = path.join(RESOURCES, 'lizenzen')
fs.cpSync('desktop/lizenzen', licences, { recursive: true })
for (const [name, file] of [
  ['react.txt', 'node_modules/react/LICENSE'],
  ['tone.txt', 'node_modules/tone/LICENSE.md'],
  ['wavesurfer.js.txt', 'node_modules/wavesurfer.js/LICENSE'],
  ['zustand.txt', 'node_modules/zustand/LICENSE'],
]) {
  fs.copyFileSync(file, path.join(licences, name))
}

/* -- 4. electron-builder ---------------------------------------------------- */

step(onlyDir ? 'App-Ordner bauen' : 'Installer bauen')
const builder = path.join(DESKTOP, 'node_modules/electron-builder/cli.js')
const args = onlyDir ? ['--dir'] : ['--win', 'nsis', '--x64']
execFileSync(process.execPath, [builder, ...args, '--publish', 'never'], { cwd: DESKTOP, stdio: 'inherit' })
