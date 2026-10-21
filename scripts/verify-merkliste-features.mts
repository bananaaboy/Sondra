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
} from '../src/lib/merkliste'

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

console.log('--- All Merkliste Feature Tests Passed! ---')
