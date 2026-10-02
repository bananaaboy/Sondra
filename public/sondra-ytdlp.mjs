/**
 * Sondra über yt-dlp, mit einem Befehl.
 *
 * yt-dlp ist ein Befehl, kein Dienst: es hat keine Schnittstelle, die eine
 * Webseite ansprechen könnte, und eine Webseite darf auch kein Programm auf
 * Ihrem Rechner starten. Dieses Skript ist das fehlende Stück dazwischen. Es
 * spricht nach außen genau das Protokoll, das Sondra ohnehin schon kann, und
 * ruft nach innen yt-dlp auf.
 *
 * Zusammengefügt wird nichts hier: Bild- und Tonspur gehen getrennt an Sondra,
 * und dort setzt das eingebaute FFmpeg sie zusammen. Deshalb braucht dieser Weg
 * kein ffmpeg auf Ihrem Rechner — nur die eine yt-dlp-Datei.
 *
 * Nichts wird gespeichert, nichts protokolliert, und beide Ports hören nur auf
 * der Loopback-Schnittstelle.
 *
 *   node sondra-ytdlp.mjs https://ihre-seite.example
 */

import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createDecipheriv } from 'node:crypto'

const argv = process.argv.slice(2)
const SITE = (argv.find((value) => value.startsWith('http')) ?? '').replace(/\/$/, '')
const SERVICE_PORT = Number(process.env.SONDRA_SERVICE_PORT ?? 9000)
const PAGE_PORT = Number(process.env.SONDRA_PAGE_PORT ?? 8787)

/**
 * Welcher Browser die Anmeldung beisteuert.
 *
 * YouTube verlangt von Anschlüssen, die es nicht mag, eine Anmeldung — die
 * Fehlermeldung lautet „Sign in to confirm you're not a bot". yt-dlp kann die
 * Sitzung aus einem lokal installierten Browser lesen, und weil alles hier auf
 * Ihrem Rechner läuft, verlässt dieses Merkmal ihn auch nicht: es geht an
 * YouTube, und zwar genau dorthin, wo Sie ohnehin angemeldet sind.
 *
 *   node sondra-ytdlp.mjs https://… --cookies firefox
 */
const cookieFlag = argv.indexOf('--cookies')
const COOKIES = cookieFlag >= 0 ? argv[cookieFlag + 1] : process.env.SONDRA_COOKIES || ''
const cookieArgs = COOKIES ? ['--cookies-from-browser', COOKIES] : []

/* -- yt-dlp finden --------------------------------------------------------- */

/**
 * Erst der aktuelle Ordner, dann bekannte WinGet-/System-Pfade, dann der Suchpfad.
 */
function findYtDlp() {
  const local = ['yt-dlp.exe', 'yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos', 'yt-dlp_x86.exe']
    .map((name) => path.resolve(name))
    .find(existsSync)
  if (local) return local

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || ''
    const wingetLocations = [
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
      path.join(localAppData, 'Microsoft', 'WindowsApps', 'yt-dlp.exe'),
    ]
    const found = wingetLocations.find(existsSync)
    if (found) return found
    return 'yt-dlp.exe'
  }
  return 'yt-dlp'
}

const YTDLP = findYtDlp()

/** Führt yt-dlp aus und sammelt die Ausgabe ein. */
function run(args, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(YTDLP, args, { windowsHide: true })
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: String(error.message ?? error), missing: true })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      // ENOENT here means the file is not where we looked — the one case that
      // really is "yt-dlp is missing".
      resolve({ code: -1, stdout: '', stderr: String(error.message ?? error), missing: error.code === 'ENOENT' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/* -- Formatwahl ------------------------------------------------------------ */

const heightOf = (format) => format.height ?? 0
const isVideoOnly = (format) => format.vcodec && format.vcodec !== 'none' && (!format.acodec || format.acodec === 'none')
const isAudioOnly = (format) => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none')
const isProgressive = (format) =>
  format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none'

/**
 * Direkte HTTP(S)-Datei oder HLS-Stream.
 *
 * Viele Embed-Hoster (Filemoon, VoE, Doodstream, Vidmol …) liefern ihre
 * Streams als HLS (protocol = „m3u8" oder „m3u8_native"). Die frühere Prüfung
 * lehnte diese stillschweigend ab. Sondra versteht HLS-Playlisten bereits
 * selbst, daher werden sie hier ebenfalls durchgelassen — aber als solche
 * markiert, damit der Auftragsblock das korrekte Flag setzen kann.
 */
const isPlainFile = (format) =>
  !format.protocol ||
  format.protocol.startsWith('http') ||
  format.protocol === 'm3u8' ||
  format.protocol === 'm3u8_native'

/** Wahr, wenn das Format über HLS geliefert wird (statt als eine einzelne Datei). */
const isHlsFormat = (format) =>
  format.protocol === 'm3u8' || format.protocol === 'm3u8_native'

/**
 * H.264 in MP4 zuerst.
 *
 * Sondra fügt die Teile mit `-c copy` zusammen, kopiert die Spuren also
 * unverändert in einen MP4-Container. VP9 und AV1 passen da nicht hinein, und
 * neu zu kodieren würde aus Sekunden Minuten machen.
 */
function scoreVideo(format) {
  const codec = String(format.vcodec ?? '')
  const container = codec.startsWith('avc') || codec.startsWith('h264') ? 3 : codec.startsWith('av01') ? 1 : 2
  return container * 1e9 + heightOf(format) * 1e4 + (format.tbr ?? 0)
}

function scoreAudio(format) {
  const codec = String(format.acodec ?? '')
  // AAC lässt sich in ein MP4 kopieren, Opus nicht.
  const container = codec.startsWith('mp4a') || codec.startsWith('aac') ? 2 : 1
  return container * 1e6 + (format.abr ?? format.tbr ?? 0)
}

/**
 * Bis 1080p gibt es H.264, darüber nur noch VP9 und AV1.
 *
 * Sondra kopiert die Spuren unverändert in einen MP4-Container. Die beiden
 * neueren Codecs passen da nicht verlustfrei hinein, und neu zu kodieren würde
 * aus Sekunden Minuten machen — deshalb endet dieser Weg bei 1080p, auch wenn
 * mehr angeboten wird.
 */
function pickVideo(formats, maxHeight) {
  const fits = formats.filter((f) => isVideoOnly(f) && isPlainFile(f) && (!maxHeight || heightOf(f) <= maxHeight))
  const pool = fits.length > 0 ? fits : formats.filter((f) => isVideoOnly(f) && isPlainFile(f))
  return pool.sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] ?? null
}

function pickAudio(formats) {
  return formats.filter((f) => isAudioOnly(f) && isPlainFile(f)).sort((a, b) => scoreAudio(b) - scoreAudio(a))[0] ?? null
}

function pickProgressive(formats, maxHeight) {
  const pool = formats.filter((f) => isProgressive(f) && isPlainFile(f) && (!maxHeight || heightOf(f) <= maxHeight))
  return pool.sort((a, b) => heightOf(b) - heightOf(a) || (b.tbr ?? 0) - (a.tbr ?? 0))[0] ?? null
}

/* -- Aufträge -------------------------------------------------------------- */

/**
 * Was zwischen „was gibt es?" und „gib es her" gemerkt werden muss.
 *
 * Nur im Arbeitsspeicher und mit Verfallsdatum: eine Adresse, die eine Stunde
 * später noch etwas herausrückt, ist eine Adresse, die jemand weitergeben kann.
 */
const jobs = new Map()
const JOB_TTL_MS = 30 * 60 * 1000

function remember(job) {
  const id = randomUUID()
  jobs.set(id, { ...job, expires: Date.now() + JOB_TTL_MS })
  return `http://localhost:${SERVICE_PORT}/tunnel?id=${id}`
}

setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) if (job.expires < now) jobs.delete(id)
}, 60_000).unref()

/* -- Fehler ---------------------------------------------------------------- */

/**
 * yt-dlps Klartext in die Codes übersetzen, die Sondra schon erklären kann.
 */
function errorCode(stderr) {
  const text = stderr.toLowerCase()
  if (text.includes('not a bot') || text.includes('sign in to confirm')) return 'error.api.ytdlp.signin'
  // Ein 403 auf den Datenstrom ist derselbe Bot-Check, nur einen Schritt
  // später — und hat dieselbe Abhilfe.
  if (text.includes('403') || text.includes('forbidden')) return 'error.api.ytdlp.signin'
  if (text.includes('unsupported url') || text.includes('is not a valid url')) return 'error.api.link.unsupported'
  if (text.includes('private video') || text.includes('members-only')) return 'error.api.content.video.private'
  if (text.includes('confirm your age') || text.includes('age-restricted')) return 'error.api.content.video.age'
  if (text.includes('not available in your country') || text.includes('geo')) return 'error.api.content.video.region'
  if (text.includes('video unavailable') || text.includes('has been removed')) return 'error.api.content.video.unavailable'
  if (text.includes('no video formats') || text.includes('unable to extract')) {
    return 'error.api.link.unsupported'
  }
  return 'error.api.fetch.fail'
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

/* -- Die API --------------------------------------------------------------- */

const SERVICES = [
  'youtube', 'soundcloud', 'bandcamp', 'vimeo', 'twitch', 'twitter', 'tiktok', 'instagram',
  'facebook', 'reddit', 'dailymotion', 'bilibili', 'ok', 'rutube', 'streamable', 'tumblr',
  'bluesky', 'loom', 'pinterest', 'snapchat', 'mixcloud', 'ard', 'zdf', 'arte', 'srf',
  // Embed-Hoster ohne eigenen yt-dlp-Extraktor — über den generischen Fallback
  'aniworld', 'filemoon', 'voe', 'doodstream', 'vidmol', 'streamwish', 'vidguard', 'upstream',
]

let versionLabel = 'yt-dlp'

/* -- Benutzerdefinierte Extraktoren (VOE, FileMoon, Vidmoly, DoodStream) ---- */

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

const isVoeHost = (host) => /(?:^|\.)(?:voe\.sx|jeremyparticipantanything\.com|jamesbornmain\.com|chaliceguzzlerlandlord\.com)$/i.test(host) || (process.env.SONDRA_VOE_HOSTS ?? '').split(',').map((entry) => entry.trim().toLowerCase()).includes(host)
const isAniWorldHost = (host) => host === 'aniworld.to' || host.endsWith('.aniworld.to') || (process.env.SONDRA_ANIWORLD_HOSTS ?? '').split(',').map((entry) => entry.trim().toLowerCase()).includes(host)

function decodeVoePayload(value) {
  const rot13 = (text) => text.replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0)
    const base = code <= 90 ? 65 : 97
    return String.fromCharCode(((code - base + 13) % 26) + base)
  })
  const withoutMarkers = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'].reduce((text, marker) => text.replaceAll(marker, ''), rot13(value))
  const shifted = Array.from(Buffer.from(withoutMarkers, 'base64').toString('utf8'), (char) =>
    String.fromCharCode(char.charCodeAt(0) - 3),
  ).join('')
  return JSON.parse(Buffer.from([...shifted].reverse().join(''), 'base64').toString('utf8'))
}

async function extractVoe(url) {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS })
    if (!res.ok) return null
    const html = await res.text()
    // VOE rotates markup details; inspect every JSON script, regardless of
    // attribute order or additional attributes, instead of relying on one tag.
    const blocks = [...html.matchAll(/<script\b(?=[^>]*\btype\s*=\s*(['"])application\/json\1)[^>]*>([\s\S]*?)<\/script>/gi)]
    for (const block of blocks) {
      let payload
      try { payload = JSON.parse(block[2].trim()) } catch { continue }
      for (const encoded of Array.isArray(payload) ? payload : []) {
        if (typeof encoded !== 'string') continue
        try {
          const data = decodeVoePayload(encoded)
          const streamUrl = data.source || data.direct_access_url
          if (streamUrl) return { title: data.title || 'VOE Video', url: streamUrl, referer: url }
        } catch { /* another JSON block, not the VOE payload */ }
      }
    }
    return null
  } catch {
    return null
  }
}

async function extractAniWorld(url) {
  try {
    const episode = await fetch(url, { headers: BROWSER_HEADERS })
    if (!episode.ok) return null
    const episodeUrl = episode.url
    const html = await episode.text()
    const redirects = [...html.matchAll(/(?:href|data-link-target)\s*=\s*(['"])(\/redirect\/[^'"]+)\1/gi)]
      .map((match) => ({ href: new URL(match[2], episodeUrl).href, nearby: html.slice(Math.max(0, match.index - 500), match.index + 500) }))
      .sort((a, b) => Number(/\bvoe\b/i.test(b.nearby)) - Number(/\bvoe\b/i.test(a.nearby)))
    for (const redirect of redirects) {
      const target = await fetch(redirect.href, { redirect: 'follow', headers: { ...BROWSER_HEADERS, Referer: episodeUrl } })
      if (!target.ok) continue
      const finalUrl = target.url
      const targetHtml = await target.text()
      const embed = isVoeHost(new URL(finalUrl).hostname)
        ? finalUrl
        : targetHtml.match(/https?:\\?\/\\?\/[^'"\s<]+/i)?.[0]?.replace(/\\\//g, '/')
      if (embed) {
        try {
          if (isVoeHost(new URL(embed).hostname)) return extractVoe(embed)
        } catch { /* keep trying hosters */ }
      }
    }
  } catch { /* ordinary yt-dlp fallback */ }
  return null
}

async function extractFileMoon(url) {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.replace(/\/$/, '').split('/')
    const code = parts[parts.length - 1]
    if (!code || code === 'e' || code === 'd') return null

    const apiUrl = `${parsed.protocol}//${parsed.host}/api/videos/${code}`
    const res = await fetch(apiUrl, {
      headers: {
        Referer: url,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })
    if (!res.ok) return null
    const data = await res.json()
    const playback = data?.playback
    if (!playback?.key_parts || !playback?.iv || !playback?.payload) return null

    const key = Buffer.concat(playback.key_parts.map((p) => Buffer.from(p, 'base64url')))
    const iv = Buffer.from(playback.iv, 'base64url')
    const payload = Buffer.from(playback.payload, 'base64url')

    const tag = payload.subarray(payload.length - 16)
    const ciphertext = payload.subarray(0, payload.length - 16)

    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const parsedPlayback = JSON.parse(decrypted.toString('utf-8'))

    const hls = parsedPlayback.sources?.find((s) => s.mime_type?.includes('mpegurl')) || parsedPlayback.sources?.[0]
    if (!hls?.url) return null

    return {
      title: data.title || 'FileMoon Video',
      url: hls.url,
      referer: url,
    }
  } catch {
    return null
  }
}

async function extractVidmoly(url) {
  try {
    const parsed = new URL(url)
    const embedIdMatch =
      parsed.pathname.match(/\/embed-([a-zA-Z0-9]+)\.html/) || parsed.pathname.match(/\/([a-zA-Z0-9]+)$/)
    const embedId = embedIdMatch ? embedIdMatch[1] : ''

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: url,
      Cookie: embedId ? `cf_turnstile_demo_pass_${embedId}=1` : '',
    }

    const res = await fetch(url, { headers })
    if (!res.ok) return null
    const html = await res.text()

    const match = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)/)
    if (!match) return null
    const streamUrl = new URL(match[1], url).href

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidmoly.*$/i, '').trim() : 'Vidmoly Video'

    return {
      title,
      url: streamUrl,
      referer: url,
    }
  } catch {
    return null
  }
}

async function extractDoodStream(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: url,
      },
    })
    if (!res.ok) return null
    const html = await res.text()

    const passMatch = html.match(/\/pass_md5\/[^'"<>\s]+/)
    if (!passMatch) return null

    const baseOrigin = new URL(url).origin
    const passUrl = `${baseOrigin}${passMatch[0]}`

    const passRes = await fetch(passUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: url,
      },
    })
    if (!passRes.ok) return null
    const baseStream = (await passRes.text()).trim()
    if (!baseStream || baseStream.includes('RELOAD')) return null

    const randomChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let token = ''
    for (let i = 0; i < 10; i++) token += randomChars.charAt(Math.floor(Math.random() * randomChars.length))
    const finalUrl = `${baseStream}${token}?token=${passMatch[0].split('/').pop()}&expiry=${Date.now()}`

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Dood.*$/i, '').trim() : 'DoodStream Video'

    return {
      title,
      url: finalUrl,
      referer: url,
    }
  } catch {
    return null
  }
}

/** Erkennt den Hoster und extrahiert die direkte Stream-Adresse vor dem yt-dlp-Aufruf. */
async function extractDirectStream(rawUrl) {
  let host = ''
  try {
    host = (new URL(rawUrl).hostname || '').toLowerCase()
  } catch {
    return null
  }

  if (isAniWorldHost(host)) {
    const result = await extractAniWorld(rawUrl)
    if (result) return result
  }

  // 1. FileMoon
  if (host.includes('filemoon')) {
    const res = await extractFileMoon(rawUrl)
    if (res) return res
  }

  // 2. Vidmoly
  if (host.includes('vidmoly')) {
    const res = await extractVidmoly(rawUrl)
    if (res) return res
  }

  // 3. DoodStream
  if (host.includes('dood') || host.includes('myvidplay') || host.includes('dsvplay') || host.includes('playmogo')) {
    const res = await extractDoodStream(rawUrl)
    if (res) return res
  }

  // 4. VOE (voe.sx, jamesbornmain.com, chaliceguzzlerlandlord.com usw.)
  if (
    host.includes('voe.') ||
    host.includes('jamesbornmain') ||
    host.includes('chaliceguzzler') ||
    host.includes('tube.sx') ||
    rawUrl.includes('/e/')
  ) {
    const res = await extractVoe(rawUrl)
    if (res) return res
  }

  // Universeller Fallback auf VOE-Erkennung
  return extractVoe(rawUrl)
}

async function resolve(body) {
  const target = String(body.url ?? '').trim()
  if (!target) return { status: 'error', error: { code: 'error.api.link.invalid' } }

  // 1. Spezielle Hoster direkt auflösen (VOE, FileMoon, Vidmoly, DoodStream)
  let directSource = null
  try {
    directSource = await extractDirectStream(target)
  } catch {
    /* Weiter mit normalem yt-dlp */
  }

  const queryUrl = directSource ? directSource.url : target
  const refererArgs = directSource?.referer ? ['--referer', directSource.referer] : []

  let probe = await run(['-J', '--no-warnings', '--no-playlist', ...refererArgs, ...cookieArgs, '--', queryUrl])
  if (probe.missing) return { status: 'error', error: { code: 'error.api.ytdlp.missing' } }

  if (probe.code !== 0) return { status: 'error', error: { code: errorCode(probe.stderr) } }

  let info
  try {
    info = JSON.parse(probe.stdout)
  } catch {
    return { status: 'error', error: { code: 'error.api.fetch.empty' } }
  }

  const formats = Array.isArray(info.formats) ? info.formats : []
  if (formats.length === 0) return { status: 'error', error: { code: 'error.api.fetch.empty' } }

  const quality = String(body.videoQuality ?? 'max')
  const maxHeight = quality === 'max' ? 0 : Number(quality) || 0
  const titleCandidate =
    directSource?.title && directSource.title !== 'master' ? directSource.title : info.title ?? 'download'
  const stem = String(titleCandidate).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
  const mode = String(body.downloadMode ?? 'auto')

  if (mode === 'audio') {
    const audio = pickAudio(formats)
    if (!audio) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
    const wanted = String(body.audioFormat ?? 'best')
    return {
      status: 'local-processing',
      type: 'audio',
      tunnel: [remember({ url: queryUrl, referer: directSource?.referer, format: audio, mime: 'audio/mp4' })],
      output: { filename: `${stem}.${wanted === 'best' ? 'm4a' : wanted}`, type: 'audio/mp4' },
      // Kopieren geht nur, wenn kein anderes Format verlangt wurde.
      audio: { format: wanted, copy: wanted === 'best' },
      isHLS: isHlsFormat(audio),
    }
  }

  if (mode === 'mute') {
    const video = pickVideo(formats, maxHeight)
    if (!video) return { status: 'error', error: { code: 'error.api.fetch.empty' } }
    return {
      status: 'local-processing',
      type: 'mute',
      tunnel: [remember({ url: queryUrl, referer: directSource?.referer, format: video, mime: 'video/mp4' })],
      output: { filename: `${stem} (${heightOf(video)}p, ohne Ton).mp4`, type: 'video/mp4' },
      isHLS: isHlsFormat(video),
    }
  }

  // Bild und Ton. Liegt beides schon in einer Datei, ist nichts zu tun.
  const progressive = pickProgressive(formats, maxHeight)
  const video = pickVideo(formats, maxHeight)
  const audio = pickAudio(formats)

  if (progressive && (!video || !audio || heightOf(progressive) >= heightOf(video))) {
    return {
      status: 'tunnel',
      url: remember({ url: queryUrl, referer: directSource?.referer, format: progressive, mime: 'video/mp4' }),
      filename: `${stem} (${heightOf(progressive)}p).${progressive.ext ?? 'mp4'}`,
    }
  }

  if (!video || !audio) return { status: 'error', error: { code: 'error.api.fetch.empty' } }

  return {
    status: 'local-processing',
    type: 'merge',
    tunnel: [
      remember({ url: queryUrl, referer: directSource?.referer, format: video, mime: 'video/mp4' }),
      remember({ url: queryUrl, referer: directSource?.referer, format: audio, mime: 'audio/mp4' }),
    ],
    output: { filename: `${stem} (${heightOf(video)}p).mp4`, type: 'video/mp4' },
    isHLS: isHlsFormat(video),
  }
}

/* -- Durchreichen ---------------------------------------------------------- */

/**
 * Ein Format, von yt-dlp geholt und direkt weitergereicht.
 *
 * Bewusst nicht selbst heruntergeladen: die Kopfzeilen, die Bereichsabrufe und
 * die Wiederholungen, an denen ein eigener Abruf scheitert, sind genau das,
 * was yt-dlp gut kann. Hier fließen nur Bytes.
 */
function tunnel(job, req, res) {
  const size = Number(job.format.filesize) || 0
  const headers = {
    'content-type': job.mime,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Estimated-Content-Length',
    'cache-control': 'no-store',
  }
  // Nur die exakte Größe, nie die geschätzte — eine falsche Längenangabe
  // bricht die Übertragung im Browser.
  if (size > 0) headers['content-length'] = String(size)
  else if (job.format.filesize_approx) headers['estimated-content-length'] = String(job.format.filesize_approx)

  const child = spawn(
    YTDLP,
    [
      '-f', String(job.format.format_id),
      '-o', '-',
      '--no-part', '--no-warnings', '--quiet', '--no-playlist',
      ...(job.referer ? ['--referer', job.referer] : []),
      ...cookieArgs,
      '--', job.url,
    ],
    { windowsHide: true },
  )

  let sent = 0
  let started = false
  let complaints = ''

  /**
   * Die Kopfzeilen warten auf das erste Byte.
   *
   * Sobald „200 OK" heraus ist, lässt sich nicht mehr sagen, dass es doch
   * nicht geklappt hat — dann bleibt nur, die Verbindung abzureißen, und der
   * Empfänger sieht eine leere Datei statt eines Grundes. Genau so entstand
   * die 9-Byte-Datei. Also erst schreiben, wenn wirklich etwas fließt.
   */
  const begin = () => {
    if (started) return
    started = true
    res.writeHead(200, headers)
  }

  child.stdout.on('data', (chunk) => {
    begin()
    sent += chunk.length
    if (!res.write(chunk)) child.stdout.pause()
  })
  res.on('drain', () => child.stdout.resume())
  child.stderr.on('data', (chunk) => {
    complaints += chunk
    process.stderr.write(chunk)
  })

  child.on('close', () => {
    if (!started) {
      // Nie ein Byte gesehen: das lässt sich noch sauber als Fehler sagen.
      return json(res, 502, { status: 'error', error: { code: errorCode(complaints) } })
    }
    // Zu wenig Bytes bei angekündigter Länge: die Verbindung abreißen lassen,
    // damit der Browser das als Fehler sieht statt als kurze Datei.
    if (size > 0 && sent !== size) res.destroy()
    else res.end()
  })
  child.on('error', () => {
    if (!started) return json(res, 502, { status: 'error', error: { code: 'error.api.ytdlp.missing' } })
    res.destroy()
  })
  // Abbruch im Browser beendet auch den Download.
  res.on('close', () => child.kill())
}

/* -- Server ---------------------------------------------------------------- */

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${SERVICE_PORT}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, accept',
        'access-control-max-age': '86400',
      })
      return res.end()
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return json(res, 200, {
        cobalt: { version: versionLabel, url: `http://localhost:${SERVICE_PORT}/`, services: SERVICES },
      })
    }

    if (req.method === 'GET' && url.pathname === '/tunnel') {
      const job = jobs.get(url.searchParams.get('id') ?? '')
      if (!job || job.expires < Date.now()) return json(res, 404, { status: 'error', error: { code: 'error.api.tunnel.missing' } })
      return tunnel(job, req, res)
    }

    if (req.method === 'POST' && url.pathname === '/') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return json(res, 400, { status: 'error', error: { code: 'error.api.invalid_body' } })
      }
      const answer = await resolve(body)
      if (answer.error?.code === 'error.api.ytdlp.signin' && !COOKIES) {
        console.error('')
        console.error('  YouTube verlangt für diese Adresse eine Anmeldung.')
        console.error('  Mit dem Browser neu starten, in dem Sie bei YouTube angemeldet sind:')
        console.error('')
        console.error(`    node sondra-ytdlp.mjs ${SITE || '<Adresse>'} --cookies firefox`)
        console.error('')
        console.error('  Statt firefox geht auch chrome, edge, brave, opera oder safari.')
        console.error('')
      }
      return json(res, answer.status === 'error' ? 400 : 200, answer)
    }

    json(res, 404, { status: 'error', error: { code: 'error.api.not_found' } })
  })
  .listen(SERVICE_PORT, '127.0.0.1', async () => {
    const version = await run(['--version'], { timeoutMs: 15_000 })
    if (version.code !== 0) {
      console.error('')
      console.error(`  yt-dlp wurde nicht gefunden (gesucht als "${YTDLP}").`)
      console.error('  Die Einzeldatei von https://github.com/yt-dlp/yt-dlp/releases/latest')
      console.error('  in diesen Ordner legen, dann noch einmal starten.')
      console.error('')
      process.exit(1)
    }
    versionLabel = `yt-dlp ${version.stdout.trim()} · Sondra-Brücke`
    console.log('')
    console.log(`  Gefunden: ${versionLabel}`)
    if (COOKIES) console.log(`  Anmeldung: aus ${COOKIES}`)
    if (!SITE) {
      console.log(`  Dienst:   http://localhost:${SERVICE_PORT}/`)
      console.log('')
      console.log('  Kein Seitenspiegel — die Adresse oben in Sondra eintragen.')
      console.log('')
    }
  })

/* -- Die Seite ------------------------------------------------------------- */

/**
 * Derselbe Spiegel wie im anderen Starter: eine Seite aus dem Internet darf
 * einen Dienst auf Ihrem Rechner nicht ansprechen. Von hier ausgeliefert
 * sitzen beide auf derselben Maschine, und es gibt keine Grenze zu überqueren.
 */
if (SITE) {
  http
    .createServer(async (req, res) => {
      try {
        const upstream = await fetch(SITE + req.url, {
          method: req.method,
          headers: {
            'user-agent': req.headers['user-agent'] ?? 'sondra-ytdlp',
            accept: req.headers.accept ?? '*/*',
          },
          redirect: 'follow',
        })

        const headers = {}
        upstream.headers.forEach((value, name) => {
          if (['content-encoding', 'content-length', 'transfer-encoding'].includes(name)) return
          headers[name] = value
        })
        headers['cross-origin-opener-policy'] = 'same-origin'
        headers['cross-origin-embedder-policy'] = 'credentialless'

        res.writeHead(upstream.status, headers)
        if (!upstream.body) return res.end()
        for await (const chunk of upstream.body) res.write(chunk)
        res.end()
      } catch (error) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`${SITE} war nicht erreichbar: ${error.message}`)
      }
    })
    .listen(PAGE_PORT, '127.0.0.1', () => {
      console.log(`  Sondra:   http://localhost:${PAGE_PORT}/   ← diese Adresse öffnen`)
      console.log(`  Dienst:   http://localhost:${SERVICE_PORT}/`)
      console.log('')
      console.log('  Dieses Fenster offen lassen. Strg+C beendet beides.')
      console.log('')
    })
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
