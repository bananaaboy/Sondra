/**
 * AniList & MyAnimeList (MAL) integration for Sondra's Merkliste.
 *
 * - Searches AniList's public GraphQL API for series metadata (cover image,
 *   titles, episode count, status) without needing an account.
 * - Syncs episode progress (`SaveMediaListEntry`) when the user provides an
 *   AniList Personal Access Token or MyAnimeList token.
 */

const ANILIST_GRAPHQL = 'https://graphql.anilist.co'
const STORAGE_KEY = 'sondra:anilist:settings'
const CACHE_KEY = 'sondra:anilist:media-cache'

export interface AniListSettings {
  enabled: boolean
  anilistToken: string
  anilistUser: string | null
  malToken: string
  autoSyncOnSeen: boolean
}

export interface AniListMediaInfo {
  id: number
  idMal: number | null
  titleRomaji: string
  titleEnglish: string | null
  titleNative: string | null
  episodes: number | null
  status: string | null
  coverUrl: string | null
  description: string | null
  seasonYear: number | null
}

const DEFAULT_SETTINGS: AniListSettings = {
  enabled: false,
  anilistToken: '',
  anilistUser: null,
  malToken: '',
  autoSyncOnSeen: true,
}

type Listener = (settings: AniListSettings) => void
const listeners = new Set<Listener>()

export function getAniListSettings(): AniListSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AniListSettings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function setAniListSettings(patch: Partial<AniListSettings>): AniListSettings {
  const next = { ...getAniListSettings(), ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore storage errors
  }
  listeners.forEach((fn) => fn(next))
  return next
}

export function onAniListSettings(fn: Listener): () => void {
  listeners.add(fn)
  fn(getAniListSettings())
  return () => {
    listeners.delete(fn)
  }
}

function getMediaCache(): Record<string, AniListMediaInfo> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, AniListMediaInfo>) : {}
  } catch {
    return {}
  }
}

function setMediaCacheEntry(key: string, info: AniListMediaInfo): void {
  if (typeof localStorage === 'undefined') return
  try {
    const cache = getMediaCache()
    cache[key] = info
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // ignore
  }
}

/**
 * Searches AniList's public GraphQL endpoint for an anime by title (and optional season number).
 */
export async function searchAniListMedia(
  title: string,
  seasonNumber = 1,
  signal?: AbortSignal,
): Promise<AniListMediaInfo | null> {
  const cleanTitle = title
    .replace(/\s*[-–—:]\s*Staffel\s*\d+.*$/i, '')
    .replace(/\s*S\d+E\d+.*$/i, '')
    .trim()
  if (!cleanTitle) return null

  const searchQuery =
    seasonNumber > 1 ? `${cleanTitle} Season ${seasonNumber}` : cleanTitle
  const cacheKey = `${cleanTitle.toLowerCase()}::s${seasonNumber}`
  const cached = getMediaCache()[cacheKey]
  if (cached) return cached

  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        episodes
        status
        seasonYear
        description(asHtml: false)
        coverImage {
          extraLarge
          large
        }
      }
    }
  `

  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables: { search: searchQuery } }),
      signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      data?: {
        Media?: {
          id: number
          idMal?: number | null
          title?: { romaji?: string; english?: string | null; native?: string | null }
          episodes?: number | null
          status?: string | null
          seasonYear?: number | null
          description?: string | null
          coverImage?: { extraLarge?: string | null; large?: string | null }
        }
      }
    }
    const media = json.data?.Media
    if (!media) return null

    const info: AniListMediaInfo = {
      id: media.id,
      idMal: media.idMal ?? null,
      titleRomaji: media.title?.romaji ?? cleanTitle,
      titleEnglish: media.title?.english ?? null,
      titleNative: media.title?.native ?? null,
      episodes: typeof media.episodes === 'number' && media.episodes > 0 ? media.episodes : null,
      status: media.status ?? null,
      coverUrl: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
      description: media.description ? media.description.replace(/<[^>]+>/g, '').trim() : null,
      seasonYear: media.seasonYear ?? null,
    }
    setMediaCacheEntry(cacheKey, info)
    return info
  } catch {
    return null
  }
}

/**
 * Verifies an AniList Personal Access Token and returns the authenticated user's profile.
 */
export async function verifyAniListToken(
  token: string,
): Promise<{ id: number; name: string } | null> {
  const clean = token.trim()
  if (!clean) return null
  const query = `
    query {
      Viewer {
        id
        name
      }
    }
  `
  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${clean}`,
      },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { Viewer?: { id: number; name: string } } }
    const viewer = json.data?.Viewer
    if (!viewer) return null
    setAniListSettings({ anilistUser: viewer.name })
    return viewer
  } catch {
    return null
  }
}

/**
 * Syncs watched episode progress for a series to AniList (and MyAnimeList if configured).
 */
export async function syncProgressToTrackers(entry: {
  title: string
  season: number
  watchedCount: number
  totalEpisodes?: number | null
  status?: 'watching' | 'planned' | 'paused' | 'dropped' | 'done'
}): Promise<{ ok: boolean; tracker?: string; error?: string }> {
  const settings = getAniListSettings()
  if (!settings.enabled || !settings.autoSyncOnSeen) {
    return { ok: false }
  }
  const token = settings.anilistToken.trim()
  if (!token) return { ok: false }

  try {
    const media = await searchAniListMedia(entry.title, Math.max(1, entry.season))
    if (!media) return { ok: false, error: 'Serie auf AniList nicht gefunden.' }

    const isDone =
      entry.status === 'done' ||
      (typeof entry.totalEpisodes === 'number' &&
        entry.totalEpisodes > 0 &&
        entry.watchedCount >= entry.totalEpisodes)

    const alStatus = isDone
      ? 'COMPLETED'
      : entry.status === 'planned'
        ? 'PLANNING'
        : entry.status === 'paused'
          ? 'PAUSED'
          : entry.status === 'dropped'
            ? 'DROPPED'
            : 'CURRENT'

    const mutation = `
      mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
          id
          progress
          status
        }
      }
    `
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          mediaId: media.id,
          progress: Math.max(0, entry.watchedCount),
          status: alStatus,
        },
      }),
    })
    if (!res.ok) {
      return { ok: false, error: `AniList HTTP ${res.status}` }
    }
    return { ok: true, tracker: 'AniList' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Netzwerkfehler' }
  }
}

/**
 * Fetches the authenticated user's anime list from AniList so it can be imported/merged into Merkliste.
 */
export async function fetchAniListCollection(): Promise<
  {
    title: string
    progress: number
    totalEpisodes: number | null
    status: 'watching' | 'planned' | 'paused' | 'dropped' | 'done'
    coverUrl: string | null
    siteUrl: string
  }[]
> {
  const settings = getAniListSettings()
  const token = settings.anilistToken.trim()
  if (!token) return []

  const viewer = await verifyAniListToken(token)
  if (!viewer) return []

  const query = `
    query ($userId: Int) {
      MediaListCollection(userId: $userId, type: ANIME) {
        lists {
          entries {
            progress
            status
            media {
              id
              siteUrl
              episodes
              title {
                romaji
                english
              }
              coverImage {
                large
              }
            }
          }
        }
      }
    }
  `
  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: { userId: viewer.id } }),
    })
    if (!res.ok) return []
    const json = (await res.json()) as {
      data?: {
        MediaListCollection?: {
          lists?: {
            entries?: {
              progress?: number
              status?: string
              media?: {
                id: number
                siteUrl?: string
                episodes?: number | null
                title?: { romaji?: string; english?: string | null }
                coverImage?: { large?: string | null }
              }
            }[]
          }[]
        }
      }
    }
    const out: {
      title: string
      progress: number
      totalEpisodes: number | null
      status: 'watching' | 'planned' | 'paused' | 'dropped' | 'done'
      coverUrl: string | null
      siteUrl: string
    }[] = []
    for (const list of json.data?.MediaListCollection?.lists ?? []) {
      for (const entry of list.entries ?? []) {
        const m = entry.media
        if (!m) continue
        const title = m.title?.english || m.title?.romaji || `Anime #${m.id}`
        const statusMap: Record<string, 'watching' | 'planned' | 'paused' | 'dropped' | 'done'> = {
          CURRENT: 'watching',
          REPEATING: 'watching',
          PLANNING: 'planned',
          PAUSED: 'paused',
          DROPPED: 'dropped',
          COMPLETED: 'done',
        }
        out.push({
          title,
          progress: entry.progress ?? 0,
          totalEpisodes: typeof m.episodes === 'number' && m.episodes > 0 ? m.episodes : null,
          status: statusMap[entry.status ?? 'CURRENT'] ?? 'watching',
          coverUrl: m.coverImage?.large ?? null,
          siteUrl: m.siteUrl || `https://anilist.co/anime/${m.id}`,
        })
      }
    }
    return out
  } catch {
    return []
  }
}
