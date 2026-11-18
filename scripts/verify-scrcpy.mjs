// The phone mirror ships a third party's file and talks to it with a library
// that must name the very same version. This checks what would otherwise fail
// only on a phone: the jar is the one that was reviewed, client and server
// versions agree, the licence texts travel with it, and the libraries are
// pinned (a caret would let an install change the protocol under us).
import { createHash } from 'node:crypto'
import fs from 'node:fs'

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok   ' : 'FEHLT'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

const source = fs.readFileSync('src/lib/phoneMirror.ts', 'utf8')
const version = source.match(/SERVER_VERSION = '([^']+)'/)?.[1]
const wanted = source.match(/SERVER_SHA256 = '([0-9a-f]{64})'/)?.[1]
const jar = `src/assets/scrcpy/scrcpy-server-v${version}.jar`

check('Version und Prüfsumme stehen in phoneMirror.ts', Boolean(version && wanted))
check('Die Server-Datei liegt da', fs.existsSync(jar), jar)
const actual = fs.existsSync(jar) ? createHash('sha256').update(fs.readFileSync(jar)).digest('hex') : ''
check('SHA-256 der Server-Datei stimmt', actual === wanted, actual)
check('Dieselbe Prüfsumme in der README neben der Datei', fs.readFileSync('src/assets/scrcpy/README.md', 'utf8').includes(wanted ?? '?'))

const clientVersion = fs.readFileSync('node_modules/@yume-chan/adb-scrcpy/esm/3_3_3.js', 'utf8').match(/clientOptions\?\.version \?\? "([^"]+)"/)?.[1]
check('Die Client-Bibliothek nennt dieselbe Server-Version', clientVersion === version, `${clientVersion} / ${version}`)
check('Der Dienst übergibt AdbScrcpyOptions3_3_3', source.includes('AdbScrcpyOptions3_3_3'))

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const tango = Object.entries(pkg.dependencies).filter(([name]) => name.startsWith('@yume-chan/'))
check('Die Tango-Pakete sind fest eingetragen (keine ^ oder ~)', tango.length >= 6 && tango.every(([, range]) => /^\d+\.\d+\.\d+$/.test(range)), tango.map(([n, r]) => `${n}@${r}`).join(' '))

const licence = fs.readFileSync('src/assets/scrcpy/LICENSE', 'utf8')
check('Apache-2.0-Text neben der Server-Datei', licence.includes('Apache License') && licence.includes('Version 2.0'))
for (const file of ['public/lizenzen/scrcpy-Apache-2.0.txt', 'public/lizenzen/tango-MIT.txt', 'desktop/lizenzen/scrcpy-Apache-2.0.txt', 'desktop/lizenzen/tango-MIT.txt']) {
  check(`Lizenztext vorhanden: ${file}`, fs.existsSync(file) && fs.statSync(file).size > 900)
}
const page = fs.readFileSync('public/lizenz.html', 'utf8')
check('Die Lizenzseite nennt scrcpy und Tango und verlinkt die Texte', page.includes('scrcpy') && page.includes('Tango ADB') && page.includes('lizenzen/scrcpy-Apache-2.0.txt') && page.includes('lizenzen/tango-MIT.txt'))
check('Die Anleitung nennt scrcpy nicht als Namen des Reiters', !/label: 'scrcpy/i.test(fs.readFileSync('src/components/panelMeta.tsx', 'utf8')))

// In the Windows app Electron asks the *session* which phone: a listener on the
// window's webContents never hears the event, Electron cancels at once, and the
// page says "Kein Handy gewählt" without a choice (seen 18.11.2026).
const electron = fs.readFileSync('desktop/electron.mjs', 'utf8')
check('Windows-App: „select-usb-device“ hängt an der Session, nicht am Fenster', /[sS]ession\.on\('select-usb-device'/.test(electron) && !/webContents\.on\('select-usb-device'/.test(electron))
check('Windows-App: die Auswahl fragt immer, auch bei einem Handy', electron.includes('Welches Handy soll gespiegelt werden?') && !/devices\.length === 1\) return callback/.test(electron))

process.exit(failed ? 1 : 0)
