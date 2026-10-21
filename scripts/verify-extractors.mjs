/**
 * Comprehensive test suite for all extractors:
 * P.A.C.K.E.R, VOE, FileMoon, Vidmoly, Doodstream, Streamtape, Vidoza, AniWorld (s.to).
 *
 * Runs locally with an HTTP stand-in server: zero network calls needed.
 *
 * Run with: node scripts/verify-extractors.mjs
 */

import http from 'node:http'
import crypto from 'node:crypto'
import {
  unpackPackedJs,
  extractVoe,
  extractFilemoon,
  extractVidmoly,
  extractDoodstream,
  extractStreamtape,
  extractVidoza,
  extractAniworld,
  extractAniworldSeason,
  extractDirectHoster,
  checkAniworldOnlineUpdates,
  isAniworldUrl,
  isAniworldSeasonUrl,
  isVoeUrl,
  isFilemoonUrl,
  isVidmolyUrl,
  isDoodstreamUrl,
  isStreamtapeUrl,
  isVidozaUrl,
  isPodcastOrRssUrl,
  isSpotifyUrl,
  parsePodcastFeed,
} from '../api/extractors.js'

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : ` — erwartet: ${JSON.stringify(expected)}, erhalten: ${JSON.stringify(actual)}`}`)
}

/* -------------------------------------------------------------------------- */
/* 1. URL Pattern Checks                                                      */
/* -------------------------------------------------------------------------- */

check('URL: AniWorld Episode', isAniworldUrl('https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1'), true)
check('URL: AniWorld Film', isAniworldUrl('https://aniworld.to/anime/stream/one-piece/filme/film-1'), true)
check('URL: s.to Episode', isAniworldUrl('https://s.to/serie/stream/breaking-bad/staffel-1/episode-1'), true)
check('URL: serienstream.to', isAniworldUrl('https://serienstream.to/serie/stream/dr-house/staffel-2/episode-4'), true)
check('URL: fremde Seite nicht AniWorld', isAniworldUrl('https://youtube.com/watch?v=123'), false)
check('URL: AniWorld Staffel', isAniworldSeasonUrl('https://aniworld.to/anime/stream/one-piece/staffel-1'), true)
check('URL: AniWorld Serie Root', isAniworldSeasonUrl('https://aniworld.to/anime/stream/one-piece'), true)
check('URL: AniWorld Episode keine Staffel', isAniworldSeasonUrl('https://aniworld.to/anime/stream/one-piece/staffel-1/episode-1'), false)

check('URL: VOE sx', isVoeUrl('https://voe.sx/e/2ldxarskbpp2'), true)
check('URL: VOE Clone jamesbornmain', isVoeUrl('https://jamesbornmain.com/e/2ldxarskbpp2'), true)
check('URL: FileMoon', isFilemoonUrl('https://filemoon.sx/e/abc123xyz'), true)
check('URL: Vidmoly', isVidmolyUrl('https://vidmoly.to/embed-xyz.html'), true)
check('URL: DoodStream', isDoodstreamUrl('https://dood.to/e/xyz123'), true)
check('URL: Streamtape', isStreamtapeUrl('https://streamtape.com/e/68rB24M1gXszB12'), true)
check('URL: Vidoza', isVidozaUrl('https://vidoza.net/embed-8x7y6z5w4v.html'), true)
check('URL: Spotify Track', isSpotifyUrl('https://open.spotify.com/track/4HCOHRCSQelz2GPX8iTamO?si=274d78f4803a4df3'), true)
check('URL: Spotify Album', isSpotifyUrl('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'), true)
check('URL: Spotify Playlist', isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), true)

/* -------------------------------------------------------------------------- */
/* 2. P.A.C.K.E.R Unpacker Check                                              */
/* -------------------------------------------------------------------------- */

const packedSample =
  "eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('0 1=\"2\";',3,3,'var|source|https://storage.example/hls.m3u8'.split('|')))"
const unpacked = unpackPackedJs(packedSample)
check('PACKER: entpackt Code korrekt', unpacked, 'var source="https://storage.example/hls.m3u8";')

/* -------------------------------------------------------------------------- */
/* Mock Server for Hosters and AniWorld                                       */
/* -------------------------------------------------------------------------- */

// Generate VOE encoded payload
function createVoePayload(title, sourceUrl) {
  function rot13(s) {
    return s.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= 'Z' ? 65 : 97
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
    })
  }
  const rawJson = JSON.stringify({ title, source: sourceUrl })
  const s5 = Buffer.from(rawJson, 'utf8').toString('base64').split('').reverse().join('')
  const s4 = Array.from(s5).map((c) => String.fromCharCode(c.charCodeAt(0) + 3)).join('')
  const s3 = Buffer.from(s4, 'latin1').toString('base64')
  const s2 = s3.slice(0, 8) + '@$' + s3.slice(8, 16) + '^^' + s3.slice(16, 24) + '*~' + s3.slice(24)
  return rot13(s2)
}

// Generate FileMoon AES-256-GCM payload
const filemoonKey1 = crypto.randomBytes(16)
const filemoonKey2 = crypto.randomBytes(16)
const filemoonKey = Buffer.concat([filemoonKey1, filemoonKey2])
const filemoonIv = crypto.randomBytes(12)
const filemoonPlaintext = JSON.stringify({
  sources: [{ file: 'https://cdn.filemoon.example/hls/stream.m3u8', mime_type: 'application/x-mpegurl' }],
})
const filemoonCipher = crypto.createCipheriv('aes-256-gcm', filemoonKey, filemoonIv)
const filemoonCt = Buffer.concat([filemoonCipher.update(filemoonPlaintext, 'utf8'), filemoonCipher.final()])
const filemoonTag = filemoonCipher.getAuthTag()
const filemoonPayload = Buffer.concat([filemoonCt, filemoonTag])

let serverBase = ''

const server = http.createServer((req, res) => {
  const url = new URL(req.url, serverBase)
  const p = url.pathname

  // 1. VOE Mock
  if (p === '/voe/e/sample') {
    const encoded = createVoePayload('One Piece - Episode 1', 'https://delivery.voe.example/hls/master.m3u8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>VOE Sample</title></head><body>
        <script type="application/json">["${encoded}"]</script>
      </body></html>
    `)
  }

  // 2. FileMoon Mock (API & Embed & Packed)
  if (p === '/filemoon/e/fm123') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>FileMoon Video</title></head><body>
        <div id="player"></div>
      </body></html>
    `)
  }
  if (p === '/filemoon/e/fm_packed') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>Packed FileMoon</title></head><body>
        <script>
          ${packedSample}
        </script>
      </body></html>
    `)
  }
  if (p === '/filemoon/api/videos/fm123') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(
      JSON.stringify({
        title: 'Attack on Titan S01E01',
        playback: {
          key_parts: [filemoonKey1.toString('base64url'), filemoonKey2.toString('base64url')],
          iv: filemoonIv.toString('base64url'),
          payload: filemoonPayload.toString('base64url'),
        },
      }),
    )
  }

  // 3. Vidmoly Mock
  if (p === '/vidmoly/embed-vm123.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>Demon Slayer - Vidmoly</title></head><body>
        <script>
          var player = jwplayer("vplayer");
          player.setup({
            sources: [{ file: "https://stream.vidmoly.example/hls/ep1.m3u8" }]
          });
        </script>
      </body></html>
    `)
  }

  // 4. Doodstream Mock
  if (p === '/dood/e/dood123') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>Jujutsu Kaisen - Dood</title></head><body>
        <script>
          fetch('/pass_md5/mytoken12345');
        </script>
      </body></html>
    `)
  }
  if (p === '/pass_md5/mytoken12345') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('https://video.dood.example/stream/')
  }

  // 5. Streamtape Mock
  if (p === '/streamtape/e/st123') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>Naruto - Streamtape</title></head><body>
        <div id="norobotlink"></div>
        <script>
          document.getElementById('norobotlink').innerHTML = '//streamtape.com/get_video?id=st123&token=' + ('xyzTOKEN456').substring(3);
        </script>
      </body></html>
    `)
  }

  // 6. Vidoza Mock
  if (p === '/vidoza/embed-vz123.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>Bleach - Vidoza</title></head><body>
        <video id="player">
          <source src="https://media.vidoza.example/video.mp4" type="video/mp4">
        </video>
      </body></html>
    `)
  }

  // 7. AniWorld Episode Mock
  if (p === '/anime/stream/one-piece/staffel-1/episode-1') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>One Piece Staffel 1 Folge 1</title></head><body>
        <div class="series-title"><h1><span>One Piece</span></h1></div>
        <div class="hosterSiteTitle">
          <h2><span class="episodeGermanTitle">Ich bin Ruffy!</span> <small class="episodeEnglishTitle">I'm Luffy!</small></h2>
        </div>
        <div class="hosterSiteVideo">
          <ul class="row">
            <li class="col-md-3 episodeLink101" data-lang-key="3" data-link-id="101" data-link-target="/redirect/101">
              <div><a class="watchEpisode" href="/redirect/101"><h4>VOE</h4></a></div>
            </li>
            <li class="col-md-3 episodeLink102" data-lang-key="1" data-link-id="102" data-link-target="/redirect/102">
              <div><a class="watchEpisode" href="/redirect/102"><h4>Filemoon</h4></a></div>
            </li>
          </ul>
        </div>
      </body></html>
    `)
  }

  // 8. AniWorld Season Mock
  if (p === '/anime/stream/one-piece/staffel-1') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>One Piece Staffel 1</title></head><body>
        <div class="series-title"><h1><span>One Piece</span></h1></div>
        <table><tbody>
          <tr data-episode-id="1">
            <td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/one-piece/staffel-1/episode-1">Folge 1</a></td>
            <td><strong>Ich bin Ruffy!</strong> - <span>I'm Luffy!</span></td>
          </tr>
          <tr data-episode-id="2">
            <td><meta itemprop="episodeNumber" content="2" /><a href="/anime/stream/one-piece/staffel-1/episode-2">Folge 2</a></td>
            <td><strong>Der große Schwertkämpfer</strong> - <span>Great Swordsman</span></td>
          </tr>
        </tbody></table>
      </body></html>
    `)
  }

  // 9. AniWorld Movie List Mock
  if (p === '/anime/stream/one-piece/filme') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(`
      <!DOCTYPE html><html><head><title>One Piece Filme</title></head><body>
        <div class="series-title"><h1><span>One Piece</span></h1></div>
        <table><tbody>
          <tr data-episode-id="101">
            <td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/one-piece/filme/film-1">Film 1</a></td>
            <td><strong>Das Abenteuer beginnt</strong></td>
          </tr>
          <tr data-episode-id="102">
            <td><meta itemprop="episodeNumber" content="2" /><a href="/anime/stream/one-piece/filme/film-2">Film 2</a></td>
            <td><strong>Abenteuer auf der Spiralinsel</strong></td>
          </tr>
        </tbody></table>
      </body></html>
    `)
  }

  // AniWorld redirect endpoints
  if (p === '/redirect/101') {
    res.writeHead(302, { Location: `${serverBase}/voe/e/sample` })
    return res.end()
  }
  if (p === '/redirect/102') {
    res.writeHead(302, { Location: `${serverBase}/filemoon/e/fm123` })
    return res.end()
  }

  res.writeHead(404)
  res.end('Not found')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
serverBase = `http://127.0.0.1:${server.address().port}`

/* -------------------------------------------------------------------------- */
/* 3. Run Extractor Tests against Mock Server                                 */
/* -------------------------------------------------------------------------- */

// VOE
const voeResult = await extractVoe(`${serverBase}/voe/e/sample`)
check('VOE: Extraktion erfolgreich', Boolean(voeResult), true)
check('VOE: Stream-URL stimmt', voeResult?.url, 'https://delivery.voe.example/hls/master.m3u8')
check('VOE: isHls Flag gesetzt', voeResult?.isHls, true)

// FileMoon
const fmResult = await extractFilemoon(`${serverBase}/filemoon/e/fm123`)
check('FileMoon: Extraktion via AES-256-GCM', Boolean(fmResult), true)
check('FileMoon: Stream-URL stimmt', fmResult?.url, 'https://cdn.filemoon.example/hls/stream.m3u8')
check('FileMoon: Titel korrekt', fmResult?.title, 'Attack on Titan S01E01')

const fmPackedResult = await extractFilemoon(`${serverBase}/filemoon/e/fm_packed`)
check('FileMoon: Fallback via PACKER', Boolean(fmPackedResult), true)
check('FileMoon: Packed Stream-URL stimmt', fmPackedResult?.url, 'https://storage.example/hls.m3u8')

// Vidmoly
const vmResult = await extractVidmoly(`${serverBase}/vidmoly/embed-vm123.html`)
check('Vidmoly: Extraktion erfolgreich', Boolean(vmResult), true)
check('Vidmoly: Stream-URL stimmt', vmResult?.url, 'https://stream.vidmoly.example/hls/ep1.m3u8')
check('Vidmoly: isHls Flag gesetzt', vmResult?.isHls, true)

// DoodStream
const doodResult = await extractDoodstream(`${serverBase}/dood/e/dood123`)
check('DoodStream: Extraktion erfolgreich', Boolean(doodResult), true)
check('DoodStream: URL beginnt mit baseStream', doodResult?.url?.startsWith('https://video.dood.example/stream/'), true)
check('DoodStream: Token in URL', doodResult?.url?.includes('token=mytoken12345'), true)

// Streamtape
const stResult = await extractStreamtape(`${serverBase}/streamtape/e/st123`)
check('Streamtape: Extraktion erfolgreich', Boolean(stResult), true)
check('Streamtape: Token substring zusammengefügt', stResult?.url, 'https://streamtape.com/get_video?id=st123&token=TOKEN456&stream=1')

// Vidoza
const vzResult = await extractVidoza(`${serverBase}/vidoza/embed-vz123.html`)
check('Vidoza: Extraktion erfolgreich', Boolean(vzResult), true)
check('Vidoza: MP4 URL stimmt', vzResult?.url, 'https://media.vidoza.example/video.mp4')
check('Vidoza: isHls ist false', vzResult?.isHls, false)

// AniWorld Full Flow
const aniResult = await extractAniworld(`${serverBase}/anime/stream/one-piece/staffel-1/episode-1`)
check('AniWorld: Extraktion erfolgreich', Boolean(aniResult), true)
check('AniWorld: Titel zusammengesetzt', aniResult?.title, 'One Piece - S01E01 - Ich bin Ruffy!')
check('AniWorld: Hoster gewählt', aniResult?.hoster, 'VOE')
check('AniWorld: Direkte Stream-URL aufgelöst', aniResult?.url, 'https://delivery.voe.example/hls/master.m3u8')
check('AniWorld: isHls Flag', aniResult?.isHls, true)
check('AniWorld: mindestens ein aufgelöster Stream', aniResult?.streams?.length >= 1, true)
check('AniWorld: alle Hoster-Einträge erfasst', aniResult?.allEntries?.length, 2)
check('AniWorld: mehrere Stream-Spiegel verfügbar', aniResult?.streams?.length, 2)

// AniWorld Season Extraction
const seasonResult = await extractAniworldSeason(`${serverBase}/anime/stream/one-piece/staffel-1`)
check('AniWorld Staffel: Extraktion erfolgreich', Boolean(seasonResult), true)
check('AniWorld Staffel: isPlaylist Flag', seasonResult?.isPlaylist, true)
check('AniWorld Staffel: Episodenanzahl', seasonResult?.items?.length, 2)
check('AniWorld Staffel: Titel', seasonResult?.title, 'One Piece - Staffel 1')
check('AniWorld Staffel: Episode 1 Titel', seasonResult?.items?.[0]?.title, 'One Piece - S01E01 - Ich bin Ruffy!')

// AniWorld Filme Extraction
const filmeResult = await extractAniworldSeason(`${serverBase}/anime/stream/one-piece/filme`)
check('AniWorld Filme: Extraktion erfolgreich', Boolean(filmeResult), true)
check('AniWorld Filme: isPlaylist Flag', filmeResult?.isPlaylist, true)
check('AniWorld Filme: Titel', filmeResult?.title, 'One Piece - Filme')
check('AniWorld Filme: Film 1 Titel', filmeResult?.items?.[0]?.title, 'One Piece - Film 1 - Das Abenteuer beginnt')

// Dispatcher checks (verify routing without false positives)
const dispSt = await extractDirectHoster(`${serverBase}/streamtape/e/st123`)
check('Dispatcher: Streamtape auflösen', dispSt?.hoster, 'Streamtape')
const dispFm = await extractDirectHoster(`${serverBase}/filemoon/e/fm123`)
check('Dispatcher: Filemoon auflösen', dispFm?.hoster, 'Filemoon')

// Podcast & RSS Feed
check('URL: Podcast RSS Feed', isPodcastOrRssUrl('https://feeds.example.com/podcast.rss'), true)
check('URL: Feed URL', isPodcastOrRssUrl('https://example.com/podcast/feed/'), true)
check('URL: Keine RSS URL', isPodcastOrRssUrl('https://example.com/video.mp4'), false)

const sampleRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Sondra Audio Talk</title>
    <itunes:author>Sondra Studio</itunes:author>
    <item>
      <title>Episode 1: Web Audio &amp; MIDI</title>
      <enclosure url="https://storage.example/ep1.mp3" length="12345678" type="audio/mpeg"/>
    </item>
    <item>
      <title>Episode 2: Pitch &amp; Time Stretch</title>
      <enclosure url="https://storage.example/ep2.mp3" length="23456789" type="audio/mpeg"/>
    </item>
  </channel>
</rss>`

const parsedRss = parsePodcastFeed(sampleRss, 'https://feeds.example.com/podcast.rss')
check('Podcast: parsePodcastFeed erfolgreich', Boolean(parsedRss), true)
check('Podcast: isPlaylist Flag', parsedRss?.isPlaylist, true)
check('Podcast: Episodenanzahl', parsedRss?.items?.length, 2)
check('Podcast: Titel', parsedRss?.title, 'Sondra Audio Talk')
check('Podcast: Author', parsedRss?.seriesTitle, 'Sondra Studio')
check('Podcast: Episode 1 Titel', parsedRss?.items?.[0]?.title, 'Episode 1: Web Audio & MIDI')
check('Podcast: Episode 1 URL', parsedRss?.items?.[0]?.url, 'https://storage.example/ep1.mp3')

// AniWorld: how far a series is online (the Merkliste's check). The pages
// come from a stand-in for fetch, since the check only takes AniWorld's own
// hosts: the series page names its seasons — and links to other series,
// which must not count — and the newest season lists its episodes.
{
  const pages = {
    'https://aniworld.to/anime/stream/frieren': `
      <div class="series-title"><h1 itemprop="name"><span>Frieren &amp; Co</span></h1></div>
      <ul><li><a href="/anime/stream/frieren/filme">Filme</a></li>
      <li><a href="/anime/stream/frieren/staffel-1" title="Staffel 1">1</a></li>
      <li><a href="/anime/stream/frieren/staffel-2" title="Staffel 2">2</a></li></ul>
      <a href="/anime/stream/frieren/staffel-1/episode-28">28</a>
      <aside><a href="/anime/stream/one-piece">One Piece</a>
      <a href="/anime/stream/one-piece/staffel-21/episode-1100">Neu: One Piece 1100</a>
      <div data-season-id="48213"></div></aside>`,
    'https://aniworld.to/anime/stream/frieren/staffel-2': `
      <tr data-episode-id="1"><td><meta itemprop="episodeNumber" content="1" /><a href="/anime/stream/frieren/staffel-2/episode-1">Folge 1</a></td></tr>
      <tr data-episode-id="2"><td><meta itemprop="episodeNumber" content="7" /><a href="/anime/stream/frieren/staffel-2/episode-7">Folge 7</a></td></tr>
      <aside><a href="/anime/stream/one-piece/staffel-21/episode-1100">Neu: One Piece 1100</a></aside>`,
  }
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    const body = pages[String(url)]
    return new Response(body ?? 'nicht da', { status: body ? 200 : 404, headers: { 'Content-Type': 'text/html' } })
  }
  try {
    const online = await checkAniworldOnlineUpdates('https://aniworld.to/anime/stream/frieren/staffel-1/episode-13')
    check('AniWorld online: Titel', online?.seriesTitle, 'Frieren & Co')
    check('AniWorld online: neueste Staffel', online?.maxSeason, 2)
    check('AniWorld online: neueste Folge darin', online?.maxEpisode, 7)
    check(
      'AniWorld online: Serienseite und neueste Staffel gelesen',
      asked.join(' '),
      'https://aniworld.to/anime/stream/frieren https://aniworld.to/anime/stream/frieren/staffel-2',
    )
    check('AniWorld online: fremde Seite nicht geprüft', await checkAniworldOnlineUpdates('https://example.com/anime/stream/frieren'), null)
    check('AniWorld online: Seite nicht erreichbar', await checkAniworldOnlineUpdates('https://aniworld.to/anime/stream/gibt-es-nicht'), null)
  } finally {
    globalThis.fetch = realFetch
  }
}

if (typeof server.closeAllConnections === 'function') {
  server.closeAllConnections()
}
await new Promise((resolve) => server.close(resolve))

if (failures > 0) {
  console.error(`\nFEHLER: ${failures} Test(s) fehlgeschlagen!`)
  process.exitCode = 1
} else {
  console.log('\nOK: Alle Extractor-Tests bestanden! VOE, FileMoon, Vidmoly, Dood, Streamtape, Vidoza, AniWorld und Podcast/RSS funktionieren einwandfrei.')
  process.exitCode = 0
}
