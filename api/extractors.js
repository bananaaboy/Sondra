/**
 * Universal video extractors for AniWorld, SerienStream (s.to), and embed hosters
 * (VOE, FileMoon, Vidmoly, DoodStream, Streamtape, Vidoza).
 *
 * Runs seamlessly in pure Node.js (Web serverless, Desktop Electron, and CLI)
 * with zero external dependencies, using native fetch and node:crypto.
 */

import { createDecipheriv } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

/* -------------------------------------------------------------------------- */
/* Constants & URL matchers                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_USER_AGENT =
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

export function isAniworldUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return ANIWORLD_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

export function isAniworldSeasonUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    if (!ANIWORLD_HOSTS.test(u.hostname)) return false
    const isEpisode = /\/episode-\d+/i.test(u.pathname) || /\/film-\d+/i.test(u.pathname)
    const isSeasonOrSeries = /\/(?:anime|serie)\/stream\/[^/]+(?:\/(?:staffel-\d+|filme))?\/?$/i.test(u.pathname)
    return !isEpisode && isSeasonOrSeries
  } catch {
    return false
  }
}

export function isVoeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return VOE_HOSTS.test(u.hostname) || u.pathname.startsWith('/e/')
  } catch {
    return false
  }
}

export function isFilemoonUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return FILEMOON_HOSTS.test(u.hostname) || u.hostname.includes('filemoon')
  } catch {
    return false
  }
}

export function isVidmolyUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return VIDMOLY_HOSTS.test(u.hostname) || u.hostname.includes('vidmoly')
  } catch {
    return false
  }
}

export function isDoodstreamUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return (
      DOOD_HOSTS.test(u.hostname) ||
      u.hostname.includes('dood') ||
      u.hostname.includes('dsvplay') ||
      u.hostname.includes('playmogo')
    )
  } catch {
    return false
  }
}

export function isStreamtapeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return STREAMTAPE_HOSTS.test(u.hostname) || u.hostname.includes('streamtape')
  } catch {
    return false
  }
}

export function isVidozaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return VIDOZA_HOSTS.test(u.hostname) || u.hostname.includes('vidoza')
  } catch {
    return false
  }
}

export function isHosterUrl(rawUrl) {
  return (
    isVoeUrl(rawUrl) ||
    isFilemoonUrl(rawUrl) ||
    isVidmolyUrl(rawUrl) ||
    isDoodstreamUrl(rawUrl) ||
    isStreamtapeUrl(rawUrl) ||
    isVidozaUrl(rawUrl)
  )
}

/* -------------------------------------------------------------------------- */
/* Dean Edwards P.A.C.K.E.R unpacker                                          */
/* -------------------------------------------------------------------------- */

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

/**
 * Unpacks code packed with Dean Edwards P.A.C.K.E.R.
 * Returns the unpacked code string, or null if parsing fails.
 */
export function unpackPackedJs(source) {
  if (!source || !source.includes('eval(function(p,a,c,k,e,d)')) return null
  const match = source.match(
    /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\((['"][\s\S]*?['"]),\s*(\d+),\s*(\d+),\s*(['"][\s\S]*?['"])\.split\(['"]\|['"]\)/,
  )
  if (!match) return null

  let payload = match[1]
  if (payload.startsWith("'") && payload.endsWith("'")) {
    payload = payload.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  } else if (payload.startsWith('"') && payload.endsWith('"')) {
    payload = payload.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }

  const radix = Number(match[2])
  const count = Number(match[3])
  let keywordsStr = match[4]
  if (keywordsStr.startsWith("'") && keywordsStr.endsWith("'")) {
    keywordsStr = keywordsStr.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  } else if (keywordsStr.startsWith('"') && keywordsStr.endsWith('"')) {
    keywordsStr = keywordsStr.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  const keywords = keywordsStr.split('|')
  if (keywords.length < count && count > 0) {
    while (keywords.length < count) keywords.push('')
  }

  return payload.replace(/\b\w+\b/g, (token) => {
    const index = baseDecode(token, radix)
    if (index !== null && index < keywords.length && keywords[index] !== '') {
      return keywords[index]
    }
    return token
  })
}

/* -------------------------------------------------------------------------- */
/* Common HTTP fetch helper with network adapter (localAddress) support      */
/* -------------------------------------------------------------------------- */

export async function boundedFetch(url, options = {}, redirectCount = 0) {
  const localAddr = options.localAddress && options.localAddress !== 'default' ? String(options.localAddress) : null
  if (!localAddr && typeof globalThis.fetch === 'function') {
    return globalThis.fetch(url, options)
  }

  const parsed = typeof url === 'string' ? new URL(url) : url
  const isHttps = parsed.protocol === 'https:'
  const transport = isHttps ? https : http

  const headers = {}
  if (options.headers) {
    if (typeof options.headers.entries === 'function') {
      for (const [k, v] of options.headers.entries()) headers[k] = v
    } else {
      Object.assign(headers, options.headers)
    }
  }

  const method = (options.method || 'GET').toUpperCase()

  return new Promise((resolve, reject) => {
    const req = transport.request(parsed, {
      method,
      headers,
      localAddress: localAddr || undefined,
      rejectUnauthorized: false,
      signal: options.signal,
    }, (res) => {
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode)
      if (options.redirect !== 'manual' && isRedirect && res.headers.location && redirectCount < 10) {
        res.resume()
        const nextUrl = new URL(res.headers.location, parsed.href).href
        const nextMethod = (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) ? 'GET' : method
        const nextOptions = { ...options, method: nextMethod }
        if (nextMethod === 'GET') delete nextOptions.body
        return resolve(boundedFetch(nextUrl, nextOptions, redirectCount + 1))
      }

      const headersObj = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headersObj.append(k, item)
        } else if (v !== undefined) {
          headersObj.set(k, v)
        }
      }

      let bodyUsed = false
      const response = {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: headersObj,
        url: parsed.href,
        get body() {
          return Readable.toWeb(res)
        },
        async text() {
          if (bodyUsed) throw new Error('Body already used')
          bodyUsed = true
          const chunks = []
          for await (const chunk of res) chunks.push(chunk)
          return Buffer.concat(chunks).toString('utf-8')
        },
        async json() {
          return JSON.parse(await this.text())
        },
        async arrayBuffer() {
          if (bodyUsed) throw new Error('Body already used')
          bodyUsed = true
          const chunks = []
          for await (const chunk of res) chunks.push(chunk)
          return Buffer.concat(chunks).buffer
        },
      }
      resolve(response)
    })

    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function fetchHtml(url, options = {}) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    ...options.headers,
  }
  const res = await boundedFetch(url, {
    method: options.method || 'GET',
    headers,
    redirect: options.redirect || 'follow',
    signal: options.signal,
    body: options.body,
    localAddress: options.localAddress,
  })
  return res
}

/* -------------------------------------------------------------------------- */
/* VOE Extractor                                                              */
/* -------------------------------------------------------------------------- */

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
  })
}

export async function extractVoe(url, options = {}) {
  try {
    let currentUrl = url
    let res = await fetchHtml(currentUrl, options)
    if (!res.ok) return null
    let html = await res.text()

    // 1. Follow any client-side redirect stub
    const redirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/)
    if (redirectMatch && redirectMatch[1]) {
      try {
        currentUrl = new URL(redirectMatch[1], currentUrl).href
        res = await fetchHtml(currentUrl, options)
        if (res.ok) html = await res.text()
      } catch {
        /* continue with current HTML */
      }
    }

    // 2. Decode modern application/json script tags
    const scriptMatches = html.matchAll(
      /<script\b[^>]*\btype\s*=\s*(['"])application\/json\1[^>]*>([\s\S]*?)<\/script>/gi,
    )
    for (const match of scriptMatches) {
      try {
        const rawJson = JSON.parse(match[2].trim())
        const encodedStr = Array.isArray(rawJson) && typeof rawJson[0] === 'string' ? rawJson[0] : null
        if (!encodedStr) continue

        let step1 = rot13(encodedStr)
        for (const pat of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) {
          step1 = step1.replaceAll(pat, '')
        }
        const step2 = Buffer.from(step1, 'base64').toString('latin1')
        const step3 = Array.from(step2)
          .map((c) => String.fromCharCode(c.charCodeAt(0) - 3))
          .join('')
        const step4 = step3.split('').reverse().join('')
        const step5 = Buffer.from(step4, 'base64').toString('utf-8')
        const data = JSON.parse(step5)

        const streamUrl = data.source || data.direct_access_url
        if (streamUrl) {
          return {
            title: data.title || 'VOE Video',
            url: streamUrl,
            isHls: streamUrl.includes('.m3u8') || Boolean(data.source),
            referer: currentUrl,
            hoster: 'VOE',
          }
        }
      } catch {
        // Skip non-stream JSON payloads
      }
    }

    // 3. Fallback: Check for inline HLS/MP4 definitions or wc0 variable
    const hlsMatch = html.match(/['"]hls['"]\s*:\s*['"]([^'"]+)['"]/i)
    if (hlsMatch && hlsMatch[1]) {
      let candidate = hlsMatch[1]
      if (!candidate.startsWith('http')) {
        try {
          candidate = Buffer.from(candidate, 'base64').toString('utf-8')
        } catch {}
      }
      if (candidate.startsWith('http')) {
        return {
          title: 'VOE Video',
          url: candidate,
          isHls: true,
          referer: currentUrl,
          hoster: 'VOE',
        }
      }
    }

    const mp4Match = html.match(/['"]mp4['"]\s*:\s*['"]([^'"]+)['"]/i)
    if (mp4Match && mp4Match[1]) {
      let candidate = mp4Match[1]
      if (!candidate.startsWith('http')) {
        try {
          candidate = Buffer.from(candidate, 'base64').toString('utf-8')
        } catch {}
      }
      if (candidate.startsWith('http')) {
        return {
          title: 'VOE Video',
          url: candidate,
          isHls: false,
          referer: currentUrl,
          hoster: 'VOE',
        }
      }
    }

    // 4. Generic m3u8 scan in script
    const directM3u8 = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/)
    if (directM3u8) {
      return {
        title: 'VOE Video',
        url: directM3u8[1],
        isHls: true,
        referer: currentUrl,
        hoster: 'VOE',
      }
    }

    return null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* FileMoon Extractor                                                         */
/* -------------------------------------------------------------------------- */

export async function extractFilemoon(url, options = {}) {
  try {
    let currentUrl = url
    let res = await fetchHtml(currentUrl, options)
    if (!res.ok) return null
    let html = await res.text()

    // 1. Follow iframe if player is nested
    const iframeMatch = html.match(/<iframe\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/i)
    if (iframeMatch && iframeMatch[1] && !iframeMatch[1].includes('about:blank')) {
      try {
        const iframeUrl = new URL(iframeMatch[1], currentUrl).href
        const iframeRes = await fetchHtml(iframeUrl, {
          ...options,
          headers: { ...options.headers, Referer: currentUrl },
        })
        if (iframeRes.ok) {
          html = await iframeRes.text()
          currentUrl = iframeUrl
        }
      } catch {
        /* continue with parent HTML */
      }
    }

    const parsed = new URL(currentUrl)
    const code = parsed.pathname.replace(/\/$/, '').split('/').pop()

    // 2. Approach A: Modern /api/videos/{code} AES-256-GCM
    if (code && code !== 'e' && code !== 'd') {
      try {
        // Handle basePath if path has prefixes (e.g. mock server or subdirectory)
        const pathPrefix = parsed.pathname.includes('/filemoon/') ? '/filemoon' : ''
        const apiUrl = `${parsed.protocol}//${parsed.host}${pathPrefix}/api/videos/${code}`
        const apiRes = await fetchHtml(apiUrl, {
          ...options,
          headers: { Referer: currentUrl, 'User-Agent': DEFAULT_USER_AGENT },
        })
        if (apiRes.ok) {
          const data = await apiRes.json()
          const pb = data?.playback
          if (pb?.key_parts && pb?.iv && pb?.payload) {
            const key = Buffer.concat(pb.key_parts.map((p) => Buffer.from(p, 'base64url')))
            const iv = Buffer.from(pb.iv, 'base64url')
            const payload = Buffer.from(pb.payload, 'base64url')
            const tag = payload.subarray(payload.length - 16)
            const ciphertext = payload.subarray(0, payload.length - 16)

            const decipher = createDecipheriv('aes-256-gcm', key, iv)
            decipher.setAuthTag(tag)
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            const parsedPb = JSON.parse(decrypted.toString('utf-8'))
            const hls = parsedPb.sources?.find((s) => s.mime_type?.includes('mpegurl') || s.url?.includes('.m3u8')) ||
              parsedPb.sources?.[0]
            const streamUrl = hls?.url || hls?.file
            if (streamUrl) {
              return {
                title: data.title || 'FileMoon Video',
                url: streamUrl,
                isHls: true,
                referer: currentUrl,
                hoster: 'Filemoon',
              }
            }
          }
        }
      } catch {
        /* fall through to packed code */
      }
    }

    // 3. Approach B: Unpack packed JavaScript
    const unpacked = unpackPackedJs(html)
    const searchTarget = unpacked || html

    const fileMatch =
      searchTarget.match(/file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/) ||
      searchTarget.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/) ||
      searchTarget.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/)

    if (fileMatch && fileMatch[1]) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
      const title = titleMatch ? titleMatch[1].replace(/ - FileMoon.*$/i, '').trim() : 'FileMoon Video'
      return {
        title,
        url: fileMatch[1],
        isHls: true,
        referer: currentUrl,
        hoster: 'Filemoon',
      }
    }

    return null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Vidmoly Extractor                                                          */
/* -------------------------------------------------------------------------- */

export async function extractVidmoly(url, options = {}) {
  try {
    const parsed = new URL(url)
    const embedMatch = parsed.pathname.match(/\/embed-([a-zA-Z0-9]+)\.html/) || parsed.pathname.match(/\/([a-zA-Z0-9]+)$/)
    const embedId = embedMatch ? embedMatch[1] : ''

    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: 'https://vidmoly.to/',
      Cookie: embedId ? `cf_turnstile_demo_pass_${embedId}=1` : '',
      ...options.headers,
    }

    const res = await fetchHtml(url, { ...options, headers })
    if (!res.ok) return null
    const html = await res.text()

    const match =
      html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/) ||
      html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/)
    if (!match) return null

    const streamUrl = new URL(match[1], url).href
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidmoly.*$/i, '').trim() : 'Vidmoly Video'

    return {
      title,
      url: streamUrl,
      isHls: true,
      referer: 'https://vidmoly.to/',
      hoster: 'Vidmoly',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* DoodStream Extractor                                                       */
/* -------------------------------------------------------------------------- */

export async function extractDoodstream(url, options = {}) {
  try {
    const normalizedUrl = url.replace(/\/d\//, '/e/')
    const res = await fetchHtml(normalizedUrl, options)
    if (!res.ok) return null
    const html = await res.text()

    const passMatch = html.match(/\/pass_md5\/[^'"<>\s]+/)
    if (!passMatch) return null

    const baseOrigin = new URL(normalizedUrl).origin
    const passUrl = `${baseOrigin}${passMatch[0]}`

    const passRes = await fetchHtml(passUrl, {
      ...options,
      headers: { Referer: normalizedUrl },
    })
    if (!passRes.ok) return null
    const baseStream = (await passRes.text()).trim()
    if (!baseStream || baseStream.includes('RELOAD')) return null

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let token = ''
    for (let i = 0; i < 10; i++) token += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
    const finalUrl = `${baseStream}${token}?token=${passMatch[0].split('/').pop()}&expiry=${Date.now()}`

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Dood.*$/i, '').trim() : 'DoodStream Video'

    return {
      title,
      url: finalUrl,
      isHls: false,
      referer: normalizedUrl,
      hoster: 'Doodstream',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Streamtape Extractor                                                       */
/* -------------------------------------------------------------------------- */

export async function extractStreamtape(url, options = {}) {
  try {
    const normalizedUrl = url.replace(/\/v\//, '/e/')
    const res = await fetchHtml(normalizedUrl, options)
    if (!res.ok) return null
    const html = await res.text()

    // Streamtape constructs URL in JavaScript by concatenating substrings
    const match =
      html.match(/ById\(['"](?:norobotlink|robotlink)['"]\)\.innerHTML\s*=\s*([^;]+);/i) ||
      html.match(/innerHTML\s*=\s*([^\n;]+norobotlink[^\n;]+)/i) ||
      html.match(/(['"]\/\/streamtape\.com\/get_video\?[^;]+)/i)

    let finalLink = null
    if (match) {
      const expr = match[1]
      // Split on '+' and evaluate string substrings
      const parts = expr.split('+')
      let assembled = ''
      for (const part of parts) {
        const strMatch = part.match(/['"]([^'"]*)['"]/)
        if (!strMatch) continue
        let val = strMatch[1]
        // Sum up all .substring(n) offsets in this part
        const subMatches = [...part.matchAll(/\.substring\((\d+)\)/g)]
        for (const sm of subMatches) {
          val = val.substring(Number(sm[1]))
        }
        assembled += val
      }
      if (assembled) {
        finalLink = (assembled.startsWith('//') ? `https:${assembled}` : assembled) + '&stream=1'
      }
    }

    if (!finalLink) {
      // Fallback: search get_video in page
      const gvMatch = html.match(/(https?:\/\/[^'"]+streamtape\.com\/get_video\?[^'"]+)/)
      if (gvMatch) finalLink = gvMatch[1] + '&stream=1'
    }

    if (!finalLink) return null

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/name="og:title"\s+content="([^"]+)"/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Streamtape.*$/i, '').trim() : 'Streamtape Video'

    return {
      title,
      url: finalLink,
      isHls: false,
      referer: 'https://streamtape.com/',
      hoster: 'Streamtape',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Vidoza Extractor                                                           */
/* -------------------------------------------------------------------------- */

export async function extractVidoza(url, options = {}) {
  try {
    const res = await fetchHtml(url, options)
    if (!res.ok) return null
    const html = await res.text()

    const srcMatch =
      html.match(/<source\s+src=['"]([^'"]+)['"]\s+type=['"]video\/mp4['"]/i) ||
      html.match(/sourcesCode\s*:\s*\[\{\s*src\s*:\s*['"]([^'"]+)['"]/i) ||
      html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i)

    if (!srcMatch) return null

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidoza.*$/i, '').trim() : 'Vidoza Video'

    return {
      title,
      url: srcMatch[1],
      isHls: false,
      referer: 'https://vidoza.net/',
      hoster: 'Vidoza',
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* AniWorld & SerienStream (s.to) Parser                                      */
/* -------------------------------------------------------------------------- */

const LANGUAGE_LABELS = {
  1: 'Deutsch',
  2: 'Englisch Sub',
  3: 'Deutsch Sub',
}

/**
 * Resolves an aniworld.to / s.to /redirect/{id} link to its hoster destination.
 */
async function resolveAniworldRedirect(redirectUrl, referer, options = {}) {
  try {
    const res = await fetchHtml(redirectUrl, {
      ...options,
      redirect: 'manual',
      headers: { Referer: referer, ...options.headers },
    })
    const loc = res.headers.get('location')
    if (loc) {
      return new URL(loc, redirectUrl).href
    }
    // If followed or 200 returned
    if (res.url && res.url !== redirectUrl) {
      return res.url
    }
    return null
  } catch {
    return null
  }
}

/**
 * Parses an AniWorld or SerienStream (s.to) season or series page,
 * extracting all episode URLs and metadata in order.
 */
export async function extractAniworldSeason(url, options = {}) {
  try {
    const res = await fetchHtml(url, options)
    if (!res.ok) return null
    const html = await res.text()

    const pageUrl = new URL(url)
    const baseOrigin = pageUrl.origin

    const seriesTitleMatch =
      html.match(/<div class="series-title"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<h1\b[^>]*\bitemprop=['"]name['"][^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<meta property="og:title" content="([^"]+)"/i)
    const seriesTitle = (seriesTitleMatch ? seriesTitleMatch[1] : 'Anime')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .trim()

    const seasonMatch = pageUrl.pathname.match(/staffel-(\d+)/i)
    const seasonNum = seasonMatch ? Number(seasonMatch[1]) : 1

    const episodes = []
    const trMatches = html.matchAll(/<tr[^>]*data-episode-id=[\s\S]*?<\/tr>/gi)

    for (const trMatch of trMatches) {
      const tr = trMatch[0]
      const linkMatch = tr.match(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/staffel-\d+\/episode-\d+)['"]/i)
      if (!linkMatch) continue

      const epUrl = `${baseOrigin}${linkMatch[1]}`
      const epNumMatch = tr.match(/itemprop=['"]episodeNumber['"]\s+content=['"](\d+)['"]/i) || linkMatch[1].match(/episode-(\d+)/i)
      const epNum = epNumMatch ? Number(epNumMatch[1]) : episodes.length + 1

      const deTitleMatch = tr.match(/<strong>([^<]+)<\/strong>/i)
      const subTitleMatch = tr.match(/<span>([^<]+)<\/span>/i)
      const germanTitle = deTitleMatch ? deTitleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim() : ''
      const secondTitle = subTitleMatch ? subTitleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim() : ''
      const epName = germanTitle || secondTitle

      const numTag = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
      const fullTitle = `${seriesTitle} - ${numTag}${epName ? ` - ${epName}` : ''}`

      episodes.push({
        episodeNumber: epNum,
        seasonNumber: seasonNum,
        title: fullTitle,
        url: epUrl,
      })
    }

    if (episodes.length === 0) {
      const epLinks = [
        ...new Set([...html.matchAll(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/staffel-\d+\/episode-\d+)['"]/gi)].map((m) => m[1])),
      ]
      for (let i = 0; i < epLinks.length; i++) {
        const epPath = epLinks[i]
        const epNumMatch = epPath.match(/episode-(\d+)/i)
        const epNum = epNumMatch ? Number(epNumMatch[1]) : i + 1
        const numTag = `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
        episodes.push({
          episodeNumber: epNum,
          seasonNumber: seasonNum,
          title: `${seriesTitle} - ${numTag}`,
          url: `${baseOrigin}${epPath}`,
        })
      }
    }

    if (episodes.length === 0) return null

    return {
      isPlaylist: true,
      title: `${seriesTitle} - Staffel ${seasonNum}`,
      seriesTitle,
      seasonNumber: seasonNum,
      count: episodes.length,
      items: episodes,
    }
  } catch {
    return null
  }
}

/**
 * Parses an AniWorld or SerienStream (s.to) episode or movie page, finds all
 * available hoster links, and resolves them to direct playable streams.
 */
export async function extractAniworld(url, options = {}) {
  if (isAniworldSeasonUrl(url)) {
    return extractAniworldSeason(url, options)
  }
  try {
    const res = await fetchHtml(url, options)
    if (!res.ok) return null
    const html = await res.text()

    const pageUrl = new URL(url)
    const baseOrigin = pageUrl.origin

    // 1. Extract titles & metadata
    const seriesTitleMatch =
      html.match(/<div class="series-title"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<h1\b[^>]*\bitemprop=['"]name['"][^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<meta property="og:title" content="([^"]+)"/i)
    const seriesTitle = seriesTitleMatch ? seriesTitleMatch[1].trim() : 'Anime'

    const episodeGermanMatch = html.match(/<span class="episodeGermanTitle"[^>]*>([^<]+)<\/span>/i)
    const episodeEnglishMatch = html.match(/<small class="episodeEnglishTitle"[^>]*>([^<]+)<\/small>/i)
    const episodeGerman = episodeGermanMatch ? episodeGermanMatch[1].trim() : ''
    const episodeEnglish = episodeEnglishMatch ? episodeEnglishMatch[1].trim() : ''

    const seasonMatch = pageUrl.pathname.match(/staffel-(\d+)/i)
    const epMatch = pageUrl.pathname.match(/episode-(\d+)/i)
    const filmMatch = pageUrl.pathname.match(/filme(?:\/film-(\d+))?/i)

    const seasonNum = seasonMatch ? Number(seasonMatch[1]) : filmMatch ? 0 : 1
    const epNum = epMatch ? Number(epMatch[1]) : filmMatch ? Number(filmMatch[1] || 1) : 1

    const numTag = filmMatch ? `Film ${epNum}` : `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
    const epTitle = episodeGerman || episodeEnglish || numTag
    const compoundTitle = `${seriesTitle} - ${numTag}${episodeGerman ? ` - ${episodeGerman}` : episodeEnglish ? ` - ${episodeEnglish}` : ''}`

    // 2. Extract hoster elements
    // AniWorld has <li ... data-lang-key="X" ... data-link-target="/redirect/Y">
    const hosterEntries = []
    const liMatches = html.matchAll(/<li\b[^>]*class=['"][^'"]*episodeLink[^'"]*['"][^>]*>([\s\S]*?)<\/li>/gi)

    for (const match of liMatches) {
      const liInner = match[1]
      const wholeLi = match[0]

      const langMatch = wholeLi.match(/data-lang-key=['"](\d+)['"]/)
      const targetMatch =
        wholeLi.match(/data-link-target=['"]([^'"]+)['"]/) ||
        wholeLi.match(/href=['"]([^'"]*\/redirect\/\d+)['"]/)
      const hosterNameMatch =
        liInner.match(/<h4[^>]*>([^<]+)<\/h4>/i) ||
        wholeLi.match(/title=['"](?:Hoster\s+)?([A-Za-z0-9_-]+)['"]/i)

      if (targetMatch && hosterNameMatch) {
        const langKey = langMatch ? Number(langMatch[1]) : 1
        const rawTarget = targetMatch[1]
        const redirectUrl = rawTarget.startsWith('http') ? rawTarget : `${baseOrigin}${rawTarget}`
        const hosterName = hosterNameMatch[1].trim()
        hosterEntries.push({
          langKey,
          langLabel: LANGUAGE_LABELS[langKey] || 'Sprache',
          hosterName,
          redirectUrl,
        })
      }
    }

    // Fallback: If no li.episodeLink, scan directly for /redirect/ links
    if (hosterEntries.length === 0) {
      const redirectMatches = html.matchAll(/href=['"](\/redirect\/\d+)['"][^>]*>[\s\S]*?<h4[^>]*>([^<]+)<\/h4>/gi)
      for (const m of redirectMatches) {
        hosterEntries.push({
          langKey: 1,
          langLabel: 'Standard',
          hosterName: m[2].trim(),
          redirectUrl: `${baseOrigin}${m[1]}`,
        })
      }
    }

    if (hosterEntries.length === 0) {
      // If it's a season or series page with episode links, return episode discovery
      const episodeLinkMatches = [
        ...html.matchAll(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/staffel-\d+\/episode-\d+)['"]/gi),
      ]
      if (episodeLinkMatches.length > 0) {
        const firstEp = `${baseOrigin}${episodeLinkMatches[0][1]}`
        return extractAniworld(firstEp, options)
      }
      return null
    }

    // 3. Provider priority order: VOE > Filemoon > Vidmoly > Streamtape > Vidoza > Doodstream
    const hosterPriority = ['voe', 'filemoon', 'vidmoly', 'streamtape', 'vidoza', 'doodstream', 'dood']
    function scoreEntry(entry) {
      const hostIdx = hosterPriority.findIndex((h) => entry.hosterName.toLowerCase().includes(h))
      const hostScore = hostIdx >= 0 ? 100 - hostIdx * 10 : 0
      // Prefer German Sub (3) or German Dub (1) over English (2)
      const langScore = entry.langKey === 3 ? 30 : entry.langKey === 1 ? 25 : 15
      return hostScore + langScore
    }

    const sortedEntries = [...hosterEntries].sort((a, b) => scoreEntry(b) - scoreEntry(a))

    // 4. Resolve the best available provider
    const resolvedStreams = []
    for (const entry of sortedEntries) {
      const embedUrl = await resolveAniworldRedirect(entry.redirectUrl, url, options)
      if (!embedUrl) continue

      const direct = await extractDirectHoster(embedUrl, options)
      if (direct && direct.url) {
        resolvedStreams.push({
          id: `${entry.hosterName.toLowerCase()}-${entry.langKey}`,
          label: `${entry.hosterName} · ${entry.langLabel}`,
          provider: entry.hosterName,
          language: entry.langLabel,
          url: direct.url,
          isHls: direct.isHls,
          referer: direct.referer,
          ext: direct.isHls ? 'mp4' : direct.url.includes('.mp4') ? 'mp4' : 'm4a',
        })
        // Break after collecting top working stream to keep resolve fast
        if (resolvedStreams.length >= 1) break
      }
    }

    if (resolvedStreams.length === 0) return null

    const primary = resolvedStreams[0]
    return {
      title: compoundTitle,
      seriesTitle,
      season: seasonNum,
      episode: epNum,
      url: primary.url,
      isHls: primary.isHls,
      referer: primary.referer,
      hoster: primary.provider,
      streams: resolvedStreams,
      allEntries: hosterEntries,
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Universal Hosters Dispatcher                                               */
/* -------------------------------------------------------------------------- */

export async function extractDirectHoster(rawUrl, options = {}) {
  if (isVoeUrl(rawUrl)) return extractVoe(rawUrl, options)
  if (isFilemoonUrl(rawUrl)) return extractFilemoon(rawUrl, options)
  if (isVidmolyUrl(rawUrl)) return extractVidmoly(rawUrl, options)
  if (isStreamtapeUrl(rawUrl)) return extractStreamtape(rawUrl, options)
  if (isVidozaUrl(rawUrl)) return extractVidoza(rawUrl, options)
  if (isDoodstreamUrl(rawUrl)) return extractDoodstream(rawUrl, options)

  // Generic fallback: test VOE decoding (many unbranded clones)
  try {
    const voeAttempt = await extractVoe(rawUrl, options)
    if (voeAttempt) return voeAttempt
  } catch {}

  return null
}

/**
 * Top-level media extraction for any URL:
 * Handles AniWorld, SerienStream (s.to), and all embed hosters.
 */
export async function extractDirectMedia(rawUrl, options = {}) {
  if (isAniworldUrl(rawUrl)) {
    return extractAniworld(rawUrl, options)
  }
  return extractDirectHoster(rawUrl, options)
}
