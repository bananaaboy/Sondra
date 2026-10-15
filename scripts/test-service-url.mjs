#!/usr/bin/env node
/**
 * Test a specific download service or all services with real URLs.
 *
 * Usage:
 *   node scripts/test-service-url.mjs <service_name> [custom_url]
 *   node scripts/test-service-url.mjs --list
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { extractDirectMedia, isAniworldUrl, isBilibiliUrl, isHosterUrl, isPodcastOrRssUrl, isSpotifyUrl } from '../api/extractors.js'

function findYtDlp() {
  const local = ['yt-dlp.exe', 'yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos']
    .map((name) => path.resolve(name))
    .find(existsSync)
  if (local) return local

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || ''
    const candidate = path.join(appData, 'Sondra', 'yt-dlp.exe')
    if (existsSync(candidate)) return candidate
    return 'yt-dlp.exe'
  }
  return 'yt-dlp'
}

const YTDLP = findYtDlp()

export const SERVICE_URLS = {
  // Video & Streaming Portals
  youtube: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  soundcloud: 'scsearch1:lofi chill',
  bandcamp: 'https://disasterpeace.com/track/compass',
  vimeo: 'https://vimeo.com/channels/staffpicks/816223594',
  twitch: 'https://www.twitch.tv/videos/2143049581',
  twitter: 'https://twitter.com/NASA/status/1777771759670673413',
  tiktok: 'https://www.tiktok.com/@tiktok/video/7106594312292453675',
  instagram: 'https://www.instagram.com/reel/C-mD9yMIdZk/',
  facebook: 'https://www.facebook.com/watch/?v=10153231379946729',
  reddit: 'https://www.reddit.com/r/NatureIsFuckingLit/comments/1c31h7t/a_stunning_view_of_a_waterfall/',
  dailymotion: 'https://www.dailymotion.com/video/x5461bq',
  bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD',
  streamable: 'https://streamable.com/moo123',
  tumblr: 'https://staff.tumblr.com/post/682281090159755264/',
  bluesky: 'https://bsky.app/profile/bsky.app/post/3mk4lzkrnk22d',
  loom: 'https://www.loom.com/share/e1b6f0e4b85c4901b0fbb12165243851',
  pinterest: 'https://www.pinterest.com/pin/68749007421',
  mixcloud: 'https://www.mixcloud.com/spartacus/party-groove/',

  // Public Broadcasters (DACH & EU)
  ard: 'https://www.ardmediathek.de/video/doku-und-reportage/tagesschau-20-00-uhr/das-erste/Y3JpZDovL2Rhc2Vyc3RlLmRlL3RhZ2Vzc2NoYXUvMjAyNC0wOC0xOV8yMC0wMC1NRVM',
  zdf: 'https://www.zdf.de/nachrichten/heute-19-uhr',
  arte: 'https://www.arte.tv/de/videos/084754-000-A/tracks/',
  srf: 'https://www.srf.ch/play/tv/tagesschau/video/tagesschau-vom-19-08-2024-19-30?urn=urn:srf:video:123',
  orf: 'https://on.orf.at/video/14238515/zeit-im-bild-vom-19082024',
  '3sat': 'https://www.3sat.de/kultur/kulturzeit/sendung-123.html',

  // Anime & Hosters
  aniworld: 'https://aniworld.to/anime/stream/solo-leveling/staffel-1/episode-1',
  serienstream: 'https://s.to/serie/stream/breaking-bad/staffel-1/episode-1',
  filemoon: 'https://filemoon.sx/e/demo123',
  voe: 'https://voe.sx/e/demo123',
  vidmoly: 'https://vidmoly.to/w/demo123.html',
  streamtape: 'https://streamtape.com/e/demo123',
  vidoza: 'https://vidoza.net/embed-demo123.html',
  doodstream: 'https://doodstream.com/e/demo123',

  // 16 New Services
  spotify: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  applepodcasts: 'https://podcasts.apple.com/us/podcast/the-daily/id1200361736',
  threads: 'https://www.threads.net/@zuck/post/CuU59kZLt7W',
  snapchat: 'https://www.snapchat.com/spotlight/W7_ED1IQXAA_gWcCNX_W1A',
  patreon: 'https://www.patreon.com/posts/public-post-sample-12345',
  vk: 'https://vk.com/video-220754053_456240212',
  rumble: 'https://rumble.com/v20944b-big-buck-bunny-trailer-4k-60fps.html',
  odysee: 'https://odysee.com/@lbry:3f/what-is-lbry:a',
  archive: 'https://archive.org/details/Electra1962',
  kick: 'https://kick.com/video/12345678',
  substack: 'https://billmckibben.substack.com/p/the-solar-surge',
  peertube: 'https://peertube.tv/w/9d77f24d-6169-42b7-a363-2f9b8c04ec56',
  ok: 'https://ok.ru/video/7475662490142',
  rutube: 'https://rutube.ru/video/e9d9e683f2a8ef6a93581335cb8c7757/',
}

export async function testService(serviceName, customUrl = null) {
  const service = serviceName.toLowerCase().trim()
  const target = customUrl || SERVICE_URLS[service]
  if (!target) {
    throw new Error(`Unbekannter Dienst: "${serviceName}". Verfügbare Dienste: ${Object.keys(SERVICE_URLS).join(', ')}`)
  }

  const start = Date.now()
  const result = {
    service,
    url: target,
    ok: false,
    durationMs: 0,
    title: null,
    extractor: null,
    format: null,
    directUrl: null,
    error: null,
  }

  try {
    // 1. Native Extractor Path (AniWorld, SerienStream, Hosters, Podcasts, Bilibili, Spotify)
    if (isAniworldUrl(target) || isHosterUrl(target) || isPodcastOrRssUrl(target) || isBilibiliUrl(target) || isSpotifyUrl(target)) {
      result.extractor = 'native'
      const extracted = await extractDirectMedia(target)
      if (!extracted) throw new Error('Extraktor gab null zurück.')
      result.ok = true
      result.title = extracted.title || 'Ohne Titel'
      result.directUrl = extracted.url || extracted.items?.[0]?.url || extracted.previewUrl || 'Playlist/Feed'
      result.format = extracted.format || (extracted.isHls ? 'HLS (m3u8)' : extracted.isPlaylist ? `Feed (${extracted.items?.length ?? 0} Folgen)` : extracted.isSpotifyTrack ? 'Spotify Track Audio' : 'Direkt-MP4')
      result.durationMs = Date.now() - start
      return result
    }

    // 2. yt-dlp Path
    result.extractor = 'yt-dlp'
    const stdout = execFileSync(YTDLP, ['--dump-json', '--no-playlist', '--socket-timeout', '15', target], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    })

    const info = JSON.parse(stdout)
    result.ok = true
    result.title = info.title || info.fulltitle || 'Unbekannter Titel'
    result.directUrl = info.url || info.requested_formats?.[0]?.url || 'dynamischer Stream'
    result.format = info.format || info.ext || 'Standard'
    result.durationMs = Date.now() - start
    return result
  } catch (err) {
    result.ok = false
    result.error = (err.stderr || err.message || String(err)).trim().split('\n').filter(Boolean).pop()
    result.durationMs = Date.now() - start
    return result
  }
}

// CLI Mode
const args = process.argv.slice(2)
if (args[0] === '--list') {
  console.log(JSON.stringify(Object.keys(SERVICE_URLS), null, 2))
  process.exitCode = 0
} else if (args.length > 0) {
  const service = args[0]
  const custom = args[1] || null
  testService(service, custom).then((res) => {
    console.log(JSON.stringify(res, null, 2))
    process.exitCode = res.ok ? 0 : 1
  })
}
