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
  return heightOf(format) * 1e6 + container * 1e4 + (format.tbr ?? 0)
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
  'aniworld', 'serienstream', 'filemoon', 'voe', 'vidmoly', 'streamtape', 'vidoza', 'doodstream',
]

let versionLabel = 'yt-dlp'

/* -- Benutzerdefinierte Extraktoren (AniWorld, VOE, FileMoon, Vidmoly, Streamtape, Vidoza, DoodStream) ---- */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

const ANIWORLD_HOSTS = /^(?:www\.)?(?:aniworld\.to|s\.to|serienstream\.to)$/i
const VOE_HOSTS =
  /(?:^|\.)(?:voe\.sx|tube\.sx|jamesbornmain\.com|chaliceguzzlerlandlord\.com|jeremyparticipantanything\.com|voe-network\.net)$/i
const FILEMOON_HOSTS = /(?:^|\.)(?:filemoon\.(?:sx|to|in|nl|wf)|kerapoxy\.cc|moonmov\.pro)$/i
const VIDMOLY_HOSTS = /(?:^|\.)(?:vidmoly\.(?:to|me|net))$/i
const DOOD_HOSTS =
  /(?:^|\.)(?:dood\.(?:to|so|ws|wf|re|pm|la|li|watch|cx|yt|stream)|doodstream\.com|dsvplay\.com|myvidplay\.com|playmogo\.com|d0o0d\.com|dooood\.com|ds2play\.com)$/i
const STREAMTAPE_HOSTS = /(?:^|\.)(?:streamtape\.(?:com|net|to)|streamta\.pe|streamadblocker\.com)$/i
const VIDOZA_HOSTS = /(?:^|\.)(?:vidoza\.net)$/i

function isAniworld(raw) {
  try { return ANIWORLD_HOSTS.test(new URL(raw).hostname) } catch { return false }
}
function isVoe(raw) {
  try { const u = new URL(raw); return VOE_HOSTS.test(u.hostname) || u.pathname.startsWith('/e/') } catch { return false }
}
function isFilemoon(raw) {
  try { return FILEMOON_HOSTS.test(new URL(raw).hostname) || new URL(raw).hostname.includes('filemoon') } catch { return false }
}
function isVidmoly(raw) {
  try { return VIDMOLY_HOSTS.test(new URL(raw).hostname) || new URL(raw).hostname.includes('vidmoly') } catch { return false }
}
function isDood(raw) {
  try { const h = new URL(raw).hostname; return DOOD_HOSTS.test(h) || h.includes('dood') || h.includes('dsvplay') || h.includes('playmogo') } catch { return false }
}
function isStreamtape(raw) {
  try { return STREAMTAPE_HOSTS.test(new URL(raw).hostname) || new URL(raw).hostname.includes('streamtape') } catch { return false }
}
function isVidoza(raw) {
  try { return VIDOZA_HOSTS.test(new URL(raw).hostname) || new URL(raw).hostname.includes('vidoza') } catch { return false }
}

const PACKER_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
function baseDecode(token, radix) {
  let value = 0
  for (let i = 0; i < token.length; i++) {
    const digit = PACKER_ALPHABET.indexOf(token[i])
    if (digit === -1 || digit >= radix) return null
    value = value * radix + digit
  }
  return value
}
function unpackPackedJs(source) {
  if (!source || !source.includes('eval(function(p,a,c,k,e,d)')) return null
  const match = source.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\((['"][\s\S]*?['"]),\s*(\d+),\s*(\d+),\s*(['"][\s\S]*?['"])\.split\(['"]\|['"]\)/,
  )
  if (!match) return null
  let payload = match[1]
  if (payload.startsWith("'") && payload.endsWith("'")) payload = payload.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  else if (payload.startsWith('"') && payload.endsWith('"')) payload = payload.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const radix = Number(match[2])
  const count = Number(match[3])
  let keywordsStr = match[4]
  if (keywordsStr.startsWith("'") && keywordsStr.endsWith("'")) keywordsStr = keywordsStr.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  else if (keywordsStr.startsWith('"') && keywordsStr.endsWith('"')) keywordsStr = keywordsStr.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const keywords = keywordsStr.split('|')
  while (keywords.length < count) keywords.push('')
  return payload.replace(/\b\w+\b/g, (token) => {
    const index = baseDecode(token, radix)
    return (index !== null && index < keywords.length && keywords[index] !== '') ? keywords[index] : token
  })
}

async function extractVoe(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()

    const cloneRedirect = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i)
    if (cloneRedirect && cloneRedirect[1] !== url && cloneRedirect[1] !== finalUrl) {
      return extractVoe(cloneRedirect[1])
    }

    const scripts = html.matchAll(/<script\b[^>]*\btype\s*=\s*(['"])application\/json\1[^>]*>([\s\S]*?)<\/script>/gi)
    let b64Payload = ''
    for (const script of scripts) {
      try {
        const val = JSON.parse(script[2].trim())
        if (Array.isArray(val) && typeof val[0] === 'string' && val[0].length > 20) {
          b64Payload = val[0]
          break
        }
      } catch {}
    }

    if (b64Payload) {
      const rot13 = (s) =>
        s.replace(/[a-zA-Z]/g, (c) => {
          const code = c.charCodeAt(0)
          const base = code <= 90 ? 65 : 97
          return String.fromCharCode(((code - base + 13) % 26) + base)
        })
      const removeJunk = (s) => {
        let t = s
        for (const pat of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) t = t.replaceAll(pat, '')
        return t
      }
      const shiftChars = (s, shift) => Array.from(s).map((c) => String.fromCharCode(c.charCodeAt(0) - shift)).join('')

      const s1 = rot13(b64Payload)
      const s2 = removeJunk(s1)
      const s3 = Buffer.from(s2, 'base64').toString('latin1')
      const s4 = shiftChars(s3, 3)
      const s5 = s4.split('').reverse().join('')
      const s6 = Buffer.from(s5, 'base64').toString('utf8')
      const data = JSON.parse(s6)
      const streamUrl = data.source || data.direct_access_url
      if (streamUrl) {
        return {
          title: data.title || 'VOE Video',
          url: streamUrl,
          referer: finalUrl,
          isHls: streamUrl.includes('.m3u8'),
        }
      }
    }

    const hlsMatch = html.match(/['"]hls['"]\s*:\s*['"]([A-Za-z0-9+/=]+)['"]/i)
    if (hlsMatch) {
      try {
        const decoded = Buffer.from(hlsMatch[1], 'base64').toString('utf8')
        if (decoded.startsWith('http')) {
          return { title: 'VOE Video', url: decoded, referer: finalUrl, isHls: decoded.includes('.m3u8') }
        }
      } catch {}
    }

    const directSrcMatch = html.match(/(?:sources|mp4|source)\s*:\s*['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i)
    if (directSrcMatch) {
      return { title: 'VOE Video', url: directSrcMatch[1], referer: finalUrl, isHls: directSrcMatch[1].includes('.m3u8') }
    }
    return null
  } catch {
    return null
  }
}

async function extractFileMoon(url) {
  try {
    const res = await fetch(url, {
      headers: { Referer: url, 'User-Agent': DEFAULT_UA },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()

    const parsed = new URL(finalUrl)
    const parts = parsed.pathname.replace(/\/$/, '').split('/')
    const code = parts[parts.length - 1]

    if (code && code !== 'e' && code !== 'd') {
      const apiUrl = `${parsed.protocol}//${parsed.host}/api/videos/${code}`
      try {
        const apiRes = await fetch(apiUrl, {
          headers: { Referer: finalUrl, 'User-Agent': DEFAULT_UA },
        })
        if (apiRes.ok) {
          const data = await apiRes.json()
          const playback = data?.playback
          if (playback?.key_parts && playback?.iv && playback?.payload) {
            const key = Buffer.concat(playback.key_parts.map((p) => Buffer.from(p, 'base64url')))
            const iv = Buffer.from(playback.iv, 'base64url')
            const payload = Buffer.from(playback.payload, 'base64url')
            const tag = payload.subarray(payload.length - 16)
            const ciphertext = payload.subarray(0, payload.length - 16)
            const decipher = createDecipheriv('aes-256-gcm', key, iv)
            decipher.setAuthTag(tag)
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            const parsedPlayback = JSON.parse(decrypted.toString('utf8'))
            const src = parsedPlayback.sources?.find((s) => s.mime_type?.includes('mpegurl')) || parsedPlayback.sources?.[0]
            if (src?.url) {
              return { title: data.title || 'FileMoon Video', url: src.url, referer: finalUrl, isHls: src.url.includes('.m3u8') }
            }
          }
        }
      } catch {}
    }

    if (html.includes('eval(function(p,a,c,k,e,d)')) {
      const unpacked = unpackPackedJs(html)
      if (unpacked) {
        const m3u8Match = unpacked.match(/['"](https?:\/\/[^'"]+?\.m3u8[^'"]*)['"]/) || unpacked.match(/file\s*:\s*['"]([^'"]+)['"]/)
        if (m3u8Match) {
          const streamUrl = new URL(m3u8Match[1], finalUrl).href
          return { title: 'FileMoon Video', url: streamUrl, referer: finalUrl, isHls: streamUrl.includes('.m3u8') }
        }
      }
    }

    const directMatch = html.match(/['"](https?:\/\/[^'"]+?\.(?:m3u8|mp4)[^'"]*)['"]/)
    if (directMatch) {
      return { title: 'FileMoon Video', url: directMatch[1], referer: finalUrl, isHls: directMatch[1].includes('.m3u8') }
    }
    return null
  } catch {
    return null
  }
}

async function extractVidmoly(url) {
  try {
    const parsed = new URL(url)
    const embedIdMatch = parsed.pathname.match(/\/embed-([a-zA-Z0-9]+)\.html/) || parsed.pathname.match(/\/([a-zA-Z0-9]+)$/)
    const embedId = embedIdMatch ? embedIdMatch[1] : ''
    const headers = {
      'User-Agent': DEFAULT_UA,
      Referer: url,
      Cookie: embedId ? `cf_turnstile_demo_pass_${embedId}=1` : '',
    }
    const res = await fetch(url, { headers, redirect: 'follow' })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()
    const match = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)/)
    if (!match) return null
    const streamUrl = new URL(match[1], finalUrl).href
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidmoly.*$/i, '').trim() : 'Vidmoly Video'
    return { title, url: streamUrl, referer: finalUrl, isHls: streamUrl.includes('.m3u8') }
  } catch {
    return null
  }
}

async function extractStreamtape(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, Referer: url }, redirect: 'follow' })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()
    const tokenMatch = html.match(/document\.getElementById\(['"](?:robotlink|norobotlink)['"]\)\.innerHTML\s*=\s*(.+?);/i)
    if (!tokenMatch) return null
    const parts = tokenMatch[1].matchAll(/['"]([^'"]+)['"]|\+.*substring\((\d+)\)/g)
    let streamUrl = ''
    for (const p of parts) {
      if (p[1]) streamUrl += p[1]
    }
    const subMatch = tokenMatch[1].match(/\+.*substring\((\d+)\)/)
    if (subMatch) {
      const offset = Number(subMatch[1])
      const targetStr = html.match(new RegExp(`id=['"](?:norobotlink|robotlink)['"][^>]*>([^<]+)<`))
      if (targetStr && targetStr[1]) streamUrl += targetStr[1].substring(offset)
    }
    if (!streamUrl.startsWith('http')) streamUrl = `https:${streamUrl}`
    if (!streamUrl.includes('&stream=1')) streamUrl += '&stream=1'
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Streamtape.*$/i, '').trim() : 'Streamtape Video'
    return { title, url: streamUrl, referer: finalUrl, isHls: false }
  } catch {
    return null
  }
}

async function extractVidoza(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, Referer: url }, redirect: 'follow' })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()
    const srcMatch = html.match(/<source\s+[^>]*src=['"]([^'"]+\.mp4[^'"]*)['"]/i) || html.match(/['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/)
    if (!srcMatch) return null
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidoza.*$/i, '').trim() : 'Vidoza Video'
    return { title, url: srcMatch[1], referer: finalUrl, isHls: false }
  } catch {
    return null
  }
}

async function extractDoodStream(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, Referer: url }, redirect: 'follow' })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()
    const passMatch = html.match(/\/pass_md5\/[^'"<>\s]+/)
    if (!passMatch) return null
    const baseOrigin = new URL(finalUrl).origin
    const passUrl = `${baseOrigin}${passMatch[0]}`
    const passRes = await fetch(passUrl, { headers: { 'User-Agent': DEFAULT_UA, Referer: finalUrl } })
    if (!passRes.ok) return null
    const baseStream = (await passRes.text()).trim()
    if (!baseStream || baseStream.includes('RELOAD')) return null
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let token = ''
    for (let i = 0; i < 10; i++) token += chars.charAt(Math.floor(Math.random() * chars.length))
    const finalStreamUrl = `${baseStream}${token}?token=${passMatch[0].split('/').pop()}&expiry=${Date.now()}`
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Dood.*$/i, '').trim() : 'DoodStream Video'
    return { title, url: finalStreamUrl, referer: finalUrl, isHls: false }
  } catch {
    return null
  }
}

async function extractAniworld(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,*/*' }, redirect: 'follow' })
    if (!res.ok) return null
    const finalUrl = res.url || url
    const html = await res.text()

    const germanTitleMatch = html.match(/<span\s+class=["']episodeGermanTitle["'][^>]*>([^<]+)<\/span>/i)
    const englishTitleMatch = html.match(/<small\s+class=["']episodeEnglishTitle["'][^>]*>([^<]+)<\/small>/i)
    const seriesTitleMatch = html.match(/<h1[^>]*>.*?<span[^>]*>([^<]+)<\/span>/i) || html.match(/data-series-title=["']([^"']+)["']/i)
    const seriesTitle = (seriesTitleMatch ? seriesTitleMatch[1] : '').trim()
    const episodeTitle = (germanTitleMatch ? germanTitleMatch[1] : englishTitleMatch ? englishTitleMatch[1] : '').trim()

    const seasonMatch = finalUrl.match(/staffel-(\d+)/i)
    const episodeMatch = finalUrl.match(/episode-(\d+)/i)
    const seasonNumber = seasonMatch ? Number(seasonMatch[1]) : 1
    const episodeNumber = episodeMatch ? Number(episodeMatch[1]) : 1

    let compoundTitle = seriesTitle
      ? `${seriesTitle} - S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}${episodeTitle ? ` - ${episodeTitle}` : ''}`
      : episodeTitle || 'AniWorld Episode'

    const hosterRegex = /<li\s+[^>]*?data-lang-key=["'](\d+)["'][^>]*?data-link-target=["'](\/redirect\/\d+)["'][^>]*>[\s\S]*?<h4[^>]*>([^<]+)<\/h4>/gi
    const hosters = []
    let hMatch
    while ((hMatch = hosterRegex.exec(html)) !== null) {
      hosters.push({ langKey: Number(hMatch[1]), redirectUrl: new URL(hMatch[2], finalUrl).href, hosterName: hMatch[3].trim().toLowerCase() })
    }

    if (hosters.length === 0) {
      const fallbackRegex = /<li\s+[^>]*?data-link-target=["'](\/redirect\/\d+)["'][^>]*>[\s\S]*?<h4[^>]*>([^<]+)<\/h4>/gi
      while ((hMatch = fallbackRegex.exec(html)) !== null) {
        hosters.push({ langKey: 1, redirectUrl: new URL(hMatch[1], finalUrl).href, hosterName: hMatch[2].trim().toLowerCase() })
      }
    }

    const priority = ['voe', 'filemoon', 'vidmoly', 'streamtape', 'vidoza', 'doodstream']
    hosters.sort((a, b) => {
      const langRankA = a.langKey === 1 ? 3 : a.langKey === 3 ? 2 : 1
      const langRankB = b.langKey === 1 ? 3 : b.langKey === 3 ? 2 : 1
      if (langRankA !== langRankB) return langRankB - langRankA
      const prioA = priority.indexOf(a.hosterName) !== -1 ? priority.indexOf(a.hosterName) : 999
      const prioB = priority.indexOf(b.hosterName) !== -1 ? priority.indexOf(b.hosterName) : 999
      return prioA - prioB
    })

    for (const h of hosters) {
      try {
        const redirRes = await fetch(h.redirectUrl, {
          headers: { 'User-Agent': DEFAULT_UA, Referer: finalUrl },
          redirect: 'manual',
        })
        const location = redirRes.headers.get('location')
        if (location) {
          const direct = await extractDirectStream(location)
          if (direct) {
            return {
              title: compoundTitle,
              url: direct.url,
              referer: direct.referer,
              isHls: direct.isHls,
              hoster: h.hosterName,
            }
          }
        }
      } catch {}
    }
    return null
  } catch {
    return null
  }
}

/** Erkennt den Hoster und extrahiert die direkte Stream-Adresse vor dem yt-dlp-Aufruf. */
async function extractDirectStream(rawUrl) {
  if (isAniworld(rawUrl)) return extractAniworld(rawUrl)
  if (isFilemoon(rawUrl)) return extractFileMoon(rawUrl)
  if (isVidmoly(rawUrl)) return extractVidmoly(rawUrl)
  if (isStreamtape(rawUrl)) return extractStreamtape(rawUrl)
  if (isVidoza(rawUrl)) return extractVidoza(rawUrl)
  if (isDood(rawUrl)) return extractDoodStream(rawUrl)
  if (isVoe(rawUrl)) return extractVoe(rawUrl)
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

  child.on('close', (code) => {
    if (!started) {
      // Nie ein Byte gesehen: das lässt sich noch sauber als Fehler sagen.
      return json(res, 502, { status: 'error', error: { code: errorCode(complaints) } })
    }
    // Zu wenig Bytes bei angekündigter Länge und fehlgeschlagenem Prozess: Verbindung abreißen lassen
    if (size > 0 && sent !== size && code !== 0) res.destroy()
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
