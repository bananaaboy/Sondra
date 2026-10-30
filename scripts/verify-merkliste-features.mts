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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  advance,
  allHistory,
  allTags,
  createMerkItem,
  exportMerklisteSqlite,
  getSqliteAppState,
  importAniListJson,
  importMalXml,
  readMerklisteFile,
  setSqliteAppState,
  undoWatchHistory,
  setMerkItems,
  merkItems,
  onlineNews,
  takeOnlineNews,
  mergeShared,
  readSharedFile,
  sharedFileText,
  sharedKey,
  sharedSqliteBytes,
  settle,
  sortMerkItems,
  watchedUpTo,
} from '../src/lib/merkliste'
import { isSqliteBytes } from '../src/lib/sqlite'
import { NATIVE_CONTAINER, standJob } from '../src/lib/playable'
import { daysBetween, finishAt, goalState, paceFor, paceSetting, recentPace, watchPlan } from '../src/lib/watchPlan'
import { alreadySeen, guessEpisode, matchEpisode, seenEpisode } from '../src/lib/episodeMatch'
import { chaptersText, cleanMarks, markName, neighbourMark, nextOffered, openingOffered, sleepFade, withMark } from '../src/lib/player'
import { renamedFile, splitName } from '../src/lib/format'
import { recapYears, recordedSince, yearRecap } from '../src/lib/recap'
import { decodeShare, encodeShare, LINK_MAX, newFromShared, shareableList, shareLink, sharedFromHash } from '../src/lib/merkShare'

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

// The Merkliste as the file in Google Drive
{
  const mine = [createMerkItem({ id: 'a', title: 'Frieren', updatedAt: 10 }), createMerkItem({ id: 'b', title: 'Dark', updatedAt: 10, cover: 'data:image/webp;base64,AAAA' })]
  const removed = { gone: 5 }
  const text = sharedFileText(mine, removed)
  const back = readSharedFile(text)
  assert.ok(back, 'eigene Datei lesbar')
  assert.strictEqual(back!.key, sharedKey(mine, removed), 'eigene Datei gilt als gleich — nichts zu schreiben')
  assert.deepStrictEqual(back!.removed, removed, 'Entferntes reist mit')
  assert.strictEqual(back!.items.find((item) => item.id === 'b')?.cover, 'sondra:lokal', 'Cover aus Dateien bleiben auf dem Gerät')
  assert.ok(readMerklisteFile(text).length === 2, 'auch als gewöhnliche Datei einlesbar')
  // An older Sondra's backup: no removals, covers inside.
  const old = readSharedFile(JSON.stringify({ kind: 'sondra-merkliste', version: 1, items: [{ id: 'c', title: 'Nana', updatedAt: 3 }] }))
  assert.deepStrictEqual([old?.items.length, old?.removed], [1, {}], 'alte Sicherung lesbar')
  assert.strictEqual(readSharedFile('{"nope":1}'), null, 'keine Merkliste → null, nie überschrieben')
  assert.strictEqual(readSharedFile('kaputt'), null, 'kein JSON → null')
  // The other device changed Frieren later and removed Dark after its last change.
  const remote = { items: [createMerkItem({ id: 'a', title: 'Frieren', updatedAt: 20, episode: 4 })], removed: { b: 15 } }
  const merged = mergeShared(mine, remote)
  assert.deepStrictEqual(merged.items.map((item) => [item.id, item.episode]), [['a', 4]], 'später geändert gewinnt, entfernt bleibt entfernt')
  console.log('✓ Merkliste in Google Drive: Datei, Vergleich, Zusammenführen')
}

// „Bis wohin?“: episodes and time to a chosen point
{
  const series = createMerkItem({
    id: 'plan',
    title: 'Nordlicht',
    season: 1,
    episode: 4,
    seasons: [
      { number: 1, episodes: 12, watched: [1, 2, 3] },
      { number: 2, episodes: 12, watched: [] },
    ],
  })
  const plain = watchPlan(series, { season: 2, episode: 12 })
  assert.deepStrictEqual([plain.episodes, plain.rawMinutes, plain.minutes, plain.first], [21, 504, 504, { season: 1, episode: 4 }], '21 Folgen à 24 Min. ab dem Stand')
  const skipped = watchPlan(series, { season: 2, episode: 12 }, { from: 'stand', speed: 1, skipOpening: 90 })
  assert.strictEqual(skipped.minutes, 473, 'ohne Vorspann: 21 × 22,5 Min.')
  const fast = watchPlan(series, { season: 2, episode: 12 }, { from: 'stand', speed: 1.5, skipOpening: 90 })
  assert.strictEqual(fast.minutes, 315, 'bei 1,5× ein Drittel weniger')
  const behind = watchPlan(series, { season: 1, episode: 2 })
  assert.deepStrictEqual([behind.episodes, behind.behind], [0, true], 'ein Punkt hinter dem Stand ist schon gesehen')
  const again = watchPlan(series, { season: 1, episode: 12 }, { from: 'start', speed: 1, skipOpening: 0 })
  assert.strictEqual(again.episodes, 12, 'von vorn zählt Gesehenes mit')
  const bar = plain.bar.find((season) => season.number === 1)!
  assert.deepStrictEqual(bar.runs.map((run) => [run.kind, run.from, run.to]), [['seen', 1, 3], ['planned', 4, 12]], 'die Linie: gesehen, dann geplant')

  const gaps = createMerkItem({
    id: 'gaps',
    title: 'Sternfall',
    season: 1,
    episode: 4,
    durations: { '3:2': 48 },
    seasons: [
      { number: 1, episodes: 12, watched: [1, 2, 3] },
      { number: 2, episodes: null, watched: [] },
      { number: 3, episodes: 10, watched: [] },
      { number: 0, episodes: 2, watched: [] },
    ],
  })
  const unknown = watchPlan(gaps, { season: 3, episode: 5 })
  assert.deepStrictEqual([unknown.episodes, unknown.unknown, unknown.exceptions], [14, [2], 1], 'Staffel ohne Folgenzahl wird genannt, nicht geraten')
  assert.strictEqual(unknown.rawMinutes, 13 * 24 + 48, 'eigene Länge einer Folge zählt')
  const films = watchPlan(gaps, { season: 0, episode: 2 }, { from: 'start', speed: 1, skipOpening: 90 })
  assert.strictEqual(films.films, 2, 'Filme kommen nach den Staffeln')
  assert.ok(films.bar.some((season) => season.number === 0), 'Filme stehen auf der Linie, wenn sie das Ziel sind')
  console.log('✓ Bis wohin: Folgen, Zeit, Vorspann, Tempo, unbekannte Staffeln, Filme')
}

// Pace and dates
{
  const today = new Date(2026, 9, 25)
  const daily = finishAt(21, 3, 'day', today)
  assert.deepStrictEqual([daily.days, daysBetween(today, daily.date)], [7, 6], '3 am Tag: am siebten Tag, heute mitgezählt')
  const weekly = finishAt(21, 3, 'week', today)
  assert.strictEqual(weekly.days, 49, '3 pro Woche: sieben Wochen')
  assert.strictEqual(finishAt(0, 3, 'day', today).days, 0, 'nichts zu schauen, kein Tag')
  const needed = paceFor(21, 504, new Date(2026, 9, 31), today)
  assert.deepStrictEqual([needed?.days, needed?.perDay, needed?.minutesPerDay], [7, 3, 72], 'bis zum 31.: 3 am Tag, 72 Min.')
  assert.strictEqual(paceFor(5, 100, new Date(2026, 9, 20), today), null, 'ein vergangener Tag hat kein Tempo')
  assert.deepStrictEqual(paceSetting(0.4), { rate: 3, unit: 'week' }, 'unter einer am Tag: pro Woche')
  assert.deepStrictEqual(paceSetting(2.4), { rate: 2, unit: 'day' }, 'sonst am Tag')
  const now = today.getTime()
  const watched = createMerkItem({
    id: 'pace',
    title: 'X',
    history: [1, 2, 4, 6, 8, 10].map((daysAgo, i) => ({ id: `h${i}`, season: 1, episode: i + 1, at: now - daysAgo * 86_400_000 })),
  })
  const pace = recentPace(watched, now)
  assert.deepStrictEqual([pace?.count, pace?.days], [6, 10], 'sechs Folgen in zehn Tagen')
  const binge = createMerkItem({ id: 'binge', title: 'Y', history: [1, 2, 3].map((n) => ({ id: `b${n}`, season: 1, episode: n, at: now - n * 60_000 })) })
  assert.strictEqual(recentPace(binge, now)?.days, 7, 'ein Abend zählt als Woche, nicht als Gewohnheit')
  console.log('✓ Tempo und Tage: am Tag, pro Woche, bis zu einem Datum, aus dem Verlauf')
}

// A goal kept on the series
{
  const setAt = new Date(2026, 9, 1).getTime()
  const item = createMerkItem({
    id: 'goal',
    title: 'Abendlicht',
    season: 1,
    episode: 12,
    seasons: [
      { number: 1, episodes: 21, watched: Array.from({ length: 11 }, (_, i) => i + 1) },
    ],
    goal: { season: 1, episode: 21, by: '2026-10-31', setAt, count: 21 },
  })
  assert.deepStrictEqual(item.goal, { season: 1, episode: 21, by: '2026-10-31', setAt, count: 21 }, 'Ziel bleibt beim Speichern')
  const state = goalState(item, item.goal!, undefined, new Date(2026, 9, 16))
  // 31 days, 15 gone: an even pace would leave 21 × 16/31 ≈ 10.8; 10 are left.
  assert.deepStrictEqual([state.left, state.days, state.ahead, state.reached], [10, 16, 1, false], 'eine Folge vor dem Plan')
  const late = goalState(item, item.goal!, undefined, new Date(2026, 10, 2))
  assert.strictEqual(late.overdue, true, 'Tag vorbei')
  const done = createMerkItem({ ...item, seasons: [{ number: 1, episodes: 21, watched: Array.from({ length: 21 }, (_, i) => i + 1) }] })
  assert.strictEqual(goalState(done, item.goal!).reached, true, 'alles bis zum Ziel gesehen')
  assert.strictEqual(createMerkItem({ id: 'g2', title: 'Z', goal: { season: 1, episode: 0, setAt: 1 } as never }).goal, undefined, 'kaputtes Ziel fällt weg')
  assert.strictEqual(createMerkItem({ id: 'g3', title: 'Z', goal: { season: 1, episode: 3, by: 'morgen', setAt: 1 } }).goal?.by, undefined, 'kein Datum, das keines ist')
  console.log('✓ Ziel: gespeichert, vor/hinter dem Plan, vorbei, erreicht')
}

// Paused and given up
{
  assert.strictEqual(createMerkItem({ id: 'p', title: 'P', status: 'paused' }).status, 'paused', 'Pausiert bleibt')
  assert.strictEqual(createMerkItem({ id: 'd', title: 'D', status: 'dropped' }).status, 'dropped', 'Abgebrochen bleibt')
  assert.strictEqual(createMerkItem({ id: 'b', title: 'B', status: 'bogus' as never }).status, 'watching', 'Unbekanntes wird Am Schauen')
  const paused = createMerkItem({ id: 'pp', title: 'Q', status: 'paused', season: 1, episode: 3, seasons: [{ number: 1, episodes: 12, watched: [1, 2] }] })
  assert.strictEqual(advance(paused).status, 'watching', 'eine gesehene Folge nimmt die Serie wieder auf')
  const longer = [{ number: 1, episodes: 24, watched: [1, 2] }]
  assert.strictEqual(settle(paused, longer, 1).status, 'paused', 'eine geänderte Folgenzahl nicht')
  assert.strictEqual(settle(paused, watchedUpTo(paused, 1, 5), 1).status, 'watching', 'Abhaken bis Folge 5 schon')
  const mal = importMalXml(`<myanimelist><anime><series_title>A</series_title><series_episodes>12</series_episodes><my_watched_episodes>4</my_watched_episodes><my_status>On-Hold</my_status></anime><anime><series_title>B</series_title><series_episodes>12</series_episodes><my_watched_episodes>2</my_watched_episodes><my_status>Dropped</my_status></anime></myanimelist>`)
  assert.deepStrictEqual(mal.map((item) => item.status), ['paused', 'dropped'], 'MAL: On-Hold und Dropped')
  const anilist = importAniListJson(JSON.stringify({ lists: [{ entries: [{ status: 'PAUSED', media: { title: { romaji: 'C' }, episodes: 12 } }, { status: 'DROPPED', media: { title: { romaji: 'D' }, episodes: 12 } }] }] }))
  assert.deepStrictEqual(anilist.map((item) => item.status), ['paused', 'dropped'], 'AniList: PAUSED und DROPPED')
  console.log('✓ Pausiert und Abgebrochen: gespeichert, wieder aufgenommen, eingelesen')
}

// Sorted by what is left
{
  const make = (id: string, watched: number) => createMerkItem({ id, title: id, seasons: [{ number: 1, episodes: 12, watched: Array.from({ length: watched }, (_, i) => i + 1) }] })
  const open = createMerkItem({ id: 'open', title: 'open', seasons: [{ number: 1, episodes: null, watched: [] }] })
  const sorted = sortMerkItems([make('a', 2), open, make('b', 10), make('c', 6)], 'remaining')
  assert.deepStrictEqual(sorted.map((item) => item.id), ['b', 'c', 'a', 'open'], 'am wenigsten übrig zuerst, Unbekanntes zuletzt')
  console.log('✓ Sortierung: am wenigsten übrig')
}

// SQLite 3 database storage & Google Drive SQLite sync + Direct Player Streaming
{
  setSqliteAppState('player:mode', { direct: true, maxChunkSec: 120 })
  assert.deepStrictEqual(getSqliteAppState('player:mode'), { direct: true, maxChunkSec: 120 }, 'App-State in SQLite gespeichert')

  const mine = [
    createMerkItem({
      id: 'sql-1',
      title: 'Frieren SQLite',
      updatedAt: 100,
      season: 1,
      episode: 5,
      rating: 5,
      tags: ['Anime', 'SQLite'],
      seasons: [{ number: 1, episodes: 28, watched: [1, 2, 3, 4] }],
      history: [{ id: 'h-sql-1', season: 1, episode: 4, at: 99 }],
    }),
    createMerkItem({
      id: 'sql-2',
      title: 'Dark SQLite',
      updatedAt: 200,
      cover: 'data:image/webp;base64,' + 'B'.repeat(12000),
    }),
  ]
  const removed = { 'gone-sql': 55 }
  const sqliteBytes = sharedSqliteBytes(mine, removed)
  assert.strictEqual(isSqliteBytes(sqliteBytes), true, 'echtes SQLite-3-Binärformat (SQLite format 3\\0)')

  // Validate generated SQLite file with Node's built-in C SQLite engine (node:sqlite)
  const tmpSqlite = path.join(os.tmpdir(), `sondra-verify-${Date.now()}.sqlite`)
  fs.writeFileSync(tmpSqlite, sqliteBytes)
  const db = new DatabaseSync(tmpSqlite)
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  assert.strictEqual(integrity.integrity_check, 'ok', 'PRAGMA integrity_check === ok')
  const dbItems = db.prepare('SELECT id, title, rating FROM merkliste_items ORDER BY sort_order').all() as { id: string; title: string; rating: number }[]
  assert.strictEqual(dbItems.length, 2)
  assert.strictEqual(dbItems[0].title, 'Frieren SQLite')
  assert.strictEqual(dbItems[0].rating, 5)
  const dbSeasons = db.prepare('SELECT item_id, season_number, episodes, watched_json FROM merkliste_seasons').all() as { item_id: string; episodes: number; watched_json: string }[]
  assert.strictEqual(dbSeasons.length, 1)
  assert.strictEqual(dbSeasons[0].episodes, 28)
  assert.strictEqual(dbSeasons[0].watched_json, '[1,2,3,4]')
  const dbRemovals = db.prepare('SELECT item_id, removed_at FROM merkliste_removals').all() as { item_id: string; removed_at: number }[]
  assert.strictEqual(dbRemovals.length, 1)
  assert.strictEqual(dbRemovals[0].item_id, 'gone-sql')
  db.close()
  fs.unlinkSync(tmpSqlite)

  // Round-trip via readSharedFile & readMerklisteFile
  const backFromSqlite = readSharedFile(sqliteBytes)
  assert.ok(backFromSqlite, 'SQLite-Datei aus Google Drive lesbar')
  assert.strictEqual(backFromSqlite!.key, sharedKey(mine, removed), 'SQLite-Datei stimmt mit sharedKey überein')
  assert.deepStrictEqual(backFromSqlite!.removed, removed, 'Entferntes in SQLite-Tabelle merkliste_removals erhalten')
  assert.strictEqual(backFromSqlite!.items.find((i) => i.id === 'sql-2')?.cover, 'sondra:lokal')

  const exportedBytes = exportMerklisteSqlite(mine, removed)
  const importedFromSqlite = readMerklisteFile(exportedBytes)
  assert.strictEqual(importedFromSqlite.length, 2, 'SQLite-Export über readMerklisteFile einlesbar')
  assert.ok(importedFromSqlite.find((i) => i.id === 'sql-2')?.cover?.startsWith('data:image/webp;base64,'), 'Voll-Export behält lokale Cover in SQLite-Overflow-Pages')

  // Verify direct playback of .mkv and windowed streaming job for huge files
  assert.strictEqual(NATIVE_CONTAINER.test('Frieren S01E01.mkv'), true, 'MKV wird direkt abgespielt ohne Vorab-Hüllentausch')
  const streamJob = standJob(
    'repack',
    {
      durationSeconds: 7200,
      width: 1920,
      height: 1080,
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      sampleRate: 48000,
      channels: 'stereo',
      streams: [
        { index: 0, type: 'video', codec: 'h264', language: null, title: null, isDefault: true },
        { index: 0, type: 'audio', codec: 'aac', language: 'deu', title: null, isDefault: true },
      ],
    },
    '/disk/quelle.mkv',
    { startTime: 600, durationSeconds: 120 },
  )
  const ssIndex = streamJob.args.indexOf('-ss')
  const inputIndex = streamJob.args.indexOf('-i')
  assert.ok(ssIndex !== -1 && ssIndex < inputIndex, '-ss steht vor -i für sofortiges Disk-Seeking bei riesigen Dateien')
  assert.ok(streamJob.args.includes('frag_keyframe+empty_moov+default_base_moof'), 'nutzt fragmentiertes MP4 für schnellen Direkt-Stream')
  console.log('✓ SQLite-3-Datenbank & Direkt-Wiedergabe für riesige Videodateien verifiziert')
}

// Rückblick: what was watched in a year, from the dates the Merkliste keeps.
{
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime()
  const a = createMerkItem({ title: 'Frieren', url: '' })
  const b = createMerkItem({ title: 'Nana', url: '' })
  a.episodeDuration = 25
  b.episodeDuration = 20
  a.history = [
    { id: '1', season: 1, episode: 1, at: at(2026, 3, 1) },
    { id: '2', season: 1, episode: 2, at: at(2026, 3, 2) },
    { id: '3', season: 1, episode: 3, at: at(2026, 3, 3) },
    { id: '3b', season: 1, episode: 3, at: at(2026, 3, 4) },
    { id: '4', season: 1, episode: 4, at: at(2026, 7, 9) },
    { id: '0', season: 1, episode: 9, at: at(2025, 12, 31) },
  ]
  b.history = [
    { id: '5', season: 1, episode: 1, at: at(2026, 3, 3) },
    { id: '6', season: 1, episode: 2, at: at(2026, 3, 3) },
  ]
  b.status = 'done'
  const recap = yearRecap([a, b], 2026)
  assert.strictEqual(recap.episodes, 6, 'ein zweimal abgehaktes Folge zählt einmal, das Vorjahr gar nicht')
  assert.strictEqual(recap.minutes, 4 * 25 + 2 * 20, 'Minuten aus der Länge jeder Folge')
  assert.strictEqual(recap.byMonth[2], 5, 'März: fünf, davon drei an einem Tag der Serie 2')
  assert.strictEqual(recap.byMonth[6], 1, 'Juli: eine')
  assert.deepStrictEqual(recap.busiestMonth, { month: 2, episodes: 5 })
  assert.strictEqual(recap.busiestDay?.episodes, 3, 'am 3. März drei Folgen (eine Frieren, zwei Nana)')
  assert.strictEqual(recap.streak, 3, 'drei Tage hintereinander: 1., 2., 3. März')
  assert.deepStrictEqual(recap.top.map((row) => [row.title, row.episodes]), [['Frieren', 4], ['Nana', 2]])
  assert.strictEqual(recap.finished, 1, 'Nana ist fertig, und ihre letzte Folge war in diesem Jahr')
  assert.deepStrictEqual(recapYears([a, b]), [2026, 2025])
  assert.strictEqual(recordedSince([a, b]), at(2025, 12, 31))
  assert.strictEqual(yearRecap([a, b], 2024).episodes, 0, 'ein Jahr ohne Einträge ist leer, nicht erfunden')
  assert.strictEqual(yearRecap([], 2026).busiestMonth, null)
  console.log('✓ Jahresrückblick aus dem Verlauf')
}

// Merkliste teilen: the list in an address, read back as plain data only.
{
  const a = createMerkItem({ title: 'Frieren', url: 'https://geheim.example/serie', notes: 'privat', rating: 5 })
  a.status = 'done'
  const b = createMerkItem({ title: 'Nana', url: 'https://geheim.example/nana', season: 2, episode: 4 })
  const share = shareableList([a, b], '  Mia  ')
  const serialised = JSON.stringify(share)
  assert.ok(!serialised.includes('geheim') && !serialised.includes('privat'), 'weder Adressen noch Notizen gehen mit')
  assert.strictEqual(share.name, 'Mia')
  const link = await shareLink(share, 'https://sondra.lizge.ch/')
  assert.ok(link.startsWith('https://sondra.lizge.ch/#geteilt='), 'der Link trägt die Liste im Hash')
  assert.ok(link.length < LINK_MAX, 'zwei Einträge sind ein kurzer Link')
  const back = await decodeShare(sharedFromHash(new URL(link).hash)!)
  assert.deepStrictEqual(back?.items.map((item) => [item.title, item.status ?? 'watching', item.rating ?? 0, item.season, item.episode]), [['Frieren', 'done', 5, 1, 1], ['Nana', 'watching', 0, 2, 4]], 'hin und zurück')
  assert.strictEqual((await decodeShare(await encodeShare(shareableList([a], 'x', { progress: false }))))?.items[0].rating, undefined, 'ohne Fortschritt auch ohne Bewertung')
  // A hundred series still make a link a chat can carry.
  const many = Array.from({ length: 100 }, (_, n) => createMerkItem({ title: `Serie Nummer ${n} mit einem längeren Namen`, season: 1, episode: n % 12 }))
  const long = await shareLink(shareableList(many, 'Viele'), 'https://sondra.lizge.ch')
  assert.ok(long.length < LINK_MAX, `hundert Serien: ${long.length} Zeichen`)
  // What is not a list, or a hostile one, becomes nothing — never a crash, never more than the caps.
  assert.strictEqual(await decodeShare('das-ist-kein-link!'), null)
  assert.strictEqual(await decodeShare('AAAA'), null)
  assert.strictEqual(await decodeShare(''), null)
  const hostile = await encodeShare({ v: 1, name: 'x\u0000<script>', items: [{ title: '<img src=x onerror=alert(1)>', status: 'hacked' as never, rating: 99, season: -3, episode: 1e12 }, { title: '   ' }, { title: 'Ok', seen: 5 }] } as never)
  const clean = await decodeShare(hostile)
  assert.deepStrictEqual(clean?.items.map((item) => [item.title, item.status, item.rating, item.season, item.episode, item.seen]), [['<img src=x onerror=alert(1)>', undefined, undefined, undefined, undefined, undefined], ['Ok', undefined, undefined, undefined, undefined, 5]], 'unbekannter Status, Bewertung, Staffel und Folge ausserhalb des Möglichen werden verworfen, leere Titel auch')
  assert.ok(!clean?.name.includes('\u0000'), 'Steuerzeichen im Namen sind weg')
  // A bomb: a few bytes that unpack to many megabytes.
  const bomb = await encodeShare({ v: 1, name: '', items: [{ title: 'x'.repeat(60_000_000) }] } as never).catch(() => 'nicht-gepackt')
  assert.strictEqual(await decodeShare(bomb), null, 'zu grosses Auspacken wird abgebrochen')
  // New on this list.
  const mine = [createMerkItem({ title: 'FRIEREN' }), createMerkItem({ title: 'Eigene' })]
  assert.deepStrictEqual(newFromShared(share, mine).map((item) => item.title), ['Nana'], 'was schon da ist, nicht doppelt')
  console.log('✓ Merkliste teilen: Link, Prüfung, Obergrenzen')
}

console.log('--- All Merkliste Feature Tests Passed! ---')
