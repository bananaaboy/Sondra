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
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { extractDirectMedia, isAniworldUrl, isBilibiliUrl, isHosterUrl, isSpotifyUrl, boundedFetch, DEFAULT_USER_AGENT } from '../api/extractors.js'

export function getNetworkAdapters() {
  const nets = os.networkInterfaces()
  const list = []
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        list.push({
          name,
          address: a.address,
        })
      }
    }
  }
  return list
}

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
  'aniworld', 'serienstream', 'filemoon', 'voe', 'vidmoly', 'streamtape', 'vidoza', 'doodstream',
  'spotify', 'applepodcasts', 'threads', 'snapchat', 'patreon', 'vk', 'rumble', 'odysee',
  'archive', 'kick', 'substack', 'peertube', 'orf', '3sat', 'ok', 'rutube',
]

/* -- choosing formats (the same rules as the bridge) ------------------------ */

const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' }
/** yt-dlp's own last error line, for the page to show when no code fits. */
const detailOf = (stderr) => {
  const lines = stderr.trim().split('\n')
  const errorLine = lines.filter((line) => /error/i.test(line) && !/Traceback|File "|DownloadError:/i.test(line)).pop()
    ?? lines.filter((line) => /error/i.test(line)).pop()
    ?? lines.pop()
    ?? ''
  return errorLine
    .replace(/^ERROR:\s*(?:\[[^\]]+\]\s*)?/, '')
    .replace(/\s*(See|Also see)\s+https?:\/\/\S+.*$/i, '')
    .slice(0, 240)
}

const failure = (stderr) => ({ status: 'error', error: { code: errorCode(stderr), detail: detailOf(stderr) } })

const mimeOf = (format) => MIME[String(format.ext ?? '').toLowerCase()] ?? 'application/octet-stream'

const heightOf = (format) => format.height ?? 0
const isVideoOnly = (f) => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
const isAudioOnly = (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
const isHls = (f) => f.protocol === 'm3u8' || f.protocol === 'm3u8_native'
const isProgressive = (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && !isHls(f)
const isPlain = (f) => !f.protocol || f.protocol.startsWith('http') || isHls(f)

// Higher resolution first, with H.264/MP4 preferred over VP9/AV1 at equal height.
function scoreVideo(f) {
  const codec = String(f.vcodec ?? '')
  const rank = codec.startsWith('avc') || codec.startsWith('h264') ? 3 : codec.startsWith('av01') ? 1 : 2
  return heightOf(f) * 1e6 + rank * 1e4 + (f.tbr ?? 0)
}
function scoreAudio(f) {
  const codec = String(f.acodec ?? '')
  return (codec.startsWith('mp4a') || codec.startsWith('aac') ? 2 : 1) * 1e6 + (f.abr ?? f.tbr ?? 0)
}
function pickVideo(formats, maxHeight) {
  const fits = formats.filter((f) => isVideoOnly(f) && isPlain(f) && (!maxHeight || heightOf(f) <= maxHeight))
  const pool = fits.length > 0 ? fits : formats.filter((f) => isVideoOnly(f) && isPlain(f))
  if (pool.length > 0) return pool.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
  // Progressive stream fallback for TikTok, Instagram, Twitter/X, Threads, Loom
  const progFits = formats.filter((f) => isProgressive(f) && isPlain(f) && (!maxHeight || heightOf(f) <= maxHeight))
  const progPool = progFits.length > 0 ? progFits : formats.filter((f) => isProgressive(f) && isPlain(f))
  return progPool.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] ?? null
}
function pickAudio(formats) {
  const audioOnly = formats.filter((f) => isAudioOnly(f) && isPlain(f)).sort((a, b) => scoreAudio(b) - scoreAudio(a))
  if (audioOnly.length > 0) return audioOnly[0]
  // Progressive stream fallback for audio extraction from TikTok, Twitter/X, Instagram, Threads, Loom
  const withAudio = formats.filter((f) => f.acodec && f.acodec !== 'none' && isPlain(f))
  return withAudio.sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0] ?? null
}
function pickProgressive(formats, maxHeight) {
  const pool = formats.filter((f) => isProgressive(f) && isPlain(f) && (!maxHeight || heightOf(f) <= maxHeight))
  return pool.sort((a, b) => heightOf(b) - heightOf(a) || (b.tbr ?? 0) - (a.tbr ?? 0))[0] ?? null
}

/** yt-dlp's plain-text complaints, as the codes the page can explain. */
function errorCode(stderr) {
  const text = stderr.toLowerCase()
  // The browser sign-in could not be read: Chrome and Edge lock their cookie
  // store while open and encrypt it against other programs.
  if (text.includes('cookie') && /could not copy|failed to decrypt|dpapi|could not find|permission denied|unable to open|locked|no such file/.test(text)) {
    return 'error.api.ytdlp.cookies'
  }
  // The site changed faster than this yt-dlp: a newer one usually knows.
  if (/nsig extraction failed|signature extraction failed|please update|latest version|unable to extract (initial )?player|requested format is not available/.test(text)) {
    return 'error.api.ytdlp.outdated'
  }
  if (/429|too many requests|rate[- ]?limit|temporarily blocked|quota exceeded/i.test(text)) {
    return 'error.api.rate_exceeded'
  }
  if (/confirm your age|age-restricted|age gate|requires age verification/i.test(text)) {
    return 'error.api.content.video.age'
  }
  if (/not available in your country|geo[-_ ]?(?:block|restrict)|restricted in your (?:country|region)|not available in your region|georestricted/i.test(text)) {
    return 'error.api.content.video.region'
  }
  // Before the sign-in check: yt-dlp says "Private video. Sign in if you have
  // been granted access", and read as a sign-in problem every private video
  // asked which browser to take the login from — for a video no login opens.
  if (text.includes('private video') || text.includes('members-only')) return 'error.api.content.video.private'
  if (/not a bot|sign in to confirm|confirm that you are not a bot|login required|sign in if you have been granted access/i.test(text)) {
    return 'error.api.ytdlp.signin'
  }
  if (text.includes('unsupported url') || text.includes('is not a valid url')) return 'error.api.link.unsupported'
  if (text.includes('video unavailable') || text.includes('has been removed') || text.includes('this video has been deleted')) return 'error.api.content.video.unavailable'
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
 *
 * `fetchesTool: false` is the Microsoft Store build: an app from the Store
 * may not download and run program code it did not ship (policy 10.2.2), so
 * there yt-dlp is only used when it is already on the machine — WinGet,
 * PATH — and a missing one is its own error, with its own way to fix it.
 */
export async function startDownloader({ port = 9000, dataDir, origin, log = () => {}, ask, fetchesTool = true }) {
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
  const getBindAddress = (explicitAddr = null) => {
    const chosen = explicitAddr || readSettings().bindAddress
    if (!chosen || chosen === 'default') return null
    const isTest = Boolean(process.env.SONDRA_TEST_STUB)
    const active = getNetworkAdapters().some((a) => a.address === chosen)
    if (!active && !isTest) {
      log(`Netzwerkadapter ${chosen} ist nicht mehr aktiv; weiche auf Standard aus.`)
      return null
    }
    return String(chosen)
  }
  const sourceArgs = (explicitAddr = null) => {
    const chosen = getBindAddress(explicitAddr)
    return chosen ? ['--source-address', chosen, '--force-ipv4'] : []
  }
  const commonYtdlpArgs = (explicitAddr = null) => [
    ...sourceArgs(explicitAddr),
    '--no-check-certificates',
    '--user-agent', DEFAULT_USER_AGENT,
    '--socket-timeout', '20',
    '--retries', '3',
    '--fragment-retries', '3',
  ]

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
    if (!fetchesTool || updateChecked || !found || found.bin !== ownCopy) return
    updateChecked = true
    try {
      if (Date.now() - fs.statSync(ownCopy).mtimeMs < UPDATE_AFTER_MS) return
    } catch {
      return
    }
    void update()
  }

  let updating = null
  let updatedThisSession = false

  /**
   * Brings the own copy up to date; true when there is now a newer one to
   * try. Once per session — a site that still fails after that is not a
   * question of the version.
   */
  function update() {
    if (!fetchesTool || updatedThisSession || !found || found.bin !== ownCopy) return Promise.resolve(false)
    updating ??= (async () => {
      const before = found?.version
      const result = await run(ownCopy, ['-U'], { timeoutMs: 180_000 })
      updatedThisSession = true
      log(`yt-dlp aktualisieren: ${result.code === 0 ? 'fertig' : `Code ${result.code}`}`)
      if (result.code !== 0) return false
      try {
        const now = new Date()
        fs.utimesSync(ownCopy, now, now)
      } catch {
        /* checked again next week */
      }
      found = null
      const after = await locate()
      return Boolean(after && after.version !== before)
    })().finally(() => {
      updating = null
    })
    return updating
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
    if (!fetchesTool) return null
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

  function rewriteTunnelPlaylist(text, base, { referer = null, bindAddress = null } = {}) {
    const claim = (target, nested) => {
      let absolute
      try {
        absolute = new URL(target, base)
      } catch {
        return null
      }
      if (!/^https?:$/i.test(absolute.protocol)) return null
      return remember({
        bin: null,
        url: absolute.href,
        referer,
        filename: nested ? 'playlist.m3u8' : 'segment.ts',
        format: { format_id: 'best' },
        mime: nested ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        directFetch: true,
        isHls: Boolean(nested),
        bindAddress,
      })
    }
    let nextIsPlaylist = false
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed) return line
        if (trimmed.startsWith('#')) {
          if (/^#EXT-X-STREAM-INF/i.test(trimmed)) nextIsPlaylist = true
          if (/^#EXT-X-(?:SESSION-)?KEY/i.test(trimmed)) return line
          const nested = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)/i.test(trimmed)
          return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
            const proxied = claim(uri, nested)
            return proxied ? `URI="${proxied}"` : whole
          })
        }
        const nested = nextIsPlaylist || /\.m3u8?(?:$|\?)/i.test(trimmed)
        nextIsPlaylist = false
        return claim(trimmed, nested) ?? line
      })
      .join('\n')
  }

  /* -- the API -------------------------------------------------------------- */

  async function probe(bin, target, referer = null, explicitBindAddr = null) {
    const extra = referer ? ['--referer', referer] : []
    return run(bin, ['-J', '--no-warnings', '--no-playlist', ...commonYtdlpArgs(explicitBindAddr), ...extra, ...cookieArgs(), '--', target])
  }

  function directMediaResponse(directMedia, bindAddr) {
    const stem = String(directMedia.title ?? 'download').replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
    if (directMedia.previewUrl && !directMedia.url) {
      return {
        status: 'tunnel',
        url: remember({
          bin: null,
          url: directMedia.previewUrl,
          referer: 'https://open.spotify.com/',
          filename: `${stem} (Preview).mp3`,
          format: { format_id: 'preview', ext: 'mp3' },
          mime: 'audio/mpeg',
          directFetch: true,
          bindAddress: bindAddr,
        }),
        filename: `${stem} (Preview).mp3`,
      }
    }
    if (directMedia.isHls) {
      return {
        status: 'local-processing',
        type: 'remux',
        tunnel: [
          remember({
            bin: null,
            url: directMedia.url,
            referer: directMedia.referer,
            filename: `${stem}.mp4`,
            format: { format_id: 'best' },
            mime: 'application/vnd.apple.mpegurl',
            directFetch: true,
            isHls: true,
            bindAddress: bindAddr,
          }),
        ],
        output: { filename: `${stem}.mp4`, type: 'video/mp4' },
        isHLS: true,
      }
    }
    return {
      status: 'tunnel',
      url: remember({
        bin: null,
        url: directMedia.url,
        referer: directMedia.referer,
        filename: `${stem}.mp4`,
        format: { format_id: 'best' },
        mime: 'video/mp4',
        directFetch: true,
        bindAddress: bindAddr,
      }),
      filename: `${stem}.mp4`,
    }
  }

  async function resolve(body) {
    const target = String(body.url ?? '').trim()
    if (!/^https?:\/\//i.test(target)) return { status: 'error', error: { code: 'error.api.link.invalid' } }

    const bindAddr = getBindAddress(body.bindAddress)
    let directMedia = null
    if (isAniworldUrl(target) || isHosterUrl(target) || isBilibiliUrl(target) || isSpotifyUrl(target)) {
      try {
        directMedia = await extractDirectMedia(target, {
          localAddress: bindAddr,
          language: body.language || body.preferredLanguage,
        })
        if (directMedia && directMedia.isPlaylist) {
          return {
            status: 'playlist',
            title: directMedia.title,
            author: directMedia.seriesTitle,
            items: directMedia.items,
          }
        }
      } catch (failure) {
        log(`Direktextraktion: ${failure?.message ?? failure}`)
      }
    }

    // When direct extraction resolved a playable stream (AniWorld, SerienStream, VOE, FileMoon, etc.),
    // serve it directly through the local tunnel without wasting 10–25s on a redundant yt-dlp probe.
    if (directMedia && !directMedia.isSpotifyTrack && directMedia.url) {
      return directMediaResponse(directMedia, bindAddr)
    }

    const tool = await ytdlp()
    const isPlaylistTarget = !isSpotifyUrl(target) && /[?&]list=|\/playlist\b|\/sets\/|\/album\//i.test(target)
    if (tool && isPlaylistTarget) {
      const plResult = await run(tool.bin, ['--flat-playlist', '-J', '--no-warnings', ...commonYtdlpArgs(bindAddr), ...cookieArgs(), '--', target])
      if (plResult.code === 0 && plResult.stdout) {
        try {
          const plInfo = JSON.parse(plResult.stdout)
          if (Array.isArray(plInfo.entries) && plInfo.entries.length > 0) {
            return {
              status: 'playlist',
              title: plInfo.title || 'Playlist',
              author: plInfo.uploader || plInfo.channel || 'YouTube',
              items: plInfo.entries
                .map((e) => ({
                  title: e.title || 'Video',
                  url: e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null),
                }))
                .filter((e) => e.url),
            }
          }
        } catch {
          // fallback to probe
        }
      }
    }
    if (!tool && !directMedia) {
      return { status: 'error', error: { code: fetchesTool ? 'error.api.ytdlp.missing' : 'error.api.ytdlp.missing.store' } }
    }

    const queryUrl = directMedia?.isSpotifyTrack ? directMedia.searchQuery : (directMedia ? directMedia.url : target)
    const referer = directMedia?.referer ?? null

    let result = tool ? await probe(tool.bin, queryUrl, referer, bindAddr) : { code: -1, stdout: '', stderr: '' }

    // A sign-in that cannot be read is forgotten, and the video tried without.
    if (tool && result.code !== 0 && errorCode(result.stderr) === 'error.api.ytdlp.cookies') {
      log(`Anmeldung aus ${readSettings().cookies} nicht lesbar: ${detailOf(result.stderr)}`)
      writeSettings({ cookies: null })
      result = await probe(tool.bin, queryUrl, referer, bindAddr)
    }
    // Too old for the site: update once, then try again.
    if (tool && result.code !== 0 && errorCode(result.stderr) === 'error.api.ytdlp.outdated' && (await update())) {
      result = await probe(tool.bin, queryUrl, referer, bindAddr)
    }
    if (tool && result.code !== 0 && errorCode(result.stderr) === 'error.api.ytdlp.signin') {
      // A sign-in that was chosen and still does not do: ask again next time.
      if (readSettings().cookies) {
        writeSettings({ cookies: null })
      } else {
        const browser = await ask.signIn()
        if (browser) {
          writeSettings({ cookies: browser })
          result = await probe(tool.bin, queryUrl, referer, bindAddr)
        }
      }
    }

    // If yt-dlp probe failed or is not available, but direct extraction succeeded:
    if (result.code !== 0 && directMedia) {
      return directMediaResponse(directMedia, bindAddr)
    }

    if (result.code !== 0) {
      log(`yt-dlp: ${detailOf(result.stderr) || result.code}`)
      return failure(result.stderr)
    }

    let info
    try {
      info = JSON.parse(result.stdout)
      if (Array.isArray(info.entries) && info.entries.length > 0) {
        info = info.entries[0]
      }
    } catch {
      return { status: 'error', error: { code: 'error.api.fetch.empty' } }
    }
    const formats = Array.isArray(info.formats) ? info.formats : info.url ? [info] : []
    if (formats.length === 0) return { status: 'error', error: { code: 'error.api.fetch.empty' } }

    const quality = String(body.videoQuality ?? 'max')
    const maxHeight = quality === 'max' ? 0 : Number(quality) || 0
    const titleCandidate = (directMedia?.title && directMedia.title !== 'master') ? directMedia.title : (info.title ?? 'download')
    const stem = String(titleCandidate).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
    const mode = directMedia?.isSpotifyTrack && (!body.downloadMode || body.downloadMode === 'auto') ? 'audio' : String(body.downloadMode ?? 'auto')
    const targetSourceUrl = info.webpage_url || (info.id ? `https://www.youtube.com/watch?v=${info.id}` : queryUrl)
    const job = (format, mime, customName = null) =>
      remember({
        bin: isHls(format) && format.url ? null : tool.bin,
        url: isHls(format) && format.url ? format.url : targetSourceUrl,
        referer: format.http_headers?.Referer || referer,
        format,
        mime: isHls(format) ? 'application/vnd.apple.mpegurl' : mime,
        filename: customName || `${stem}.${format.ext ?? 'mp4'}`,
        directFetch: Boolean(isHls(format) && format.url),
        isHls: isHls(format),
        bindAddress: bindAddr,
      })

    if (mode === 'audio') {
      const audio = pickAudio(formats)
      if (!audio) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
      const wanted = String(body.audioFormat ?? 'best')
      const targetMime = mimeOf(audio)
      return {
        status: 'local-processing',
        type: 'audio',
        tunnel: [job(audio, targetMime, `${stem}.${audio.ext ?? 'm4a'}`)],
        output: { filename: `${stem}.${wanted === 'best' ? (audio.ext ?? 'm4a') : wanted}`, type: 'audio/mp4' },
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
        tunnel: [job(video, 'video/mp4', `${stem} (${heightOf(video)}p, ohne Ton).mp4`)],
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
      // One file with nothing to tell apart — an audio track, a plain video, or an HLS stream.
      const only = formats.find((f) => isPlain(f)) ?? null
      if (!only) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
      if (isHls(only)) {
        return {
          status: 'local-processing',
          type: 'remux',
          tunnel: [job(only, 'application/vnd.apple.mpegurl', `${stem}.mp4`)],
          output: { filename: `${stem}.mp4`, type: 'video/mp4' },
          isHLS: true,
        }
      }
      return { status: 'tunnel', url: job(only, mimeOf(only)), filename: `${stem}.${only.ext ?? 'bin'}` }
    }
    return {
      status: 'local-processing',
      type: 'merge',
      tunnel: [job(video, 'video/mp4', `${stem} (${heightOf(video)}p, Video).mp4`), job(audio, 'audio/mp4', `${stem} (${heightOf(video)}p, Audio).m4a`)],
      output: { filename: `${stem} (${heightOf(video)}p).mp4`, type: 'video/mp4' },
      isHLS: isHls(video),
    }
  }

  /**
   * One format, fetched by yt-dlp and passed straight on. The headers wait
   * for the first byte: once "200" is out, a failure can only show as a cut
   * connection, and the page would see an empty file instead of a reason.
   */
  /**
   * A format picked by what it is rather than by its number — for when the
   * site hands out different numbers on the second request than on the first.
   */
  function looseSelector(format) {
    const h = heightOf(format)
    if (isAudioOnly(format)) return 'ba[ext=m4a]/ba'
    if (isVideoOnly(format)) return h ? `bv*[height=${h}][vcodec^=avc1]/bv*[height<=${h}]/bv*` : 'bv*'
    return h ? `b[height<=${h}]/b` : 'b'
  }

  function tunnel(job, req, res, cors) {
    const filename = job.filename || 'download.mp4'
    const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, escape)
    const disposition = `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodedFilename}`

    if (!job.bin || job.directFetch) {
      let cancelled = false
      res.on('close', () => { cancelled = true })

      const reqHeaders = {
        ...(job.referer ? { Referer: job.referer } : {}),
        'User-Agent': DEFAULT_USER_AGENT,
      }
      if (req?.headers?.range && !job.isHls) {
        reqHeaders.Range = req.headers.range
      }

      const bindAddr = job.bindAddress ?? getBindAddress()
      boundedFetch(job.url, {
        headers: reqHeaders,
        localAddress: bindAddr,
      }).then(async (up) => {
        if (!up.ok && up.status !== 206) return send(res, 502, { status: 'error', error: { code: 'error.api.fetch.fail' } }, cors)
        const contentType = up.headers.get('content-type') || job.mime || 'application/octet-stream'
        const maybePlaylist =
          Boolean(job.isHls) ||
          /mpegurl/i.test(contentType) ||
          (/\.m3u8(?:$|\?)/i.test(job.url) && !/^(?:video|audio)\/(?!.*mpegurl)/i.test(contentType))

        if (maybePlaylist) {
          const buffer = Buffer.from(await up.arrayBuffer())
          const head = buffer.subarray(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart()
          if (head.startsWith('#EXTM3U')) {
            const rewritten = rewriteTunnelPlaylist(buffer.toString('utf8'), up.url || job.url, {
              referer: job.referer,
              bindAddress: bindAddr,
            })
            const body = Buffer.from(rewritten, 'utf8')
            res.writeHead(200, {
              'content-type': 'application/vnd.apple.mpegurl',
              'content-length': String(body.byteLength),
              'cache-control': 'no-store',
              ...cors,
            })
            res.end(body)
            return
          }
          res.writeHead(up.status === 206 ? 206 : 200, {
            'content-type': contentType,
            'content-length': String(buffer.byteLength),
            'cache-control': 'no-store',
            'content-disposition': disposition,
            ...cors,
          })
          res.end(buffer)
          return
        }

        const headers = {
          'content-type': contentType,
          'cache-control': 'no-store',
          'content-disposition': disposition,
          'accept-ranges': 'bytes',
          ...cors,
        }
        const cl = up.headers.get('content-length')
        if (cl) headers['content-length'] = cl
        const cr = up.headers.get('content-range')
        if (cr) headers['content-range'] = cr

        res.writeHead(up.status === 206 ? 206 : 200, headers)
        const reader = up.body?.getReader()
        if (!reader) return res.end()
        for (;;) {
          if (cancelled) { reader.cancel(); break }
          const { done, value } = await reader.read()
          if (done) { res.end(); break }
          if (!res.write(value)) {
            await new Promise((r) => res.once('drain', r))
          }
        }
      }).catch(() => {
        if (!res.headersSent) send(res, 502, { status: 'error', error: { code: 'error.api.fetch.fail' } }, cors)
        else res.destroy()
      })
      return
    }

    const size = Number(job.format?.filesize) || 0
    let cancelled = false
    let child = null
    res.on('close', () => {
      cancelled = true
      child?.kill()
    })

    const attempt = (selector, exact) => {
      const headers = {
        'content-type': job.mime,
        'cache-control': 'no-store',
        'content-disposition': disposition,
        ...cors,
        'access-control-expose-headers': 'Estimated-Content-Length, Content-Disposition',
      }
      // The exact size only for the exact format — a wrong length breaks the
      // transfer in the browser.
      if (exact && size > 0) headers['content-length'] = String(size)
      else if (job.format?.filesize_approx) headers['estimated-content-length'] = String(job.format.filesize_approx)

      const refererArgs = job.referer ? ['--referer', job.referer] : []
      const formatArgs = selector ? ['-f', selector] : []

      child = spawn(
        job.bin,
        [
          ...formatArgs,
          '-o', '-',
          '--no-part',
          '--no-warnings',
          '--quiet',
          '--no-playlist',
          ...commonYtdlpArgs(job.bindAddress),
          ...refererArgs,
          ...cookieArgs(),
          '--',
          job.url,
        ],
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
      res.on('drain', () => child?.stdout.resume())
      child.stderr.on('data', (chunk) => (complaints += chunk))
      child.on('close', (code) => {
        if (cancelled) return
        if (!started) {
          log(`yt-dlp (Übertragung, ${selector}): ${detailOf(complaints) || 'keine Daten'}`)
          if (exact) return attempt(looseSelector(job.format), false)
          return send(res, 502, failure(complaints), cors)
        }
        if (exact && size > 0 && sent !== size && code !== 0) res.destroy()
        else res.end()
      })
      child.on('error', () => {
        if (!started) return send(res, 502, { status: 'error', error: { code: 'error.api.ytdlp.missing' } }, cors)
        res.destroy()
      })
    }

    attempt(String(job.format?.format_id ?? 'best'), true)
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
    const cors = { 'access-control-allow-origin': from || origin || '*', vary: 'Origin' }
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

    if (req.method === 'GET' && url.pathname === '/adapters') {
      const adapters = getNetworkAdapters()
      const current = readSettings().bindAddress || 'default'
      return send(res, 200, {
        adapters: [
          { id: 'default', name: 'Automatisch (Windows-Standard)', address: null },
          ...adapters.map((a) => ({
            id: a.address,
            name: `${a.name} (${a.address})`,
            address: a.address,
          })),
        ],
        selected: current,
      }, cors)
    }

    if (req.method === 'POST' && url.pathname === '/adapters') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {}
      const chosen = body.bindAddress || 'default'
      writeSettings({ bindAddress: chosen })
      log(`Netzwerkadapter gesetzt: ${chosen}`)
      return send(res, 200, { ok: true, selected: chosen }, cors)
    }

    if (req.method === 'GET' && url.pathname === '/tunnel') {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      if (!job || job.expires < Date.now()) return send(res, 404, { status: 'error', error: { code: 'error.api.tunnel.missing' } }, cors)
      return tunnel(job, req, res, cors)
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
