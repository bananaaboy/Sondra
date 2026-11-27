/**
 * The order of language versions — „Deutsch, sonst Deutsch untertitelt, sonst
 * Englisch“ — and what follows from it: an episode comes in the first version
 * there is, the version it came in is remembered, and when a better one
 * appears later the Merkliste offers it. Offers, never replaces: the file
 * already loaded stays where it is, and the new one is a click, not a surprise.
 *
 * Pure, so the rules can be checked on their own (`verify:language`); the
 * parts that touch the Merkliste and the network are in `merkliste.ts`.
 */

export type LangCode = 'ger_dub' | 'ger_sub' | 'eng_sub'

export const LANG_CODES: LangCode[] = ['ger_dub', 'ger_sub', 'eng_sub']

export const LANG_LABELS: Record<LangCode, string> = {
  ger_dub: 'Deutsch',
  ger_sub: 'Deutsch untertitelt',
  eng_sub: 'Englisch untertitelt',
}

/** What „Automatisch“ always did: German with subtitles, then German dubbed, then English. */
export const DEFAULT_ORDER: LangCode[] = ['ger_sub', 'ger_dub', 'eng_sub']

const KEY = 'sondra:sprachen'

export const isLangCode = (value: unknown): value is LangCode => typeof value === 'string' && (LANG_CODES as string[]).includes(value)

/** An order as stored: the known codes, once each, and any that are missing at the end in the default order — always all three. */
export function normalizeOrder(raw: unknown): LangCode[] {
  const given = Array.isArray(raw) ? raw.filter(isLangCode) : []
  const once = given.filter((code, index) => given.indexOf(code) === index)
  return [...once, ...DEFAULT_ORDER.filter((code) => !once.includes(code))]
}

export function getLanguageOrder(): LangCode[] {
  try {
    return normalizeOrder(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return [...DEFAULT_ORDER]
  }
}

export function setLanguageOrder(order: LangCode[]): LangCode[] {
  const next = normalizeOrder(order)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Only a preference.
  }
  return next
}

/** One step up (−1) or down (+1) in the order; the ends stay put. */
export function moveLanguage(order: LangCode[], code: LangCode, step: -1 | 1): LangCode[] {
  const from = order.indexOf(code)
  const to = from + step
  if (from < 0 || to < 0 || to >= order.length) return order
  const next = [...order]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

/** AniWorld's language keys: 1 German dub, 2 English sub, 3 German sub. */
export function langOfKey(key: number | undefined): LangCode | null {
  return key === 1 ? 'ger_dub' : key === 3 ? 'ger_sub' : key === 2 ? 'eng_sub' : null
}

/** 0 is the best; a version the order does not name ranks after all it does. */
export const rankOf = (code: LangCode, order: LangCode[]): number => {
  const at = order.indexOf(code)
  return at < 0 ? order.length : at
}

/** The best of `available` that ranks above `have`, or `null` when there is none. */
export function betterOf(have: LangCode, available: LangCode[], order: LangCode[]): LangCode | null {
  let best: LangCode | null = null
  for (const code of available) {
    if (rankOf(code, order) < rankOf(best ?? have, order)) best = code
  }
  return best
}

export const episodeKey = (season: number, episode: number) => `${season}:${episode}`

/** The version each episode was loaded in, keyed `season:episode`. */
export type EpisodeLanguages = Record<string, LangCode>

export function normalizeLangs(raw: unknown): EpisodeLanguages | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const kept: EpisodeLanguages = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/^\d{1,3}:\d{1,4}$/.test(key) && isLangCode(value)) kept[key] = value
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/** An episode for which a better version is out than the one loaded. */
export interface LangUpgrade {
  season: number
  episode: number
  to: LangCode
  foundAt: number
}

export function normalizeUpgrades(raw: unknown): LangUpgrade[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const kept = raw
    .filter(
      (entry): entry is LangUpgrade =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        Number.isInteger((entry as LangUpgrade).season) &&
        (entry as LangUpgrade).season >= 0 &&
        Number.isInteger((entry as LangUpgrade).episode) &&
        (entry as LangUpgrade).episode >= 1 &&
        isLangCode((entry as LangUpgrade).to),
    )
    .map((entry) => ({ season: entry.season, episode: entry.episode, to: entry.to, foundAt: Number(entry.foundAt) || 0 }))
    .slice(0, 40)
  return kept.length > 0 ? kept : undefined
}

/** How many episodes one round looks at, and how often an episode is asked again. */
export const UPGRADE_CHECK_MAX = 6
export const UPGRADE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * The episodes worth asking about: loaded in a version that is not the best of
 * the order, the latest first, at most `max`. An episode loaded in the best
 * version has nothing to improve, and asking about it would cost a page for
 * nothing.
 */
export function upgradeCandidates(langs: EpisodeLanguages | undefined, order: LangCode[], max = UPGRADE_CHECK_MAX): { season: number; episode: number; have: LangCode }[] {
  if (!langs) return []
  return Object.entries(langs)
    .filter(([, code]) => rankOf(code, order) > 0)
    .map(([key, have]) => {
      const [season, episode] = key.split(':').map(Number)
      return { season, episode, have }
    })
    .sort((a, b) => b.season - a.season || b.episode - a.episode)
    .slice(0, max)
}

/** „Folge 3 und 5“, „Folge 2, 3 und 5“, „Staffel 2, Folge 1“ — of the episodes an upgrade is offered for. */
export function upgradeWhere(upgrades: LangUpgrade[]): string {
  const bySeason = new Map<number, number[]>()
  for (const entry of upgrades) bySeason.set(entry.season, [...(bySeason.get(entry.season) ?? []), entry.episode].sort((a, b) => a - b))
  const parts = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([season, episodes]) => {
    const list = episodes.length === 1 ? String(episodes[0]) : `${episodes.slice(0, -1).join(', ')} und ${episodes[episodes.length - 1]}`
    const noun = season === 0 ? (episodes.length === 1 ? 'Film' : 'Filme') : episodes.length === 1 ? 'Folge' : 'Folgen'
    return bySeason.size > 1 && season > 0 ? `Staffel ${season}, ${noun} ${list}` : `${noun} ${list}`
  })
  return parts.join(' · ')
}
