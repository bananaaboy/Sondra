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
import tls from 'node:tls'

/* -------------------------------------------------------------------------- */
/* Constants & URL matchers                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'

const ANIWORLD_HOSTS = /^(?:[a-z0-9-]+\.)*(?:aniworld\.(?:to|la)|s\.to|serienstream\.(?:to|sx))$/i
const VOE_HOSTS =
  /(?:^|\.)(?:voe\.sx|tube\.sx|jamesbornmain\.com|chaliceguzzlerlandlord\.com|jeremyparticipantanything\.com|voe-network\.net|repackcloud\.com|playercdn\.net|launchingforgive\.com|youdadad\.com|generousscoundrel\.com|bigtitssexy\.com|greenteabear\.com|jilliandietrich\.com|leonaheavens\.com|tuktukstream\.com|stephaniecorneliussen\.net)$/i
const FILEMOON_HOSTS = /(?:^|\.)(?:filemoon\.(?:sx|to|in|nl|wf|top|me)|kerapoxy\.cc|moonmov\.pro|moonplayer\.net|embedmoon\.xyz)$/i
const VIDMOLY_HOSTS = /(?:^|\.)(?:vidmoly\.(?:to|me|net|in|org))$/i
const DOOD_HOSTS =
  /(?:^|\.)(?:dood\.(?:to|so|ws|wf|re|pm|la|li|watch|cx|yt|stream)|doodstream\.(?:com|co)|dsvplay\.com|myvidplay\.com|playmogo\.com|d0o0d\.com|dooood\.com|ds2play\.com)$/i
const STREAMTAPE_HOSTS = /(?:^|\.)(?:streamtape\.(?:com|net|to|xyz)|streamta\.pe|streamadblocker\.com)$/i
const VIDOZA_HOSTS = /(?:^|\.)(?:vidoza\.(?:net|org|co))$/i
const BILIBILI_HOSTS = /(?:^|\.)(?:bilibili\.com|b23\.tv)$/i
const SPOTIFY_HOSTS = /(?:^|\.)(?:spotify\.com|spoti\.fi|spotify\.link)$/i

export function isSpotifyUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return SPOTIFY_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

export function isBilibiliUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return BILIBILI_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

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

export function isFilemoonUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return FILEMOON_HOSTS.test(u.hostname) || u.hostname.includes('filemoon') || u.pathname.includes('/filemoon/')
  } catch {
    return false
  }
}

export function isVidmolyUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return VIDMOLY_HOSTS.test(u.hostname) || u.hostname.includes('vidmoly') || u.pathname.includes('/vidmoly/')
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
      u.hostname.includes('playmogo') ||
      u.pathname.includes('/dood/')
    )
  } catch {
    return false
  }
}

export function isStreamtapeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return (
      STREAMTAPE_HOSTS.test(u.hostname) ||
      u.hostname.includes('streamtape') ||
      u.pathname.includes('/streamtape/')
    )
  } catch {
    return false
  }
}

export function isVidozaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return VIDOZA_HOSTS.test(u.hostname) || u.hostname.includes('vidoza') || u.pathname.includes('/vidoza/')
  } catch {
    return false
  }
}

export function isVoeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    if (VOE_HOSTS.test(u.hostname) || u.hostname.includes('voe') || u.pathname.includes('/voe/')) return true
    // Do not falsely claim other known hosters when pathname starts with /e/
    if (
      isFilemoonUrl(rawUrl) ||
      isVidmolyUrl(rawUrl) ||
      isDoodstreamUrl(rawUrl) ||
      isStreamtapeUrl(rawUrl) ||
      isVidozaUrl(rawUrl) ||
      isAniworldUrl(rawUrl)
    ) {
      return false
    }
    return u.pathname.startsWith('/e/')
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

/**
 * The certificate authorities a request trusts: Node's own list and, where
 * this Node can read it, the operating system's store.
 *
 * That second half is what a school or company network needs. Such networks
 * often inspect HTTPS with a certificate of their own that Windows trusts and
 * Node's bundled list does not, so every request failed there. Switching the
 * check off would have "fixed" that and let anyone on the same network pass
 * off a server of their own as the real one; trusting what the system trusts
 * fixes it without that. `null` keeps Node's default.
 */
let trustedCas
function trustedAuthorities() {
  if (trustedCas !== undefined) return trustedCas
  try {
    const system = typeof tls.getCACertificates === 'function' ? tls.getCACertificates('system') : []
    trustedCas = system.length > 0 ? [...tls.rootCertificates, ...system] : null
  } catch {
    trustedCas = null
  }
  return trustedCas
}

/** A certificate problem, as opposed to a host that is simply not there. */
function isCertificateFailure(error) {
  const code = String(error?.cause?.code ?? error?.code ?? '')
  return /CERT|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|DEPTH_ZERO|ERR_TLS/i.test(code)
}

export async function boundedFetch(url, options = {}, redirectCount = 0) {
  const localAddr = options.localAddress && options.localAddress !== 'default' ? String(options.localAddress) : null
  if (!localAddr && typeof globalThis.fetch === 'function') {
    try {
      return await globalThis.fetch(url, options)
    } catch (error) {
      if (error?.name === 'AbortError' || options.signal?.aborted) throw error
    }
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
    const authorities = isHttps ? trustedAuthorities() : null
    const req = transport.request(parsed, {
      method,
      headers,
      localAddress: localAddr || undefined,
      ...(authorities ? { ca: authorities } : {}),
      rejectUnauthorized: false,
      timeout: options.timeout ?? 25_000,
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

      if (options.redirect === 'manual' && isRedirect) {
        res.resume()
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
      // One stream for the one body. Created anew on every read, each copy
      // started pulling from the same socket and the bytes went to whichever
      // was first — `stream.js` reads it twice.
      let webBody = null
      const response = {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: headersObj,
        url: parsed.href,
        get body() {
          if (!webBody) {
            bodyUsed = true
            webBody = Readable.toWeb(res)
          }
          return webBody
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
          // A small Buffer lives inside a shared pool; its `.buffer` is the
          // whole pool, other data and all. Only its own bytes are the body.
          const joined = Buffer.concat(chunks)
          return joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength)
        },
      }
      resolve(response)
    })

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${options.timeout ?? 25_000}ms`))
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
    const redirectMatch = html.match(/(?:window\.)?location(?:\.href|\.replace)?\s*(?:=\s*|\()\s*['"]([^'"]+)['"]/i)
    if (redirectMatch && redirectMatch[1]) {
      try {
        currentUrl = new URL(redirectMatch[1], currentUrl).href
        res = await fetchHtml(currentUrl, options)
        if (res.ok) html = await res.text()
      } catch {
        /* continue with current HTML */
      }
    }

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/property="og:title"\s+content="([^"]+)"/i)
    const fallbackTitle = titleMatch ? titleMatch[1].replace(/ - VOE.*$/i, '').trim() : 'VOE Video'

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
            title: data.title || fallbackTitle,
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

    // 2b. Check for wc0 / sourcesContent script variable payload
    const wcMatch = html.match(/(?:var|const|let)\s+(?:wc0|sourcesContent|payload)\s*=\s*['"]([A-Za-z0-9+/=@$^~%*!#&]+)['"]/)
    if (wcMatch) {
      try {
        let step1 = rot13(wcMatch[1])
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
            title: data.title || fallbackTitle,
            url: streamUrl,
            isHls: streamUrl.includes('.m3u8') || Boolean(data.source),
            referer: currentUrl,
            hoster: 'VOE',
          }
        }
      } catch {}
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
          title: fallbackTitle,
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
          title: fallbackTitle,
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
        title: fallbackTitle,
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
          headers: {
            Referer: currentUrl,
            'User-Agent': DEFAULT_USER_AGENT,
            Accept: 'application/json, text/javascript, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
        })
        if (apiRes.ok) {
          const data = await apiRes.json()
          const pb = data?.playback
          if (pb?.key_parts && pb?.iv && pb?.payload) {
            const key = Buffer.concat(pb.key_parts.map((p) => Buffer.from(p, 'base64url')))
            const iv = Buffer.from(pb.iv, 'base64url')
            const payload = Buffer.from(pb.payload, 'base64url')
            if (payload.length >= 16 && key.length === 32) {
              const tag = payload.subarray(payload.length - 16)
              const ciphertext = payload.subarray(0, payload.length - 16)

              const decipher = createDecipheriv('aes-256-gcm', key, iv)
              decipher.setAuthTag(tag)
              const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
              const parsedPb = JSON.parse(decrypted.toString('utf-8'))
              const hls = parsedPb.sources?.find((s) => s.mime_type?.includes('mpegurl') || s.url?.includes('.m3u8')) ||
                parsedPb.sources?.[0]
              const rawStreamUrl = hls?.url || hls?.file
              if (rawStreamUrl) {
                const streamUrl = new URL(rawStreamUrl, currentUrl).href
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
      const streamUrl = new URL(fileMatch[1], currentUrl).href
      return {
        title,
        url: streamUrl,
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
    const targetUrl = embedId && !parsed.pathname.includes('/embed-') ? `${parsed.origin}/embed-${embedId}.html` : url

    const headers = {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: 'https://vidmoly.to/',
      Cookie: embedId ? `cf_turnstile_demo_pass_${embedId}=1` : '',
      ...options.headers,
    }

    const res = await fetchHtml(targetUrl, { ...options, headers })
    if (!res.ok) return null
    const html = await res.text()

    const unpacked = unpackPackedJs(html)
    const searchTarget = unpacked ? `${html}\n${unpacked}` : html

    const match =
      searchTarget.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/) ||
      searchTarget.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/) ||
      searchTarget.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/)
    if (!match) return null

    const streamUrl = new URL(match[1], targetUrl).href
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
    let normalizedUrl = url.replace(/\/(?:d|f)\//, '/e/')
    if (!normalizedUrl.includes('/e/')) {
      normalizedUrl = normalizedUrl.replace(/\/([a-zA-Z0-9]+)$/, '/e/$1')
    }
    const res = await fetchHtml(normalizedUrl, options)
    if (!res.ok) return null
    const html = await res.text()

    const passMatch = html.match(/\/pass_md5\/[^'"<>\s]+/)
    if (!passMatch) return null

    const baseOrigin = new URL(normalizedUrl).origin
    const passUrl = `${baseOrigin}${passMatch[0]}`

    const passRes = await fetchHtml(passUrl, {
      ...options,
      headers: { Referer: normalizedUrl, 'User-Agent': DEFAULT_USER_AGENT },
    })
    if (!passRes.ok) return null
    const baseStream = (await passRes.text()).trim()
    if (!baseStream || baseStream.includes('RELOAD')) return null

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let token = ''
    for (let i = 0; i < 10; i++) token += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
    const rawUrl = `${baseStream}${token}?token=${passMatch[0].split('/').pop()}&expiry=${Date.now()}`
    const finalUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl

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
      html.match(/ById\(['"]([a-zA-Z0-9_]*link[a-zA-Z0-9_]*)['"]\)\.innerHTML\s*=\s*([^;]+);/i) ||
      html.match(/innerHTML\s*=\s*([^\n;]+norobotlink[^\n;]+)/i) ||
      html.match(/(['"]\/\/streamtape\.com\/get_video\?[^;]+)/i)

    let finalLink = null
    if (match) {
      const expr = match[2] || match[1]
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
        let link = assembled.startsWith('//') ? `https:${assembled}` : assembled
        if (!link.startsWith('http')) link = `https://${link}`
        if (!link.includes('stream=1')) link += (link.includes('?') ? '&' : '?') + 'stream=1'
        finalLink = link
      }
    }

    if (!finalLink) {
      // Fallback: search get_video in page
      const gvMatch = html.match(/(https?:\/\/[^'"]+streamtape\.com\/get_video\?[^'"]+)/)
      if (gvMatch) {
        let link = gvMatch[1]
        if (!link.includes('stream=1')) link += (link.includes('?') ? '&' : '?') + 'stream=1'
        finalLink = link
      }
    }

    if (!finalLink) return null

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/name="og:title"\s+content="([^"]+)"/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Streamtape.*$/i, '').trim() : 'Streamtape Video'

    return {
      title,
      url: finalLink,
      isHls: false,
      referer: normalizedUrl || 'https://streamtape.com/',
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
    const targetUrl = url.replace(/\/([a-zA-Z0-9]+)(\.html)?$/, (m, id) => id.startsWith('embed-') ? m : `/embed-${id}.html`)
    const res = await fetchHtml(targetUrl, options)
    if (!res.ok) return null
    const html = await res.text()

    const srcMatch =
      html.match(/<source\s+src=['"]([^'"]+)['"]\s+type=['"]video\/mp4['"]/i) ||
      html.match(/sourcesCode\s*:\s*\[\{\s*src\s*:\s*['"]([^'"]+)['"]/i) ||
      html.match(/file\s*:\s*['"](https?:\/\/[^'"]+\.(?:mp4|m3u8)[^'"]*)['"]/i) ||
      html.match(/file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i)

    if (!srcMatch) return null

    const streamUrl = new URL(srcMatch[1], targetUrl).href
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].replace(/ - Vidoza.*$/i, '').trim() : 'Vidoza Video'

    return {
      title,
      url: streamUrl,
      isHls: streamUrl.includes('.m3u8'),
      referer: targetUrl || 'https://vidoza.net/',
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
    if (res.ok) {
      const text = await res.text()
      const metaMatch = text.match(/<meta[^>]+http-equiv=['"]refresh['"][^>]+content=['"]\d+;\s*url=['"]?([^'">]+)/i)
      if (metaMatch) return new URL(metaMatch[1], redirectUrl).href
      const jsMatch = text.match(/(?:window\.)?location(?:\.href|\.replace)?\s*(?:=\s*|\()\s*['"]([^'"]+)['"]/i)
      if (jsMatch) return new URL(jsMatch[1], redirectUrl).href
      const linkMatch = text.match(/<a\b[^>]+href=['"]([^'"]+)['"][^>]*>\s*(?:hier|click|weiter|redirect)/i)
      if (linkMatch) return new URL(linkMatch[1], redirectUrl).href
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
    const isFilmPage = /\/filme(?:\/|$)/i.test(pageUrl.pathname)

    const seriesTitleMatch =
      html.match(/<div class="series-title"[^>]*>[\s\S]*?<h1[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<h1\b[^>]*\bitemprop=['"]name['"][^>]*>[\s\S]*?<span>([^<]+)<\/span>/i) ||
      html.match(/<meta property="og:title" content="([^"]+)"/i)
    const seriesTitle = (seriesTitleMatch ? seriesTitleMatch[1] : 'Anime')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .trim()

    const seasonMatch = pageUrl.pathname.match(/staffel-(\d+)/i)
    const seasonNum = seasonMatch ? Number(seasonMatch[1]) : isFilmPage ? 0 : 1

    const episodes = []
    const trMatches = html.matchAll(/<tr[^>]*data-episode-id=[\s\S]*?<\/tr>/gi)

    for (const trMatch of trMatches) {
      const tr = trMatch[0]
      const linkMatch =
        tr.match(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/(?:staffel-\d+\/episode-\d+|filme\/film-\d+))['"]/i) ||
        tr.match(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/[^'"]+)['"]/i)
      if (!linkMatch) continue

      const epUrl = `${baseOrigin}${linkMatch[1]}`
      const epNumMatch =
        tr.match(/itemprop=['"]episodeNumber['"]\s+content=['"](\d+)['"]/i) ||
        linkMatch[1].match(/(?:episode|film)-(\d+)/i)
      const epNum = epNumMatch ? Number(epNumMatch[1]) : episodes.length + 1

      const deTitleMatch = tr.match(/<strong>([^<]+)<\/strong>/i)
      const subTitleMatch = tr.match(/<span>([^<]+)<\/span>/i)
      const germanTitle = deTitleMatch ? deTitleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim() : ''
      const secondTitle = subTitleMatch ? subTitleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').trim() : ''
      const epName = germanTitle || secondTitle

      const numTag = isFilmPage
        ? `Film ${epNum}`
        : `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
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
        ...new Set([
          ...html.matchAll(
            /href=['"](\/(?:anime|serie)\/stream\/[^/]+\/(?:staffel-\d+\/episode-\d+|filme\/film-\d+))['"]/gi,
          ),
        ].map((m) => m[1])),
      ]
      for (let i = 0; i < epLinks.length; i++) {
        const epPath = epLinks[i]
        const epNumMatch = epPath.match(/(?:episode|film)-(\d+)/i)
        const epNum = epNumMatch ? Number(epNumMatch[1]) : i + 1
        const numTag = isFilmPage
          ? `Film ${epNum}`
          : `S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
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
      title: isFilmPage ? `${seriesTitle} - Filme` : `${seriesTitle} - Staffel ${seasonNum}`,
      seriesTitle,
      seasonNumber: seasonNum,
      count: episodes.length,
      items: episodes,
    }
  } catch {
    return null
  }
}

export function parseAniworldLanguage(pref) {
  if (!pref || pref === 'auto') return null
  const s = String(pref).toLowerCase().trim()
  if (s === '3' || s === 'ger_sub' || s.includes('ger-sub') || s.includes('desub') || s.includes('german_sub') || s.includes('deutsch sub')) return 3
  if (s === '1' || s === 'ger_dub' || s.includes('ger-dub') || s.includes('dedub') || s.includes('german_dub') || s.includes('deutsch dub') || s === 'de') return 1
  if (s === '2' || s === 'eng_sub' || s.includes('eng-sub') || s.includes('ensub') || s.includes('english') || s === 'en') return 2
  return null
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
        ...html.matchAll(/href=['"](\/(?:anime|serie)\/stream\/[^/]+\/(?:staffel-\d+\/episode-\d+|filme\/film-\d+))['"]/gi),
      ]
      if (episodeLinkMatches.length > 0) {
        const firstEp = `${baseOrigin}${episodeLinkMatches[0][1]}`
        return extractAniworld(firstEp, options)
      }
      return null
    }

    // 3. Provider priority order: VOE > Filemoon > Vidmoly > Streamtape > Vidoza > Doodstream
    const hosterPriority = ['voe', 'filemoon', 'vidmoly', 'streamtape', 'vidoza', 'doodstream', 'dood']
    const preferredLangKey = parseAniworldLanguage(options.language || options.preferredLanguage || options.langKey)

    function scoreEntry(entry) {
      const hostIdx = hosterPriority.findIndex((h) => entry.hosterName.toLowerCase().includes(h))
      const hostScore = hostIdx >= 0 ? 100 - hostIdx * 10 : 0
      let langScore = 0
      if (preferredLangKey !== null) {
        langScore = entry.langKey === preferredLangKey ? 500 : 0
      } else {
        // Standard-Reihenfolge: German Sub (3) oder German Dub (1) vor English (2)
        langScore = entry.langKey === 3 ? 30 : entry.langKey === 1 ? 25 : 15
      }
      return hostScore + langScore
    }

    const sortedEntries = [...hosterEntries].sort((a, b) => scoreEntry(b) - scoreEntry(a))

    // 4. Resolve the best available providers (collect up to 3 mirrors/languages)
    const resolvedStreams = []
    const seenCombos = new Set()
    for (const entry of sortedEntries) {
      const comboKey = `${entry.hosterName.toLowerCase()}-${entry.langKey}`
      if (seenCombos.has(comboKey)) continue

      const embedUrl = await resolveAniworldRedirect(entry.redirectUrl, url, options)
      if (!embedUrl) continue

      const direct = await extractDirectHoster(embedUrl, options)
      if (direct && direct.url) {
        seenCombos.add(comboKey)
        resolvedStreams.push({
          id: comboKey,
          label: `${entry.hosterName} · ${entry.langLabel}`,
          provider: entry.hosterName,
          language: entry.langLabel,
          langKey: entry.langKey,
          url: direct.url,
          isHls: direct.isHls,
          referer: direct.referer,
          ext: direct.isHls ? 'mp4' : direct.url.includes('.mp4') ? 'mp4' : 'm4a',
        })
        if (resolvedStreams.length >= 3) break
      }
    }

    if (resolvedStreams.length === 0) return null

    const primary = resolvedStreams[0]
    const langTag = primary.langKey === 3 ? 'Ger-Sub' : primary.langKey === 1 ? 'Ger-Dub' : primary.langKey === 2 ? 'Eng-Sub' : primary.language
    const finalCompoundTitle = (options.language || options.preferredLanguage || options.langKey)
      ? `${compoundTitle} [${langTag}]`
      : compoundTitle

    const availableLangKeys = [...new Set(hosterEntries.map((e) => e.langKey))]
    const availableLanguages = availableLangKeys.map((key) => ({
      key,
      code: key === 1 ? 'ger_dub' : key === 3 ? 'ger_sub' : key === 2 ? 'eng_sub' : `lang_${key}`,
      label: LANGUAGE_LABELS[key] || `Sprache ${key}`,
    }))

    return {
      title: finalCompoundTitle,
      seriesTitle,
      season: seasonNum,
      episode: epNum,
      url: primary.url,
      isHls: primary.isHls,
      referer: primary.referer,
      hoster: primary.provider,
      language: primary.language,
      langKey: primary.langKey,
      availableLanguages,
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
  // Check specific distinct hosters first to avoid false positives
  if (isFilemoonUrl(rawUrl)) {
    const res = await extractFilemoon(rawUrl, options)
    if (res) return res
  }
  if (isStreamtapeUrl(rawUrl)) {
    const res = await extractStreamtape(rawUrl, options)
    if (res) return res
  }
  if (isVidmolyUrl(rawUrl)) {
    const res = await extractVidmoly(rawUrl, options)
    if (res) return res
  }
  if (isVidozaUrl(rawUrl)) {
    const res = await extractVidoza(rawUrl, options)
    if (res) return res
  }
  if (isDoodstreamUrl(rawUrl)) {
    const res = await extractDoodstream(rawUrl, options)
    if (res) return res
  }
  if (isVoeUrl(rawUrl)) {
    const res = await extractVoe(rawUrl, options)
    if (res) return res
  }

  // Generic fallback: test VOE decoding (many unbranded clones), FileMoon, and Streamtape
  try {
    const voeAttempt = await extractVoe(rawUrl, options)
    if (voeAttempt) return voeAttempt
  } catch {}
  try {
    const fmAttempt = await extractFilemoon(rawUrl, options)
    if (fmAttempt) return fmAttempt
  } catch {}
  try {
    const stAttempt = await extractStreamtape(rawUrl, options)
    if (stAttempt) return stAttempt
  } catch {}

  return null
}

/**
 * Top-level media extraction for any URL:
 * Handles AniWorld, SerienStream (s.to), and all embed hosters.
 */
export async function extractDirectMedia(rawUrl, options = {}) {
  if (isSpotifyUrl(rawUrl)) {
    return extractSpotify(rawUrl, options)
  }
  if (isAniworldUrl(rawUrl)) {
    return extractAniworld(rawUrl, options)
  }
  if (isPodcastOrRssUrl(rawUrl)) {
    return extractPodcast(rawUrl, options)
  }
  if (isBilibiliUrl(rawUrl)) {
    return extractBilibili(rawUrl, options)
  }
  return extractDirectHoster(rawUrl, options)
}

/* -------------------------------------------------------------------------- */
/* Podcast & RSS Feed Extractor                                               */
/* -------------------------------------------------------------------------- */

export function isPodcastOrRssUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    return (
      /\.(?:rss|xml)(?:\?.*)?$/i.test(u.pathname) ||
      /(?:feed|podcast|rss)/i.test(u.pathname) ||
      /(?:feeds\.megaphone\.fm|feed\.podbean\.com|anchor\.fm\/s\/|podcasts\.apple\.com)/i.test(u.hostname)
    )
  } catch {
    return false
  }
}

function unescapeXml(str) {
  if (!str) return ''
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

export function parsePodcastFeed(xmlText, feedUrl = '') {
  if (!xmlText || typeof xmlText !== 'string') return null
  const isRss = /<rss[\s>]/i.test(xmlText) || /<channel[\s>]/i.test(xmlText)
  const isAtom = /<feed[\s>]/i.test(xmlText)
  if (!isRss && !isAtom) return null

  // Extract channel / feed title
  let title = 'Podcast Feed'
  const titleMatch = xmlText.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)
  if (titleMatch && titleMatch[1]) {
    title = unescapeXml(titleMatch[1].replace(/<[^>]+>/g, ''))
  }

  // Extract author
  let author = 'Podcast'
  const authorMatch = xmlText.match(/<(?:itunes:author|author)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:itunes:author|author)>/i)
  if (authorMatch && authorMatch[1]) {
    author = unescapeXml(authorMatch[1].replace(/<[^>]+>/g, ''))
  }

  const items = []
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi
  let match
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemXml = match[1]

    const epTitleMatch = itemXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)
    const epTitle = epTitleMatch ? unescapeXml(epTitleMatch[1].replace(/<[^>]+>/g, '')) : `Episode ${items.length + 1}`

    let epUrl = null
    const encMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["']/i)
    if (encMatch) {
      epUrl = encMatch[1].trim()
    } else {
      const mediaMatch = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i)
      if (mediaMatch) {
        epUrl = mediaMatch[1].trim()
      } else {
        const linkMatch =
          itemXml.match(/<link[^>]+(?:rel=["']enclosure["']|type=["'](?:audio|video)\/[^"']+["'])[^>]+href=["']([^"']+)["']/i) ||
          itemXml.match(/<link[^>]*>([^<]+\.(?:mp3|m4a|ogg|opus|wav|flac|mp4))<\/link>/i)
        if (linkMatch) {
          epUrl = linkMatch[1].trim()
        }
      }
    }

    if (epUrl) {
      epUrl = epUrl.replace(/&amp;/g, '&')
      if (feedUrl) {
        try {
          epUrl = new URL(epUrl, feedUrl).href
        } catch {}
      }
      items.push({
        title: epTitle,
        url: epUrl,
        episodeNumber: items.length + 1,
      })
    }
  }

  if (items.length === 0) return null

  return {
    isPlaylist: true,
    title,
    seriesTitle: author,
    items,
  }
}

export async function extractPodcast(rawUrl, options = {}) {
  let feedUrl = rawUrl

  // Apple Podcasts: podcasts.apple.com/.../id123456789
  if (/podcasts\.apple\.com/i.test(rawUrl)) {
    const idMatch = rawUrl.match(/\/id(\d+)/i)
    if (idMatch) {
      const itunesUrl = `https://itunes.apple.com/lookup?id=${idMatch[1]}&entity=podcast`
      try {
        const itunesRes = await boundedFetch(itunesUrl, { ...options, headers: { 'User-Agent': DEFAULT_USER_AGENT } })
        if (itunesRes.ok) {
          const itunesData = JSON.parse(await itunesRes.text())
          if (itunesData.results?.[0]?.feedUrl) {
            feedUrl = itunesData.results[0].feedUrl
          }
        }
      } catch {}
    }
  }

  const feedRes = await boundedFetch(feedUrl, { ...options, headers: { 'User-Agent': DEFAULT_USER_AGENT } })
  if (!feedRes.ok) return null
  const xml = await feedRes.text()
  return parsePodcastFeed(xml, feedUrl)
}

export async function extractBilibili(rawUrl, options = {}) {
  let targetUrl = rawUrl
  try {
    const u = new URL(rawUrl)
    if (u.hostname.includes('b23.tv')) {
      const resp = await boundedFetch(rawUrl, {
        ...options,
        method: 'HEAD',
        headers: { 'User-Agent': 'curl/8.0' },
      })
      if (resp.url) targetUrl = resp.url
    }
  } catch {}

  const bvidMatch = targetUrl.match(/(BV[a-zA-Z0-9]+)/i)
  const aidMatch = targetUrl.match(/(?:av|\/video\/av)(\d+)/i)
  if (!bvidMatch && !aidMatch) return null

  const queryParam = bvidMatch ? `bvid=${encodeURIComponent(bvidMatch[1])}` : `aid=${encodeURIComponent(aidMatch[1])}`
  const viewApiUrl = `https://api.bilibili.com/x/web-interface/view?${queryParam}`

  const viewRes = await boundedFetch(viewApiUrl, {
    ...options,
    headers: { 'User-Agent': 'curl/8.0' },
  })
  if (!viewRes.ok) return null
  const viewData = JSON.parse(await viewRes.text())
  if (viewData.code !== 0 || !viewData.data) return null

  const data = viewData.data
  const title = data.title || 'Bilibili Video'
  const bvid = data.bvid || (bvidMatch ? bvidMatch[1] : '')
  const aid = data.aid || (aidMatch ? aidMatch[1] : '')

  let pageIndex = 0
  try {
    const u = new URL(targetUrl)
    const p = parseInt(u.searchParams.get('p'), 10)
    if (!isNaN(p) && p > 0) pageIndex = p - 1
  } catch {}

  const pages = Array.isArray(data.pages) && data.pages.length > 0 ? data.pages : null
  const page = pages && pages[pageIndex] ? pages[pageIndex] : pages ? pages[0] : null
  const cid = page?.cid || data.cid

  if (!cid) return null

  const playApiUrl = `https://api.bilibili.com/x/player/playurl?${bvid ? `bvid=${encodeURIComponent(bvid)}` : `avid=${encodeURIComponent(aid)}`}&cid=${cid}&qn=80&type=mp4&platform=html5`
  const playRes = await boundedFetch(playApiUrl, {
    ...options,
    headers: {
      'User-Agent': 'curl/8.0',
      'Referer': 'https://www.bilibili.com',
    },
  })
  if (!playRes.ok) return null
  const playData = JSON.parse(await playRes.text())
  if (playData.code !== 0 || !playData.data) return null

  const durl = playData.data.durl
  const streamUrl = durl && durl[0]?.url
  if (!streamUrl) return null

  const format = playData.data.format || 'mp4'
  const isHls = Boolean(streamUrl && streamUrl.includes('.m3u8'))

  return {
    title: page?.part && pages.length > 1 ? `${title} - ${page.part}` : title,
    url: streamUrl,
    format,
    isHls,
    referer: 'https://www.bilibili.com',
    hoster: 'Bilibili',
    duration: data.duration,
  }
}

/* -------------------------------------------------------------------------- */
/* Spotify Extractor (Tracks, Albums, Playlists)                             */
/* -------------------------------------------------------------------------- */

export async function extractSpotify(rawUrl, options = {}) {
  try {
    let target = rawUrl
    if (/(?:spotify\.link|spoti\.fi)/i.test(target)) {
      try {
        const headRes = await boundedFetch(target, { method: 'HEAD', redirect: 'follow', ...options })
        if (headRes?.url) target = headRes.url
      } catch {}
    }

    const u = new URL(target)
    const match = u.pathname.match(/\/(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/i)
    if (!match) return null

    const type = match[1].toLowerCase()
    const id = match[2]
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`

    let entity = null
    try {
      const res = await boundedFetch(embedUrl, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        ...options,
      })
      if (res.ok) {
        const html = await res.text()
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
        if (nextDataMatch) {
          const parsed = JSON.parse(nextDataMatch[1])
          entity = parsed.props?.pageProps?.state?.data?.entity || null
        }
      }
    } catch {}

    let oembed = null
    if (!entity || !entity.title) {
      try {
        const oembedRes = await boundedFetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`, options)
        if (oembedRes.ok) {
          oembed = await oembedRes.json()
        }
      } catch {}
    }

    if (type === 'album' || type === 'playlist') {
      const title = entity?.title || entity?.name || oembed?.title || 'Spotify Playlist'
      const author = entity?.subtitle || (entity?.artists && entity.artists.map((a) => a.name).join(', ')) || 'Spotify'
      const trackList = entity?.trackList || []
      const items = trackList
        .map((t, idx) => {
          const trackId = t.uri ? t.uri.replace('spotify:track:', '') : t.id || ''
          const artist = t.subtitle || (t.artists && t.artists.map((a) => a.name).join(', ')) || ''
          return {
            title: t.title ? (artist ? `${t.title} - ${artist}` : t.title) : `Track ${idx + 1}`,
            url: trackId ? `https://open.spotify.com/track/${trackId}` : null,
            duration: t.duration ? Math.round(t.duration / 1000) : null,
          }
        })
        .filter((item) => item.url)

      return {
        isPlaylist: true,
        type,
        id,
        title,
        seriesTitle: author,
        thumbnail: oembed?.thumbnail_url || null,
        items,
      }
    }

    const title = entity?.title || entity?.name || oembed?.title || 'Spotify Track'
    let artists = ''
    if (entity?.artists && Array.isArray(entity.artists)) {
      artists = entity.artists.map((a) => a.name).join(', ')
    } else if (entity?.subtitle) {
      artists = entity.subtitle
    }

    const searchTerms = [title, artists].filter(Boolean).join(' ')
    const searchQuery = `ytsearch1:${searchTerms} audio`.trim()

    return {
      isSpotifyTrack: true,
      type: 'track',
      id,
      title: artists ? `${artists} - ${title}` : title,
      trackTitle: title,
      artist: artists,
      duration: entity?.duration ? Math.round(entity.duration / 1000) : null,
      thumbnail: oembed?.thumbnail_url || null,
      searchQuery,
      previewUrl: entity?.audioPreview?.url || null,
    }
  } catch {
    return null
  }
}



