#!/usr/bin/env node
/**
 * Universeller Downloader für yt-dlp + VOE / FileMoon / Vidmoly / DoodStream
 * 
 * Verwendung:
 *   node scripts/dl.mjs "https://jamesbornmain.com/e/2ldxarskbpp2"
 *   node scripts/dl.mjs "https://voe.sx/e/..."
 *   node scripts/dl.mjs "https://filemoon.sx/e/..."
 *   node scripts/dl.mjs "https://vidmoly.to/embed-..."
 *   node scripts/dl.mjs "https://dood.to/e/..."
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'

const args = process.argv.slice(2)
const targetUrl = args.find((a) => a.startsWith('http'))

if (!targetUrl) {
  console.log(`
Verwendung:
  node scripts/dl.mjs "<URL>" [--cookies <browser>]

Unterstützt:
  - VOE (voe.sx, jamesbornmain.com, chaliceguzzlerlandlord.com und alle VOE-Klone)
  - FileMoon (filemoon.sx, filemoon.to)
  - Vidmoly (vidmoly.to, vidmoly.me)
  - DoodStream (dood.to, doodstream.com, dsvplay.com, playmogo.com)
  - Sowie alle normalen yt-dlp-Plattformen (YouTube, SoundCloud, Vimeo usw.)
`)
  process.exit(1)
}

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

async function extractDirectStream(rawUrl) {
  let host = ''
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return null
  }

  if (isAniWorldHost(host)) {
    const result = await extractAniWorld(rawUrl)
    if (result) return result
  }
  if (host.includes('filemoon')) return extractFileMoon(rawUrl)
  if (host.includes('vidmoly')) return extractVidmoly(rawUrl)
  if (host.includes('dood') || host.includes('myvidplay') || host.includes('dsvplay') || host.includes('playmogo')) {
    return extractDoodStream(rawUrl)
  }
  if (host.includes('voe.') || host.includes('jamesbornmain') || host.includes('chaliceguzzler') || host.includes('tube.sx') || rawUrl.includes('/e/')) {
    const v = await extractVoe(rawUrl)
    if (v) return v
  }
  return extractVoe(rawUrl)
}

async function main() {
  console.log(`\n🔍 Analysiere Adresse: ${targetUrl}`)

  let directSource = null
  try {
    directSource = await extractDirectStream(targetUrl)
  } catch {
    // Weiter mit normalem yt-dlp
  }

  let finalUrl = targetUrl
  const extraArgs = []

  if (directSource) {
    console.log(`✅ Gefunden über Extraktor: ${directSource.title}`)
    console.log(`🔗 Stream-URL: ${directSource.url}`)
    finalUrl = directSource.url
    if (directSource.referer) {
      extraArgs.push('--referer', directSource.referer)
    }
    const cleanTitle = directSource.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 120)
    extraArgs.push('-o', `${cleanTitle}.%(ext)s`)
  }

  // Zusätzliche Argumente vom Aufruf durchreichen (z. B. --cookies chrome)
  const userArgs = args.filter((a) => a !== targetUrl)

  const ytdlpArgs = [
    ...extraArgs,
    ...userArgs,
    '--',
    finalUrl,
  ]

  console.log(`\n🚀 Starte yt-dlp: ${YTDLP}\n`)
  const child = spawn(YTDLP, ytdlpArgs, { stdio: 'inherit' })

  child.on('close', (code) => {
    if (code === 0) {
      console.log('\n🎉 Download erfolgreich abgeschlossen!')
    } else {
      console.error(`\n❌ yt-dlp beendete mit Fehlercode ${code}`)
    }
    process.exit(code ?? 1)
  })
}

main()
