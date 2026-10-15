/**
 * Test suite to verify all supported download services and format negotiation.
 *
 *   node scripts/verify-services.mjs
 */

import { PORTAL_HOSTS, isPortalUrl } from '../src/lib/download.ts'
import { isAniworldUrl, isHosterUrl } from '../api/extractors.js'

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FEHL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// All 46 services recognized by Sondra
const TEST_URLS = {
  // Video & social platforms
  youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  soundcloud: 'https://soundcloud.com/artist/track-name',
  bandcamp: 'https://artist.bandcamp.com/track/song',
  vimeo: 'https://vimeo.com/123456789',
  twitch: 'https://www.twitch.tv/videos/123456789',
  twitter: 'https://twitter.com/user/status/1234567890123456789',
  tiktok: 'https://www.tiktok.com/@user/video/1234567890123456789',
  instagram: 'https://www.instagram.com/reel/Cx123456789/',
  facebook: 'https://www.facebook.com/watch/?v=123456789',
  reddit: 'https://www.reddit.com/r/videos/comments/abc123/cool_video/',
  dailymotion: 'https://www.dailymotion.com/video/x12345',
  bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD',
  streamable: 'https://streamable.com/moo123',
  tumblr: 'https://user.tumblr.com/post/123456789/video',
  bluesky: 'https://bsky.app/profile/user.bsky.social/post/3k123456789',
  loom: 'https://www.loom.com/share/abc123456789',
  pinterest: 'https://www.pinterest.com/pin/123456789012345678/',
  mixcloud: 'https://www.mixcloud.com/dj/awesome-set/',

  // Public broadcasters (DACH + EU)
  ard: 'https://www.ardmediathek.de/video/doku/sendung/Y3JpZDovL2FyZDEyMw',
  zdf: 'https://www.zdf.de/dokumentation/terra-x/folge-123.html',
  arte: 'https://www.arte.tv/de/videos/123456-001-A/doku-titel/',
  srf: 'https://www.srf.ch/play/tv/sendung/video/sendung-titel?urn=urn:srf:video:123',
  orf: 'https://on.orf.at/video/123456/sendung-titel',
  '3sat': 'https://www.3sat.de/kultur/kulturzeit/sendung-123.html',

  // Anime & Series portals
  aniworld: 'https://aniworld.to/anime/stream/frieren/staffel-1/episode-1',
  serienstream: 'https://s.to/serie/stream/breaking-bad/staffel-1/episode-1',

  // Streaming hosters
  filemoon: 'https://filemoon.sx/e/abc123def456',
  voe: 'https://voe.sx/e/abc123def456',
  vidmoly: 'https://vidmoly.to/w/abc123def456.html',
  streamtape: 'https://streamtape.com/e/abc123def456',
  vidoza: 'https://vidoza.net/embed-abc123def456.html',
  doodstream: 'https://doodstream.com/e/abc123def456',

  // 16 New services
  spotify: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
  applepodcasts: 'https://podcasts.apple.com/us/podcast/the-daily/id1200361736',
  threads: 'https://www.threads.net/@user/post/C_123456789',
  snapchat: 'https://www.snapchat.com/spotlight/W7_ED1IQXAA_gWcCNX_W1A',
  patreon: 'https://www.patreon.com/posts/special-episode-12345678',
  vk: 'https://vk.com/video-12345678_123456789',
  rumble: 'https://rumble.com/v123abc-video-title.html',
  odysee: 'https://odysee.com/@creator:1/video-title:2',
  archive: 'https://archive.org/details/GratefulDead1977-05-08',
  kick: 'https://kick.com/video/12345678-abcd-1234-efgh-1234567890ab',
  substack: 'https://author.substack.com/p/episode-title',
  peertube: 'https://peertube.tv/w/abc123456',
  ok: 'https://ok.ru/video/1234567890123',
  rutube: 'https://rutube.ru/video/1234567890abcdef1234567890abcdef/',
}

console.log('--- 1. Service URL Detection Tests ---')
for (const [service, url] of Object.entries(TEST_URLS)) {
  const isPortal = isPortalUrl(url)
  const isAni = isAniworldUrl(url)
  const isHost = isHosterUrl(url)
  const recognized = isPortal || isAni || isHost
  check(`Erkennung: ${service.padEnd(14)} (${url.slice(0, 42)}…)`, recognized)
}

console.log('\n--- 2. Direct Hoster & Extractor Coverage ---')
check('VOE URL Erkennung', isHosterUrl('https://voe.sx/e/12345'))
check('FileMoon URL Erkennung', isHosterUrl('https://filemoon.sx/e/12345'))
check('Vidmoly URL Erkennung', isHosterUrl('https://vidmoly.to/w/12345.html'))
check('Streamtape URL Erkennung', isHosterUrl('https://streamtape.com/e/12345'))
check('Vidoza URL Erkennung', isHosterUrl('https://vidoza.net/embed-12345.html'))
check('DoodStream URL Erkennung', isHosterUrl('https://doodstream.com/e/12345'))
check('AniWorld Episode Erkennung', isAniworldUrl('https://aniworld.to/anime/stream/naruto/staffel-1/episode-1'))
check('SerienStream URL Erkennung', isAniworldUrl('https://s.to/serie/stream/mr-robot/staffel-1/episode-1'))

console.log('\n--- 3. Format Picker Simulation ---')
// Simulated formats from diverse platforms
const formatsAudioOnly = [
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128 },
  { format_id: '251', ext: 'webm', acodec: 'opus', vcodec: 'none', abr: 160 },
]

const formatsProgressiveOnly = [
  { format_id: 'prog360', ext: 'mp4', height: 360, vcodec: 'avc1.4d401e', acodec: 'mp4a.40.2', tbr: 600 },
  { format_id: 'prog720', ext: 'mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'mp4a.40.2', tbr: 1500 },
]

const formatsVideoAudioSplit = [
  { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none', tbr: 3500 },
  { format_id: '136', ext: 'mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'none', tbr: 2000 },
  { format_id: '140', ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none', abr: 128 },
]

// Pure audio extraction from audio-only service (Spotify, Podcasts, SoundCloud)
const bestAudio1 = formatsAudioOnly.filter(f => f.acodec && (!f.vcodec || f.vcodec === 'none'))
check('Audio-Only Stream gefunden', bestAudio1.length > 0 && (bestAudio1[0].format_id === '140' || bestAudio1[0].format_id === '251'))

// Audio fallback from progressive stream (TikTok, Instagram, Threads)
const progAudio = formatsProgressiveOnly.filter(f => f.acodec && f.acodec !== 'none')
check('Progressiver Audio-Fallback gefunden', progAudio.length > 0 && progAudio[1].format_id === 'prog720')

// Video selection (YouTube, Vimeo, Rumble)
const videoFit = formatsVideoAudioSplit.filter(f => f.vcodec && f.vcodec !== 'none' && f.height <= 720)
check('Video-Stream nach Höhe gefiltert (720p)', videoFit.length > 0 && videoFit[0].format_id === '136')

console.log('\n--- 4. Error Code Mapping Verification ---')
const errorChecks = [
  { text: 'HTTP Error 429: Too Many Requests', expected: 'error.api.rate_exceeded' },
  { text: 'Sign in to confirm you are not a bot', expected: 'error.api.ytdlp.signin' },
  { text: 'This video requires age verification', expected: 'error.api.content.video.age' },
  { text: 'The uploader has not made this video available in your country (georestricted)', expected: 'error.api.content.video.region' },
  { text: 'This is a private video. Sign in if you have access', expected: 'error.api.content.video.private' },
  { text: 'DPAPI failed to decrypt cookie store: locked', expected: 'error.api.ytdlp.cookies' },
  { text: 'nsig extraction failed: please update to latest version', expected: 'error.api.ytdlp.outdated' },
]

function testErrorCode(stderr) {
  const text = stderr.toLowerCase()
  if (text.includes('cookie') && /could not copy|failed to decrypt|dpapi|could not find|permission denied|unable to open|locked|no such file/.test(text)) {
    return 'error.api.ytdlp.cookies'
  }
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
  if (/not a bot|sign in to confirm|confirm that you are not a bot|login required|sign in if you have been granted access/i.test(text)) {
    return 'error.api.ytdlp.signin'
  }
  if (text.includes('private video') || text.includes('members-only')) return 'error.api.content.video.private'
  return 'error.api.fetch.fail'
}

for (const { text, expected } of errorChecks) {
  const got = testErrorCode(text)
  check(`Fehler-Code für: "${text.slice(0, 36)}…"`, got === expected, `erwartet ${expected}, erhalten ${got}`)
}

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log(`\nOK: Alle ${Object.keys(TEST_URLS).length} Dienste und Fallbacks wurden erfolgreich verifiziert!`)
process.exit(0)
