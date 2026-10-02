/**
 * The app's own download service, end to end, without the network.
 *
 *   npm run verify:ytdlp
 *
 * `startDownloader` (desktop/downloader.mjs) is started on a free port with a
 * temporary data folder, and in that folder sits a stand-in for yt-dlp: the
 * service looks there first, before PATH, so the real one is never touched
 * and nothing leaves the machine. The stand-in answers the three calls the
 * service makes — `--version`, the format probe `-J`, and the transfer
 * `-f … -o -` — the way yt-dlp would for a plain MP4 address.
 *
 * Checked: the service describes itself, a POST resolves to a tunnel with the
 * right file name, the tunnel delivers the bytes, and the errors the page
 * shows come back as codes, not as a generic failure.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

import { startDownloader } from '../desktop/downloader.mjs'

const ORIGIN = 'http://localhost:5173'
const PAYLOAD = 'sondra-verify-payload\n'.repeat(64)
const TARGET = 'https://media.example.test/clips/hafenkonzert.mp4'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FEHL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A free port on 127.0.0.1, so a running bridge on 9000 is never in the way. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * The stand-in for yt-dlp. A Node script with a shebang, named the way the
 * service looks for its own copy. It writes every call to a log, so the test
 * can see what the service asked for.
 */
function writeStub(dir) {
  const log = path.join(dir, 'aufrufe.log')
  const file = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const info = {
    title: 'Hafenkonzert: Probe 3',
    formats: [
      { format_id: 'audio', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', protocol: 'https', abr: 128 },
      { format_id: 'p480', ext: 'mp4', height: 480, vcodec: 'avc1.4d401e', acodec: 'mp4a.40.2', protocol: 'https', tbr: 900 },
      { format_id: 'p720', ext: 'mp4', height: 720, vcodec: 'avc1.64001f', acodec: 'mp4a.40.2', protocol: 'https', tbr: 1800, filesize: Buffer.byteLength(PAYLOAD) },
    ],
  }
  const source = `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const target = args[args.indexOf('--') + 1] ?? ''
if (args[0] === '--version') { process.stdout.write('2099.01.01\\n'); process.exit(0) }
if (target.includes('nicht-da')) { process.stderr.write('ERROR: [generic] Video unavailable\\n'); process.exit(1) }
if (target.includes('privat')) { process.stderr.write('ERROR: Private video. Sign in if you have been granted access\\n'); process.exit(1) }
if (args.includes('-J')) { process.stdout.write(${JSON.stringify(JSON.stringify(info))}); process.exit(0) }
if (args.includes('-f')) { process.stdout.write(${JSON.stringify(PAYLOAD)}); process.exit(0) }
process.stderr.write('ERROR: unerwarteter Aufruf\\n'); process.exit(2)
`
  fs.writeFileSync(file, source, { mode: 0o755 })
  return log
}

async function main() {
  if (process.platform === 'win32') {
    // The stand-in is a script with a shebang; Windows does not run those as
    // programs. The workflow tests the real service there instead.
    console.log('übersprungen — unter Windows prüft der Desktop-Workflow den Dienst mit echtem yt-dlp')
    return
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sondra-ytdlp-'))
  const callLog = writeStub(dataDir)
  const port = await freePort()
  const asked = []
  const service = await startDownloader({
    port,
    dataDir,
    origin: ORIGIN,
    log: () => {},
    ask: {
      install: async () => (asked.push('install'), false),
      signIn: async () => (asked.push('signIn'), null),
    },
  })
  check('Dienst startet', Boolean(service), service?.url)
  if (!service) return

  const base = `http://localhost:${port}/`
  const post = (body, origin = ORIGIN) =>
    fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })

  try {
    // 1. The description the page reads to show which service answers.
    const about = await fetch(base, { headers: { origin: ORIGIN } })
    const aboutBody = await about.json()
    check('Beschreibung: 200', about.status === 200, String(about.status))
    check('Beschreibung nennt yt-dlp-Version', /2099\.01\.01/.test(aboutBody?.cobalt?.version ?? ''), aboutBody?.cobalt?.version)
    check('CORS für Sondra', about.headers.get('access-control-allow-origin') === ORIGIN)

    // 2. A fremde page is turned away.
    const foreign = await fetch(base, { headers: { origin: 'https://fremde-seite.example' } })
    check('fremde Seite: 403', foreign.status === 403, String(foreign.status))

    // 3. Resolving a plain address: probe, pick 720p progressive, tunnel.
    const resolved = await post({ url: TARGET, videoQuality: '1080' })
    const answer = await resolved.json()
    check('Auflösen: 200', resolved.status === 200, String(resolved.status))
    check('Antwort ist ein Tunnel', answer.status === 'tunnel', answer.status)
    check('Dateiname mit 720p', answer.filename === 'Hafenkonzert- Probe 3 (720p).mp4', answer.filename)

    const calls = fs.readFileSync(callLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const probeCall = calls.find((args) => args.includes('-J'))
    check('Formatprobe mit -J für die Adresse', Boolean(probeCall) && probeCall.at(-1) === TARGET, JSON.stringify(probeCall))

    // 4. The tunnel delivers what the stand-in wrote, with the exact length.
    const tunnel = await fetch(answer.url, { headers: { origin: ORIGIN } })
    const bytes = await tunnel.text()
    check('Tunnel: 200', tunnel.status === 200, String(tunnel.status))
    check('Tunnel liefert die Bytes', bytes === PAYLOAD, `${bytes.length} von ${PAYLOAD.length}`)
    check('Tunnel: Länge stimmt', tunnel.headers.get('content-length') === String(Buffer.byteLength(PAYLOAD)))
    const transferCall = fs
      .readFileSync(callLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((args) => args.includes('-f'))
    check('Übertragung mit dem gewählten Format', transferCall?.[transferCall.indexOf('-f') + 1] === 'p720', JSON.stringify(transferCall))

    // 5. Errors come back as codes the page can explain.
    const missing = await (await post({ url: 'https://media.example.test/nicht-da.mp4' })).json()
    check('nicht vorhanden → eigener Code', missing?.error?.code === 'error.api.content.video.unavailable', missing?.error?.code)
    const priv = await (await post({ url: 'https://media.example.test/privat.mp4' })).json()
    check('privat → eigener Code', priv?.error?.code === 'error.api.content.video.private', priv?.error?.code)
    const empty = await post({})
    const emptyBody = await empty.json()
    check('ohne Adresse → 400 mit link.invalid', empty.status === 400 && emptyBody?.error?.code === 'error.api.link.invalid', `${empty.status} ${emptyBody?.error?.code}`)
    const stale = await fetch(`${base}tunnel?id=gibt-es-nicht`, { headers: { origin: ORIGIN } })
    check('abgelaufener Tunnel → 404', stale.status === 404, String(stale.status))

    check('keine Rückfragen an die Person', asked.length === 0, asked.join(', '))
  } finally {
    service.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

await main()
if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nDer Download-Dienst der App antwortet wie erwartet.')
// The service keeps no handles open after close(), but the job sweeper's
// interval is unref'd only — exit explicitly so a stray socket cannot hold CI.
process.exit(0)
