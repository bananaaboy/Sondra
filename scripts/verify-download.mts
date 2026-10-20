/**
 * Recognising, putting together and fetching — the parts of the downloader
 * that broke without anyone noticing, because each only failed for one shape
 * of input.
 *
 *   npm run verify:download
 *
 * Checked without the network: how addresses are read out of pasted text
 * (commas, semicolons, quotes, a full stop at the end), how an HLS playlist is
 * read (the real bandwidth rather than the average, the sound a master keeps
 * apart, byte ranges), and how the proxy rewrites a playlist so every address
 * in it goes back through `api/stream.js` with a token of its own.
 */

import {
  audioFor,
  buildUrlWithEpisode,
  deriveLinkTitle,
  extractAddresses,
  isHlsPlaylistText,
  parseLinkEpisodeInfo,
  parseM3u8,
  sourceBadgeForUrl,
} from '../src/lib/download'
import { verify } from '../api/_shared.js'
import { rewritePlaylist } from '../api/stream.js'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/* -- Erkennen --------------------------------------------------------------- */

const A = 'https://a.example/x.mp4'
const B = 'https://b.example/y.mp4'
check('Komma mit Leerzeichen', extractAddresses(`${A}, ${B}`), [A, B])
check('Komma ohne Leerzeichen', extractAddresses(`${A},${B}`), [A, B])
check('Semikolon', extractAddresses(`${A};${B}`), [A, B])
check('Zeilen, Anführungszeichen, spitze Klammern', extractAddresses(`"${A}"\n<${B}>`), [A, B])
check('Punkt am Satzende', extractAddresses(`Hier: ${A}.`), [A])
check('Klammern im Namen bleiben', extractAddresses('(https://w.example/Datei_(1).ogg)'), ['https://w.example/Datei_(1).ogg'])
check('Komma im Pfad bleibt', extractAddresses('https://c.example/a,b.mp4'), ['https://c.example/a,b.mp4'])
check('Doppelte zählen einmal', extractAddresses(`${A}\n${A}`), [A])
check('Abfrage bleibt ganz', extractAddresses('https://www.youtube.com/watch?v=abc&list=PL1'), ['https://www.youtube.com/watch?v=abc&list=PL1'])
check('Kein Link', extractAddresses('nur Text'), [])
check('HLS-Datei ist keine Linkliste', isHlsPlaylistText('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts'), true)
check('Musik-Playlist ist eine Linkliste', isHlsPlaylistText('#EXTM3U\n#EXTINF:123,Lied\nhttps://a.example/lied.mp3'), false)

/* -- Zusammensetzen: lesen ---------------------------------------------------- */

const master = parseM3u8(
  [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ton",NAME="Deutsch",LANGUAGE="de",DEFAULT=YES,URI="ton/de.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ton",NAME="English",LANGUAGE="en",URI="ton/en.m3u8"',
    '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=100,BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="ton"',
    'v360.m3u8',
    '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="ton"',
    'v720.m3u8',
  ].join('\n'),
  'https://cdn.example/stream/master.m3u8',
)
check('Master erkannt', master.kind, 'master')
check('Beste Qualität zuerst, nach BANDWIDTH statt AVERAGE-BANDWIDTH', master.variants.map((v) => v.bandwidth), [3000000, 900000])
check('Getrennter Ton: Standardspur der Gruppe', audioFor(master, master.variants[0])?.url, 'https://cdn.example/stream/ton/de.m3u8')

const ranged = parseM3u8(
  [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="film.mp4",BYTERANGE="800@0"',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:1000@800',
    'film.mp4',
    '#EXTINF:4,',
    '#EXT-X-BYTERANGE:500',
    'film.mp4',
  ].join('\n'),
  'https://cdn.example/film.m3u8',
)
check('Byte-Bereiche: Init, mit Versatz, fortgesetzt', ranged.ranges, [
  { start: 0, end: 799 },
  { start: 800, end: 1799 },
  { start: 1800, end: 2299 },
])
check('Byte-Bereiche: dieselbe Adresse dreimal', new Set(ranged.segments).size, 1)

/* -- Zusammensetzen: durch den Dienst ---------------------------------------- */

const rewritten = rewritePlaylist(
  [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ton",URI="ton.m3u8"',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
    'v/index.m3u8',
    '#EXTINF:4,',
    'seg1.ts',
    'https://localhost/intern.ts',
  ].join('\n'),
  'https://media.example.com/hls/master.m3u8',
  { ref: 'https://seite.example.com/' },
)
const lines = rewritten.split('\n')
const tokenOf = (line: string) => decodeURIComponent(line.match(/t=([^"&\s]+)/)?.[1] ?? '')
const audioClaim = verify(tokenOf(lines[1]))
const variantClaim = verify(tokenOf(lines[4]))
const segmentClaim = verify(tokenOf(lines[6]))
check('Tonspur durch den Dienst, als Playlist', [audioClaim?.u, audioClaim?.isHls], ['https://media.example.com/hls/ton.m3u8', true])
check('Schlüssel bleibt unberührt', lines[2], '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"')
check('Qualität durch den Dienst, als Playlist', [variantClaim?.u, variantClaim?.isHls], ['https://media.example.com/hls/v/index.m3u8', true])
check('Segment durch den Dienst, mit Referer', [segmentClaim?.u, segmentClaim?.isHls ?? false, segmentClaim?.ref], [
  'https://media.example.com/hls/seg1.ts',
  false,
  'https://seite.example.com/',
])
check('Private Adresse wird nicht signiert', lines[7], 'https://localhost/intern.ts')

/* -- Link-Einstellungen (Staffel / Episode / Titel) -------------------------- */

check(
  'AniWorld Staffel & Episode lesen',
  parseLinkEpisodeInfo('https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-2/episode-5'),
  { season: 2, episode: 5, isEpisodicUrl: true, seriesSlug: 'jujutsu-kaisen' },
)
check(
  'AniWorld Staffel & Episode umschreiben',
  buildUrlWithEpisode('https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-1/episode-1', 2, 7),
  'https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-2/episode-7',
)
check(
  'AniWorld Ganze Staffel umschreiben',
  buildUrlWithEpisode('https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-1/episode-3', 2, null),
  'https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-2',
)
check(
  'AniWorld Filme umschreiben',
  buildUrlWithEpisode('https://aniworld.to/anime/stream/jujutsu-kaisen/staffel-1/episode-1', 0, 1),
  'https://aniworld.to/anime/stream/jujutsu-kaisen/filme/film-1',
)
check(
  'AniWorld Titel aus Adresse ableiten',
  deriveLinkTitle('https://aniworld.to/anime/stream/solo-leveling/staffel-1/episode-4'),
  'Solo Leveling',
)
check('AniWorld Badge erkennen', sourceBadgeForUrl('https://aniworld.to/anime/stream/solo-leveling'), 'AniWorld')

if (failures > 0) {
  console.log(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nErkennen, Zusammensetzen und Signieren verhalten sich wie erwartet.')
