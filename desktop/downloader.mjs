/**
 * The downloader's service, inside the app.
 *
 * On the website, anything beyond YouTube's 360p and plain file addresses
 * needs a service on the visitor's machine, started by hand from a script.
 * The app is already a program on that machine, so it runs that service
 * itself: on 127.0.0.1:9000, speaking the protocol the page already knows,
 * and calling yt-dlp underneath.
 *
 * What it deliberately is not: the bridge script from the website. That one
 * carries extractors of its own for a handful of embed hosts; this one has
 * none and leaves every site to yt-dlp's own judgement, exactly as yt-dlp on
 * the command line would.
 *
 * yt-dlp is not shipped. It changes every few weeks as the sites change, and
 * a copy frozen into an installer would be out of date before the next
 * release. The service uses one already on the machine, or — once, when first
 * needed, and only after asking — fetches the official build from the
 * project's GitHub releases, checks it against the published SHA-256, and
 * keeps it in the app's data folder.
 *
 * Only Sondra may use it: the app's own page, and Sondra's website in a
 * browser on this machine — so the website gets full resolution too while the
 * app is running. Everything on the machine can reach 127.0.0.1, including
 * every other website open in a browser; a service that answered all of them
 * would let any page use this machine, and the browser sign-in it may hold,
 * to fetch things.
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'
const ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform] ?? 'yt-dlp'
const OWN_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const UPDATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const JOB_TTL_MS = 30 * 60 * 1000

/** Sondra's website, the one page besides the app that may use the service. */
const SITE_ORIGINS = ['https://www.sondra.lizge.ch', 'https://sondra.lizge.ch']

/** Sites yt-dlp handles well, for the page's list; yt-dlp decides the rest. */
const SERVICES = [
  'youtube', 'soundcloud', 'bandcamp', 'vimeo', 'twitch', 'twitter', 'tiktok', 'instagram',
  'facebook', 'reddit', 'dailymotion', 'bilibili', 'streamable', 'tumblr', 'bluesky', 'loom',
  'pinterest', 'mixcloud', 'ard', 'zdf', 'arte', 'srf',
]

/* -- choosing formats (the same rules as the bridge) ------------------------ */

const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' }
const mimeOf = (format) => MIME[String(format.ext ?? '').toLowerCase()] ?? 'application/octet-stream'

const heightOf = (format) => format.height ?? 0
const isVideoOnly = (f) => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
const isAudioOnly = (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
const isProgressive = (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
const isHls = (f) => f.protocol === 'm3u8' || f.protocol === 'm3u8_native'
const isPlain = (f) => !f.protocol || f.protocol.startsWith('http') || isHls(f)

// H.264 and AAC first: the page copies the streams into an MP4 unchanged,
// and VP9, AV1 and Opus do not go into one without re-encoding.
function scoreVideo(f) {
  const codec = String(f.vcodec ?? '')
  const rank = codec.startsWith('avc') || codec.startsWith('h264') ? 3 : codec.startsWith('av01') ? 1 : 2
  return rank * 1e9 + heightOf(f) * 1e4 + (f.tbr ?? 0)
}
function scoreAudio(f) {
  const codec = String(f.acodec ?? '')
  return (codec.startsWith('mp4a') || codec.startsWith('aac') ? 2 : 1) * 1e6 + (f.abr ?? f.tbr ?? 0)
}
function pickVideo(formats, maxHeight) {
  const fits = formats.filter((f) => isVideoOnly(f) && isPlain(f) && (!maxHeight || heightOf(f) <= maxHeight))
  const pool = fits.length > 0 ? fits : formats.filter((f) => isVideoOnly(f) && isPlain(f))
  return pool.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] ?? null
}
const pickAudio = (formats) =>
  formats.filter((f) => isAudioOnly(f) && isPlain(f)).sort((a, b) => scoreAudio(b) - scoreAudio(a))[0] ?? null
function pickProgressive(formats, maxHeight) {
  const pool = formats.filter((f) => isProgressive(f) && isPlain(f) && (!maxHeight || heightOf(f) <= maxHeight))
  return pool.sort((a, b) => heightOf(b) - heightOf(a) || (b.tbr ?? 0) - (a.tbr ?? 0))[0] ?? null
}

/** yt-dlp's plain-text complaints, as the codes the page can explain. */
function errorCode(stderr) {
  const text = stderr.toLowerCase()
  if (text.includes('not a bot') || text.includes('sign in to confirm') || text.includes('403') || text.includes('forbidden')) {
    return 'error.api.ytdlp.signin'
  }
  if (text.includes('unsupported url') || text.includes('is not a valid url')) return 'error.api.link.unsupported'
  if (text.includes('private video') || text.includes('members-only')) return 'error.api.content.video.private'
  if (text.includes('confirm your age') || text.includes('age-restricted')) return 'error.api.content.video.age'
  if (text.includes('not available in your country') || text.includes('geo')) return 'error.api.content.video.region'
  if (text.includes('video unavailable') || text.includes('has been removed')) return 'error.api.content.video.unavailable'
  if (text.includes('no video formats') || text.includes('unable to extract')) return 'error.api.link.unsupported'
  return 'error.api.fetch.fail'
}

/**
 * Starts the service. Resolves to `{ url }`, or to null when the port is
 * taken — most likely by a bridge someone started by hand, which the page
 * then simply uses instead.
 *
 * `ask.install()` and `ask.signIn()` put the two questions to the person in
 * front of the app and resolve to their answer.
 */
export async function startDownloader({ port = 9000, dataDir, origin, log = () => {}, ask }) {
  const settingsFile = path.join(dataDir, 'herunterladen.json')
  const readSettings = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    } catch {
      return {}
    }
  }
  const writeSettings = (patch) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...patch }, null, 2))
    } catch (failure) {
      log(`Einstellungen nicht gespeichert: ${failure?.message ?? failure}`)
    }
  }
  const cookieArgs = () => {
    const browser = readSettings().cookies
    return browser ? ['--cookies-from-browser', String(browser)] : []
  }

  /* -- finding yt-dlp ------------------------------------------------------ */

  const ownCopy = path.join(dataDir, OWN_NAME)

  function candidates() {
    const list = [ownCopy]
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || ''
      list.push(
        path.join(local, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
        path.join(local, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
        path.join(local, 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
      )
    }
    return [...list.filter((file) => fs.existsSync(file)), 'yt-dlp']
  }

  /** Runs a program and collects what it says. `missing` means it is not there. */
  function run(bin, args, { timeoutMs = 90_000 } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(bin, args, { windowsHide: true })
      } catch (failure) {
        return resolve({ code: -1, stdout: '', stderr: String(failure?.message ?? failure), missing: true })
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', (failure) => {
        clearTimeout(timer)
        resolve({ code: -1, stdout: '', stderr: String(failure?.message ?? failure), missing: failure.code === 'ENOENT' || failure.code === 'EACCES' })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  }

  let found = null
  let updateChecked = false

  async function locate() {
    if (found) return found
    for (const bin of candidates()) {
      const version = await run(bin, ['--version'], { timeoutMs: 20_000 })
      if (version.code === 0) {
        found = { bin, version: version.stdout.trim() }
        log(`yt-dlp ${found.version}: ${bin}`)
        maybeUpdate()
        return found
      }
    }
    return null
  }

  /** The own copy updates itself once a week, in the background. */
  function maybeUpdate() {
    if (updateChecked || !found || found.bin !== ownCopy) return
    updateChecked = true
    try {
      if (Date.now() - fs.statSync(ownCopy).mtimeMs < UPDATE_AFTER_MS) return
    } catch {
      return
    }
    void run(ownCopy, ['-U'], { timeoutMs: 180_000 }).then((result) => {
      log(`yt-dlp aktualisieren: ${result.code === 0 ? 'fertig' : `Code ${result.code}`}`)
      if (result.code === 0) {
        try {
          const now = new Date()
          fs.utimesSync(ownCopy, now, now)
        } catch {
          /* checked again next week */
        }
        found = null
      }
    })
  }

  let installing = null

  /** Fetches the official build and checks it against the published checksum. */
  function install() {
    installing ??= (async () => {
      log(`yt-dlp wird geladen: ${RELEASES}${ASSET}`)
      const sums = await fetch(`${RELEASES}SHA2-256SUMS`, { redirect: 'follow' })
      if (!sums.ok) throw new Error(`Prüfsummen nicht erreichbar (${sums.status})`)
      const line = (await sums.text()).split('\n').find((entry) => entry.trim().endsWith(` ${ASSET}`))
      const expected = line?.trim().split(/\s+/)[0]?.toLowerCase()
      if (!expected) throw new Error(`Keine Prüfsumme für ${ASSET}`)

      const response = await fetch(`${RELEASES}${ASSET}`, { redirect: 'follow' })
      if (!response.ok) throw new Error(`yt-dlp nicht erreichbar (${response.status})`)
      const bytes = Buffer.from(await response.arrayBuffer())
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== expected) throw new Error('Die geladene Datei passt nicht zur veröffentlichten Prüfsumme.')

      fs.mkdirSync(dataDir, { recursive: true })
      const partial = `${ownCopy}.partial`
      fs.writeFileSync(partial, bytes, { mode: 0o755 })
      fs.renameSync(partial, ownCopy)
      found = null
      updateChecked = true
      log(`yt-dlp geladen (${(bytes.length / 1e6).toFixed(1)} MB, SHA-256 geprüft)`)
    })().finally(() => {
      installing = null
    })
    return installing
  }

  /** yt-dlp, found or — if the person agrees — fetched. Null when not. */
  async function ytdlp() {
    const here = await locate()
    if (here) return here
    if (!(await ask.install())) return null
    try {
      await install()
    } catch (failure) {
      log(`yt-dlp laden fehlgeschlagen: ${failure?.message ?? failure}`)
      return null
    }
    return locate()
  }

  /* -- jobs ----------------------------------------------------------------- */

  const jobs = new Map()
  const remember = (job) => {
    const id = randomUUID()
    jobs.set(id, { ...job, expires: Date.now() + JOB_TTL_MS })
    return `http://localhost:${port}/tunnel?id=${id}`
  }
  setInterval(() => {
    const now = Date.now()
    for (const [id, job] of jobs) if (job.expires < now) jobs.delete(id)
  }, 60_000).unref()

  /* -- the API -------------------------------------------------------------- */

  async function probe(bin, target) {
    return run(bin, ['-J', '--no-warnings', '--no-playlist', ...cookieArgs(), '--', target])
  }

  async function resolve(body) {
    const target = String(body.url ?? '').trim()
    if (!/^https?:\/\//i.test(target)) return { status: 'error', error: { code: 'error.api.link.invalid' } }

    const tool = await ytdlp()
    if (!tool) return { status: 'error', error: { code: 'error.api.ytdlp.missing' } }

    let result = await probe(tool.bin, target)
    if (result.code !== 0 && errorCode(result.stderr) === 'error.api.ytdlp.signin') {
      // A sign-in that was chosen and still does not do: ask again next time.
      if (readSettings().cookies) {
        writeSettings({ cookies: null })
      } else {
        const browser = await ask.signIn()
        if (browser) {
          writeSettings({ cookies: browser })
          result = await probe(tool.bin, target)
        }
      }
    }
    if (result.code !== 0) {
      log(`yt-dlp: ${result.stderr.trim().split('\n').pop()?.slice(0, 200) ?? result.code}`)
      return { status: 'error', error: { code: errorCode(result.stderr) } }
    }

    let info
    try {
      info = JSON.parse(result.stdout)
    } catch {
      return { status: 'error', error: { code: 'error.api.fetch.empty' } }
    }
    const formats = Array.isArray(info.formats) ? info.formats : info.url ? [info] : []
    if (formats.length === 0) return { status: 'error', error: { code: 'error.api.fetch.empty' } }

    const quality = String(body.videoQuality ?? 'max')
    const maxHeight = quality === 'max' ? 0 : Number(quality) || 0
    const stem = String(info.title ?? 'download').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
    const mode = String(body.downloadMode ?? 'auto')
    const job = (format, mime) => remember({ bin: tool.bin, url: target, format, mime })

    if (mode === 'audio') {
      const audio = pickAudio(formats)
      if (!audio) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
      const wanted = String(body.audioFormat ?? 'best')
      return {
        status: 'local-processing',
        type: 'audio',
        tunnel: [job(audio, 'audio/mp4')],
        output: { filename: `${stem}.${wanted === 'best' ? 'm4a' : wanted}`, type: 'audio/mp4' },
        audio: { format: wanted, copy: wanted === 'best' },
        isHLS: isHls(audio),
      }
    }

    if (mode === 'mute') {
      const video = pickVideo(formats, maxHeight)
      if (!video) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
      return {
        status: 'local-processing',
        type: 'mute',
        tunnel: [job(video, 'video/mp4')],
        output: { filename: `${stem} (${heightOf(video)}p, ohne Ton).mp4`, type: 'video/mp4' },
        isHLS: isHls(video),
      }
    }

    const progressive = pickProgressive(formats, maxHeight)
    const video = pickVideo(formats, maxHeight)
    const audio = pickAudio(formats)
    if (progressive && (!video || !audio || heightOf(progressive) >= heightOf(video))) {
      return {
        status: 'tunnel',
        url: job(progressive, mimeOf(progressive)),
        filename: `${stem}${heightOf(progressive) ? ` (${heightOf(progressive)}p)` : ''}.${progressive.ext ?? 'mp4'}`,
      }
    }
    if (!video || !audio) {
      // One file with nothing to tell apart — an audio track, a plain video.
      const only = formats.find((f) => isPlain(f)) ?? null
      if (!only) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
      return { status: 'tunnel', url: job(only, mimeOf(only)), filename: `${stem}.${only.ext ?? 'bin'}` }
    }
    return {
      status: 'local-processing',
      type: 'merge',
      tunnel: [job(video, 'video/mp4'), job(audio, 'audio/mp4')],
      output: { filename: `${stem} (${heightOf(video)}p).mp4`, type: 'video/mp4' },
      isHLS: isHls(video),
    }
  }

  /**
   * One format, fetched by yt-dlp and passed straight on. The headers wait
   * for the first byte: once "200" is out, a failure can only show as a cut
   * connection, and the page would see an empty file instead of a reason.
   */
  function tunnel(job, res, cors) {
    const size = Number(job.format.filesize) || 0
    const headers = { 'content-type': job.mime, 'cache-control': 'no-store', ...cors, 'access-control-expose-headers': 'Estimated-Content-Length' }
    if (size > 0) headers['content-length'] = String(size)
    else if (job.format.filesize_approx) headers['estimated-content-length'] = String(job.format.filesize_approx)

    const child = spawn(
      job.bin,
      ['-f', String(job.format.format_id), '-o', '-', '--no-part', '--no-warnings', '--quiet', '--no-playlist', ...cookieArgs(), '--', job.url],
      { windowsHide: true },
    )
    let sent = 0
    let started = false
    let complaints = ''
    child.stdout.on('data', (chunk) => {
      if (!started) {
        started = true
        res.writeHead(200, headers)
      }
      sent += chunk.length
      if (!res.write(chunk)) child.stdout.pause()
    })
    res.on('drain', () => child.stdout.resume())
    child.stderr.on('data', (chunk) => (complaints += chunk))
    child.on('close', () => {
      if (!started) return send(res, 502, { status: 'error', error: { code: errorCode(complaints) } }, cors)
      if (size > 0 && sent !== size) res.destroy()
      else res.end()
    })
    child.on('error', () => {
      if (!started) return send(res, 502, { status: 'error', error: { code: 'error.api.ytdlp.missing' } }, cors)
      res.destroy()
    })
    res.on('close', () => child.kill())
  }

  function send(res, status, body, cors) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer(async (req, res) => {
    // Only Sondra. A request without an Origin is not from a web page.
    const from = req.headers.origin
    if (from && from !== origin && !SITE_ORIGINS.includes(from)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Dieser Dienst gehört zu Sondra und antwortet nur Sondra.')
    }
    const cors = { 'access-control-allow-origin': from || origin, vary: 'Origin' }
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, accept',
        'access-control-max-age': '86400',
        // A page from the internet asking a service on this machine: Chrome
        // wants the service to say it expects that.
        ...(req.headers['access-control-request-private-network'] ? { 'access-control-allow-private-network': 'true' } : {}),
      })
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const here = await locate()
      return send(res, 200, {
        cobalt: {
          version: here ? `yt-dlp ${here.version} · in Sondra` : 'yt-dlp · in Sondra, wird beim ersten Laden geholt',
          url: `http://localhost:${port}/`,
          services: SERVICES,
        },
      }, cors)
    }

    if (req.method === 'GET' && url.pathname === '/tunnel') {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      if (!job || job.expires < Date.now()) return send(res, 404, { status: 'error', error: { code: 'error.api.tunnel.missing' } }, cors)
      return tunnel(job, res, cors)
    }

    if (req.method === 'POST' && url.pathname === '/') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return send(res, 400, { status: 'error', error: { code: 'error.api.invalid_body' } }, cors)
      }
      try {
        const answer = await resolve(body)
        return send(res, answer.status === 'error' ? 400 : 200, answer, cors)
      } catch (failure) {
        log(`Herunterladen: ${failure?.stack ?? failure}`)
        return send(res, 500, { status: 'error', error: { code: 'error.api.fetch.fail' } }, cors)
      }
    }

    send(res, 404, { status: 'error', error: { code: 'error.api.not_found' } }, cors)
  })

  return new Promise((resolveStart) => {
    server.once('error', (failure) => {
      log(`Dienst zum Herunterladen nicht gestartet: ${failure?.code ?? failure?.message ?? failure}`)
      resolveStart(null)
    })
    server.listen(port, '127.0.0.1', () => resolveStart({ url: `http://localhost:${port}/`, close: () => server.close() }))
  })
}
