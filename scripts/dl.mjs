#!/usr/bin/env node
/**
 * Universeller CLI-Downloader für Sondra: yt-dlp + AniWorld / SerienStream / VOE / FileMoon / Vidmoly / Streamtape / Vidoza / DoodStream
 * 
 * Verwendung:
 *   node scripts/dl.mjs "https://aniworld.to/anime/stream/solo-leveling/staffel-2/episode-3"
 *   node scripts/dl.mjs "https://s.to/serie/stream/breaking-bad/staffel-1/episode-1"
 *   node scripts/dl.mjs "https://voe.sx/e/..."
 *   node scripts/dl.mjs "https://filemoon.sx/e/..."
 *   node scripts/dl.mjs "https://vidmoly.to/embed-..."
 *   node scripts/dl.mjs "https://streamtape.com/v/..."
 *   node scripts/dl.mjs "https://vidoza.net/embed-..."
 *   node scripts/dl.mjs "https://dood.to/e/..."
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { extractDirectMedia, isAniworldUrl, isHosterUrl } from '../api/extractors.js'

const args = process.argv.slice(2)
const targetUrl = args.find((a) => a.startsWith('http'))

if (!targetUrl) {
  console.log(`
Verwendung:
  node scripts/dl.mjs "<URL>" [--cookies <browser>]

Unterstützt:
  - AniWorld.to & s.to (SerienStream.to) Episoden & Filme
  - VOE (voe.sx und alle VOE-Klone)
  - FileMoon (filemoon.sx, filemoon.to)
  - Vidmoly (vidmoly.to, vidmoly.me)
  - Streamtape (streamtape.com)
  - Vidoza (vidoza.net)
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

async function main() {
  console.log(`🎯 Ziel: ${targetUrl}`)

  let directSource = null
  if (isAniworldUrl(targetUrl) || isHosterUrl(targetUrl)) {
    try {
      directSource = await extractDirectMedia(targetUrl)
    } catch (err) {
      console.warn(`⚠️ Direktextraktion warnte: ${err?.message ?? err}`)
    }
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
