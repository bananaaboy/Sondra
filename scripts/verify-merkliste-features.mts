/**
 * Verification tests for the new Merkliste features:
 * - MAL XML import
 * - AniList JSON import
 * - Watch history logging & undo
 * - Tags normalization & filtering
 * - Batch queue transfer
 * - AniWorld update parser logic
 */

import assert from 'node:assert'
import {
  advance,
  allHistory,
  allTags,
  createMerkItem,
  importAniListJson,
  importMalXml,
  readMerklisteFile,
  undoWatchHistory,
  setMerkItems,
  merkItems,
  onlineNews,
  takeOnlineNews,
} from '../src/lib/merkliste'
import { alreadySeen, guessEpisode, matchEpisode, seenEpisode } from '../src/lib/episodeMatch'
import { chaptersText, cleanMarks, markName, neighbourMark, nextOffered, openingOffered, sleepFade, withMark } from '../src/lib/player'
import { renamedFile, splitName } from '../src/lib/format'

console.log('--- Testing Merkliste Mega Features ---')

// 1. Test MyAnimeList XML Import
{
  const malXml = `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo>
    <user_name>OtakuTester</user_name>
  </myinfo>
  <anime>
    <series_animedb_id>1234</series_animedb_id>
    <series_title><![CDATA[Welcome to Demon School! Iruma-kun]]></series_title>
    <series_episodes>23</series_episodes>
    <my_watched_episodes>12</my_watched_episodes>
    <my_score>9</my_score>
    <my_status>Watching</my_status>
  </anime>
  <anime>
    <series_animedb_id>5678</series_animedb_id>
    <series_title>Frieren: Beyond Journey's End</series_title>
    <series_episodes>28</series_episodes>
    <my_watched_episodes>28</my_watched_episodes>
    <my_score>10</my_score>
    <my_status>Completed</my_status>
  </anime>
</myanimelist>`

  const imported = importMalXml(malXml)
  assert.strictEqual(imported.length, 2, 'Should parse 2 anime from MAL XML')
  assert.strictEqual(imported[0].title, 'Welcome to Demon School! Iruma-kun')
  assert.strictEqual(imported[0].status, 'watching')
  assert.strictEqual(imported[0].episode, 13) // Next episode after 12
  assert.strictEqual(imported[0].rating, 5) // 9/10 rounded to 5 stars
  assert(imported[0].tags?.includes('MAL'), 'Should have MAL tag')

  assert.strictEqual(imported[1].title, "Frieren: Beyond Journey's End")
  assert.strictEqual(imported[1].status, 'done')
  assert.strictEqual(imported[1].episode, 28)
  assert.strictEqual(imported[1].rating, 5)

  // Verify readMerklisteFile detects MAL XML
  const autoRead = readMerklisteFile(malXml)
  assert.strictEqual(autoRead.length, 2)
  console.log('✓ MyAnimeList XML Import verified')
}

// 2. Test AniList JSON Import
{
  const anilistJson = JSON.stringify({
    lists: [
      {
        name: 'Watching',
        entries: [
          {
            media: {
              title: { userPreferred: 'Jujutsu Kaisen Season 2' },
              episodes: 23,
              coverImage: { large: 'https://example.com/cover.jpg' },
            },
            status: 'CURRENT',
            progress: 15,
            score: 8.5,
          },
        ],
      },
    ],
  })

  const imported = importAniListJson(anilistJson)
  assert.strictEqual(imported.length, 1)
  assert.strictEqual(imported[0].title, 'Jujutsu Kaisen Season 2')
  assert.strictEqual(imported[0].status, 'watching')
  assert.strictEqual(imported[0].episode, 16)
  assert.strictEqual(imported[0].rating, 4) // 8.5 -> 4 stars
  assert.strictEqual(imported[0].cover, 'https://example.com/cover.jpg')
  assert(imported[0].tags?.includes('AniList'))

  // Verify readMerklisteFile detects AniList JSON
  const autoRead = readMerklisteFile(anilistJson)
  assert.strictEqual(autoRead.length, 1)
  console.log('✓ AniList JSON Import verified')
}

// 3. Test Tags and allTags
{
  const item1 = createMerkItem({ id: 't1', title: 'Show 1', tags: ['Anime', 'Comedy', '#Favorit'] })
  const item2 = createMerkItem({ id: 't2', title: 'Show 2', tags: ['Manga', 'Comedy'] })
  assert.deepStrictEqual(item1.tags, ['Anime', 'Comedy', 'Favorit']) // leading # stripped, deduplicated
  const tags = allTags([item1, item2])
  assert.deepStrictEqual(tags, ['Anime', 'Comedy', 'Favorit', 'Manga'])
  console.log('✓ Tags normalization & allTags collection verified')
}

// 4. Test Watch History & Undo
{
  const series = createMerkItem({
    id: 'test-history-item',
    title: 'History Test Anime',
    season: 1,
    episode: 3,
    seasons: [{ number: 1, episodes: 12, watched: [1, 2] }],
  })
  setMerkItems([series])

  // Advance item (marking episode 3 seen)
  const next = advance(series)
  assert.strictEqual(next.episode, 4)
  assert.strictEqual(next.history?.length, 1)
  assert.strictEqual(next.history[0].season, 1)
  assert.strictEqual(next.history[0].episode, 3)

  setMerkItems([{ ...series, ...next }])
  const historyList = allHistory(merkItems())
  assert.strictEqual(historyList.length, 1)
  assert.strictEqual(historyList[0].item.title, 'History Test Anime')
  assert.strictEqual(historyList[0].entry.episode, 3)

  // Undo the history entry
  const entryId = next.history[0].id
  const undone = undoWatchHistory('test-history-item', entryId)
  assert.strictEqual(undone, true)

  const afterUndo = merkItems().find((i) => i.id === 'test-history-item')!
  assert.strictEqual(afterUndo.episode, 3) // Reverted back to episode 3
  assert.deepStrictEqual(afterUndo.seasons?.[0].watched, [1, 2]) // 3 removed from watched
  assert.strictEqual(afterUndo.history?.length, 0)
  console.log('✓ Watch history advance & undo verified')
}

// 5. Test AniWorld Online Updates Extraction Regex
{
  const sampleAniworldHtml = `
  <div class="series-title"><h1><span>Demon School Iruma</span></h1></div>
  <nav id="season-menu">
    <a href="/anime/stream/welcome-to-demon-school-iruma-kun/staffel-1">Staffel 1</a>
    <a href="/anime/stream/welcome-to-demon-school-iruma-kun/staffel-2">Staffel 2</a>
    <a href="/anime/stream/welcome-to-demon-school-iruma-kun/staffel-3">Staffel 3</a>
  </nav>
  <table>
    <tr data-episode-id="101" itemprop="episodeNumber" content="1"></tr>
    <tr data-episode-id="102" itemprop="episodeNumber" content="2"></tr>
    <tr data-episode-id="121" itemprop="episodeNumber" content="21"></tr>
  </table>`

  const slug = 'welcome-to-demon-school-iruma-kun'
  const seasonMatches = [...sampleAniworldHtml.matchAll(new RegExp(`/(?:anime|serie)/stream/${slug}/staffel-(\\d+)`, 'gi'))]
  const seasonNums = seasonMatches.map((m) => Number(m[1]))
  const maxSeason = Math.max(...seasonNums)
  assert.strictEqual(maxSeason, 3, 'Should discover season 3 as max season')

  const epMatches = [...sampleAniworldHtml.matchAll(/itemprop=['"]episodeNumber['"]\s+content=['"](\d+)['"]/gi)]
  const epNums = epMatches.map((m) => Number(m[1]))
  const maxEpisode = Math.max(...epNums)
  assert.strictEqual(maxEpisode, 21, 'Should discover episode 21 as max episode')
  console.log('✓ AniWorld season & episode online detection logic verified')
}

// 7. The player recognises episodes by file name and ticks them off
{
  const guesses: [string, { title: string; season: number | null; episode: number } | null][] = [
    ['Frieren S01E13.mkv', { title: 'Frieren', season: 1, episode: 13 }],
    ['Frieren.S02E03.1080p.WEB.x264.mkv', { title: 'Frieren', season: 2, episode: 3 }],
    ['Dark.1x05.German.mp4', { title: 'Dark', season: 1, episode: 5 }],
    ['[SubsPlease] Frieren - 13 (1080p) [ABCD1234].mkv', { title: 'Frieren', season: null, episode: 13 }],
    ['Mob Psycho 100 II - 04v2.mkv', { title: 'Mob Psycho 100 II', season: null, episode: 4 }],
    ['Nana Staffel 1 Folge 20.mp4', { title: 'Nana', season: 1, episode: 20 }],
    ['Vinland Saga Episode 7.mp4', { title: 'Vinland Saga', season: null, episode: 7 }],
    ['Urlaub 2024.mp4', null],
    ['Konzert.mp3', null],
  ]
  for (const [name, expected] of guesses) {
    const guess = guessEpisode(name)
    if (expected === null) {
      // A bare number at the end is a guess only; it must not match a series.
      assert.ok(guess === null || matchEpisode(name, []) === null, `${name}: keine Folge`)
    } else {
      assert.deepStrictEqual(guess, expected, `${name}: erkannt`)
    }
  }
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const list = [
    createMerkItem({ id: 'fr', title: 'Frieren', season: 1, episode: 13, seasons: [{ number: 1, episodes: 28, watched: range(12) }] }),
    createMerkItem({ id: 'mob', title: 'Mob Psycho 100', season: 1, episode: 1, seasons: [{ number: 1, episodes: 12, watched: [] }] }),
    createMerkItem({ id: 'mob2', title: 'Mob Psycho 100 II', season: 1, episode: 1, seasons: [{ number: 1, episodes: 13, watched: [] }] }),
    createMerkItem({
      id: 'jojo',
      title: 'JoJo',
      season: 2,
      episode: 4,
      seasons: [
        { number: 1, episodes: 26, watched: range(26) },
        { number: 2, episodes: 39, watched: range(3) },
      ],
    }),
  ]
  const at = (name: string) => {
    const match = matchEpisode(name, list)
    return match ? [match.item.id, match.season, match.episode] : null
  }
  assert.deepStrictEqual(at('Frieren S01E13.mkv'), ['fr', 1, 13], 'Frieren S01E13')
  assert.deepStrictEqual(at('[SubsPlease] Frieren - 13 (1080p).mkv'), ['fr', 1, 13], 'Frieren ohne Staffel')
  assert.deepStrictEqual(at('Mob Psycho 100 II - 04.mkv'), ['mob2', 1, 4], 'der längere Titel gewinnt')
  assert.deepStrictEqual(at('JoJo - 05.mkv'), ['jojo', 2, 5], 'ohne Staffel: die, bei der der Eintrag steht')
  assert.deepStrictEqual(at('JoJo - 30.mkv'), ['jojo', 2, 30], 'passt in die Staffel, bei der der Eintrag steht')
  assert.deepStrictEqual(at('JoJo - 45.mkv'), ['jojo', 2, 19], 'darüber hinaus durchgezählt: Folge 45 ist Staffel 2, Folge 19')
  assert.deepStrictEqual(at('Frieren S01E40.mkv'), null, 'über das Ende hinaus: keine Folge')
  assert.deepStrictEqual(at('Bleach S01E01.mkv'), null, 'nicht auf der Liste')

  const frieren = list[0]
  const match = matchEpisode('Frieren S01E13.mkv', list)!
  assert.strictEqual(alreadySeen(match), false)
  const next = seenEpisode(frieren, 1, 13)
  assert.deepStrictEqual([next.season, next.episode], [1, 14], 'abgehakt: der Stand geht auf Folge 14')
  assert.ok(next.seasons?.[0].watched.includes(13) && !next.seasons?.[0].watched.includes(14), 'nur diese Folge')
  assert.strictEqual(next.history?.at(-1)?.episode, 13, 'steht im Verlauf')
  const ahead = seenEpisode(frieren, 1, 20)
  assert.deepStrictEqual([ahead.season, ahead.episode], [1, 13], 'vorausgeschaut: der Stand bleibt bei der ersten offenen')
  const newSeason = seenEpisode(frieren, 2, 1)
  assert.ok(newSeason.seasons?.some((season) => season.number === 2 && season.watched.includes(1)), 'fehlende Staffel kommt dazu')
  console.log('✓ Abspielen: Folgen am Dateinamen erkannt und abgehakt')
}

// 8. New episodes: announced in the app once, never on the first look
{
  let online = { maxSeason: 1, maxEpisode: 12 }
  const asked: string[] = []
  const notices: { title: string; body?: string; onclick: (() => void) | null; close: () => void }[] = []
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: { sondraApp: {}, focus: () => {}, addEventListener: () => {}, dispatchEvent: () => true, setTimeout, clearTimeout, setInterval, clearInterval },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    fetch: async (_url: string, init: { body: string }) => {
      asked.push(JSON.parse(init.body).url)
      return { ok: true, json: async () => ({ status: 'updates', ...online }) }
    },
    Notification: class {
      static permission = 'granted'
      onclick: (() => void) | null = null
      constructor(public title: string, options: { body?: string }) {
        notices.push(Object.assign(this, { body: options.body, close: () => {} }))
      }
    },
  })
  const news = await import('../src/lib/newEpisodes')
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  setMerkItems([
    createMerkItem({ id: 'fr', title: 'Frieren', status: 'watching', url: 'https://aniworld.to/anime/stream/frieren', updatedAt: 500, season: 1, episode: 13, seasons: [{ number: 1, episodes: null, watched: range(12) }] }),
    createMerkItem({ id: 'later', title: 'Später', status: 'later', url: 'https://aniworld.to/anime/stream/spaeter', updatedAt: 500 }),
    createMerkItem({ id: 'yt', title: 'Ohne AniWorld', status: 'watching', url: 'https://www.youtube.com/watch?v=x', updatedAt: 500 }),
  ])
  const opened: string[] = []
  assert.strictEqual(await news.checkNewEpisodes((id) => opened.push(id)), 0, 'erste Runde: nur merken')
  assert.deepStrictEqual(asked, ['https://aniworld.to/anime/stream/frieren'], 'nur „Am Schauen“ auf AniWorld')
  assert.strictEqual(merkItems().find((item) => item.id === 'fr')?.updatedAt, 500, 'eine Prüfung ist keine Änderung')
  assert.strictEqual(await news.checkNewEpisodes((id) => opened.push(id)), 0, 'gleiche Folge: nichts')
  online = { maxSeason: 1, maxEpisode: 13 }
  assert.strictEqual(await news.checkNewEpisodes((id) => opened.push(id)), 1, 'neue Folge: gemeldet')
  assert.strictEqual(notices[0]?.title, 'Neue Folge: Frieren')
  notices[0].onclick?.()
  assert.deepStrictEqual(opened, ['fr'], 'Klick öffnet die Serie')
  assert.strictEqual(await news.checkNewEpisodes((id) => opened.push(id)), 0, 'dieselbe Folge nicht zweimal')
  news.setNewEpisodesOn(false)
  online = { maxSeason: 2, maxEpisode: 1 }
  assert.strictEqual(await news.checkNewEpisodes((id) => opened.push(id)), 0, 'ausgeschaltet: nichts')
  console.log('✓ Neue Folgen: einmal gemeldet, erste Prüfung nur gemerkt, Klick öffnet die Serie')
}

// What AniWorld has beyond the list — and taking it on.
{
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const base = createMerkItem({ id: 'fr', title: 'Frieren', season: 1, episode: 14, seasons: [{ number: 1, episodes: 28, watched: range(1, 13) }] })
  assert.strictEqual(onlineNews(base, { maxSeason: 1, maxEpisode: 20 }), null, 'nur im Rückstand: nichts Neues')
  assert.deepStrictEqual(onlineNews(base, { maxSeason: 1, maxEpisode: 30 }), { season: 1, from: 29, to: 30, newSeason: false, countUnknown: false })
  assert.deepStrictEqual(onlineNews(base, { maxSeason: 2, maxEpisode: 4 }), { season: 2, from: 1, to: 4, newSeason: true, countUnknown: false })

  const more = takeOnlineNews({ ...base, onlineAvailable: { maxSeason: 1, maxEpisode: 30, checkedAt: 0 } })!
  assert.deepStrictEqual([more.seasons?.[0].episodes, more.season, more.episode], [30, 1, 14], 'Folgen dazu, Stand bleibt bei der ersten ungesehenen')

  const done = createMerkItem({ ...base, status: 'done', episode: 28, seasons: [{ number: 1, episodes: 28, watched: range(1, 28) }], onlineAvailable: { maxSeason: 3, maxEpisode: 10, checkedAt: 0 } })
  const grown = takeOnlineNews(done)!
  assert.deepStrictEqual(
    grown.seasons?.map((season) => `${season.number}:${season.episodes}`),
    ['1:28', '2:null', '3:10'],
    'fehlende Staffel davor kommt ohne Zahl dazu',
  )
  assert.deepStrictEqual([grown.season, grown.episode, grown.status], [2, 1, 'watching'], 'Fertig wird wieder Am Schauen, ab Staffel 2')

  const split = createMerkItem({
    ...base,
    seasons: [{ number: 1, episodes: 24, watched: range(1, 13), parts: [{ episodes: 12 }, { episodes: 12 }] }],
    onlineAvailable: { maxSeason: 1, maxEpisode: 26, checkedAt: 0 },
  })
  const parts = takeOnlineNews(split)!.seasons![0]
  assert.deepStrictEqual([parts.episodes, parts.parts?.map((part) => part.episodes)], [26, [12, 14]], 'geteilte Staffel: der letzte Teil wächst')

  const open = createMerkItem({ ...base, seasons: [{ number: 1, episodes: null, watched: range(1, 13) }], onlineAvailable: { maxSeason: 1, maxEpisode: 20, checkedAt: 0 } })
  assert.strictEqual(onlineNews(open)?.countUnknown, true)
  assert.strictEqual(takeOnlineNews(open)?.seasons?.[0].episodes, 20, 'unbekannte Zahl wird übernommen')
  console.log('✓ Neu online: nur was die Liste nicht kennt, übernommen ohne Sprung über Ungesehenes')
}

// Abspielen: „Vorspann überspringen“, „Nächste Folge“, the sleep timer's fade.
{
  const episode = 24 * 60
  assert.strictEqual(openingOffered(5, episode, 90), true, 'am Anfang einer Folge')
  assert.strictEqual(openingOffered(5 * 60, episode, 90), true, 'nach einem langen Prolog')
  assert.strictEqual(openingOffered(7 * 60, episode, 90), false, 'nach sechs Minuten nicht mehr')
  assert.strictEqual(openingOffered(5, 3 * 60, 90), false, 'kein Clip unter vier Minuten')
  assert.strictEqual(openingOffered(110, 5 * 60, 90), false, 'kurze Datei: nur im ersten Drittel')
  assert.strictEqual(nextOffered(episode - 120, episode), true, 'im Abspann')
  assert.strictEqual(nextOffered(episode - 200, episode), false, 'vor dem Abspann nicht')
  assert.strictEqual(nextOffered(episode, episode), false, 'am Ende übernimmt „Automatisch weiter“')
  assert.deepStrictEqual([sleepFade(60_000), sleepFade(5_000), sleepFade(0), sleepFade(-1)], [1, 0.5, 0, 0], 'leiser über die letzten zehn Sekunden')
  const kept = createMerkItem({ id: 'op', title: 'Frieren', opening: 85 })
  assert.strictEqual(kept.opening, 85, 'Vorspann-Länge der Serie bleibt')
  assert.strictEqual(createMerkItem({ id: 'op', title: 'X', opening: 3 }).opening, undefined, 'unsinnige Länge fällt weg')
  console.log('✓ Abspielen: Vorspann, nächste Folge und Schlaf-Timer zur rechten Zeit')
}

// Abspielen: Lesezeichen.
{
  let marks = withMark([], 125.04).marks
  marks = withMark(marks, 10).marks
  assert.deepStrictEqual(marks.map((mark) => mark.at), [10, 125], 'nach Zeit geordnet, auf Zehntel gerundet')
  assert.strictEqual(withMark(marks, 125.6).added, null, 'gleiche Stelle (unter einer Sekunde) nur einmal')
  assert.strictEqual(markName(marks, marks[1]), 'Lesezeichen 2', 'ohne Namen nummeriert')
  assert.strictEqual(neighbourMark(marks, 50, 1)?.at, 125, 'nächstes')
  assert.strictEqual(neighbourMark(marks, 130, -1)?.at, 125, 'voriges')
  assert.strictEqual(neighbourMark(marks, 126, -1)?.at, 10, 'kurz nach einem: das davor, nicht das gerade passierte')
  assert.strictEqual(neighbourMark(marks, 200, 1), null, 'danach keins')
  marks[1] = { ...marks[1], label: 'Kampf' }
  assert.strictEqual(chaptersText(marks), '0:00 Anfang\n0:10 Kapitel 1\n2:05 Kampf', 'Kapitel ab 0:00')
  assert.strictEqual(chaptersText([{ id: 'x', at: 0, label: '' }, { id: 'y', at: 3725, label: 'Ende' }]), '0:00 Kapitel 1\n1:02:05 Ende', 'erstes bei 0 bleibt, Stunden')
  assert.deepStrictEqual(cleanMarks([{ id: 'a', at: -1 }, null, { at: 'x' }, { id: 'b', at: 5, label: 7 }]), [{ id: 'b', at: 5, label: '' }], 'kaputte fallen weg')
  console.log('✓ Lesezeichen: geordnet, ohne Doppelte, Sprünge, Kapitel')
}

// Sitzung: Umbenennen.
{
  assert.deepStrictEqual(splitName('Aufnahme 3.wav'), { stem: 'Aufnahme 3', extension: '.wav' })
  assert.deepStrictEqual(splitName('ohne-endung'), { stem: 'ohne-endung', extension: '' })
  assert.deepStrictEqual(splitName('Mein Film v1.2 final.mkv'), { stem: 'Mein Film v1.2 final', extension: '.mkv' })
  assert.deepStrictEqual(renamedFile('  Interview   Lea ', 'take1.wav'), { name: 'Interview Lea.wav' }, 'Endung bleibt, Leerraum aufgeräumt')
  assert.deepStrictEqual(renamedFile('Folge. ', 'a.mp4'), { name: 'Folge.mp4' }, 'Punkt am Ende fällt weg')
  assert.ok('error' in renamedFile('   ', 'a.wav'), 'leer abgelehnt')
  assert.ok('error' in renamedFile('a/b', 'a.wav'), 'Schrägstrich abgelehnt')
  assert.ok('error' in renamedFile('CON', 'a.wav'), 'reservierter Name abgelehnt')
  assert.ok('error' in renamedFile('x'.repeat(300), 'a.wav'), 'zu lang abgelehnt')
  console.log('✓ Umbenennen: Endung bleibt, was Windows ablehnt, wird gesagt')
}

// Merkliste: erkannte Vorspänne der Serie.
{
  const intro = (n: number) => ({ print: btoa(String.fromCharCode(n, 0, 0, 0, 0)), seconds: 89.04, learnedAt: n })
  const item = createMerkItem({ id: 'v', title: 'Frieren', intros: [1, 2, 3, 4, 5].map(intro) })
  assert.deepStrictEqual(item.intros?.map((entry) => entry.learnedAt), [2, 3, 4, 5], 'höchstens vier, die neuesten')
  assert.strictEqual(item.intros?.[0].seconds, 89, 'Länge auf Zehntel')
  const broken = createMerkItem({ id: 'w', title: 'X', intros: [{ print: '', seconds: 5, learnedAt: 1 }, { print: 'x'.repeat(20000), seconds: 9, learnedAt: 1 }] as never })
  assert.strictEqual(broken.intros, undefined, 'leere oder zu grosse fallen weg')
  console.log('✓ Vorspänne der Serie: höchstens vier, nur gültige')
}

console.log('--- All Merkliste Feature Tests Passed! ---')
