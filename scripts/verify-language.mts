/**
 * The order of language versions and the offers that follow from it, checked
 * without AniWorld: the pure rules (`lib/languages.ts`), and the Merkliste's
 * side (remembering a version, asking which exist now, offering, waving away)
 * against a stand-in for `fetch`.
 *
 *   npm run verify:language
 *
 * What it holds to: nothing is ever swapped in by itself; a check is not a
 * change (`updatedAt` stays); an episode in the best version is never asked
 * about; one round asks a few episodes, not a whole series.
 */

import {
  betterOf,
  DEFAULT_ORDER,
  langOfKey,
  moveLanguage,
  normalizeLangs,
  normalizeOrder,
  normalizeUpgrades,
  rankOf,
  upgradeCandidates,
  upgradeWhere,
  type LangCode,
} from '../src/lib/languages'
import { checkLanguageUpgrades, createMerkItem, ignoreUpgrades, merkItems, noteEpisodeLanguage, setMerkItems } from '../src/lib/merkliste'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

const DUB_FIRST: LangCode[] = ['ger_dub', 'ger_sub', 'eng_sub']

/* -- The order ----------------------------------------------------------------- */

check('Voreinstellung wie „Automatisch“ immer: Sub, Dub, Englisch', DEFAULT_ORDER, ['ger_sub', 'ger_dub', 'eng_sub'])
check('Reihenfolge: Unsinn weg, Doppeltes weg, Fehlendes hinten', normalizeOrder(['eng_sub', 'x', 'eng_sub', 7]), ['eng_sub', 'ger_sub', 'ger_dub'])
check('Reihenfolge: nichts Gespeichertes ist die Voreinstellung', normalizeOrder(null), DEFAULT_ORDER)
check('Verschieben: eins nach oben', moveLanguage(DUB_FIRST, 'ger_sub', -1), ['ger_sub', 'ger_dub', 'eng_sub'])
check('Verschieben: das Ende bleibt, wo es ist', [moveLanguage(DUB_FIRST, 'ger_dub', -1), moveLanguage(DUB_FIRST, 'eng_sub', 1)], [DUB_FIRST, DUB_FIRST])
check('Schlüssel von AniWorld', [langOfKey(1), langOfKey(2), langOfKey(3), langOfKey(9), langOfKey(undefined)], ['ger_dub', 'eng_sub', 'ger_sub', null, null])
check('Rang: vorn ist besser, Unbekanntes zuletzt', [rankOf('ger_dub', DUB_FIRST), rankOf('eng_sub', DUB_FIRST), rankOf('ger_dub', [])], [0, 2, 0])

/* -- Better ---------------------------------------------------------------------- */

check('besser: Deutsch ist besser als Englisch (Reihenfolge Deutsch zuerst)', betterOf('eng_sub', ['eng_sub', 'ger_dub'], DUB_FIRST), 'ger_dub')
check('besser: die beste der vorhandenen, nicht die erstbeste', betterOf('eng_sub', ['ger_sub', 'ger_dub'], DUB_FIRST), 'ger_dub')
check('besser: nichts Besseres da', betterOf('ger_dub', ['ger_sub', 'eng_sub'], DUB_FIRST), null)
check('besser: gleich gut ist nicht besser', betterOf('ger_sub', ['ger_sub'], DUB_FIRST), null)
check('besser: mit der anderen Reihenfolge ist Sub das Beste', betterOf('ger_dub', ['ger_sub'], ['ger_sub', 'ger_dub', 'eng_sub']), 'ger_sub')

const langs = { '1:1': 'ger_dub', '1:2': 'eng_sub', '1:3': 'ger_sub', '2:1': 'eng_sub', '2:2': 'ger_dub', '2:3': 'eng_sub', '2:4': 'eng_sub', '2:5': 'ger_sub', '2:6': 'eng_sub', '2:7': 'eng_sub' } as const
check('Kandidaten: in der besten Fassung geladen wird nie gefragt', upgradeCandidates({ '1:1': 'ger_dub', '1:2': 'ger_dub' }, DUB_FIRST), [])
check('Kandidaten: höchstens sechs, die neuesten zuerst', upgradeCandidates(langs, DUB_FIRST).map((c) => `${c.season}:${c.episode}`), ['2:7', '2:6', '2:5', '2:4', '2:3', '2:1'])
check('Kandidaten: ohne Merkzettel keine', upgradeCandidates(undefined, DUB_FIRST), [])
check('Gespeichertes wird geprüft: falsche Schlüssel und Fassungen fallen weg', normalizeLangs({ '1:1': 'ger_dub', 'x': 'ger_dub', '1:2': 'klingon' }), { '1:1': 'ger_dub' })
check('Angebote: kaputte fallen weg', normalizeUpgrades([{ season: 1, episode: 3, to: 'ger_dub', foundAt: 5 }, { season: -1, episode: 3, to: 'ger_dub' }, { season: 1, episode: 0, to: 'ger_dub' }, { season: 1, episode: 4, to: 'nix' }]), [{ season: 1, episode: 3, to: 'ger_dub', foundAt: 5 }])
check('Angebote in Worten: eine Folge', upgradeWhere([{ season: 1, episode: 3, to: 'ger_dub', foundAt: 0 }]), 'Folge 3')
check('Angebote in Worten: mehrere', upgradeWhere([{ season: 1, episode: 5, to: 'ger_dub', foundAt: 0 }, { season: 1, episode: 3, to: 'ger_dub', foundAt: 0 }, { season: 1, episode: 4, to: 'ger_dub', foundAt: 0 }]), 'Folgen 3, 4 und 5')
check('Angebote in Worten: mehrere Staffeln', upgradeWhere([{ season: 2, episode: 1, to: 'ger_dub', foundAt: 0 }, { season: 1, episode: 3, to: 'ger_dub', foundAt: 0 }]), 'Staffel 1, Folge 3 · Staffel 2, Folge 1')

/* -- The Merkliste ------------------------------------------------------------------ */

const asked: string[] = []
/** What AniWorld "has" for an episode, by the episode's number in the address. */
let has: Record<string, string[]> = { '3': ['eng_sub', 'ger_dub'], '4': ['eng_sub'], '5': ['ger_sub', 'eng_sub'] }
let unreachable = false
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { url: string; languagesOnly?: boolean }
  asked.push(body.url)
  if (unreachable) return { ok: false, json: async () => ({}) } as Response
  const episode = /episode-(\d+)/.exec(body.url)?.[1] ?? ''
  return { ok: true, json: async () => ({ status: 'languages', availableLanguages: (has[episode] ?? []).map((code) => ({ code })) }) } as Response
}) as typeof fetch

// Not waiting two seconds between episodes in a check.
const realTimeout = globalThis.setTimeout
globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout

const series = createMerkItem({ id: 'frieren', url: 'https://aniworld.to/anime/stream/frieren/staffel-1/episode-1', title: 'Frieren', updatedAt: 1000 })
setMerkItems([series])
const get = () => merkItems().find((entry) => entry.id === 'frieren')!

noteEpisodeLanguage('frieren', 1, 3, 'eng_sub', DUB_FIRST)
noteEpisodeLanguage('frieren', 1, 4, 'eng_sub', DUB_FIRST)
noteEpisodeLanguage('frieren', 1, 5, 'ger_dub', DUB_FIRST)
check('Merken: die Fassung je Folge liegt am Eintrag', get().langs, { '1:3': 'eng_sub', '1:4': 'eng_sub', '1:5': 'ger_dub' })

const before = get().updatedAt
const run = await checkLanguageUpgrades(get(), DUB_FIRST)
check('Prüfen: nur Folgen in schlechterer Fassung werden gefragt (nicht die beste)', asked.map((u) => /episode-(\d+)/.exec(u)![1]).sort(), ['3', '4'])
check('Prüfen: gefragt wird die Folge, nicht die Serienseite', asked.every((u) => /staffel-1\/episode-\d+$/.test(u)), true)
check('Prüfen: Folge 3 hat jetzt Deutsch — angeboten; Folge 4 nichts Besseres', get().upgrades?.map((u) => `${u.season}:${u.episode}:${u.to}`), ['1:3:ger_dub'])
check('Prüfen: Ergebnis', [run.asked, run.found.length, run.unreachable], [2, 1, false])
check('Prüfen ist keine Änderung: updatedAt bleibt', get().updatedAt, before)
check('Prüfen: die Zeit der Prüfung ist vermerkt', typeof get().upgradeCheckedAt, 'number')
check('Es wird nichts von selbst ersetzt: die gemerkte Fassung bleibt die geladene', get().langs?.['1:3'], 'eng_sub')

const again = asked.length
await checkLanguageUpgrades(get(), DUB_FIRST)
check('am selben Tag nicht noch einmal', asked.length, again)
await checkLanguageUpgrades(get(), DUB_FIRST, true)
check('von Hand ja, auch am selben Tag', asked.length > again, true)

ignoreUpgrades('frieren')
check('Wegwinken: das Angebot ist weg', get().upgrades, undefined)
await checkLanguageUpgrades(get(), DUB_FIRST, true)
check('… und kommt nicht wieder, solange es dasselbe ist', get().upgrades, undefined)
has = { ...has, '3': ['eng_sub', 'ger_dub', 'ger_sub'] }
await checkLanguageUpgrades(get(), DUB_FIRST, true)
check('Wegwinken gilt für genau dieses Angebot: eine weitere Fassung derselben Folge ändert nichts daran', get().upgrades, undefined)
has = { ...has, '4': ['ger_dub'] }
await checkLanguageUpgrades(get(), DUB_FIRST, true)
check('Eine neue Fassung einer anderen Folge wird angeboten', get().upgrades?.map((u) => `${u.episode}:${u.to}`), ['4:ger_dub'])

noteEpisodeLanguage('frieren', 1, 4, 'ger_dub', DUB_FIRST)
check('Laden in der besseren Fassung erledigt das Angebot', [get().upgrades, get().langs?.['1:4']], [undefined, 'ger_dub'])
noteEpisodeLanguage('frieren', 1, 3, 'ger_sub', DUB_FIRST)
check('Auch eine andere Fassung wird gemerkt, wie sie kam', get().langs?.['1:3'], 'ger_sub')

unreachable = true
const fails = await checkLanguageUpgrades(get(), DUB_FIRST, true)
check('AniWorld nicht erreichbar: gesagt, nichts verändert', [fails.asked, fails.unreachable, get().upgrades], [0, true, undefined])

const other = createMerkItem({ id: 'film', url: 'https://example.org/film', title: 'Kein AniWorld', updatedAt: 1 })
setMerkItems([other])
const n = asked.length
check('Eine Serie ohne AniWorld-Adresse wird nicht gefragt', [(await checkLanguageUpgrades(other, DUB_FIRST, true)).asked, asked.length === n], [0, true])

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nAlles in Ordnung.')
process.exit(0)
